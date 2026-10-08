// Agent workspace. Process/output data is rendered as text, never as terminal HTML.
let serverUptimeSeconds = 0;
let uptimeSyncedAt = performance.now();
let sessions = [];
let selectedFilter = 'all';
let refreshTimer = null;
let refreshController = null;
const cards = new Map();
const $ = id => document.getElementById(id);
const states = {working: 'Trabajando', idle: 'En espera', permission: 'Necesita permiso', ended: 'Finalizada'};
const kinds = {tool: ['build', 'Herramienta'], message: ['chat_bubble', 'Mensaje'], output: ['terminal', 'Consola'], status: ['info', 'Estado']};
const notices = {permission: ['front_hand', 'Necesita tu permiso'], completed: ['task_alt', 'Trabajo terminado'], error: ['error', 'Revisa este error']};

function text(node, value) { if (node.textContent !== String(value ?? '')) node.textContent = value ?? ''; }
function icon(name) {
    const node = document.createElement('span');
    node.className = 'material-symbols-outlined';
    node.setAttribute('aria-hidden', 'true');
    node.textContent = name;
    return node;
}
function relativeTime(seconds) {
    if (!seconds) return 'Sin actividad registrada';
    const age = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
    if (age < 10) return 'Ahora';
    if (age < 60) return `Hace ${age} s`;
    if (age < 3600) return `Hace ${Math.floor(age / 60)} min`;
    return `Hace ${Math.floor(age / 3600)} h`;
}
async function api(url, options = {}) {
    const response = await fetch(url, {...options, headers: {'X-WebConsole': '1', ...options.headers}});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `No se pudo completar la petición (${response.status})`);
    return data;
}

async function refreshSessions() {
    clearTimeout(refreshTimer);
    if (refreshController) return;
    refreshController = new AbortController();
    const timeout = setTimeout(() => refreshController?.abort(), 10000);
    $('refresh').disabled = true;
    try {
        const data = await api('/api/sessions', {signal: refreshController.signal});
        sessions = data.sessions || [];
        updateStats();
        renderSessions();
        $('load-error').hidden = true;
        const available = data.monitor_available && Date.now() / 1000 - data.observed_at < 12;
        $('monitor-label').textContent = available ? 'Actividad en directo' : 'Actividad no disponible';
        document.querySelector('.monitor-status').classList.toggle('offline', !available);
        if (!available) {
            $('load-error').hidden = false;
            $('load-error').textContent = 'No se pudo observar la actividad. Los estados pueden estar desactualizados; abre la consola para comprobarlos.';
        }
    } catch (error) {
        $('load-error').hidden = false;
        $('load-error').textContent = 'No se pudo actualizar el panel. Se reintentará automáticamente; la última información puede estar desactualizada.';
        $('monitor-label').textContent = 'Sin conexión';
        document.querySelector('.monitor-status').classList.add('offline');
        if (!cards.size) showEmpty('cloud_off', 'No se pudieron cargar las sesiones', 'Comprueba la conexión y pulsa actualizar para volver a intentarlo.');
    } finally {
        clearTimeout(timeout);
        refreshController = null;
        $('refresh').disabled = false;
        $('sessions-list').setAttribute('aria-busy', 'false');
        if (!document.hidden) refreshTimer = setTimeout(refreshSessions, 3000);
    }
}

function updateStats() {
    const counts = {all: sessions.length, working: 0, attention: 0, idle: 0};
    for (const session of sessions) {
        if (session.state === 'working') counts.working++;
        if (session.state === 'idle') counts.idle++;
        if (session.notification) counts.attention++;
    }
    text($('total-sessions'), counts.all);
    text($('working-sessions'), counts.working);
    text($('attention-sessions'), counts.attention);
    text($('idle-sessions'), counts.idle);
    $('attention-strip').hidden = counts.attention === 0;
    text($('attention-title'), counts.attention === 1 ? 'Una sesión necesita tu atención' : `${counts.attention} sesiones necesitan tu atención`);
}

