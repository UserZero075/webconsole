// Project workspace: project/worktree navigation, persistent terminal tabs and bounded file editing.
const $ = id => document.getElementById(id);
const apiResponseCache = new Map();
const state = {
    projects: [], sessions: [], workspaceData: null, selectedProjectId: null,
    selectedWorkspaceId: null, selectedSessionId: null, tabs: [], activeTabId: null,
    expandedProjects: new Set(), expandedWorkspaces: new Set(), directoryCache: new Map(),
    fileGeneration: 0, frameSessionId: null, pendingAction: null, actionTimer: null,
    pollTimer: null, busy: false, messages: [], shellFrameSessionId: null,
    terminalPrefsWorkspaceId: null, terminalExpanded: false, terminalHeight: 230, terminalAppliedHeight: 230,
    pendingAttachments: [],
    handoff: null,
    contextMenuTrigger: null, confirmResolver: null, renameProjectId: null, mobileDrawerTrigger: null,
    terminalFrameReady: false, terminalLoadTimer: null,
};
const launcherNames = {opencode: 'OpenCode', codex: 'Codex', hermes: 'Hermes', terminal: 'Terminal'};
let currentEditorView = null;
let currentEditorTabId = null;
let currentMergeView = null;
let currentMergeTabId = null;
let navigationHistory = null;
let navigationTimer = null;
let restoringNavigation = false;
let markdownTimer = null;
const editorBundlePromises = new Map();
const terminalFrameResizeTimers = new WeakMap();

function ensureEditorBundle(name) {
    const globalName = name === 'markdown' ? 'WebConsoleMarkdown' : name === 'merge' ? 'WebConsoleMerge' : null;
    if (!globalName) return Promise.reject(new Error('Bundle del editor no reconocido.'));
    if (window[globalName]) return Promise.resolve();
    if (editorBundlePromises.has(name)) return editorBundlePromises.get(name);
    const url = $('editor-view')?.dataset[`${name}Src`];
    if (!url) return Promise.reject(new Error('No se encontró el recurso local del editor.'));
    const script = document.createElement('script');
    script.src = url;
    const pending = new Promise((resolve, reject) => {
        script.onload = () => window[globalName] ? resolve() : reject(new Error('El recurso local no inicializó.'));
        script.onerror = () => reject(new Error('No se pudo cargar el recurso local del editor.'));
    }).catch(error => {
        editorBundlePromises.delete(name);
        script.remove();
        throw error;
    });
    editorBundlePromises.set(name, pending);
    document.head.append(script);
    return pending;
}

async function api(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const cached = method === 'GET' ? apiResponseCache.get(url) : null;
    const headers = {'X-WebConsole': '1', ...options.headers};
    if (cached?.etag && !headers['If-None-Match']) headers['If-None-Match'] = cached.etag;
    const response = await fetch(url, {...options, headers});
    if (response.status === 304 && cached) {
        const observedAt = Number(response.headers.get('X-WebConsole-Observed-At'));
        if (Number.isFinite(observedAt) && Array.isArray(cached.data.sessions)) {
            cached.data.observed_at = observedAt;
            cached.data.sessions = cached.data.sessions.map(item => ({...item, observed_at:observedAt}));
        }
        return cached.data;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `La petición falló (${response.status}).`);
        error.status = response.status;
        error.data = data;
        throw error;
    }
    if (method === 'GET') {
        const etag = response.headers.get('ETag');
        if (etag) apiResponseCache.set(url, {etag, data});
        else apiResponseCache.delete(url);
    } else {
        // Mutations can affect more than one cached collection; refresh them
        // from the next response rather than trying to guess dependencies.
        apiResponseCache.clear();
    }
    return data;
}
function jsonOptions(method, body) {
    return {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)};
}
function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
}
function toast(message) {
    const item = node('div', 'toast', message);
    $('toast-stack').append(item);
    setTimeout(() => item.remove(), 4500);
}
function setStatus(message, led = '') {
    $('workspace-status').textContent = message;
    $('workspace-led').className = `status-led ${led}`;
}
function selectedProject() {
    return state.projects.find(item => item.id === state.selectedProjectId) || null;
}
function selectedWorkspace() {
    return state.workspaceData?.workspaces.find(item => item.id === state.selectedWorkspaceId) || null;
}
function activeTab() {
    return state.tabs.find(item => item.id === state.activeTabId) || null;
}
function sessionFor(id) {
    return state.sessions.find(item => item.id === id) || null;
}
function isWorkspaceShell(session) {
    return session?.session_role === 'workspace_shell';
}
function hasWorkspaceTerminalUI() {
    return ['workspace-terminal', 'terminal-drawer-toggle', 'terminal-drawer-content', 'terminal-resize',
        'terminal-state', 'terminal-context', 'shell-frame', 'shell-interrupt', 'shell-start', 'shell-new',
        'terminal-ended']
        .every(id => Boolean($(id)));
}
function sessionEnded(session) {
    return !session || session.ended === true || session.state === 'ended' || session.is_active === false;
}
function currentAgentSession() {
    const tab = activeTab();
    if (tab?.type !== 'terminal') return null;
    const session = sessionFor(tab.sessionId) || tab.session;
    return isWorkspaceShell(session) ? null : session;
}
function workspaceShellSession(workspaceId = selectedWorkspace()?.id) {
    return state.sessions.filter(item => isWorkspaceShell(item) && item.workspace_id === workspaceId)
        .sort((a, b) => sessionCreatedAt(b) - sessionCreatedAt(a))[0] || null;
}
function sessionCreatedAt(session) {
    if (typeof session?.created_at === 'number') return session.created_at * 1000;
    const parsed = Date.parse(session?.created_at || '');
    return Number.isFinite(parsed) ? parsed : 0;
}
function detectedAgent(session) {
    return session?.agent?.key || session?.launcher || 'terminal';
}
function agentName(session) {
    return session?.agent?.name || launcherNames[session?.launcher] || 'Terminal';
}
function stateLabel(session) {
    if (!session) return 'Desconectado';
    if (session.state === 'permission' || session.notification?.kind === 'permission') return 'Necesita permiso';
    if (session.state === 'working') return 'Trabajando';
    if (session.state === 'ended' || session.is_active === false) return 'Finalizada';
    return 'En espera';
}
function projectWorkspace(projectId, workspaceId) {
    if (state.workspaceData?.project?.id === projectId) {
        return state.workspaceData.workspaces.find(item => item.id === workspaceId) || null;
    }
    return null;
}

async function refreshAll() {
    if (state.busy) return;
    state.busy = true;
    try {
        const [projectData, sessionData] = await Promise.all([
            api('/api/projects'), api('/api/sessions'),
        ]);
        state.projects = projectData.projects || [];
        state.sessions = sessionData.sessions || [];
        if (!state.projects.some(item => item.id === state.selectedProjectId)) {
            state.selectedProjectId = state.projects[0]?.id || null;
            state.workspaceData = null;
            state.selectedWorkspaceId = null;
            if (state.activeTabId) {
                const tab = activeTab();
                const tabProjectId = tab?.type === 'terminal' ? (sessionFor(tab.sessionId) || tab.session)?.project_id : tab?.projectId;
                if (!tabProjectId || tabProjectId !== state.selectedProjectId) state.activeTabId = null;
            }
            if (state.selectedProjectId) state.expandedProjects.add(state.selectedProjectId);
        }
        renderTree();
        if (state.selectedProjectId && !state.workspaceData) await loadWorkspaces(state.selectedProjectId);
        else if (state.selectedProjectId) refreshWorkspaceAgentCounts();
        if (!state.projects.length) renderCenter();
        if (state.selectedProjectId) loadMessages(state.selectedProjectId).catch(() => {});
    } catch (error) {
        setStatus('No se pudo actualizar el workspace', 'warning');
        if (!state.projects.length) {
            $('welcome-title').textContent = 'No se pudo cargar el workspace';
            $('welcome-copy').textContent = error.message;
        }
    } finally {
        state.busy = false;
        if (!document.hidden) state.pollTimer = setTimeout(refreshAll, 5000);
    }
}

function refreshWorkspaceAgentCounts() {
    renderTree();
    renderWorkspaceTerminal();
    renderAgentControls();
    const tab = activeTab();
    if (tab?.type === 'terminal') {
        const updated = sessionFor(tab.sessionId);
        if (updated) updateTerminalStatus(updated);
    }
}

async function loadWorkspaces(projectId) {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/workspaces`);
    if (projectId !== state.selectedProjectId) return;
    state.workspaceData = data;
    if (!data.workspaces.some(item => item.id === state.selectedWorkspaceId)) {
        state.selectedWorkspaceId = data.workspaces[0]?.id || null;
    }
    if (state.selectedWorkspaceId) state.expandedWorkspaces.add(state.selectedWorkspaceId);
    state.directoryCache.clear();
    renderTree();
    renderCenter();
    renderWorkspaceChrome();
    await Promise.all([loadDirectory(''), refreshMessagesAndGit()]);
}

async function selectProject(projectId) {
    if (projectId === state.selectedProjectId && state.workspaceData) {
        state.expandedProjects.add(projectId);
        renderTree();
        return;
    }
    state.selectedProjectId = projectId;
    state.workspaceData = null;
    state.selectedWorkspaceId = null;
    const tab = activeTab();
    const tabProjectId = tab?.type === 'terminal' ? (sessionFor(tab.sessionId) || tab.session)?.project_id : tab?.projectId;
    if (tabProjectId !== projectId) {
        state.activeTabId = null;
        state.selectedSessionId = null;
    }
    state.directoryCache.clear();
    state.expandedProjects.add(projectId);
    renderTree();
    renderWorkspaceChrome();
    renderCenter();
    if (window.matchMedia('(max-width:650px)').matches) closeMobileDrawers(true);
    try { await loadWorkspaces(projectId); }
    catch (error) { setStatus(error.message, 'warning'); toast(error.message); }
}

function selectWorkspace(workspaceId) {
    const workspace = state.workspaceData?.workspaces.find(item => item.id === workspaceId);
    if (!workspace) return;
    state.selectedWorkspaceId = workspaceId;
    state.expandedWorkspaces.add(workspaceId);
    const tab = activeTab();
    const associated = tab?.type === 'terminal' ? (sessionFor(tab.sessionId) || tab.session)?.workspace_id : tab?.workspaceId;
    if (associated && associated !== workspaceId) state.activeTabId = null;
    state.directoryCache.clear();
    renderTree();
    renderCenter();
    renderWorkspaceChrome();
    loadDirectory('');
    refreshWorkspaceAgentCounts();
    if (window.matchMedia('(max-width:650px)').matches) closeMobileDrawers(true);
}

function loadTerminalPreference(workspaceId) {
    if (state.terminalPrefsWorkspaceId === workspaceId) return;
    state.terminalPrefsWorkspaceId = workspaceId;
    state.terminalExpanded = false;
    state.terminalHeight = 230;
    if (!workspaceId) return;
    try {
        state.terminalExpanded = localStorage.getItem(`webconsole.terminal.${workspaceId}.open`) === '1';
        const savedHeight = Number(localStorage.getItem(`webconsole.terminal.${workspaceId}.height`));
        if (Number.isFinite(savedHeight) && savedHeight >= 150) state.terminalHeight = Math.max(150, Math.min(420, savedHeight));
    } catch (_) {}
}

function updateMobileDrawerState() {
    const projectsDrawer = window.matchMedia('(max-width:650px)').matches;
    const inspectorDrawer = window.matchMedia('(max-width:1050px)').matches;
    const projects = $('project-sidebar');
    const inspector = $('inspector');
    if (!projects || !inspector) return;

    if (!projectsDrawer) projects.classList.remove('open');
    if (!inspectorDrawer) document.body.classList.remove('inspector-open');
    const projectsOpen = projectsDrawer && projects.classList.contains('open');
    const inspectorOpen = inspectorDrawer && document.body.classList.contains('inspector-open');
    const projectsButton = $('toggle-projects');
    const inspectorButton = $('toggle-inspector');
    projectsButton?.setAttribute('aria-expanded', String(projectsOpen));
    projectsButton?.setAttribute('aria-label', projectsOpen ? 'Ocultar proyectos' : 'Mostrar proyectos');
    inspectorButton?.setAttribute('aria-expanded', String(inspectorOpen));
    inspectorButton?.setAttribute('aria-label', inspectorOpen ? 'Ocultar archivos' : 'Mostrar archivos');
    projects.inert = projectsDrawer && !projectsOpen;
    inspector.inert = inspectorDrawer && !inspectorOpen;
    const backdrop = $('mobile-drawer-backdrop');
    if (backdrop) backdrop.hidden = !(projectsOpen || inspectorOpen);
    if (!projectsOpen && !inspectorOpen) state.mobileDrawerTrigger = null;
}

function setMobileDrawer(name, open, trigger = null) {
    const projectsDrawer = window.matchMedia('(max-width:650px)').matches;
    const inspectorDrawer = window.matchMedia('(max-width:1050px)').matches;
    if ((name === 'projects' && !projectsDrawer) || (name === 'inspector' && !inspectorDrawer)) return;

    const projectPanel = $('project-sidebar');
    const inspectorPanel = $('inspector');
    if (open) {
        if (name === 'projects') {
            document.body.classList.remove('inspector-open');
            inspectorPanel?.classList.remove('open');
            projectPanel?.classList.add('open');
        } else {
            projectPanel?.classList.remove('open');
            document.body.classList.add('inspector-open');
        }
        state.mobileDrawerTrigger = trigger || (name === 'projects' ? $('toggle-projects') : $('toggle-inspector'));
    } else if (name === 'projects') projectPanel?.classList.remove('open');
    else document.body.classList.remove('inspector-open');

    updateMobileDrawerState();
    if (open) (name === 'projects' ? projectPanel : inspectorPanel)?.focus({preventScroll:true});
}

function closeMobileDrawers(restoreFocus = false) {
    $('project-sidebar')?.classList.remove('open');
    document.body.classList.remove('inspector-open');
    const trigger = state.mobileDrawerTrigger;
    state.mobileDrawerTrigger = null;
    updateMobileDrawerState();
    if (restoreFocus && trigger?.isConnected) trigger.focus({preventScroll:true});
}

function requestTerminalFrameResize(frame, delay = 50) {
    if (!frame?.contentWindow || frame.hidden || document.hidden) return;
    clearTimeout(terminalFrameResizeTimers.get(frame));
    const timer = setTimeout(() => {
        terminalFrameResizeTimers.delete(frame);
        if (!frame.hidden && !document.hidden && frame.contentWindow) {
            frame.contentWindow.postMessage({type:'webconsole:resize'}, window.location.origin);
        }
    }, delay);
    terminalFrameResizeTimers.set(frame, timer);
}

function setTerminalHeight(value, persist = false) {
    const mobile = window.matchMedia('(max-width: 650px)').matches;
    const minimum = mobile ? 145 : 150;
    const viewportHeight = window.WebConsoleMobileViewport?.height() || window.innerHeight;
    const maximum = Math.max(minimum, Math.min(mobile ? 300 : 420, Math.floor(viewportHeight * (mobile ? 0.4 : 0.55))));
    const appliedHeight = Math.max(minimum, Math.min(maximum, Math.round(value)));
    state.terminalAppliedHeight = appliedHeight;
    if (persist) state.terminalHeight = appliedHeight;
    const drawer = $('workspace-terminal');
    drawer.style.height = `${appliedHeight}px`;
    drawer.style.flexBasis = `${appliedHeight}px`;
    $('terminal-resize').setAttribute('aria-valuenow', String(appliedHeight));
    $('terminal-resize').setAttribute('aria-valuemax', String(maximum));
    if (persist && state.terminalPrefsWorkspaceId) {
        try { localStorage.setItem(`webconsole.terminal.${state.terminalPrefsWorkspaceId}.height`, String(state.terminalHeight)); } catch (_) {}
    }
}

function renderWorkspaceTerminal() {
    // The service/browser can briefly serve an older cached workspace template.
    // Keep the existing workspace usable until its matching markup is loaded.
    if (!hasWorkspaceTerminalUI()) return;
    const workspace = selectedWorkspace();
    loadTerminalPreference(workspace?.id || null);
    const drawer = $('workspace-terminal');
    const toggle = $('terminal-drawer-toggle');
    const content = $('terminal-drawer-content');
    const frame = $('shell-frame');
    toggle.disabled = !workspace;
    toggle.setAttribute('aria-expanded', String(Boolean(workspace && state.terminalExpanded)));
    toggle.setAttribute('aria-label', state.terminalExpanded ? 'Plegar terminal del workspace' : 'Abrir terminal del workspace');
    drawer.classList.toggle('expanded', Boolean(workspace && state.terminalExpanded));
    content.hidden = !(workspace && state.terminalExpanded);
    if (workspace && state.terminalExpanded) setTerminalHeight(state.terminalHeight);
    else { drawer.style.height = ''; drawer.style.flexBasis = ''; }
    $('terminal-context').textContent = workspace ? `${workspace.name} · ${workspace.path}` : 'Shell independiente del workspace';
    const shell = workspace ? workspaceShellSession(workspace.id) : null;
    const ended = Boolean(shell && sessionEnded(shell));
    $('terminal-state').textContent = !workspace ? 'Sin workspace' : !state.terminalExpanded ? 'Plegada' : !shell ? 'Sin iniciar' : ended ? 'Finalizada' : 'Persistente';
    $('shell-interrupt').disabled = !shell || ended;
    $('shell-start').hidden = !workspace || !state.terminalExpanded || Boolean(shell);
    $('shell-new').hidden = !ended;
    $('terminal-ended').hidden = !ended;
    if (!workspace || !state.terminalExpanded || !shell?.token) {
        frame.hidden = true;
        if (state.shellFrameSessionId) {
            state.shellFrameSessionId = null;
            frame.src = 'about:blank';
        }
        return;
    }
    frame.hidden = false;
    if (state.shellFrameSessionId !== shell.id) {
        state.shellFrameSessionId = shell.id;
        frame.src = `/c/${encodeURIComponent(shell.token)}?embed=1`;
    }
}

function renderAgentControls() {
    const session = currentAgentSession();
    const unavailable = !session || sessionEnded(session);
    const interrupt = $('interrupt-agent');
    if (interrupt) interrupt.disabled = unavailable;
    const safeForInsertion = Boolean(session && !sessionEnded(session) && session.state !== 'permission' && session.notification?.kind !== 'permission');
    const attach = $('workspace-attach');
    if (attach) attach.disabled = !safeForInsertion;
    renderAttachmentTray();
    const frameSessionId = state.frameSessionId;
    const frame = $('terminal-frame');
    if (frameSessionId && frame?.contentWindow) {
        const sessionOwnsFrame = session?.id === frameSessionId;
        frame.contentWindow.postMessage({
            type: 'webconsole:session-state', session_id: frameSessionId,
            input_allowed: Boolean(sessionOwnsFrame && safeForInsertion),
            state: sessionOwnsFrame ? session.state || 'idle' : 'inactive',
        }, window.location.origin);
    }
}

async function ensureWorkspaceTerminal(createNew = false) {
    const workspace = selectedWorkspace();
    if (!workspace) return;
    const workspaceId = workspace.id;
    $('shell-start').disabled = true;
    $('shell-new').disabled = true;
    try {
        const result = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal`, jsonOptions('POST', {new:createNew}));
        const session = result.session;
        if (!session) throw new Error('El servidor no devolvió la terminal del workspace.');
        session.state = session.ended ? 'ended' : 'idle';
        session.is_active = !session.ended;
        const index = state.sessions.findIndex(item => item.id === session.id);
        if (index >= 0) state.sessions[index] = {...state.sessions[index], ...session};
        else state.sessions.push(session);
        if (state.selectedWorkspaceId === workspaceId) {
            renderTree(); renderWorkspaceTerminal();
            if (session.ended) toast('La terminal terminó. Pulsa «Nueva terminal» para crear otra.');
        }
    } catch (error) {
        if (state.selectedWorkspaceId === workspaceId) toast(error.message);
    } finally {
        $('shell-start').disabled = false;
        $('shell-new').disabled = false;
    }
}