function createCard(session) {
    const card = document.createElement('article');
    card.className = 'session-card';
    // Static scaffolding; all data from agents is assigned through textContent.
    card.innerHTML = `
        <div class="card-heading"><div class="agent-avatar" aria-hidden="true"></div><div class="agent-identity"><h2 class="agent-name"></h2><span class="session-id"></span></div><div class="state-wrap"><span class="state-badge"><span class="state-dot"></span><span class="state-label"></span></span><span class="state-evidence"></span></div></div>
        <div class="task-context"><div class="task-title"></div><div class="project-path"><span class="material-symbols-outlined" aria-hidden="true">folder_open</span><span></span></div></div>
        <div class="notification" hidden><div class="notice-heading"><span class="material-symbols-outlined" aria-hidden="true"></span><span></span></div><p class="notice-message"></p><div class="notice-actions"><a class="review-link" target="_blank" rel="noopener noreferrer">Revisar en consola</a><button class="acknowledge">Marcar como visto</button><span class="notice-source"></span></div></div>
        <div class="activity-lane"><div class="activity-heading"><span class="material-symbols-outlined" aria-hidden="true">view_timeline</span><strong>Actividad reciente</strong><time></time></div><ol class="activity-feed" aria-label="Mensajes y herramientas recientes"></ol><div class="activity-empty" hidden><span class="material-symbols-outlined" aria-hidden="true">hourglass_empty</span><span>Los mensajes aparecerán aquí cuando el agente empiece.</span></div><details class="screen-details"><summary>Ver pantalla actual</summary><pre></pre></details></div>
        <div class="card-footer"><a class="open-console btn btn-tonal" target="_blank" rel="noopener noreferrer"><span class="material-symbols-outlined" aria-hidden="true">terminal</span>Abrir consola</a><div class="card-actions"><button class="icon-button copy" aria-label="Copiar enlace de sesión" title="Copiar enlace"><span class="material-symbols-outlined" aria-hidden="true">link</span></button><button class="icon-button delete" aria-label="Eliminar sesión y detener sus procesos" title="Eliminar sesión"><span class="material-symbols-outlined" aria-hidden="true">delete</span></button></div></div>`;
    card.refs = Object.fromEntries(['agent-avatar', 'agent-name', 'session-id', 'state-badge', 'state-label', 'task-title', 'project-path', 'notification', 'notice-heading', 'notice-message', 'notice-source', 'activity-feed', 'activity-empty', 'screen-details', 'open-console', 'review-link'].map(name => [name, card.querySelector('.' + name)]));
    card.querySelector('.copy').addEventListener('click', () => copySessionLink(card.session.token));
    card.querySelector('.delete').addEventListener('click', () => deleteSession(card.session));
    card.querySelector('.acknowledge').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await api(`/api/sessions/${encodeURIComponent(card.session.id)}/acknowledge`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({fingerprint: card.session.notification.fingerprint})});
            showToast('Aviso marcado como visto');
            await refreshSessions();
        } catch (error) { showToast(error.message); }
        finally { button.disabled = false; }
    });
    return card;
}