function setTerminalExpanded(expanded, createIfMissing = true) {
    if (!selectedWorkspace()) return;
    state.terminalExpanded = expanded;
    try { localStorage.setItem(`webconsole.terminal.${state.selectedWorkspaceId}.open`, expanded ? '1' : '0'); } catch (_) {}
    renderWorkspaceTerminal();
    if (expanded) {
        const shell = workspaceShellSession();
        if (!shell && createIfMissing) ensureWorkspaceTerminal(false);
        requestTerminalFrameResize($('shell-frame'));
        requestTerminalFrameResize($('terminal-frame'));
    }
}

function renderAttachmentTray() {
    const tray = $('attachment-tray');
    if (!tray) return;
    const session = currentAgentSession();
    const attachments = state.pendingAttachments.filter(item => item.session_id === session?.id);
    tray.hidden = !attachments.length;
    tray.replaceChildren();
    for (const attachment of attachments) {
        const chip = node('div', 'attachment-chip');
        const name = node('span', '', attachment.name || 'Adjunto');
        name.title = attachment.path || '';
        const size = node('small', '', attachment.inserted ? 'Insertado' : attachment.inserting ? 'Insertando…' : 'Listo');
        const insert = node('button', 'terminal-action', 'Insertar');
        insert.type = 'button'; insert.hidden = attachment.inserted;
        insert.disabled = attachment.inserting || !session || sessionEnded(session) || session.state === 'permission';
        insert.addEventListener('click', () => insertAttachment(attachment));
        const remove = node('button', 'terminal-action', '×');
        remove.type = 'button'; remove.title = 'Quitar de la lista'; remove.setAttribute('aria-label', `Quitar ${attachment.name || 'adjunto'} de la lista`);
        remove.addEventListener('click', () => {
            state.pendingAttachments = state.pendingAttachments.filter(item => item.id !== attachment.id);
            renderAttachmentTray();
        });
        chip.append(name, size, insert, remove);
        tray.append(chip);
    }
}

function canInsertForSession(sessionId) {
    const session = currentAgentSession();
    return Boolean(session && session.id === sessionId && !sessionEnded(session)
        && session.state !== 'permission' && session.notification?.kind !== 'permission'
        && state.frameSessionId === sessionId && $('terminal-frame').contentWindow);
}

function insertAttachment(attachment) {
    if (!canInsertForSession(attachment.session_id)) {
        toast('Vuelve a la pestaña de esa sesión cuando esté lista para insertar la referencia.');
        return;
    }
    attachment.inserting = true;
    renderAttachmentTray();
    $('terminal-frame').contentWindow.postMessage({
        type: 'webconsole:insert-attachment', session_id: attachment.session_id, attachment_id: attachment.id,
    }, window.location.origin);
}

function uploadPickedAttachments(files) {
    const session = currentAgentSession();
    if (!session || sessionEnded(session) || session.state === 'permission') {
        toast('Selecciona una sesión de agente que esté lista para recibir entrada.');
        return;
    }
    const frame = $('terminal-frame');
    if (state.frameSessionId !== session.id || !frame?.contentWindow) {
        toast('Abre la pestaña del agente para ver el progreso de la subida.');
        return;
    }
    frame.contentWindow.postMessage({
        type:'webconsole:upload-attachments', session_id:session.id, files:[...files],
    }, window.location.origin);
    const picker = $('attachment-picker');
    if (picker) picker.value = '';
}

function bindContextMenu(row, keyboardTarget, type, item) {
    keyboardTarget.setAttribute('aria-haspopup', 'menu');
    keyboardTarget.setAttribute('aria-expanded', 'false');
    row.addEventListener('contextmenu', event => openContextMenu(type, item, event));
    keyboardTarget.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && event.key !== 'Menu' && !(event.shiftKey && event.key === 'F10')) return;
        openContextMenu(type, item, event);
    });
}

function closeContextMenu(restoreFocus = false) {
    const menu = $('context-menu');
    if (!menu) return;
    menu.hidden = true;
    menu.replaceChildren();
    menu.style.left = '';
    menu.style.top = '';
    const trigger = state.contextMenuTrigger;
    state.contextMenuTrigger = null;
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function filesWithUnsavedChanges(predicate) {
    return state.tabs.some(tab => tab.type === 'file' && tab.dirty && predicate(tab));
}

function menuEntry(label, run, options = {}) {
    return {label, run, ...options};
}

function contextMenuEntries(type, item) {
    if (type === 'project') {
        const dirty = filesWithUnsavedChanges(tab => tab.projectId === item.id);
        const hasSessions = state.sessions.some(session => session.project_id === item.id) || item.session_count > 0;
        const loadedWorktrees = state.workspaceData?.project?.id === item.id
            ? state.workspaceData.workspaces.filter(workspace => workspace.kind === 'managed_worktree').length : 0;
        const hasManagedWorktrees = Math.max(item.managed_worktree_count || 0, loadedWorktrees) > 0;
        const blocked = hasSessions
            ? 'Elimina explícitamente las sesiones asociadas antes de quitar el proyecto.'
            : hasManagedWorktrees
                ? 'Retira explícitamente los worktrees administrados antes de quitar el proyecto.'
                : dirty ? 'Guarda o cierra los archivos con cambios sin guardar.' : '';
        return [
            menuEntry('Abrir proyecto', () => selectProject(item.id)),
            menuEntry('Crear agente', async () => { await selectProject(item.id); openAgentDialog(); }),
            menuEntry('Crear worktree', async () => { await selectProject(item.id); openWorktreeDialog(); }),
            {separator:true},
            menuEntry('Renombrar proyecto', () => openRenameProject(item)),
            menuEntry('Quitar de WebConsole', () => removeProject(item), {
                destructive:true, disabled:Boolean(blocked), description:blocked || 'Conserva intactos la carpeta y los archivos.',
            }),
        ];
    }
    if (type === 'workspace') {
        const dirty = filesWithUnsavedChanges(tab => tab.workspaceId === item.id);
        const removeReason = item.kind === 'primary'
            ? 'El workspace principal se conserva mientras el proyecto esté registrado.'
            : item.kind !== 'managed_worktree'
                ? 'Los worktrees existentes se detectan automáticamente y no se pueden desvincular aquí.'
                : item.session_count > 0
                    ? 'Elimina explícitamente las sesiones asociadas antes de retirarlo.'
                    : !item.available ? 'La carpeta del worktree ya no está disponible.'
                        : dirty ? 'Guarda o cierra los archivos con cambios sin guardar.'
                            : item.git?.changes?.length ? 'Este worktree tiene cambios Git; consérvalos o límpialos antes de retirarlo.' : '';
        return [
            menuEntry('Seleccionar workspace', () => selectWorkspace(item.id)),
            menuEntry('Crear agente', () => { selectWorkspace(item.id); openAgentDialog(); }),
            menuEntry('Abrir terminal', () => { selectWorkspace(item.id); setTerminalExpanded(true); }),
            menuEntry('Crear worktree', () => { selectWorkspace(item.id); openWorktreeDialog(); }, {
                disabled:!item.git?.is_git,
                description:!item.git?.is_git ? 'Este workspace no pertenece a un repositorio Git.' : '',
            }),
            {separator:true},
            menuEntry('Retirar workspace', () => removeWorkspace(item), {
                destructive:true, disabled:Boolean(removeReason),
                description:removeReason || 'Borra solo el worktree limpio; conserva la rama Git.',
            }),
        ];
    }
    const session = item;
    const active = !sessionEnded(session);
    const handoffSupported = session.launcher === 'opencode' && session.session_role !== 'workspace_shell'
        && Boolean(session.project_id && session.workspace_id);
    return [
        menuEntry('Abrir sesión', () => openTerminal(session)),
        menuEntry('Cambiar de agente…', () => openHandoffDialog(session), {
            disabled:!handoffSupported,
            description:handoffSupported ? 'Preparar el contexto de OpenCode para Codex.' : 'Primer traspaso disponible: OpenCode → Codex en un workspace registrado.',
        }),
        menuEntry('Acciones de agente', () => openActions(session), {disabled:!active}),
        menuEntry('Interrumpir agente', () => dispatchAgentAction(session, {id:'interrupt'}), {disabled:!active}),
        {separator:true},
        menuEntry('Eliminar sesión', () => removeSession(session), {
            destructive:true,
            description:active ? 'Termina el proceso tmux de esta sesión.' : 'Quita el registro de la sesión finalizada.',
        }),
    ];
}

function openContextMenu(type, item, event) {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu(false);
    const menu = $('context-menu');
    const keyboard = event.type === 'keydown';
    const trigger = keyboard ? event.currentTarget : event.currentTarget.matches?.('button')
        ? event.currentTarget : event.target.closest?.('button');
    state.contextMenuTrigger = trigger || null;
    trigger?.setAttribute('aria-expanded', 'true');
    menu.replaceChildren();
    for (const entry of contextMenuEntries(type, item)) {
        if (entry.separator) {
            const divider = node('hr', 'context-menu-separator'); divider.setAttribute('role', 'separator');
            menu.append(divider);
            continue;
        }
        const button = node('button', `context-menu-item${entry.destructive ? ' danger' : ''}`);
        button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = Boolean(entry.disabled);
        button.append(node('span', '', entry.label));
        if (entry.description) button.append(node('small', '', entry.description));
        button.addEventListener('click', async () => {
            closeContextMenu(true);
            try { await entry.run(); }
            catch (error) { toast(error.message); }
        });
        menu.append(button);
    }
    menu.hidden = false;
    const rect = trigger?.getBoundingClientRect();
    const x = !keyboard && Number.isFinite(event.clientX) && event.clientX ? event.clientX : rect?.left || 8;
    const y = !keyboard && Number.isFinite(event.clientY) && event.clientY ? event.clientY : rect?.bottom || 8;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    menu.querySelector('.context-menu-item:not(:disabled)')?.focus();
}

function handleContextMenuKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault(); closeContextMenu(true); return;
    }
    const items = [...$('context-menu').querySelectorAll('.context-menu-item:not(:disabled)')];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0].focus(); }
    else if (event.key === 'End') { event.preventDefault(); items.at(-1).focus(); }
    else if (event.key === 'Tab') closeContextMenu(false);
}

function confirmDangerousAction({title, copy, confirmLabel = 'Eliminar'}) {
    const dialog = $('confirm-dialog');
    if (!dialog || dialog.open) return Promise.resolve(false);
    $('confirm-title').textContent = title;
    $('confirm-copy').textContent = copy;
    $('confirm-accept').textContent = confirmLabel;
    return new Promise(resolve => {
        state.confirmResolver = resolve;
        dialog.returnValue = '';
        dialog.showModal();
        $('confirm-accept').focus();
    });
}

async function removeSession(session) {
    const active = !sessionEnded(session);
    if (!await confirmDangerousAction({
        title:active ? '¿Eliminar esta sesión?' : '¿Quitar esta sesión finalizada?',
        copy:active ? `Se detendrá el proceso tmux de «${session.title || agentName(session)}». Esta acción no se puede deshacer.`
            : `Se quitará el registro de «${session.title || agentName(session)}». No se reiniciará.`,
        confirmLabel:active ? 'Terminar y eliminar' : 'Eliminar registro',
    })) return;
    try {
        await api(`/api/sessions/${encodeURIComponent(session.id)}`, {method:'DELETE'});
        state.sessions = state.sessions.filter(item => item.id !== session.id);
        const project = state.projects.find(item => item.id === session.project_id);
        if (project) project.session_count = Math.max(0, (project.session_count || 0) - 1);
        state.tabs = state.tabs.filter(tab => tab.type !== 'terminal' || tab.sessionId !== session.id);
        state.pendingAttachments = state.pendingAttachments.filter(item => item.session_id !== session.id);
        if (state.activeTabId === `terminal:${session.id}`) state.activeTabId = null;
        if (state.selectedSessionId === session.id) state.selectedSessionId = null;
        if (state.frameSessionId === session.id) {
            state.frameSessionId = null;
            const frame = $('terminal-frame');
            if (frame) frame.src = 'about:blank';
        }
        renderTree(); renderTabs(); renderCenter(); renderWorkspaceChrome();
        toast(active ? 'Sesión terminada y eliminada.' : 'Registro de la sesión eliminado.');
        refreshAll();
    } catch (error) { toast(error.message); refreshAll(); }
}

async function removeProject(project) {
    if (filesWithUnsavedChanges(tab => tab.projectId === project.id)) {
        toast('Guarda o cierra los archivos con cambios sin guardar antes de quitar el proyecto.');
        return;
    }
    if (!await confirmDangerousAction({
        title:'¿Quitar este proyecto?',
        copy:`«${project.name}» dejará de aparecer en WebConsole. Su carpeta, repositorio y archivos no se borrarán.`,
        confirmLabel:'Quitar proyecto',
    })) return;
    try {
        await api(`/api/projects/${encodeURIComponent(project.id)}`, {method:'DELETE'});
        const removedTabs = state.tabs.filter(tab => tab.projectId === project.id ||
            (tab.type === 'terminal' && (sessionFor(tab.sessionId) || tab.session)?.project_id === project.id));
        state.tabs = state.tabs.filter(tab => !removedTabs.includes(tab));
        const activeWasRemoved = removedTabs.some(tab => tab.id === state.activeTabId);
        if (activeWasRemoved) { state.activeTabId = null; state.selectedSessionId = null; }
        state.projects = state.projects.filter(item => item.id !== project.id);
        state.expandedProjects.delete(project.id);
        if (state.selectedProjectId === project.id) {
            state.selectedProjectId = state.projects[0]?.id || null;
            state.workspaceData = null; state.selectedWorkspaceId = null;
        }
        state.directoryCache.clear();
        renderTree(); renderTabs(); renderCenter(); renderWorkspaceChrome();
        if (state.selectedProjectId) await loadWorkspaces(state.selectedProjectId);
        else { renderWorkspaceChrome(); renderCenter(); }
        toast('Proyecto quitado de WebConsole; sus archivos siguen intactos.');
    } catch (error) { toast(error.message); }
}

async function removeWorkspace(workspace) {
    if (filesWithUnsavedChanges(tab => tab.workspaceId === workspace.id)) {
        toast('Guarda o cierra los archivos con cambios sin guardar antes de retirar el workspace.');
        return;
    }
    const project = state.projects.find(item => item.id === workspace.project_id) || selectedProject();
    if (!project || state.workspaceData?.project?.id !== project.id
            || !state.workspaceData.workspaces.some(item => item.id === workspace.id)) {
        toast('Actualiza el proyecto antes de retirar este workspace.');
        return;
    }
    if (!await confirmDangerousAction({
        title:'¿Retirar este worktree?',
        copy:`Se retirará el worktree limpio «${workspace.name}» en ${workspace.worktree_root}. Se conserva su rama Git. No se puede deshacer.`,
        confirmLabel:'Retirar worktree',
    })) return;
    const projectId = project.id;
    const active = activeTab();
    const activeWorkspaceId = active?.type === 'terminal'
        ? (sessionFor(active.sessionId) || active.session)?.workspace_id : active?.workspaceId;
    try {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {method:'DELETE'});
        const projectRecord = state.projects.find(item => item.id === projectId);
        if (projectRecord) {
            projectRecord.workspace_count = Math.max(0, (projectRecord.workspace_count || 0) - 1);
            projectRecord.managed_worktree_count = Math.max(0, (projectRecord.managed_worktree_count || 0) - 1);
        }
        const removedTabs = state.tabs.filter(tab => tab.type === 'file' && tab.workspaceId === workspace.id
            || tab.type === 'terminal' && (sessionFor(tab.sessionId) || tab.session)?.workspace_id === workspace.id);
        state.tabs = state.tabs.filter(tab => !removedTabs.includes(tab));
        if (removedTabs.some(tab => tab.id === state.activeTabId)) {
            state.activeTabId = null; state.selectedSessionId = null;
        }
        state.directoryCache.clear();
        state.workspaceData = null;
        state.selectedWorkspaceId = activeWorkspaceId && activeWorkspaceId !== workspace.id ? activeWorkspaceId : null;
        state.terminalPrefsWorkspaceId = null;
        await loadWorkspaces(projectId);
        toast('Worktree retirado; su rama Git se conservó.');
    } catch (error) { toast(error.message); }
}

function openRenameProject(project) {
    state.renameProjectId = project.id;
    $('rename-project-name').value = project.name;
    $('rename-project-error').hidden = true;
    $('rename-project-dialog').showModal();
    $('rename-project-name').focus(); $('rename-project-name').select();
}

async function renameProject(event) {
    event.preventDefault();
    const projectId = state.renameProjectId;
    const name = $('rename-project-name').value.trim();
    const button = $('save-project-name'); button.disabled = true;
    $('rename-project-error').hidden = true;
    try {
        const data = await api(`/api/projects/${encodeURIComponent(projectId)}`, jsonOptions('PATCH', {name}));
        state.projects = state.projects.map(item => item.id === projectId ? {...item, ...data.project} : item);
        if (state.workspaceData?.project?.id === projectId) state.workspaceData.project.name = data.project.name;
        $('rename-project-dialog').close();
        renderTree(); renderWorkspaceChrome();
        toast('Nombre del proyecto actualizado.');
    } catch (error) {
        $('rename-project-error').hidden = false; $('rename-project-error').textContent = error.message;
    } finally { button.disabled = false; }
}