function updateCard(card, session) {
    card.session = session;
    const refs = card.refs;
    const agent = session.agent || {key: 'terminal', name: 'Terminal', kind: 'shell'};
    const label = states[session.state] || 'Sin información';
    card.dataset.id = session.id;
    card.setAttribute('aria-label', `${agent.name}, sesión ${session.id}, ${label}`);
    text(refs['agent-avatar'], agent.key === 'terminal' ? '>_' : agent.name.slice(0, 1));
    refs['agent-avatar'].dataset.agent = agent.key;
    text(refs['agent-name'], agent.name);
    text(refs['session-id'], `Sesión ${session.id}`);
    refs['state-badge'].className = `state-badge ${Object.hasOwn(states, session.state) ? session.state : 'idle'}`;
    text(refs['state-label'], label);
    text(card.querySelector('.state-evidence'), session.state_source === 'estimated' ? 'Actividad estimada' : '');
    refs['state-badge'].title = `${session.state_detail || label}${session.state_source === 'estimated' ? '. Estado estimado; no confirma que la tarea haya terminado.' : ''}`;
    const project = (session.cwd || '').split('/').filter(Boolean).at(-1) || 'Consola';
    text(refs['task-title'], session.title || project);
    text(refs['project-path'].lastElementChild, session.cwd || 'Directorio no disponible');
    refs['project-path'].title = session.cwd || '';
    const url = '/c/' + encodeURIComponent(session.token);
    refs['open-console'].href = url;
    refs['review-link'].href = url;
    const notice = session.notification;
    card.classList.toggle('has-notification', Boolean(notice));
    refs.notification.hidden = !notice;
    if (notice) {
        const [glyph, heading] = notices[notice.kind] || notices.error;
        text(refs['notice-heading'].firstElementChild, glyph);
        text(refs['notice-heading'].lastElementChild, heading);
        text(refs['notice-message'], notice.message);
        text(refs['notice-source'], notice.source === 'screen' ? 'Detectado en pantalla' : notice.source === 'event' ? 'Aviso del agente' : 'Proceso finalizado');
        refs.notification.classList.toggle('error', notice.kind === 'error');
    }
    const time = card.querySelector('.activity-heading time');
    text(time, relativeTime(session.last_output || session.activity?.at(-1)?.at));
    const feed = refs['activity-feed'];
    const entries = session.activity || [];
    const signature = JSON.stringify(entries);
    if (card.feedSignature !== signature) {
        const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 32;
        const scroll = feed.scrollTop;
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
            const [glyph, heading] = kinds[entry.kind] || kinds.output;
            const row = document.createElement('li');
            row.className = 'activity-entry ' + (entry.kind === 'tool' ? 'tool' : '');
            row.append(icon(glyph));
            const body = document.createElement('div');
            const meta = document.createElement('div');
            meta.className = 'entry-meta';
            const title = document.createElement('strong');
            title.textContent = entry.source === 'screen' && entry.kind === 'tool' ? 'Herramienta · detectada' : heading;
            const at = document.createElement('time');
            at.textContent = new Date(entry.at * 1000).toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'});
            meta.append(title, at);
            const paragraph = document.createElement('p');
            paragraph.textContent = entry.text;
            paragraph.title = entry.text;
            body.append(meta, paragraph);
            row.append(body);
            fragment.append(row);
        }
        feed.replaceChildren(fragment);
        feed.scrollTop = follow ? feed.scrollHeight : scroll;
        card.feedSignature = signature;
    }
    feed.hidden = !entries.length;
    refs['activity-empty'].hidden = Boolean(entries.length);
    text(refs['activity-empty'].lastElementChild, agent.kind === 'shell' ? 'Consola lista. Inicia un agente para seguir su actividad aquí.' : 'Los mensajes aparecerán aquí cuando el agente empiece.');
    text(refs['screen-details'].querySelector('pre'), session.preview || 'Todavía no hay salida en esta consola.');
}