function renderTree() {
    closeContextMenu(false);
    const host = $('project-tree');
    const query = $('project-search').value.trim().toLocaleLowerCase();
    const agentSessions = state.sessions.filter(session => !isWorkspaceShell(session));
    const fragment = document.createDocumentFragment();
    const visibleProjects = state.projects.filter(project => {
        const matchingSessions = agentSessions.some(session => session.project_id === project.id &&
            [session.title, session.agent?.name, session.cwd].join(' ').toLocaleLowerCase().includes(query));
        return !query || matchingSessions || `${project.name} ${project.path}`.toLocaleLowerCase().includes(query);
    });
    if (!visibleProjects.length && !query) {
        const empty = node('div', 'sidebar-loading', 'Aún no hay proyectos. Añade una carpeta para empezar.');
        fragment.append(empty);
    }
    for (const project of visibleProjects) {
        const group = node('div', 'project-group');
        const row = node('div', `project-row ${project.id === state.selectedProjectId ? 'selected' : ''}`);
        const toggle = node('button', 'tree-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(state.expandedProjects.has(project.id)));
        const expanded = state.expandedProjects.has(project.id);
        toggle.append(node('span', `tree-chevron ${expanded ? 'open' : ''}`, '›'), node('span', 'project-glyph', '◫'), node('span', 'project-title', project.name));
        const count = agentSessions.filter(session => session.project_id === project.id).length;
        if (count) toggle.append(node('span', 'tree-counter', String(count)));
        toggle.title = project.path;
        toggle.addEventListener('click', () => {
            if (project.id !== state.selectedProjectId) {
                state.expandedProjects.add(project.id);
                selectProject(project.id);
                return;
            }
            state.expandedProjects.has(project.id) ? state.expandedProjects.delete(project.id) : state.expandedProjects.add(project.id);
            renderTree();
        });
        bindContextMenu(row, toggle, 'project', project);
        const quickAdd = node('button', 'tree-add', '+');
        quickAdd.type = 'button'; quickAdd.title = 'Crear agente en este proyecto'; quickAdd.setAttribute('aria-label', `Crear agente en ${project.name}`);
        quickAdd.addEventListener('click', event => { event.stopPropagation(); selectProject(project.id).then(openAgentDialog); });
        const context = node('button', 'tree-context', '⋯');
        context.type = 'button'; context.title = 'Opciones del proyecto'; context.setAttribute('aria-label', `Opciones de ${project.name}`);
        context.setAttribute('aria-haspopup', 'menu'); context.setAttribute('aria-expanded', 'false');
        context.addEventListener('click', event => { event.stopPropagation(); openContextMenu('project', project, event); });
        row.append(toggle, quickAdd, context); group.append(row);
        if (expanded && state.workspaceData?.project?.id === project.id) {
            const list = node('div', 'workspace-list');
            for (const workspace of state.workspaceData.workspaces) {
                const sessions = agentSessions.filter(session => session.workspace_id === workspace.id && session.project_id === project.id);
                const workspaceNode = node('div', 'workspace-node');
                const workspaceRow = node('div', `workspace-row ${workspace.id === state.selectedWorkspaceId ? 'selected' : ''}`);
                const workspaceButton = node('button', 'tree-label'); workspaceButton.type = 'button';
                const isOpen = state.expandedWorkspaces.has(workspace.id);
                workspaceButton.setAttribute('aria-expanded', String(isOpen));
                workspaceButton.append(node('span', `tree-chevron ${isOpen ? 'open' : ''}`, '›'), node('span', 'branch-glyph', '⑂'), node('span', 'project-title', workspace.name || workspace.git?.branch || 'Workspace'));
                const branch = workspace.git?.branch || workspace.branch;
                if (branch) workspaceButton.append(node('span', 'workspace-kind', branch));
                workspaceButton.title = workspace.path;
                workspaceButton.addEventListener('click', () => {
                    if (workspace.id !== state.selectedWorkspaceId) {
                        state.expandedWorkspaces.add(workspace.id);
                        selectWorkspace(workspace.id);
                        return;
                    }
                    state.expandedWorkspaces.has(workspace.id) ? state.expandedWorkspaces.delete(workspace.id) : state.expandedWorkspaces.add(workspace.id);
                    renderTree();
                });
                const workspaceContext = {...workspace, project_id:project.id};
                bindContextMenu(workspaceRow, workspaceButton, 'workspace', workspaceContext);
                workspaceRow.append(workspaceButton);
                const add = node('button', 'tree-add', '+'); add.type = 'button'; add.title = 'Crear agente en este workspace'; add.setAttribute('aria-label', `Crear agente en ${workspace.name}`);
                add.addEventListener('click', event => { event.stopPropagation(); selectWorkspace(workspace.id); openAgentDialog(); });
                const context = node('button', 'tree-context', '⋯');
                context.type = 'button'; context.title = 'Opciones del workspace'; context.setAttribute('aria-label', `Opciones de ${workspace.name}`);
                context.setAttribute('aria-haspopup', 'menu'); context.setAttribute('aria-expanded', 'false');
                context.addEventListener('click', event => { event.stopPropagation(); openContextMenu('workspace', workspaceContext, event); });
                workspaceRow.append(add, context); workspaceNode.append(workspaceRow);
                if (isOpen) {
                    const agents = node('div', 'agent-list');
                    const filtered = sessions.filter(session => !query || `${session.title} ${agentName(session)} ${session.id}`.toLocaleLowerCase().includes(query));
                    if (!filtered.length) agents.append(node('div', 'no-agents', 'Sin agentes en este workspace'));
                    for (const agent of filtered) {
                        const agentRow = node('div', `agent-row ${state.selectedSessionId === agent.id ? 'active' : ''}`);
                        const select = node('button', 'agent-select'); select.type = 'button';
                        const statusClass = agent.state === 'working' ? 'working' : agent.state === 'permission' ? 'permission' : agent.state === 'ended' ? 'ended' : '';
                        select.append(node('span', `agent-state ${statusClass}`), node('span', 'agent-name', agent.title || agentName(agent)));
                        select.title = `${agentName(agent)} · ${stateLabel(agent)} · ${agent.id}`;
                        select.addEventListener('click', () => openTerminal(agent));
                        bindContextMenu(agentRow, select, 'session', agent);
                        const menu = node('button', 'agent-menu', '⋯'); menu.type = 'button'; menu.title = 'Acciones del agente'; menu.setAttribute('aria-label', `Acciones de ${agentName(agent)}`);
                        menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-expanded', 'false');
                        menu.addEventListener('click', event => { event.stopPropagation(); openContextMenu('session', agent, event); });
                        agentRow.append(select, menu); agents.append(agentRow);
                    }
                    workspaceNode.append(agents);
                }
                list.append(workspaceNode);
            }
            group.append(list);
        }
        fragment.append(group);
    }
    const unassigned = agentSessions.filter(session => !session.project_id);
    if (unassigned.length && (!query || 'sesiones sin proyecto'.includes(query))) {
        const group = node('div', 'project-group');
        const row = node('div', 'project-row');
        const toggle = node('div', 'tree-toggle'); toggle.append(node('span', 'tree-chevron open', '›'), node('span', 'project-glyph', '⌁'), node('span', 'project-title', 'Sesiones sin proyecto'));
        row.append(toggle); group.append(row);
        const list = node('div', 'agent-list');
        for (const session of unassigned) {
            const agentRow = node('div', `agent-row ${state.selectedSessionId === session.id ? 'active' : ''}`);
            const select = node('button', 'agent-select'); select.type = 'button';
            select.append(node('span', `agent-state ${session.state === 'working' ? 'working' : ''}`), node('span', 'agent-name', session.title || agentName(session)));
            select.addEventListener('click', () => openTerminal(session));
            bindContextMenu(agentRow, select, 'session', session);
            const menu = node('button', 'agent-menu', '⋯'); menu.type = 'button'; menu.title = 'Opciones de la sesión';
            menu.setAttribute('aria-label', `Opciones de ${agentName(session)}`); menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-expanded', 'false');
            menu.addEventListener('click', event => { event.stopPropagation(); openContextMenu('session', session, event); });
            agentRow.append(select, menu); list.append(agentRow);
        }
        group.append(list); fragment.append(group);
    }
    host.replaceChildren(fragment);
}

function renderWorkspaceChrome() {
    const project = selectedProject();
    const workspace = selectedWorkspace();
    $('top-project').textContent = project?.name || 'Sin proyecto seleccionado';
    $('top-workspace').textContent = workspace ? `${workspace.name}${workspace.git?.branch ? ` · ${workspace.git.branch}` : ''}` : '';
    $('work-title').textContent = workspace?.name || project?.name || 'Workspace';
    $('work-subtitle').textContent = workspace ? `${workspace.path}${workspace.git?.branch ? ` · ${workspace.git.branch}` : ''}` : 'Selecciona un proyecto';
    $('workspace-path').textContent = workspace?.path || '';
    $('add-agent').disabled = !workspace;
    $('new-worktree').disabled = !project || !workspace?.git?.is_git;
    $('branch-picker').disabled = !workspace;
    renderBranchPicker();
    renderGit();
    renderRecipientPicker();
    renderWorkspaceTerminal();
    renderAgentControls();
}

function renderBranchPicker() {
    const select = $('branch-picker');
    const project = selectedProject();
    const workspace = selectedWorkspace();
    const options = [new Option(workspace ? `Workspace · ${workspace.name}` : 'Rama o workspace', '')];
    if (state.workspaceData?.workspaces.length) {
        const group = document.createElement('optgroup'); group.label = 'Workspaces';
        for (const item of state.workspaceData.workspaces) {
            const option = new Option(`${item.git?.branch || item.branch || 'sin rama'} · ${item.name}`, `workspace:${item.id}`);
            if (item.id === workspace?.id) option.selected = true;
            group.append(option);
        }
        options.push(group);
    }
    const branches = workspace?.git?.branches || [];
    if (branches.length) {
        for (const kind of ['local', 'remote']) {
            const groupItems = branches.filter(branch => branch.kind === kind);
            if (!groupItems.length) continue;
            const group = document.createElement('optgroup'); group.label = kind === 'local' ? 'Ramas locales' : 'Ramas remotas conocidas';
            for (const branch of groupItems) {
                const existingWorkspace = state.workspaceData.workspaces.some(item => item.git?.branch === branch.name || item.branch === branch.name);
                if (existingWorkspace) continue;
                const option = new Option(`${branch.name}${branch.ahead_behind ? ` · ${branch.ahead_behind}` : ''}`, `branch:${branch.ref}`);
                option.dataset.kind = branch.kind; option.dataset.name = branch.name;
                group.append(option);
            }
            if (group.children.length) options.push(group);
        }
    }
    select.replaceChildren(...options);
    select.value = '';
    select.disabled = !project || !workspace;
}

function updateTerminalStatus(session) {
    setStatus(`${agentName(session)} · ${stateLabel(session)}`, session.state === 'working' ? 'online' : session.state === 'permission' ? 'warning' : '');
    $('terminal-hint').textContent = `Sesión ${session.id} · tmux persistente`;
    renderAgentControls();
}

function setTerminalFrameStatus(sessionId, status) {
    if (sessionId !== state.frameSessionId) return;
    const loading = $('terminal-loading');
    if (!loading) return;
    const title = $('terminal-loading-title');
    const detail = $('terminal-loading-detail');
    const retry = $('terminal-loading-retry');
    const labels = {
        loading: ['Preparando terminal', 'Cargando la interfaz del agente…'],
        connecting: ['Conectando con el agente', 'La sesión sigue activa mientras se establece la conexión.'],
        reconnecting: ['Reconectando', 'Conservamos la pantalla mientras se recupera la conexión.'],
        resyncing: ['Sincronizando la vista', 'Descartamos solo la salida atrasada de esta vista; la sesión sigue activa.'],
        error: ['Conexión inestable', 'Se volverá a intentar automáticamente.'],
        unavailable: ['Conexión no disponible', 'Revisa el límite de vistas y vuelve a intentarlo.'],
        ended: ['Sesión finalizada', 'El proceso terminó; no se iniciará de nuevo automáticamente.'],
    };
    if (status === 'rendered') {
        state.terminalFrameReady = true;
        clearTimeout(state.terminalLoadTimer);
        state.terminalLoadTimer = null;
        loading.hidden = true;
        loading.setAttribute('aria-busy', 'false');
        return;
    }
    if (status === 'ended' || status === 'unavailable') {
        clearTimeout(state.terminalLoadTimer);
        state.terminalLoadTimer = null;
    }
    if (status === 'error' && state.terminalFrameReady) status = 'reconnecting';
    if ((status === 'reconnecting' || status === 'resyncing') && !state.terminalFrameReady) status = 'connecting';
    if (!labels[status]) return;
    loading.dataset.state = status;
    loading.dataset.hasScreen = String(state.terminalFrameReady);
    title.textContent = labels[status][0];
    detail.textContent = labels[status][1];
    retry.hidden = status !== 'error' && status !== 'unavailable';
    loading.setAttribute('aria-busy', status === 'ended' || status === 'unavailable' ? 'false' : 'true');
    loading.hidden = false;
}

function startTerminalLoadTimer(sessionId) {
    clearTimeout(state.terminalLoadTimer);
    state.terminalLoadTimer = setTimeout(() => {
        if (state.frameSessionId !== sessionId || state.terminalFrameReady || activeTab()?.sessionId !== sessionId) return;
        setTerminalFrameStatus(sessionId, 'error');
        $('terminal-loading-title').textContent = 'La conexión está tardando más de lo normal';
        $('terminal-loading-detail').textContent = 'La sesión no se ha reiniciado. Puedes reintentar la vista.';
    }, 30000);
}

function retryTerminalFrame() {
    const session = sessionFor(state.frameSessionId);
    if (!session?.token) return;
    const frame = $('terminal-frame');
    state.terminalFrameReady = false;
    setTerminalFrameStatus(session.id, 'loading');
    startTerminalLoadTimer(session.id);
    // Reload only the disposable browser attachment; tmux continues running.
    frame.src = `/c/${encodeURIComponent(session.token)}?embed=1&retry=${Date.now()}`;
}

function renderCenter() {
    renderAgentControls();
    const tab = activeTab();
    const frame = $('terminal-frame');
    const editor = $('editor-view');
    const welcome = $('welcome-view');
    if (!tab) {
        disposeEditorView(); disposeMergeView();
        $('terminal-loading').hidden = true;
        frame.hidden = true; editor.hidden = true; welcome.hidden = false;
        const project = selectedProject();
        if (!project) {
            $('welcome-title').textContent = 'Un proyecto, todos tus agentes.';
            $('welcome-copy').textContent = 'Registra una carpeta para abrir sus ramas, archivos y sesiones persistentes en un mismo espacio.';
            $('welcome-action').textContent = 'Añadir proyecto';
        } else if (!selectedWorkspace()) {
            $('welcome-title').textContent = 'Este proyecto no tiene workspaces disponibles';
            $('welcome-copy').textContent = 'Comprueba que la ruta siga accesible y actualiza el workspace.';
            $('welcome-action').textContent = 'Actualizar';
        } else {
            $('welcome-title').textContent = 'Elige un agente o abre un archivo';
            $('welcome-copy').textContent = 'Los agentes de este workspace siguen ejecutándose aunque cambies de pestaña.';
            $('welcome-action').textContent = 'Crear agente';
        }
        setStatus(project ? 'Workspace preparado' : 'Sin proyecto', '');
        renderTabs();
        return;
    }
    welcome.hidden = true;
    if (tab.type === 'terminal') {
        disposeEditorView(); disposeMergeView();
        editor.hidden = true;
        frame.hidden = false;
        const session = sessionFor(tab.sessionId) || tab.session;
        if (!session?.token) {
            $('terminal-loading').hidden = true;
            frame.hidden = true; welcome.hidden = false;
            $('welcome-title').textContent = 'No se puede recuperar esta terminal';
            $('welcome-copy').textContent = 'Actualiza las sesiones; no se ha detenido el proceso tmux.';
            return;
        }
        if (state.frameSessionId !== session.id) {
            state.frameSessionId = session.id;
            state.terminalFrameReady = false;
            setTerminalFrameStatus(session.id, 'loading');
            startTerminalLoadTimer(session.id);
            frame.src = `/c/${encodeURIComponent(session.token)}?embed=1`;
        } else if (!state.terminalFrameReady && $('terminal-loading').hidden) {
            setTerminalFrameStatus(session.id, 'loading');
            startTerminalLoadTimer(session.id);
        }
        state.selectedSessionId = session.id;
        const workspace = projectWorkspace(session.project_id, session.workspace_id);
        if (session.project_id && session.project_id !== state.selectedProjectId) {
            state.activeTabId = null;
            renderCenter();
            return;
        }
        if (workspace && workspace.id !== state.selectedWorkspaceId) state.selectedWorkspaceId = workspace.id;
        updateTerminalStatus(session);
    } else if (tab.type === 'file') {
        disposeMergeView();
        $('terminal-loading').hidden = true;
        frame.hidden = true;
        editor.hidden = false;
        state.selectedSessionId = null;
        renderEditor(tab);
        if (!restoringNavigation) recordNavigation(tab);
        setStatus(`Editando ${tab.path}${tab.dirty ? ' · sin guardar' : ''}`, tab.dirty ? 'warning' : '');
    } else if (tab.type === 'diff') {
        disposeEditorView();
        $('terminal-loading').hidden = true;
        frame.hidden = true;
        editor.hidden = false;
        state.selectedSessionId = null;
        renderGitDiffTab(tab);
        setStatus(`Comparando ${tab.path} · Git`, '');
    }
    renderTabs();
}

function openTerminal(session) {
    if (!session?.id) return;
    if (activeTab()?.type === 'file') {
        clearTimeout(navigationTimer);
        recordNavigation(activeTab());
    }
    if (session.project_id) {
        state.expandedProjects.add(session.project_id);
        if (session.workspace_id) state.expandedWorkspaces.add(session.workspace_id);
        const project = state.projects.find(item => item.id === session.project_id);
        if (project && project.id !== state.selectedProjectId) {
            state.activeTabId = null;
            state.selectedProjectId = project.id;
            state.workspaceData = null;
            state.selectedWorkspaceId = session.workspace_id;
            loadWorkspaces(project.id).then(() => openTerminal(session)).catch(error => toast(error.message));
            return;
        }
        if (session.workspace_id && session.workspace_id !== state.selectedWorkspaceId) state.selectedWorkspaceId = session.workspace_id;
    }
    state.selectedSessionId = session.id;
    const id = `terminal:${session.id}`;
    let tab = state.tabs.find(item => item.id === id);
    if (!tab) {
        tab = {id, type: 'terminal', sessionId: session.id, label: session.title || agentName(session), session};
        state.tabs.push(tab);
    }
    tab.session = session;
    tab.label = session.title || agentName(session);
    state.activeTabId = id;
    if (window.matchMedia('(max-width:650px)').matches) closeMobileDrawers(true);
    state.directoryCache.clear();
    renderTree(); renderWorkspaceChrome(); renderCenter();
    loadDirectory('');
    refreshMessagesAndGit();
}

function renderTabs() {
    const strip = $('tab-strip');
    const fragment = document.createDocumentFragment();
    for (const tab of state.tabs) {
        const wrapper = node('div', `tab ${tab.id === state.activeTabId ? 'active' : ''}`);
        const open = node('button', 'tab-open'); open.type = 'button';
        open.append(node('span', 'tab-icon', tab.type === 'terminal' ? '●' : '▤'));
        const label = tab.type === 'terminal' ? (sessionFor(tab.sessionId)?.title || tab.label || agentName(sessionFor(tab.sessionId)))
            : tab.type === 'diff' ? `⇄ ${tab.path.split('/').at(-1)}` : tab.path.split('/').at(-1);
        open.append(node('span', 'tab-label', label));
        if (tab.type === 'file' && tab.dirty) open.append(node('span', 'dirty-mark', '●'));
        open.title = tab.type === 'file' ? `${tab.path}${tab.dirty ? ' · cambios sin guardar' : ''}`
            : tab.type === 'diff' ? `${tab.path} · diff ${tab.kind === 'staged' ? 'preparado' : 'del disco'}`
                : `${label} · sesión persistente`;
        open.addEventListener('click', () => activateTab(tab.id));
        const close = node('button', 'tab-close', '×'); close.type = 'button'; close.title = 'Cerrar pestaña'; close.setAttribute('aria-label', `Cerrar ${label}`);
        close.addEventListener('click', event => { event.stopPropagation(); closeTab(tab.id); });
        wrapper.append(open, close); fragment.append(wrapper);
    }
    strip.replaceChildren(fragment);
}

function activateTab(tabId) {
    const tab = state.tabs.find(item => item.id === tabId);
    if (!tab) return;
    if (!restoringNavigation && state.activeTabId !== tabId && activeTab()?.type === 'file') {
        clearTimeout(navigationTimer);
        recordNavigation(activeTab());
    }
    state.activeTabId = tabId;
    if (tab.type === 'terminal') {
        const session = sessionFor(tab.sessionId) || tab.session;
        if (session.project_id) state.expandedProjects.add(session.project_id);
        if (session.workspace_id) state.expandedWorkspaces.add(session.workspace_id);
        if (session.project_id && session.project_id !== state.selectedProjectId) {
            state.selectedProjectId = session.project_id;
            state.workspaceData = null;
            state.selectedWorkspaceId = session.workspace_id;
            loadWorkspaces(session.project_id).then(() => renderCenter()).catch(error => toast(error.message));
            return;
        }
        state.selectedWorkspaceId = session.workspace_id || state.selectedWorkspaceId;
        state.selectedSessionId = session.id;
    } else {
        state.expandedProjects.add(tab.projectId);
        state.expandedWorkspaces.add(tab.workspaceId);
        const project = state.projects.find(item => item.id === tab.projectId);
        if (project && project.id !== state.selectedProjectId) {
            state.selectedProjectId = project.id;
            state.workspaceData = null;
            state.selectedWorkspaceId = tab.workspaceId;
            loadWorkspaces(project.id).then(() => renderCenter()).catch(error => toast(error.message));
            return;
        }
        state.selectedWorkspaceId = tab.workspaceId;
        state.selectedSessionId = null;
    }
    renderTree(); renderWorkspaceChrome(); renderCenter();
}

function closeTab(tabId) {
    const tab = state.tabs.find(item => item.id === tabId);
    if (!tab) return;
    if (tab.type === 'file' && tab.dirty && !confirm(`Descartar los cambios sin guardar de ${tab.path}?`)) return;
    if (state.activeTabId === tabId && tab.type === 'file') {
        clearTimeout(navigationTimer);
        recordNavigation(tab);
    }
    const index = state.tabs.indexOf(tab);
    state.tabs.splice(index, 1);
    if (state.activeTabId === tabId) {
        const next = state.tabs[Math.max(0, index - 1)] || state.tabs[0] || null;
        state.activeTabId = next?.id || null;
        if (next) activateTab(next.id); else renderCenter();
    } else renderTabs();
}

async function loadDirectory(relative, force = false) {
    const workspace = selectedWorkspace();
    if (!workspace) {
        $('file-tree').replaceChildren(node('div', 'inspector-empty', 'Selecciona un workspace.'));
        return;
    }
    const key = `${workspace.id}:${relative}`;
    if (!force && state.directoryCache.has(key)) { renderFileTree(); return; }
    const selectedId = workspace.id;
    try {
        const query = new URLSearchParams({path: relative, limit: '500'});
        const data = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/files?${query}`);
        if (selectedWorkspace()?.id !== selectedId) return;
        state.directoryCache.set(key, data);
        renderFileTree();
    } catch (error) {
        if (selectedWorkspace()?.id === selectedId) $('file-tree').replaceChildren(node('div', 'inspector-empty', error.message));
    }
}

function renderFileTree() {
    const workspace = selectedWorkspace();
    $('explorer-root').textContent = workspace ? workspace.name : 'Selecciona un workspace';
    $('explorer-root').title = workspace?.path || '';
    if (!workspace) return;
    const filter = $('file-search').value.trim().toLocaleLowerCase();
    const rootData = state.directoryCache.get(`${workspace.id}:`);
    if (!rootData) {
        $('file-tree').replaceChildren(node('div', 'inspector-empty', 'Cargando archivos…'));
        loadDirectory('');
        return;
    }
    const buildList = relative => {
        const data = state.directoryCache.get(`${workspace.id}:${relative}`);
        const list = node('ul', 'tree-list');
        if (!data) {
            const item = node('li', 'file-node'); item.append(node('span', 'inspector-empty', 'Cargando…')); list.append(item);
            loadDirectory(relative);
            return list;
        }
        let entries = data.entries || [];
        if (!relative && filter) entries = entries.filter(item => item.name.toLocaleLowerCase().includes(filter));
        for (const entry of entries) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            const item = node('li', 'file-node');
            const button = node('button', `file-entry ${entry.type}`); button.type = 'button';
            const expanded = state.expandedWorkspaces.has(`${workspace.id}:${path}`);
            const glyph = entry.type === 'directory' ? expanded ? '▾' : '›' : entry.type === 'symlink' ? '↗' : entry.type === 'file' ? '·' : '—';
            button.append(node('span', 'file-glyph', glyph), node('span', 'file-name', entry.name));
            if (entry.type === 'file' && entry.size != null) button.append(node('span', 'file-size', formatBytes(entry.size)));
            button.title = entry.type === 'symlink' ? 'Los enlaces simbólicos se muestran, pero no se siguen.' : path;
            if (entry.type === 'directory') {
                button.setAttribute('aria-expanded', String(expanded));
                button.addEventListener('click', () => {
                    const key = `${workspace.id}:${path}`;
                    if (state.expandedWorkspaces.has(key)) state.expandedWorkspaces.delete(key);
                    else { state.expandedWorkspaces.add(key); loadDirectory(path); }
                    renderFileTree();
                });
            } else if (entry.type === 'file') {
                button.addEventListener('click', () => openFile(path));
            } else button.disabled = true;
            item.append(button);
            if (entry.type === 'directory' && expanded) item.append(buildList(path));
            list.append(item);
        }
        if (!entries.length) {
            const empty = node('li', 'file-node'); empty.append(node('span', 'inspector-empty', filter && !relative ? 'No hay coincidencias en esta carpeta.' : 'Carpeta vacía.')); list.append(empty);
        }
        if (data.truncated) {
            const more = node('li', 'file-node'); more.append(node('span', 'inspector-empty', 'Listado limitado a 500 entradas.')); list.append(more);
        }
        return list;
    };
    $('file-tree').replaceChildren(buildList(''));
}

function formatBytes(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function openFile(relative) {
    const workspace = selectedWorkspace();
    const project = selectedProject();
    if (!workspace || !project) return;
    const existing = state.tabs.find(item => item.type === 'file' && item.workspaceId === workspace.id && item.path === relative);
    if (existing) { activateTab(existing.id); return; }
    if (activeTab()?.type === 'file') {
        clearTimeout(navigationTimer);
        recordNavigation(activeTab());
    }
    const generation = ++state.fileGeneration;
    $('editor-placeholder').hidden = false; $('editor-placeholder').textContent = 'Abriendo archivo…';
    const query = new URLSearchParams({path: relative});
    try {
        const data = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/file?${query}`);
        const id = `file:${workspace.id}:${relative}`;
        const tab = {id, type: 'file', projectId: project.id, workspaceId: workspace.id,
                     path: relative, content: data.content, revision: data.revision, dirty: false,
                     editGeneration: 0, editorMode: window.WebConsoleEditor?.isMarkdownPath(relative) ? 'preview' : 'code'};
        if (generation !== state.fileGeneration) return;
        state.tabs.push(tab); state.activeTabId = id; state.selectedSessionId = null;
        renderCenter();
        if (window.matchMedia('(max-width:1050px)').matches) closeMobileDrawers(true);
    } catch (error) {
        if (generation === state.fileGeneration) toast(error.message);
    }
}

function disposeEditorView() {
    if (!currentEditorView) return;
    const tab = state.tabs.find(item => item.id === currentEditorTabId && item.type === 'file');
    if (tab) {
        tab.editorState = currentEditorView.state;
        tab.editorScrollTop = currentEditorView.scrollDOM.scrollTop;
        tab.editorScrollLeft = currentEditorView.scrollDOM.scrollLeft;
    }
    currentEditorView.destroy();
    currentEditorView = null;
    currentEditorTabId = null;
}

function disposeMergeView() {
    if (currentMergeView) currentMergeView.destroy();
    currentMergeView = null;
    currentMergeTabId = null;
}

function setEditorDocument(tab, content) {
    if (currentEditorView && currentEditorTabId === tab.id) disposeEditorView();
    tab.content = content;
    tab.editorState = null;
    tab.editorScrollTop = 0;
    tab.editorScrollLeft = 0;
}

function editorChanged(tab, content, update) {
    if (content === null) {
        if (update.selectionSet && !restoringNavigation) scheduleNavigation(tab);
        return;
    }
    tab.content = content;
    tab.dirty = true;
    tab.conflict = null;
    tab.editGeneration = (tab.editGeneration || 0) + 1;
    $('editor-state').textContent = 'Cambios sin guardar';
    $('editor-state').classList.add('dirty');
    $('save-file').disabled = false;
    setStatus(`Editando ${tab.path} · sin guardar`, 'warning');
    renderTabs();
    if (window.WebConsoleEditor?.isMarkdownPath(tab.path)) scheduleMarkdownPreview(tab);
}

function renderEditor(tab) {
    $('diff-panel').hidden = true;
    $('file-editor-pane').hidden = false;
    $('markdown-preview').hidden = true;
    $('editor-content').classList.remove('split');
    $('editor-placeholder').hidden = true;
    $('editor-path').textContent = tab.path;
    $('editor-path').title = `${selectedWorkspace()?.path || ''}/${tab.path}`;
    $('editor-state').textContent = tab.dirty ? 'Cambios sin guardar' : 'Sin cambios';
    $('editor-state').classList.toggle('dirty', tab.dirty);
    $('save-file').hidden = false;
    $('save-file').disabled = !tab.dirty;
    $('diff-open-code').hidden = true;
    $('reload-file').hidden = false;
    $('reload-file').title = 'Recargar archivo';
    $('conflict-panel').hidden = !tab.conflict;
    if (tab.conflict) renderConflict(tab);

    const markdown = Boolean(window.WebConsoleEditor?.isMarkdownPath(tab.path));
    const modePicker = $('markdown-modes');
    modePicker.hidden = !markdown;
    if (markdown) tab.editorMode ||= 'preview';
    else tab.editorMode = 'code';
    const mode = markdown ? tab.editorMode : 'code';
    $('editor-content').classList.toggle('split', mode === 'split');
    $('file-editor-pane').hidden = markdown && mode === 'preview';
    $('markdown-preview').hidden = !markdown || mode === 'code';
    for (const button of modePicker.querySelectorAll('[data-editor-mode]')) {
        const selected = button.dataset.editorMode === mode;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
    }
    if (markdown && mode !== 'code') renderMarkdownPreview(tab, true);

    if (!window.WebConsoleEditor) {
        $('editor-placeholder').hidden = false;
        $('editor-placeholder').textContent = 'No se pudo cargar el editor local.';
        return;
    }
    if (currentEditorView && currentEditorTabId !== tab.id) disposeEditorView();
    if (!currentEditorView) {
        try {
            currentEditorView = window.WebConsoleEditor.createEditor($('editor-host'), {
                doc: tab.content, filePath: tab.path, state: tab.editorState || null,
                onChange: (content, update) => editorChanged(tab, content, update),
                onSave: () => saveFile(tab).catch(error => toast(error.message)),
            });
            currentEditorTabId = tab.id;
            tab.editorState = null;
            requestAnimationFrame(() => {
                if (currentEditorView && currentEditorTabId === tab.id) {
                    currentEditorView.scrollDOM.scrollTop = tab.editorScrollTop || 0;
                    currentEditorView.scrollDOM.scrollLeft = tab.editorScrollLeft || 0;
                    currentEditorView.requestMeasure();
                }
            });
        } catch (error) {
            $('editor-placeholder').hidden = false;
            $('editor-placeholder').textContent = 'No se pudo iniciar el editor. Recarga esta página.';
            console.error('CodeMirror failed to mount', error);
        }
    } else currentEditorView.requestMeasure();
    $('conflict-panel').hidden = !tab.conflict;
    updateHistoryButtons();
}