function showEmpty(glyph, title, description, action = false) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.append(icon(glyph));
    const heading = document.createElement('h2'); heading.textContent = title;
    const body = document.createElement('p'); body.textContent = description;
    empty.append(heading, body);
    if (action) {
        const button = document.createElement('button'); button.className = 'btn btn-primary'; button.textContent = 'Crear primera sesión';
        button.addEventListener('click', openCreate); empty.append(button);
    }
    $('sessions-list').replaceChildren(empty);
}
function renderSessions() {
    const query = $('session-search').value.trim().toLocaleLowerCase();
    const visible = sessions.filter(session => {
        const matches = selectedFilter === 'all' || (selectedFilter === 'attention' ? Boolean(session.notification) : session.state === selectedFilter);
        return matches && [session.id, session.agent?.name, session.title, session.cwd].join(' ').toLocaleLowerCase().includes(query);
    });
    const sort = $('session-sort').value;
    visible.sort((a, b) => {
        if (sort === 'attention') {
            const priority = s => s.notification?.kind === 'permission' ? 2 : s.notification ? 1 : 0;
            const difference = priority(b) - priority(a);
            if (difference) return difference;
        }
        if (sort === 'agent') return (a.agent?.name || '').localeCompare(b.agent?.name || '') || a.id.localeCompare(b.id);
        return b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
    });
    text($('list-summary'), `${visible.length} ${visible.length === 1 ? 'sesión' : 'sesiones'}${query || selectedFilter !== 'all' ? ` de ${sessions.length}` : ' en tu espacio'}`);
    const ids = new Set(sessions.map(session => session.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.remove(); cards.delete(id); }
    if (!visible.length) {
        if (sessions.length) showEmpty('filter_list', 'No hay sesiones en esta vista', 'Prueba otra búsqueda o selecciona Todas para ver tu espacio completo.');
        else showEmpty('terminal', 'Dale un espacio a tu próximo agente', 'Inicia Codex, OpenCode o Hermes. Su actividad y sus avisos aparecerán aquí.', true);
        return;
    }
    $('sessions-list').querySelector('.empty-state')?.remove();
    const shown = new Set(visible.map(session => session.id));
    for (const [id, card] of cards) if (!shown.has(id)) card.remove();
    visible.forEach((session, index) => {
        let card = cards.get(session.id);
        if (!card) { card = createCard(session); cards.set(session.id, card); }
        updateCard(card, session);
        const current = $('sessions-list').children[index];
        if (current !== card) $('sessions-list').insertBefore(card, current || null);
    });
}
function setFilter(filter) {
    selectedFilter = filter;
    for (const button of document.querySelectorAll('[data-filter]')) {
        const selected = button.dataset.filter === filter;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
    }
    renderSessions();
}
function openCreate() {
    $('create-error').hidden = true;
    $('create-dialog').showModal();
}
async function createSession(event) {
    event.preventDefault();
    $('submit-create').disabled = true;
    $('create-error').hidden = true;
    const payload = Object.fromEntries(new FormData($('create-form')));
    // Reserve a tab during the user gesture to avoid blocked async popups.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
        const data = await api('/api/sessions', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
        $('create-dialog').close();
        $('create-form').reset();
        if (tab) tab.location.href = data.url;
        else window.location.assign(data.url);
        showToast('Sesión creada');
        await refreshSessions();
    } catch (error) {
        tab?.close();
        $('create-error').hidden = false;
        $('create-error').textContent = error.message;
    } finally { $('submit-create').disabled = false; }
}
async function deleteSession(session) {
    if (!confirm(`Eliminar la sesión ${session.id} y detener todos sus procesos? Esta acción no se puede deshacer.`)) return;
    try {
        await api(`/api/sessions/${encodeURIComponent(session.id)}`, {method: 'DELETE'});
        showToast('Sesión eliminada');
        await refreshSessions();
    } catch (error) { showToast(error.message); }
}
async function copySessionLink(token) {
    try { await navigator.clipboard.writeText(`${window.location.origin}/c/${encodeURIComponent(token)}`); showToast('Enlace copiado'); }
    catch (_) { showToast('No se pudo copiar el enlace. Abre la consola y copia su dirección.'); }
}
function showToast(message) {
    const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = message;
    $('toast-container').append(toast);
    setTimeout(() => toast.remove(), 5000);
}
async function refreshUptime() {
    try {
        const data = await api('/health');
        serverUptimeSeconds = Math.max(0, Number(data.uptime_seconds) || 0);
        uptimeSyncedAt = performance.now();
    } catch (_) {}
}
function updateUptime() {
    const seconds = serverUptimeSeconds + Math.floor((performance.now() - uptimeSyncedAt) / 1000);
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60);
    text($('uptime'), `${h} h ${m} min`);
}
document.addEventListener('DOMContentLoaded', () => {
    $('new-session').addEventListener('click', openCreate);
    $('refresh').addEventListener('click', refreshSessions);
    $('create-form').addEventListener('submit', createSession);
    $('close-dialog').addEventListener('click', () => $('create-dialog').close());
    $('cancel-create').addEventListener('click', () => $('create-dialog').close());
    $('session-search').addEventListener('input', renderSessions);
    $('session-sort').addEventListener('change', renderSessions);
    $('view-attention').addEventListener('click', () => setFilter('attention'));
    for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => setFilter(button.dataset.filter));
    refreshSessions();
    refreshUptime();
    setInterval(() => { if (!document.hidden) refreshUptime(); }, 60000);
    setInterval(updateUptime, 1000);
    document.addEventListener('visibilitychange', () => {
        clearTimeout(refreshTimer);
        if (!document.hidden) refreshSessions();
    });
    window.addEventListener('online', refreshSessions);
});