function markdownTargetPath(currentPath, href) {
    if (!href || href.startsWith('#')) return null;
    if (/^(?:https?:|mailto:|tel:|\/\/)/i.test(href)) return null;
    let pathPart;
    try { pathPart = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
    catch (_) { return ''; }
    const base = currentPath.split('/').slice(0, -1);
    const segments = pathPart.startsWith('/') ? [] : base;
    for (const segment of pathPart.replace(/^\//, '').split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!segments.length) return '';
            segments.pop();
        } else segments.push(segment);
    }
    return segments.join('/');
}

function renderMarkdownPreview(tab, immediate = false) {
    clearTimeout(markdownTimer);
    const render = () => {
        const host = $('markdown-preview');
        if (!host || activeTab()?.id !== tab.id) return;
        if (new TextEncoder().encode(tab.content).length > 512 * 1024) {
            host.textContent = 'La vista previa está limitada a 512 KiB. Cambia a Código para editar el archivo completo.';
            return;
        }
        if (!window.WebConsoleMarkdown?.renderMarkdown) {
            host.textContent = 'Cargando visor Markdown local…';
            ensureEditorBundle('markdown').then(() => {
                if (activeTab()?.id === tab.id) renderMarkdownPreview(tab, true);
            }).catch(error => {
                if (activeTab()?.id === tab.id) host.textContent = error.message;
            });
            return;
        }
        host.innerHTML = window.WebConsoleMarkdown.renderMarkdown(tab.content);
        for (const anchor of host.querySelectorAll('a[href]')) {
            const href = anchor.getAttribute('href') || '';
            if (/^https?:/i.test(href) || /^mailto:/i.test(href)) {
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                continue;
            }
            const target = markdownTargetPath(tab.path, href);
            if (target === null) continue;
            if (!target) {
                anchor.removeAttribute('href');
                anchor.setAttribute('aria-disabled', 'true');
            } else {
                anchor.dataset.workspacePath = target;
                anchor.href = '#';
            }
        }
    };
    if (immediate) render();
    else markdownTimer = setTimeout(render, 180);
}

function renderConflict(tab) {
    const host = $('conflict-panel');
    const p = node('p', '', 'El archivo cambió en disco mientras lo editabas. Tus cambios locales siguen en el editor. Compara antes de reemplazar la versión nueva.');
    const label = node('strong', '', 'Versión actual en disco');
    const pre = node('pre', '', tab.conflict.content.slice(0, 8000));
    const useDisk = node('button', '', 'Descartar mi buffer y recargar');
    useDisk.addEventListener('click', () => {
        if (!confirm('¿Reemplazar el texto del editor con la versión actual del disco?')) return;
        setEditorDocument(tab, tab.conflict.content);
        tab.revision = tab.conflict.revision; tab.dirty = false; tab.conflict = null;
        tab.editGeneration = (tab.editGeneration || 0) + 1;
        if (activeTab()?.id === tab.id) renderEditor(tab);
        renderTabs();
    });
    const replaceDisk = node('button', '', 'Reemplazar en disco con mi versión');
    replaceDisk.addEventListener('click', async () => {
        if (!confirm('Esto sobrescribirá la versión que otro proceso escribió. ¿Comparaste ambas versiones y quieres continuar?')) return;
        try {
            await saveFile(tab, tab.conflict.revision);
            toast('Archivo guardado después de confirmar el conflicto');
        } catch (error) { toast(error.message); }
    });
    host.replaceChildren(p, label, pre, useDisk, replaceDisk);
    host.hidden = false;
}

async function saveFile(tab = activeTab(), expectedRevision = null) {
    if (!tab || tab.type !== 'file') return null;
    const submittedContent = tab.content;
    const submittedGeneration = tab.editGeneration || 0;
    const body = {path: tab.path, content: submittedContent, revision: expectedRevision || tab.revision};
    try {
        const saved = await api(`/api/workspaces/${encodeURIComponent(tab.workspaceId)}/file`, jsonOptions('PUT', body));
        tab.revision = saved.revision;
        if ((tab.editGeneration || 0) === submittedGeneration && tab.content === submittedContent) {
            tab.content = saved.content;
            tab.dirty = false;
        } else tab.dirty = true;
        tab.conflict = null;
        if (activeTab()?.id === tab.id) renderEditor(tab);
        renderTabs(); await refreshGit();
        toast(tab.dirty ? 'Guardé la versión enviada; hay cambios posteriores sin guardar' : 'Archivo guardado');
        return saved;
    } catch (error) {
        if (error.status === 409) {
            try { tab.conflict = await api(`/api/workspaces/${encodeURIComponent(tab.workspaceId)}/file?${new URLSearchParams({path: tab.path})}`); }
            catch (_) { tab.conflict = {content: 'No se pudo leer la versión actual.', revision: ''}; }
            if (activeTab()?.id === tab.id) renderEditor(tab);
        }
        throw error;
    }
}

async function reloadFile(tab) {
    if (!tab || tab.type !== 'file') return;
    const requestedGeneration = tab.editGeneration || 0;
    if (tab.dirty && !confirm('Descartar los cambios locales y recargar la versión en disco?')) return;
    const data = await api(`/api/workspaces/${encodeURIComponent(tab.workspaceId)}/file?${new URLSearchParams({path: tab.path})}`);
    if (!state.tabs.includes(tab)) return;
    if ((tab.editGeneration || 0) !== requestedGeneration
        && !confirm('El buffer cambió mientras se cargaba el archivo. ¿Descartar también esos cambios nuevos?')) return;
    setEditorDocument(tab, data.content);
    tab.revision = data.revision; tab.dirty = false; tab.conflict = null;
    tab.editGeneration = (tab.editGeneration || 0) + 1;
    if (activeTab()?.id === tab.id) renderEditor(tab);
    renderTabs();
}

function recordNavigation(tab) {
    if (!navigationHistory || !tab || tab.type !== 'file' || restoringNavigation) return;
    const selection = currentEditorView && currentEditorTabId === tab.id
        ? currentEditorView.state.selection.main
        : tab.editorState?.selection?.main;
    navigationHistory.record({
        workspaceId: tab.workspaceId, tabId: tab.id, path: tab.path,
        anchor: selection?.anchor || 0, head: selection?.head || 0,
        scrollTop: currentEditorView && currentEditorTabId === tab.id
            ? currentEditorView.scrollDOM.scrollTop : tab.editorScrollTop || 0,
        mode: tab.editorMode || 'code',
    });
}

function scheduleNavigation(tab) {
    clearTimeout(navigationTimer);
    navigationTimer = setTimeout(() => recordNavigation(tab), 650);
}

function updateHistoryButtons() {
    if (!navigationHistory || !$('history-back')) return;
    $('history-back').disabled = !navigationHistory.canBack;
    $('history-forward').disabled = !navigationHistory.canForward;
}

function navigateHistory(direction) {
    clearTimeout(navigationTimer);
    if (activeTab()?.type === 'file') recordNavigation(activeTab());
    const isOpen = entry => state.tabs.some(tab => tab.id === entry.tabId && tab.type === 'file'
        && tab.workspaceId === entry.workspaceId);
    const entry = direction < 0 ? navigationHistory?.back(isOpen) : navigationHistory?.forward(isOpen);
    if (!entry) return;
    const tab = state.tabs.find(item => item.id === entry.tabId);
    restoringNavigation = true;
    tab.editorMode = entry.mode;
    activateTab(tab.id);
    requestAnimationFrame(() => {
        if (activeTab()?.id === tab.id && currentEditorView && currentEditorTabId === tab.id) {
            const length = currentEditorView.state.doc.length;
            currentEditorView.dispatch({
                selection: {anchor: Math.min(entry.anchor, length), head: Math.min(entry.head, length)},
                scrollIntoView: true,
            });
            currentEditorView.scrollDOM.scrollTop = entry.scrollTop;
            currentEditorView.requestMeasure();
        }
        restoringNavigation = false;
        updateHistoryButtons();
    });
}

function renderGitDiffTab(tab, force = false) {
    $('file-editor-pane').hidden = true;
    $('markdown-preview').hidden = true;
    $('editor-content').classList.remove('split');
    $('diff-panel').hidden = false;
    $('editor-placeholder').hidden = true;
    $('markdown-modes').hidden = true;
    $('save-file').hidden = true;
    $('reload-file').hidden = false;
    $('reload-file').title = 'Actualizar comparación';
    $('editor-path').textContent = tab.path;
    $('editor-path').title = `${tab.path} · comparación Git`;
    $('editor-state').textContent = tab.kind === 'staged' ? 'Cambio preparado' : 'Cambio en disco';
    $('editor-state').classList.remove('dirty');
    $('conflict-panel').hidden = true;
    $('diff-open-code').hidden = !tab.diffData?.working_file_exists;
    if (currentMergeView && currentMergeTabId !== tab.id) disposeMergeView();
    if (force) {
        disposeMergeView();
        tab.diffData = null;
        tab.diffError = null;
    }
    if (tab.diffData) {
        $('diff-open-code').hidden = !tab.diffData.working_file_exists;
        $('diff-labels').textContent = `${tab.diffData.base_label} → ${tab.diffData.changed_label}`;
        const dirtyBuffer = state.tabs.some(item => item.type === 'file' && item.workspaceId === tab.workspaceId
            && item.path === tab.path && item.dirty);
        $('diff-status').textContent = tab.diffData.kind === 'staged'
            ? 'HEAD → índice · solo lectura' : 'Índice → working tree · solo lectura';
        if (dirtyBuffer) $('diff-status').textContent += ' · Buffer sin guardar no incluido';
        if (!window.WebConsoleMerge?.mountResponsiveMerge) {
            $('diff-status').textContent = 'Cargando comparador Git local…';
            ensureEditorBundle('merge').then(() => {
                if (activeTab()?.id === tab.id) renderGitDiffTab(tab);
            }).catch(error => {
                if (activeTab()?.id === tab.id) $('diff-status').textContent = error.message;
            });
            return;
        }
        if (!currentMergeView || currentMergeTabId !== tab.id) {
            $('diff-merge').replaceChildren();
            const language = window.WebConsoleEditor?.languageForPath(tab.path) || [];
            currentMergeView = window.WebConsoleMerge?.mountResponsiveMerge($('diff-merge'), {
                original: tab.diffData.base, modified: tab.diffData.changed, language,
                originalLabel: tab.diffData.base_label, modifiedLabel: tab.diffData.changed_label,
            }) || null;
            currentMergeTabId = tab.id;
        }
        return;
    }
    disposeMergeView();
    $('diff-labels').textContent = tab.path;
    $('diff-status').textContent = tab.diffError || 'Cargando comparación…';
    $('diff-merge').replaceChildren();
    const generation = (tab.diffGeneration || 0) + 1;
    tab.diffGeneration = generation;
    const query = new URLSearchParams({path: tab.path, kind: tab.kind});
    api(`/api/workspaces/${encodeURIComponent(tab.workspaceId)}/diff?${query}`).then(data => {
        if (tab.diffGeneration !== generation || !state.tabs.includes(tab)) return;
        tab.diffData = data;
        tab.diffError = null;
        if (activeTab()?.id === tab.id) renderGitDiffTab(tab);
    }).catch(error => {
        if (tab.diffGeneration !== generation || !state.tabs.includes(tab)) return;
        tab.diffError = error.message;
        if (activeTab()?.id === tab.id) {
            $('diff-labels').textContent = tab.path;
            $('diff-status').textContent = error.message;
            $('diff-merge').replaceChildren();
        }
    });
}

function openGitDiff(change, kind) {
    const workspace = selectedWorkspace();
    const project = selectedProject();
    if (!workspace || !project) return;
    if (activeTab()?.type === 'file') {
        clearTimeout(navigationTimer);
        recordNavigation(activeTab());
    }
    const id = `diff:${workspace.id}:${kind}:${change.path}`;
    let tab = state.tabs.find(item => item.id === id);
    if (!tab) {
        tab = {id, type: 'diff', projectId: project.id, workspaceId: workspace.id,
               path: change.path, kind, label: change.path};
        state.tabs.push(tab);
    }
    state.activeTabId = id;
    state.selectedSessionId = null;
    if (window.matchMedia('(max-width:1050px)').matches) closeMobileDrawers(true);
    renderCenter();
}

function renderGit() {
    const workspace = selectedWorkspace();
    const git = workspace?.git;
    $('github-mark').hidden = !git?.github_available;
    $('git-branch').textContent = !workspace ? 'Sin workspace' : git?.is_git ? `${git.branch || 'detached'}${git.detached ? ' · HEAD separado' : ''}` : git?.available === false ? 'Git no disponible' : 'Sin repositorio Git';
    $('git-branch').title = git?.root || '';
    const remotePicker = $('remote-picker');
    const remotes = git?.remotes || [];
    remotePicker.hidden = remotes.length === 0;
    remotePicker.replaceChildren(...remotes.map(remote => new Option(`${remote.name}${remote.provider === 'github' ? ' · GitHub' : ''}`, remote.name)));
    $('fetch-branches').hidden = remotes.length === 0;
    const host = $('git-changes');
    if (!workspace) { host.replaceChildren(node('div', 'inspector-empty', 'Selecciona un workspace para ver sus cambios.')); return; }
    if (!git?.is_git) { host.replaceChildren(node('div', 'inspector-empty', git?.error || 'Este workspace no tiene Git.')); return; }
    const changes = git.changes || [];
    if (!changes.length) { host.replaceChildren(node('div', 'inspector-empty', 'Working tree limpio.')); return; }
    const fragment = document.createDocumentFragment();
    for (const change of changes.slice(0, 80)) {
        const staged = change.status !== 'untracked' && change.index && change.index !== ' ' && change.index !== '?';
        const worktree = change.status === 'untracked' || (change.worktree && change.worktree !== ' ' && change.worktree !== '?');
        const addEntry = (kind, label, code) => {
            const button = node('button', `git-entry git-entry-${kind}`); button.type = 'button';
            button.append(node('span', `git-code ${change.status}`, code),
                node('span', 'git-path', change.path), node('span', 'git-kind', label));
            button.title = `${kind === 'staged' ? 'HEAD → índice' : 'Índice → disco'} · ${change.status} · ${change.path}`;
            button.addEventListener('click', () => openGitDiff(change, kind));
            fragment.append(button);
        };
        const code = change.status === 'untracked' ? 'U' : change.status === 'renamed' ? 'R'
            : change.status === 'deleted' ? 'D' : `${change.index}${change.worktree}`.trim() || 'M';
        if (staged) addEntry('staged', 'Preparado', code);
        if (worktree) addEntry('worktree', change.status === 'untracked' ? 'Nuevo' : 'Disco', code);
        if (!staged && !worktree) addEntry('worktree', 'Disco', code);
    }
    host.replaceChildren(fragment);
}

async function refreshGit() {
    const workspace = selectedWorkspace();
    if (!workspace) return;
    try {
        const data = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/git`);
        if (selectedWorkspace()?.id !== workspace.id) return;
        workspace.git = data.git;
        renderBranchPicker(); renderGit(); renderTree();
    } catch (error) { toast(error.message); }
}

async function refreshMessagesAndGit() {
    await Promise.all([refreshGit(), state.selectedProjectId ? loadMessages(state.selectedProjectId) : Promise.resolve()]);
}

async function loadMessages(projectId) {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/messages`);
    if (projectId !== state.selectedProjectId) return;
    state.messages = data.messages || [];
    renderMessages();
}

function renderRecipientPicker() {
    const project = selectedProject();
    const sessions = state.sessions.filter(item => item.project_id === project?.id && !isWorkspaceShell(item));
    const select = $('message-recipient');
    select.replaceChildren(...sessions.map(item => new Option(`${item.title || agentName(item)} · ${item.id}`, item.id)));
    if (state.selectedSessionId && sessions.some(item => item.id === state.selectedSessionId)) select.value = state.selectedSessionId;
    $('message-form').hidden = !project || sessions.length === 0;
}

function renderMessages() {
    const projectId = state.selectedProjectId;
    const messages = state.messages;
    const host = $('message-feed');
    if (!projectId || !messages.length) {
        host.replaceChildren(node('div', 'inspector-empty', projectId ? 'Aún no hay mensajes entre agentes.' : 'Selecciona un proyecto para ver los mensajes.'));
        $('message-count').textContent = '';
        return;
    }
    const fragment = document.createDocumentFragment();
    const recent = messages.slice(-30);
    for (const message of recent) {
        const item = node('article', 'message-item');
        const meta = node('div', 'message-meta');
        meta.append(node('span', '', message.sender_name || 'Agente'));
        const recipient = sessionFor(message.recipient_session_id);
        meta.append(node('span', 'message-recipient', `→ ${recipient?.title || recipient?.agent?.name || message.recipient_session_id}`));
        const time = node('time', '', new Date(message.created_at * 1000).toLocaleTimeString('es', {hour:'2-digit', minute:'2-digit'}));
        meta.append(time);
        item.append(meta, node('p', '', message.body), node('div', 'message-state', message.state === 'read' ? 'Leído por la herramienta del agente' : 'Pendiente de lectura'));
        fragment.append(item);
    }
    host.replaceChildren(fragment);
    host.scrollTop = host.scrollHeight;
    $('message-count').textContent = `${messages.length}`;
}

async function sendMessage(event) {
    event.preventDefault();
    const project = selectedProject();
    const body = $('message-input').value.trim();
    const recipient = $('message-recipient').value;
    if (!project || !body || !recipient) return;
    const button = $('message-form').querySelector('button'); button.disabled = true;
    try {
        await api(`/api/projects/${encodeURIComponent(project.id)}/messages`, jsonOptions('POST', {recipient_session_id: recipient, body}));
        $('message-input').value = '';
        await loadMessages(project.id);
        toast('Mensaje guardado en el buzón del agente');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
}

function openProjectDialog() {
    $('project-error').hidden = true;
    $('project-dialog').showModal();
    $('project-form').elements.path.focus();
}
async function createProject(event) {
    event.preventDefault();
    const form = $('project-form');
    const button = $('save-project'); button.disabled = true; $('project-error').hidden = true;
    try {
        const data = await api('/api/projects', jsonOptions('POST', Object.fromEntries(new FormData(form))));
        $('project-dialog').close(); form.reset();
        state.selectedProjectId = data.project.id; state.workspaceData = null; state.selectedWorkspaceId = null;
        state.projects = [...state.projects, {...data.project, workspace_count:1, session_count:0}];
        try {
            const sessionData = await api('/api/sessions');
            state.sessions = sessionData.sessions || [];
        } catch (_) {}
        renderTree();
        await loadWorkspaces(data.project.id);
        toast('Proyecto registrado; no se modificaron sus archivos.');
    } catch (error) { $('project-error').hidden = false; $('project-error').textContent = error.message; }
    finally { button.disabled = false; }
}

function openAgentDialog() {
    const project = selectedProject();
    const workspaces = state.workspaceData?.workspaces || [];
    if (!project || !workspaces.length) { toast('Selecciona un workspace disponible primero.'); return; }
    const select = $('agent-workspace');
    select.replaceChildren(...workspaces.map(item => new Option(`${item.name}${item.git?.branch ? ` · ${item.git.branch}` : ''}`, item.id)));
    if (state.selectedWorkspaceId) select.value = state.selectedWorkspaceId;
    $('agent-error').hidden = true;
    $('agent-dialog').showModal();
}
async function createAgent(event) {
    event.preventDefault();
    const form = $('agent-form'); const button = $('create-agent'); button.disabled = true; $('agent-error').hidden = true;
    const payload = Object.fromEntries(new FormData(form));
    try {
        const data = await api('/api/sessions', jsonOptions('POST', payload));
        $('agent-dialog').close(); form.reset();
        try {
            const sessionData = await api('/api/sessions');
            state.sessions = sessionData.sessions || [];
        } catch (_) {}
        renderTree();
        const session = sessionFor(data.id) || {id:data.id, token:data.token, url:data.url, title:payload.title,
            launcher:payload.agent, project_id:data.project_id, workspace_id:data.workspace_id,
            cwd:selectedWorkspace()?.path, state:'idle', is_active:true};
        openTerminal(session);
        toast('Agente iniciado en tmux; cerrarlo aquí no detiene su proceso.');
    } catch (error) { $('agent-error').hidden = false; $('agent-error').textContent = error.message; }
    finally { button.disabled = false; }
}

function resetHandoffDialog() {
    $('handoff-source').textContent = 'Comprobando la sesión de origen…';
    $('handoff-target').value = 'codex';
    $('handoff-target').disabled = false;
    $('handoff-form').querySelectorAll('[name="handoff-mode"]').forEach(input => {
        input.disabled = false;
        input.checked = input.value === 'wait';
    });
    $('handoff-preview').hidden = true;
    $('handoff-preview-meta').textContent = '';
    $('handoff-warnings').replaceChildren();
    $('handoff-last-user').textContent = '';
    $('handoff-last-assistant').textContent = '';
    $('handoff-status').hidden = true;
    $('handoff-status').textContent = '';
    $('handoff-error').hidden = true;
    $('handoff-error').textContent = '';
    $('handoff-prepare').hidden = false;
    $('handoff-prepare').disabled = true;
    $('handoff-prepare').textContent = 'Preparar vista previa';
    $('handoff-confirm').hidden = true;
    $('handoff-confirm').disabled = false;
}

async function openHandoffDialog(session) {
    if (!session || session.launcher !== 'opencode' || !session.project_id || !session.workspace_id) {
        toast('El primer traspaso disponible es desde OpenCode en un workspace registrado.');
        return;
    }
    const handoff = {sourceSessionId:session.id, operationId:null, busy:false, confirmed:false};
    state.handoff = handoff;
    resetHandoffDialog();
    $('handoff-dialog').showModal();
    try {
        const capabilities = await api(`/api/sessions/${encodeURIComponent(session.id)}/handoff/capabilities`);
        if (state.handoff !== handoff) return;
        const codex = capabilities.targets?.find(item => item.id === 'codex');
        const statusLabel = capabilities.source_state ? stateLabel({state:capabilities.source_state}) : '';
        const statusKind = capabilities.source_state_source && capabilities.source_state_source !== 'event'
            ? 'Estado estimado' : 'Estado';
        const stateText = statusLabel ? ` ${statusKind}: ${statusLabel}.` : '';
        $('handoff-source').textContent = `Sesión OpenCode: ${session.title || session.id}.${stateText}`;
        const target = $('handoff-target').selectedOptions[0];
        if (target && codex && !codex.available) target.textContent = 'Codex · no instalado';
        $('handoff-prepare').disabled = !capabilities.source_ready || !codex?.available;
        if (!capabilities.source_ready) {
            $('handoff-error').hidden = false;
            $('handoff-error').textContent = capabilities.source_message || 'La sesión no está lista para preparar el contexto.';
        } else if (!codex?.available) {
            $('handoff-error').hidden = false;
            $('handoff-error').textContent = codex?.message || 'Codex no está disponible.';
        }
    } catch (error) {
        if (state.handoff !== handoff) return;
        $('handoff-error').hidden = false;
        $('handoff-error').textContent = error.message;
    }
}

function handoffMode() {
    return $('handoff-form').querySelector('[name="handoff-mode"]:checked')?.value || 'wait';
}

async function prepareAgentHandoff() {
    const handoff = state.handoff;
    if (!handoff || handoff.busy || handoff.confirmed) return;
    handoff.busy = true;
    $('handoff-error').hidden = true;
    $('handoff-status').hidden = false;
    $('handoff-status').textContent = 'Exportando y preparando una captura privada…';
    $('handoff-prepare').disabled = true;
    $('handoff-cancel').disabled = true;
    try {
        if (handoff.operationId) {
            const oldId = handoff.operationId;
            try { await api(`/api/handoffs/${encodeURIComponent(oldId)}/cancel`, jsonOptions('POST', {})); } catch (_) {}
            handoff.operationId = null;
        }
        const result = await api(`/api/sessions/${encodeURIComponent(handoff.sourceSessionId)}/handoffs`,
            jsonOptions('POST', {target_agent:'codex', mode:handoffMode()}));
        if (state.handoff !== handoff) {
            api(`/api/handoffs/${encodeURIComponent(result.handoff.id)}/cancel`, jsonOptions('POST', {})).catch(() => {});
            return;
        }
        handoff.operationId = result.handoff.id;
        const preview = result.handoff.preview || {};
        $('handoff-preview-meta').textContent = `${preview.title || 'Conversación OpenCode'}: ${result.handoff.message_count || preview.message_count || 0} mensajes, ${preview.tool_count || 0} llamadas de herramienta y ${preview.attachment_count || 0} referencias de adjuntos.`;
        $('handoff-last-user').textContent = preview.last_user
            ? `${preview.last_user_truncated ? '[Extracto; el historial completo se conserva para Codex]\n' : ''}${preview.last_user}`
            : 'No hay un mensaje de usuario exportable.';
        $('handoff-last-assistant').textContent = preview.last_assistant
            ? `${preview.last_assistant_truncated ? '[Extracto; el historial completo se conserva para Codex]\n' : ''}${preview.last_assistant}`
            : 'No hay una respuesta de OpenCode exportable.';
        $('handoff-warnings').replaceChildren(...(preview.warnings || []).map(message => node('li', '', message)));
        $('handoff-preview').hidden = false;
        $('handoff-target').disabled = true;
        $('handoff-form').querySelectorAll('[name="handoff-mode"]').forEach(input => { input.disabled = true; });
        $('handoff-status').textContent = 'Vista previa lista. Confirma solo si corresponde a la sesión que quieres transferir.';
        $('handoff-prepare').hidden = true;
        $('handoff-confirm').hidden = false;
        $('handoff-confirm').textContent = handoffMode() === 'continue' ? 'Crear Codex y continuar' : 'Crear Codex y esperar';
    } catch (error) {
        $('handoff-error').hidden = false;
        $('handoff-error').textContent = error.message;
        $('handoff-status').hidden = true;
        $('handoff-prepare').disabled = false;
    } finally {
        handoff.busy = false;
        $('handoff-cancel').disabled = false;
    }
}

async function monitorHandoffReceipt(handoffId) {
    for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        try {
            const result = await api(`/api/handoffs/${encodeURIComponent(handoffId)}`);
            const handoffState = result.handoff?.state;
            if (handoffState === 'received') {
                toast('Codex abrió el paquete de contexto. La sesión OpenCode se conserva.');
                return;
            }
            if (handoffState === 'failed' || handoffState === 'stale') {
                toast(result.handoff.error || 'El traspaso necesita atención; el paquete privado se conserva.');
                return;
            }
        } catch (_) { return; }
    }
    toast('Codex aún no confirmó acceso al contexto; el paquete sigue disponible en su sesión.');
}

async function confirmAgentHandoff() {
    const handoff = state.handoff;
    if (!handoff?.operationId || handoff.busy || handoff.confirmed) return;
    handoff.busy = true;
    $('handoff-error').hidden = true;
    $('handoff-status').hidden = false;
    $('handoff-status').textContent = 'Verificando que OpenCode no haya cambiado y creando la sesión Codex…';
    $('handoff-confirm').disabled = true;
    $('handoff-cancel').disabled = true;
    try {
        const handoffId = handoff.operationId;
        const data = await api(`/api/handoffs/${encodeURIComponent(handoffId)}/confirm`, jsonOptions('POST', {}));
        handoff.confirmed = true;
        state.handoff = null;
        $('handoff-dialog').close();
        try {
            const sessions = await api('/api/sessions');
            state.sessions = sessions.sessions || [];
        } catch (_) {}
        renderTree();
        const session = sessionFor(data.id) || {id:data.id, token:data.token, url:data.url,
            title:'Continuación de OpenCode', launcher:'codex', project_id:data.project_id,
            workspace_id:data.workspace_id, state:'idle', is_active:true};
        openTerminal(session);
        toast('Sesión Codex creada. OpenCode sigue intacto; la lectura del contexto se confirmará por separado.');
        monitorHandoffReceipt(handoffId);
    } catch (error) {
        $('handoff-status').hidden = true;
        $('handoff-error').hidden = false;
        $('handoff-error').textContent = error.message;
        $('handoff-confirm').disabled = false;
        if (error.status === 409) {
            $('handoff-confirm').hidden = true;
            $('handoff-prepare').hidden = false;
            $('handoff-prepare').disabled = false;
            $('handoff-prepare').textContent = 'Preparar nueva vista previa';
            $('handoff-target').disabled = false;
            $('handoff-form').querySelectorAll('[name="handoff-mode"]').forEach(input => { input.disabled = false; });
        }
    } finally {
        if (state.handoff === handoff) {
            handoff.busy = false;
            $('handoff-cancel').disabled = false;
        }
    }
}

async function cancelPreparedHandoff() {
    const handoff = state.handoff;
    state.handoff = null;
    if (!handoff || !handoff.operationId || handoff.confirmed) return;
    try { await api(`/api/handoffs/${encodeURIComponent(handoff.operationId)}/cancel`, jsonOptions('POST', {})); } catch (_) {}
}

function openWorktreeDialog(selectedBranch = null) {
    const workspace = selectedWorkspace();
    const branches = workspace?.git?.branches || [];
    if (!branches.length) { toast('No hay ramas locales o remotas conocidas. Actualízalas primero.'); return; }
    const select = $('worktree-base');
    select.replaceChildren(...branches.map((branch, index) => {
        const option = new Option(`${branch.kind === 'remote' ? 'Remota' : 'Local'} · ${branch.name}${branch.current ? ' · actual' : ''}`, String(index));
        option.dataset.ref = branch.ref; option.dataset.kind = branch.kind; option.dataset.name = branch.name;
        return option;
    }));
    const preferred = selectedBranch !== null ? selectedBranch : branches.findIndex(branch => branch.ref === `refs/heads/${workspace.git.default_branch}`);
    select.value = String(typeof preferred === 'number' ? Math.max(preferred, 0) : Math.max(0, branches.findIndex(branch => branch.ref === preferred)));
    $('worktree-error').hidden = true;
    updateWorktreeBranchDefaults();
    $('worktree-dialog').showModal();
}

function updateWorktreeBranchDefaults() {
    const option = $('worktree-base').selectedOptions[0];
    if (!option) return;
    const local = option.dataset.kind === 'local';
    $('existing-branch-row').hidden = !local;
    $('existing-branch').checked = local;
    const raw = option.dataset.name || '';
    const name = local ? raw : raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
    $('worktree-branch').value = local ? raw : name;
    $('worktree-branch').disabled = local && $('existing-branch').checked;
}

async function createWorktree(event) {
    event.preventDefault();
    const project = selectedProject(); const option = $('worktree-base').selectedOptions[0];
    if (!project || !option) return;
    const button = $('create-worktree'); button.disabled = true; $('worktree-error').hidden = true;
    const payload = {base_ref: option.dataset.ref, branch: $('worktree-branch').value.trim(),
        name: $('worktree-name').value.trim(), existing_branch: $('existing-branch').checked};
    try {
        const result = await api(`/api/projects/${encodeURIComponent(project.id)}/workspaces`, jsonOptions('POST', payload));
        $('worktree-dialog').close();
        state.workspaceData = null;
        await loadWorkspaces(project.id);
        selectWorkspace(result.workspace.id);
        toast(`Worktree creado en ${result.workspace.path}`);
    } catch (error) { $('worktree-error').hidden = false; $('worktree-error').textContent = error.message; }
    finally { button.disabled = false; }
}

function openActions(session) {
    const agent = detectedAgent(session);
    const actions = agent === 'opencode' ? [
        {id:'opencode-agent', title:'Cambiar agente · Plan / Build', key:'Shift+Tab', note:'Alterna perfiles configurados en OpenCode; el resultado depende de los perfiles de este proyecto.'},
        {id:'opencode-variant', title:'Cambiar variante de razonamiento', key:'Ctrl+T', note:'Recorre las variantes disponibles para el modelo actual.'},
        {id:'opencode-palette', title:'Abrir paleta de comandos', key:'Ctrl+P', note:'Abre la paleta de comandos de OpenCode.'},
        {id:'opencode-model', title:'Abrir selector de modelo', key:'Ctrl+X, M', note:'Leader predeterminado Ctrl+X seguido de M; puede cambiarse en OpenCode.'},
    ] : agent === 'codex' ? [
        {id:'codex-model', title:'Cambiar modelo o razonamiento', key:'/model', note:'Abre el selector documentado de Codex CLI; se enviará el comando y Enter.'},
        {id:'codex-permissions', title:'Revisar permisos', key:'/permissions', note:'Abre los permisos de la sesión Codex actual.'},
        {id:'codex-review', title:'Iniciar revisión', key:'/review', note:'Inicia el flujo de revisión de Codex CLI.'},
    ] : [];
    $('actions-title').textContent = `${agentName(session)} · ${session.title || session.id}`;
    const version = session.launcher_version ? `Versión detectada al iniciar: ${session.launcher_version}.` : 'No se pudo detectar la versión de la CLI.';
    $('actions-description').textContent = actions.length ? `${version} Atajos predeterminados de la TUI; la configuración del usuario puede cambiarlos. Úsalos cuando el agente esté esperando entrada.` : 'No hay acciones de teclado verificadas para este agente. No se enviará entrada arbitraria a la terminal.';
    const list = $('action-list'); list.replaceChildren();
    for (const action of actions) {
        const button = node('button', 'agent-action'); button.type = 'button';
        button.append(node('span', '', '↵'));
        const text = node('span', ''); text.append(node('strong', '', action.title), node('small', '', `${action.key} · ${action.note}`));
        button.append(text);
        button.addEventListener('click', () => {
            if (action.id.startsWith('codex-') && !confirm(`Se enviará ${action.key} y Enter a la terminal. Continúa solo si Codex está esperando una instrucción; no lo envíes mientras procesa otra tarea. ¿Enviar?`)) return;
            $('agent-actions-dialog').close();
            dispatchAgentAction(session, action);
        });
        list.append(button);
    }
    $('agent-actions-dialog').showModal();
}

function dispatchAgentAction(session, action) {
    if (!sessionFor(session.id)?.token) { toast('La sesión no está disponible. Actualiza antes de intentarlo.'); return; }
    if (state.activeTabId !== `terminal:${session.id}`) openTerminal(sessionFor(session.id));
    state.pendingAction = {sessionId:session.id, action:action.id, attempts:0};
    clearInterval(state.actionTimer);
    const attempt = () => {
        if (!state.pendingAction) return;
        if (state.frameSessionId !== session.id || !$('terminal-frame').contentWindow) return;
        state.pendingAction.attempts++;
        $('terminal-frame').contentWindow.postMessage({type:'webconsole:agent-action', action:action.id, session_id:session.id}, window.location.origin);
        if (action.id === 'interrupt') {
            clearInterval(state.actionTimer);
            state.actionTimer = setTimeout(() => {
                if (!state.pendingAction || state.pendingAction.sessionId !== session.id) return;
                state.pendingAction = null; state.actionTimer = null;
                toast('La terminal no confirmó Ctrl+C; no se reintentó para evitar interrupciones duplicadas.');
            }, 5000);
            return;
        }
        if (state.pendingAction.attempts > 20) {
            clearInterval(state.actionTimer); state.actionTimer = null; state.pendingAction = null;
            toast('La terminal no confirmó la conexión; no se envió la acción.');
        }
    };
    state.actionTimer = setInterval(attempt, 300);
    attempt();
}

function interruptWorkspaceShell() {
    const session = workspaceShellSession();
    const frame = $('shell-frame');
    if (!session || sessionEnded(session) || state.shellFrameSessionId !== session.id || !frame.contentWindow) {
        toast('La terminal del workspace no está conectada.');
        return;
    }
    frame.contentWindow.postMessage({type:'webconsole:interrupt', session_id:session.id}, window.location.origin);
}

function handleActionResult(event) {
    if (event.origin !== window.location.origin || event.source !== $('terminal-frame').contentWindow || event.data?.type !== 'webconsole:action-result') return;
    if (!state.pendingAction || state.pendingAction.action !== event.data.action
            || state.pendingAction.sessionId !== event.data.session_id) return;
    if (event.data.success) {
        const action = state.pendingAction.action;
        clearInterval(state.actionTimer); state.actionTimer = null; state.pendingAction = null;
        toast(action === 'interrupt' ? 'Ctrl+C enviado al agente activo.' : `Acción enviada: ${action.replaceAll('-', ' ')}`);
    }
}

function handleTerminalMessage(event) {
    if (event.origin !== window.location.origin) return;
    const terminalFrame = $('terminal-frame');
    if (!terminalFrame) return;
    if (event.source === terminalFrame.contentWindow) {
        const data = event.data || {};
        if (data.type === 'webconsole:terminal-status' && data.session_id === state.frameSessionId
                && typeof data.state === 'string') {
            setTerminalFrameStatus(data.session_id, data.state);
        } else if (data.type === 'webconsole:attachment-uploaded' && data.attachment?.id
                && /^[a-f0-9]{32}$/.test(data.attachment.id)
                && data.attachment.session_id === data.session_id
                && sessionFor(data.session_id) && !isWorkspaceShell(sessionFor(data.session_id))) {
            if (!state.pendingAttachments.some(item => item.id === data.attachment.id)) {
                state.pendingAttachments.push({...data.attachment, session_id:data.session_id, inserted:Boolean(data.inserted)});
            } else if (data.inserted) {
                const item = state.pendingAttachments.find(value => value.id === data.attachment.id);
                item.inserted = true; item.inserting = false;
            }
            renderAttachmentTray();
        } else if (data.type === 'webconsole:attachment-inserted') {
            const item = state.pendingAttachments.find(value => value.id === data.attachment_id && value.session_id === data.session_id);
            if (item) { item.inserting = false; item.inserted = Boolean(data.success); }
            if (!data.success && data.error) toast(data.error);
            else if (data.success) toast('Referencia insertada en el input; no se envió.');
            renderAttachmentTray();
        }
        return;
    }
    const shellFrame = $('shell-frame');
    if (!shellFrame || event.source !== shellFrame.contentWindow) return;
    const data = event.data || {};
    if (data.session_id !== state.shellFrameSessionId) return;
    if (data.type === 'webconsole:interrupt-result') {
        toast(data.success ? 'Ctrl+C enviado a la terminal del workspace.' : 'La terminal no está conectada; no se envió Ctrl+C.');
    }
}

async function fetchBranches() {
    const workspace = selectedWorkspace();
    if (!workspace) return;
    const remote = $('remote-picker').value;
    if (!remote) return;
    const button = $('fetch-branches'); button.disabled = true;
    try {
        const data = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/fetch`, jsonOptions('POST', {remote}));
        workspace.git = data.git;
        renderWorkspaceChrome(); renderTree();
        toast(`Ramas actualizadas desde ${remote}`);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
}

function attachEvents() {
    navigationHistory = window.WebConsoleEditor?.NavigationHistory
        ? new window.WebConsoleEditor.NavigationHistory(250, updateHistoryButtons) : null;
    $('history-back').addEventListener('click', () => navigateHistory(-1));
    $('history-forward').addEventListener('click', () => navigateHistory(1));
    $('markdown-modes').addEventListener('click', event => {
        const button = event.target.closest('[data-editor-mode]');
        const tab = activeTab();
        if (!button || tab?.type !== 'file' || !window.WebConsoleEditor?.isMarkdownPath(tab.path)) return;
        recordNavigation(tab);
        tab.editorMode = button.dataset.editorMode;
        renderEditor(tab);
        recordNavigation(tab);
    });
    $('markdown-preview').addEventListener('click', event => {
        const anchor = event.target.closest('a[data-workspace-path]');
        if (!anchor) return;
        event.preventDefault();
        openFile(anchor.dataset.workspacePath);
    });
    $('diff-open-code').addEventListener('click', () => {
        const tab = activeTab();
        if (tab?.type === 'diff') openFile(tab.path);
    });
    $('add-project').addEventListener('click', openProjectDialog);
    $('welcome-action').addEventListener('click', () => {
        if (!selectedProject()) openProjectDialog();
        else if (!selectedWorkspace()) refreshAll();
        else openAgentDialog();
    });
    $('add-agent').addEventListener('click', openAgentDialog);
    $('interrupt-agent')?.addEventListener('click', () => {
        const session = currentAgentSession();
        if (session) dispatchAgentAction(session, {id:'interrupt'});
    });
    if (hasWorkspaceTerminalUI()) {
        $('terminal-drawer-toggle').addEventListener('click', () => setTerminalExpanded(!state.terminalExpanded));
        $('shell-start').addEventListener('click', () => ensureWorkspaceTerminal(false));
        $('shell-new').addEventListener('click', () => ensureWorkspaceTerminal(true));
        $('shell-interrupt').addEventListener('click', interruptWorkspaceShell);
        const resizeHandle = $('terminal-resize');
        resizeHandle.addEventListener('keydown', event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            setTerminalHeight(state.terminalAppliedHeight + (event.key === 'ArrowUp' ? 20 : -20), true);
            requestTerminalFrameResize($('shell-frame'));
        });
        resizeHandle.addEventListener('pointerdown', event => {
            if (!state.terminalExpanded || event.button !== 0) return;
            event.preventDefault();
            const startY = event.clientY, startHeight = state.terminalAppliedHeight;
            resizeHandle.setPointerCapture(event.pointerId);
            let finished = false;
            const move = moveEvent => {
                if (moveEvent.pointerId !== event.pointerId) return;
                setTerminalHeight(startHeight + startY - moveEvent.clientY);
            };
            const end = () => {
                if (finished) return;
                finished = true;
                resizeHandle.removeEventListener('pointermove', move);
                resizeHandle.removeEventListener('pointerup', end);
                resizeHandle.removeEventListener('pointercancel', end);
                resizeHandle.removeEventListener('lostpointercapture', end);
                setTerminalHeight(state.terminalAppliedHeight, true);
                if (resizeHandle.hasPointerCapture?.(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId);
                requestTerminalFrameResize($('shell-frame'));
            };
            resizeHandle.addEventListener('pointermove', move);
            resizeHandle.addEventListener('pointerup', end);
            resizeHandle.addEventListener('pointercancel', end);
            resizeHandle.addEventListener('lostpointercapture', end);
        });
    }
    const attachButton = $('workspace-attach');
    const attachmentPicker = $('attachment-picker');
    if (attachButton && attachmentPicker) {
        attachButton.addEventListener('click', () => attachmentPicker.click());
        attachmentPicker.addEventListener('change', event => {
            if (event.target.files?.length) uploadPickedAttachments([...event.target.files]);
            event.target.value = '';
        });
    }
    $('refresh-all').addEventListener('click', async () => {
        state.workspaceData = null;
        await refreshAll();
        if (state.selectedProjectId) await loadWorkspaces(state.selectedProjectId);
    });
    $('refresh-files').addEventListener('click', () => { state.directoryCache.clear(); loadDirectory('', true); });
    $('refresh-git').addEventListener('click', refreshGit);
    $('fetch-branches').addEventListener('click', fetchBranches);
    $('project-search').addEventListener('input', renderTree);
    $('file-search').addEventListener('input', renderFileTree);
    $('project-form').addEventListener('submit', createProject);
    $('agent-form').addEventListener('submit', createAgent);
    $('handoff-prepare').addEventListener('click', prepareAgentHandoff);
    $('handoff-confirm').addEventListener('click', confirmAgentHandoff);
    $('handoff-cancel').addEventListener('click', async () => {
        await cancelPreparedHandoff();
        if ($('handoff-dialog').open) $('handoff-dialog').close();
    });
    $('handoff-dialog').addEventListener('close', () => {
        if (state.handoff) cancelPreparedHandoff();
    });
    $('handoff-dialog').addEventListener('cancel', event => {
        // Confirmation has crossed the explicit commit point; keep the result visible.
        if (state.handoff?.busy && state.handoff.operationId) event.preventDefault();
    });
    $('worktree-form').addEventListener('submit', createWorktree);
    $('rename-project-form').addEventListener('submit', renameProject);
    $('confirm-dialog').addEventListener('close', () => {
        const resolve = state.confirmResolver;
        state.confirmResolver = null;
        resolve?.($('confirm-dialog').returnValue === 'confirm');
    });
    $('context-menu').addEventListener('keydown', handleContextMenuKeydown);
    document.addEventListener('pointerdown', event => {
        const menu = $('context-menu');
        if (!menu.hidden && !menu.contains(event.target)) closeContextMenu(false);
    });
    window.addEventListener('resize', () => closeContextMenu(false));
    window.addEventListener('resize', () => {
        updateMobileDrawerState();
        if (state.terminalExpanded) setTerminalHeight(state.terminalHeight);
        const tab = activeTab();
        if (tab?.type === 'diff' && tab.diffData) {
            disposeMergeView();
            renderGitDiffTab(tab);
        }
    });
    window.addEventListener('webconsole:viewportchange', () => {
        updateMobileDrawerState();
        if (state.terminalExpanded) setTerminalHeight(state.terminalHeight);
        requestTerminalFrameResize($('terminal-frame'));
        requestTerminalFrameResize($('shell-frame'));
    });
    window.addEventListener('scroll', () => closeContextMenu(false), true);
    $('worktree-base').addEventListener('change', updateWorktreeBranchDefaults);
    $('terminal-loading-retry').addEventListener('click', retryTerminalFrame);
    $('existing-branch').addEventListener('change', () => {
        const option = $('worktree-base').selectedOptions[0];
        const branchName = option?.dataset.name || '';
        if ($('existing-branch').checked) $('worktree-branch').value = branchName;
        else if ($('worktree-branch').value === branchName) $('worktree-branch').value = `${branchName}-work`;
        $('worktree-branch').disabled = $('existing-branch').checked;
    });
    $('new-worktree').addEventListener('click', () => openWorktreeDialog());
    $('branch-picker').addEventListener('change', event => {
        const value = event.target.value;
        if (value.startsWith('workspace:')) selectWorkspace(value.slice('workspace:'.length));
        else if (value.startsWith('branch:')) {
            const ref = value.slice('branch:'.length);
            const index = (selectedWorkspace()?.git?.branches || []).findIndex(branch => branch.ref === ref);
            if (index >= 0) openWorktreeDialog(index);
        }
        event.target.value = '';
    });
    $('message-form').addEventListener('submit', sendMessage);
    $('save-file').addEventListener('click', () => saveFile().catch(error => toast(error.message)));
    $('reload-file').addEventListener('click', async () => {
        const tab = activeTab(); if (!tab) return;
        if (tab.type === 'diff') { renderGitDiffTab(tab, true); return; }
        if (tab.type !== 'file') return;
        try { await reloadFile(tab); }
        catch (error) { toast(error.message); }
    });
    document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
    window.addEventListener('message', handleActionResult);
    window.addEventListener('message', handleTerminalMessage);
    $('terminal-frame')?.addEventListener('load', () => {
        requestTerminalFrameResize($('terminal-frame'));
        renderAgentControls();
    });
    $('shell-frame')?.addEventListener('load', () => {
        const content = $('terminal-drawer-content');
        if (content && !content.hidden) requestTerminalFrameResize($('shell-frame'));
    });
    const resizeObserver = new ResizeObserver(() => {
        const frame = $('terminal-frame');
        if (frame && !frame.hidden && frame.getBoundingClientRect().width > 0 && frame.getBoundingClientRect().height > 0) {
            requestTerminalFrameResize(frame);
        }
        const shell = $('shell-frame');
        const shellContent = $('terminal-drawer-content');
        if (shell && shellContent && !shell.hidden && !shellContent.hidden
            && shell.getBoundingClientRect().width > 0 && shell.getBoundingClientRect().height > 0) {
            requestTerminalFrameResize(shell);
        }
    });
    const workSurface = $('work-surface');
    if (workSurface) resizeObserver.observe(workSurface);
    const agentFrame = $('terminal-frame');
    if (agentFrame) resizeObserver.observe(agentFrame);
    if ($('workspace-terminal')) resizeObserver.observe($('workspace-terminal'));
    $('toggle-projects').addEventListener('click', event => {
        setMobileDrawer('projects', !$('project-sidebar').classList.contains('open'), event.currentTarget);
    });
    $('toggle-inspector').addEventListener('click', event => {
        setMobileDrawer('inspector', !document.body.classList.contains('inspector-open'), event.currentTarget);
    });
    $('mobile-drawer-backdrop')?.addEventListener('click', () => closeMobileDrawers(true));
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
        const open = $('project-sidebar').classList.contains('open') || document.body.classList.contains('inspector-open');
        if (open) { event.preventDefault(); closeMobileDrawers(true); }
    });
    updateMobileDrawerState();
    document.addEventListener('visibilitychange', () => {
        clearTimeout(state.pollTimer);
        if (!document.hidden) refreshAll();
    });
    window.addEventListener('online', refreshAll);
}

document.addEventListener('DOMContentLoaded', () => {
    attachEvents();
    refreshAll();
});
