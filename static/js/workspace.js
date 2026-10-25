// Project workspace: project/worktree navigation, persistent terminal tabs and bounded file editing.
const $ = id => document.getElementById(id);
const apiResponseCache = new Map();
const state = {
    projects: [], sessions: [], workspaceData: null, selectedProjectId: null,
    selectedWorkspaceId: null, selectedSessionId: null, tabs: [], activeTabId: null,
    mobileSurface: 'agents', mobileFilesBrowser: false, inspectorTab: 'files',
    sidebarVisibility: {projects:true, inspector:true},
    browserNotificationsEnabled: false, notificationFingerprints: new Map(),
    notificationFingerprintBaselineReady: false, notificationTrackingStartedAt: Date.now(),
    explorerMode: 'names', historyScope: 'workspace', searchGeneration: 0,
    gitStats: {}, gitStatsWorkspaceId: null, gitHistory: [], gitHistoryWorkspaceId: null,
    nameSearchResponse: null, nameSearchWorkspaceId: null, gitCommitDrafts: new Map(),
    gitCommitDraftWorkspaceId: null,
    expandedProjects: new Set(), expandedWorkspaces: new Set(), directoryCache: new Map(),
    gitCollapsedSections: new Set(), showDotfiles: true,
    workspacesByProject: new Map(), workspaceLoads: new Map(), projectsLoaded: false,
    terminalViews: new Map(),
    fileGeneration: 0, frameSessionId: null, pendingAction: null, actionTimer: null,
    pollTimer: null, busy: false, messages: [], shellFrameSessionId: null, nextInventoryRefreshAt: 0,
    terminalPrefsWorkspaceId: null, terminalExpanded: false, terminalHeight: 230, terminalAppliedHeight: 230,
    pendingAttachments: [],
    handoff: null,
    contextMenuTrigger: null, confirmResolver: null, renameProjectId: null, mobileDrawerTrigger: null,
    terminalFrameReady: false,
    projectSource: 'folder', directoryTarget: 'folder', directoryPath: '',
    directoryEntries: [],
    githubStatus: null, githubRepo: null, githubBranch: '', githubRepos: [],
    preferences: null,
};
const WORKSPACE_INVENTORY_REFRESH_MS = 5 * 60 * 1000;
const SESSION_NOTIFICATION_POLL_MS = 5000;
const BROWSER_NOTIFICATIONS_KEY = 'webconsole.browserNotifications';
const NOTIFICATION_FINGERPRINTS_KEY = 'webconsole.agentNotificationFingerprints';
const launcherNames = {opencode: 'OpenCode', codex: 'Codex', hermes: 'Hermes', terminal: 'Terminal'};
let currentEditorView = null;
let currentEditorTabId = null;
let currentMergeView = null;
let currentMergeTabId = null;
let navigationHistory = null;
let navigationTimer = null;
let restoringNavigation = false;
let markdownTimer = null;
let githubSearchTimer = null;
let workspaceSearchTimer = null;
const editorBundlePromises = new Map();
const terminalFrameResizeTimers = new WeakMap();
const terminalFrameLoadBound = new WeakSet();
let terminalResizeObserver = null;

function terminalViewFor(sessionId) {
    return state.terminalViews.get(sessionId) || null;
}
function terminalFrameFor(sessionId) {
    return terminalViewFor(sessionId)?.frame || null;
}
function activeTerminalFrame() {
    return terminalFrameFor(state.frameSessionId);
}
function terminalViewFromSource(source) {
    for (const view of state.terminalViews.values()) {
        if (view.frame.contentWindow === source) return view;
    }
    return null;
}
function ensureTerminalView(session) {
    let view = terminalViewFor(session.id);
    if (view) return view;
    let frame = $('terminal-frame');
    if ([...state.terminalViews.values()].some(item => item.frame === frame)) frame = null;
    if (!frame) {
        frame = document.createElement('iframe');
        frame.title = `Terminal de ${session.title || agentName(session)}`;
        frame.allow = 'clipboard-write';
        frame.hidden = true;
        frame.dataset.sessionId = session.id;
        $('work-surface').append(frame);
    } else {
        frame.dataset.sessionId = session.id;
    }
    frame.title = `Terminal de ${session.title || agentName(session)}`;
    view = {sessionId:session.id, frame, ready:false, loaded:false, loadTimer:null, mobileDraftDirty:false};
    state.terminalViews.set(session.id, view);
    terminalResizeObserver?.observe(frame);
    if (!terminalFrameLoadBound.has(frame)) {
        terminalFrameLoadBound.add(frame);
        frame.addEventListener('load', () => {
            requestTerminalFrameResize(frame);
            if (activeTerminalFrame() === frame) renderAgentControls();
        });
    }
    return view;
}
function disposeTerminalView(sessionId) {
    const view = terminalViewFor(sessionId);
    if (!view) return;
    clearTimeout(view.loadTimer);
    notifyTerminalFrameVisibility(view.frame, false, true);
    view.frame.src = 'about:blank';
    terminalResizeObserver?.unobserve(view.frame);
    if (view.frame.id !== 'terminal-frame') view.frame.remove();
    else view.frame.hidden = true;
    state.terminalViews.delete(sessionId);
}
function deactivateTerminalViews(activeSessionId = null) {
    for (const [sessionId, view] of state.terminalViews) {
        const visible = sessionId === activeSessionId;
        view.frame.hidden = !visible;
        notifyTerminalFrameVisibility(view.frame, visible, !visible);
    }
}

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
    const useCache = options.cache !== false;
    if (method === 'GET' && !useCache) apiResponseCache.delete(url);
    const fetchOptions = {...options};
    delete fetchOptions.cache;
    const cached = method === 'GET' && useCache ? apiResponseCache.get(url) : null;
    const headers = {'X-WebConsole': '1', ...options.headers};
    if (cached?.etag && !headers['If-None-Match']) headers['If-None-Match'] = cached.etag;
    const response = await fetch(url, {...fetchOptions, headers});
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
    if (method === 'GET' && useCache) {
        const etag = response.headers.get('ETag');
        if (etag) apiResponseCache.set(url, {etag, data});
        else apiResponseCache.delete(url);
    } else if (method !== 'GET') {
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
function debounce(callback, delay) {
    return (...args) => {
        clearTimeout(githubSearchTimer);
        githubSearchTimer = setTimeout(() => callback(...args), delay);
    };
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
function inventoryRefreshDue(now = Date.now()) {
    return !state.nextInventoryRefreshAt || now >= state.nextInventoryRefreshAt;
}
function setSidebarVisibility(side, visible, {persist = true} = {}) {
    if (!['projects', 'inspector'].includes(side)) return false;
    const isVisible = Boolean(visible);
    state.sidebarVisibility[side] = isVisible;
    const isProjects = side === 'projects';
    const workbench = $('workbench');
    const collapse = $(isProjects ? 'collapse-project-sidebar' : 'collapse-inspector-sidebar');
    const restore = $(isProjects ? 'restore-project-sidebar' : 'restore-inspector-sidebar');
    const label = `${isVisible ? 'Ocultar' : 'Mostrar'} ${isProjects ? 'proyectos' : 'inspector'}`;
    workbench?.classList.toggle(isProjects ? 'project-sidebar-hidden' : 'inspector-hidden', !isVisible);
    for (const button of [collapse, restore]) {
        button?.setAttribute('aria-expanded', String(isVisible));
        button?.setAttribute('aria-label', label);
        button?.setAttribute('title', label);
    }
    if (collapse) collapse.hidden = !isVisible;
    if (restore) restore.hidden = isVisible;
    if (persist) {
        try { localStorage.setItem(`webconsole.${isProjects ? 'project' : 'inspector'}SidebarHidden`, String(!isVisible)); } catch (_) {}
    }
    return true;
}

function toggleSidebarVisibility(side) {
    if (window.innerWidth <= 1050) return;
    const visible = !state.sidebarVisibility[side];
    setSidebarVisibility(side, visible);
    const target = $(visible
        ? side === 'projects' ? 'collapse-project-sidebar' : 'collapse-inspector-sidebar'
        : side === 'projects' ? 'restore-project-sidebar' : 'restore-inspector-sidebar');
    target?.focus({preventScroll:true});
}

const INSPECTOR_TABS = [
    {id:'files', button:'inspector-tab-files', panel:'explorer-section'},
    {id:'history', button:'inspector-tab-history', panel:'history-section'},
    {id:'git', button:'inspector-tab-git', panel:'git-section'},
    {id:'messages', button:'inspector-tab-messages', panel:'message-section'},
];
function setInspectorTab(tab, {focus = false, persist = true} = {}) {
    if (!INSPECTOR_TABS.some(item => item.id === tab)) return false;
    state.inspectorTab = tab;
    for (const item of INSPECTOR_TABS) {
        const selected = item.id === tab;
        const button = $(item.button);
        const panel = $(item.panel);
        button?.setAttribute('aria-selected', String(selected));
        if (button) button.tabIndex = selected ? 0 : -1;
        if (panel) panel.hidden = !selected;
    }
    if (persist) {
        try { localStorage.setItem('webconsole.inspectorTab', tab); } catch (_) {}
    }
    if (focus) $(INSPECTOR_TABS.find(item => item.id === tab)?.button)?.focus();
    return true;
}
function setExplorerMode(mode, {focus = false} = {}) {
    if (!['names', 'content'].includes(mode)) return false;
    state.explorerMode = mode;
    for (const button of document.querySelectorAll('[data-explorer-mode]')) {
        const selected = button.dataset.explorerMode === mode;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
    }
    $('explorer-names-panel').hidden = mode !== 'names';
    $('explorer-content-panel').hidden = mode !== 'content';
    if (focus) $(mode === 'names' ? 'file-search' : 'content-search')?.focus();
    if (mode === 'content' && $('content-search').value.trim()) runWorkspaceSearch();
    return true;
}
function handleInspectorTabKeydown(event) {
    const button = event.target.closest?.('[data-inspector-tab]');
    const index = INSPECTOR_TABS.findIndex(item => item.id === button?.dataset.inspectorTab);
    if (index < 0) return;
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % INSPECTOR_TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index + INSPECTOR_TABS.length - 1) % INSPECTOR_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = INSPECTOR_TABS.length - 1;
    else return;
    event.preventDefault();
    setInspectorTab(INSPECTOR_TABS[nextIndex].id, {focus:true});
}
function mobileViewport() {
    return window.matchMedia('(max-width:650px)').matches;
}
function setMobileSurface(surface, {filesBrowser} = {}) {
    if (!['agents', 'files', 'history', 'git', 'messages'].includes(surface)) return;
    if (surface === 'files') {
        const tab = activeTab();
        state.mobileFilesBrowser = filesBrowser ?? (tab?.type !== 'file');
    } else state.mobileFilesBrowser = false;
    state.mobileSurface = surface;
    if (['history', 'git', 'messages'].includes(surface) || surface === 'files' && state.mobileFilesBrowser) {
        setInspectorTab(surface === 'files' ? 'files' : surface);
    }
    document.body.classList.remove('mobile-keyboard-open');
    for (const name of ['agents', 'files', 'history', 'git', 'messages']) {
        document.body.classList.toggle(`mobile-surface-${name}`, surface === name);
    }
    document.body.classList.toggle('mobile-files-browser', surface === 'files' && state.mobileFilesBrowser);
    for (const button of document.querySelectorAll('[data-mobile-surface]')) {
        if (button.dataset.mobileSurface === surface) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    if (surface === 'files' && state.selectedWorkspaceId
            && !state.directoryCache.has(`${state.selectedWorkspaceId}:`)) loadDirectory('');
    updateMobileDrawerState();
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
    return agentIndicator(session).label;
}
function agentIndicator(session) {
    if (!session) return {status:'idle', label:'Desconectado', estimated:false};
    const notice = session.notification;
    const current = session.state || 'idle';
    const estimated = session.state_source === 'estimated';
    if (current === 'working') {
        if (estimated) return {status:'unconfirmed', label:'Actividad detectada · turno no confirmado', estimated:true};
        return {status:'working', label:'Trabajando', estimated:false};
    }
    if (current === 'done') {
        return estimated
            ? {status:'unconfirmed', label:'Finalización no confirmada', estimated:true}
            : {status:'done', label:'Turno completado', estimated:false};
    }
    if (current === 'failed') {
        return estimated
            ? {status:'unconfirmed', label:'Error no confirmado', estimated:true}
            : {status:'failed', label:'Error del agente', estimated:false};
    }
    if (notice?.kind === 'completed' && notice.source === 'process'
            && (!session.state || current === 'ended'
                || (current === 'idle' && (!session.state_source || session.state_source === 'process')))) {
        return {status:'ended', label:'Proceso finalizado', estimated:false};
    }
    if (current === 'ended' || session.ended === true || session.is_active === false) {
        return {status:'ended', label:'Sesión finalizada', estimated:false};
    }
    if (current === 'permission' || notice?.kind === 'permission') {
        const likely = estimated || notice?.source === 'screen';
        return {status:'permission', label:likely ? 'Posible solicitud de permiso' : 'Necesita permiso', estimated:likely};
    }
    if (current === 'interrupted' || notice?.kind === 'interrupted') {
        return {status:'interrupted', label:'Interrumpido', estimated:false};
    }
    if (current === 'unconfirmed' || notice?.kind === 'unconfirmed') {
        return {status:'unconfirmed', label:'No se pudo confirmar', estimated:true};
    }
    if (current === 'monitoring') return {status:'monitoring', label:'Supervisando en segundo plano', estimated:false};
    if (!session.state && notice?.kind === 'error') return {status:'failed', label:'Error del agente', estimated:false};
    if (!session.state && notice?.kind === 'completed' && notice.source === 'event') {
        return {status:'done', label:'Turno completado', estimated:false};
    }
    if (current === 'idle' && estimated) {
        return {status:'unconfirmed', label:'Turno no confirmado', estimated:true};
    }
    return {status:'idle', label:'En espera', estimated:false};
}

function formatAgentNotification(session, notice) {
    const name = agentName(session);
    let title;
    let body = notice.message || '';
    if (notice.kind === 'completed') {
        if (notice.source === 'process') {
            title = `${name} finalizó su proceso`;
            body = `${body}${body ? ' ' : ''}El fin del proceso no confirma por sí solo que la tarea esté completa.`;
        } else title = `${name} terminó su turno`;
    } else if (notice.kind === 'permission') {
        title = notice.source === 'screen' ? `${name} podría necesitar asistencia` : `${name} necesita tu permiso`;
        if (notice.source === 'screen') body = `Detección estimada en pantalla: ${body}`;
    } else if (notice.kind === 'error') title = `${name} notificó un error`;
    else return null;
    return {title, body};
}

function showAgentBrowserNotification(session, notice) {
    const NotificationAPI = window.Notification;
    if (!state.browserNotificationsEnabled || !NotificationAPI || NotificationAPI.permission !== 'granted') return false;
    const content = formatAgentNotification(session, notice);
    if (!content) return false;
    try {
        const popup = new NotificationAPI(content.title, {
            body: content.body,
            tag: `${session.id}:${notice.fingerprint}`,
        });
        popup.onclick = () => {
            window.focus();
            popup.close?.();
        };
        return true;
    } catch (_) { return false; }
}

function persistAgentNotificationFingerprints() {
    try {
        localStorage.setItem(NOTIFICATION_FINGERPRINTS_KEY, JSON.stringify(Object.fromEntries(state.notificationFingerprints)));
    } catch (_) {}
}

function processAgentNotifications(sessions) {
    for (const session of sessions || []) {
        if (!session?.id) continue;
        const notice = session.notification;
        const fingerprint = typeof notice?.fingerprint === 'string' && notice.fingerprint ? notice.fingerprint : null;
        const known = state.notificationFingerprints;
        const wasKnown = known.has(session.id);
        const noticeAt = Number(notice?.at);
        const newSessionEvent = !wasKnown && Number.isFinite(noticeAt)
            && noticeAt * 1000 >= state.notificationTrackingStartedAt;
        const changedNotice = state.notificationFingerprintBaselineReady && wasKnown
            && fingerprint && fingerprint !== known.get(session.id);
        if (fingerprint && (changedNotice || newSessionEvent)) {
            showAgentBrowserNotification(session, notice);
        }
        known.set(session.id, fingerprint);
    }
    state.notificationFingerprintBaselineReady = true;
    persistAgentNotificationFingerprints();
}

function syncBrowserNotificationControls() {
    const toggle = $('pref-browser-notifications');
    const status = $('browser-notifications-status');
    const NotificationAPI = window.Notification;
    if (toggle) {
        toggle.checked = state.browserNotificationsEnabled;
        toggle.disabled = !NotificationAPI || NotificationAPI.permission === 'denied';
    }
    if (!status) return;
    if (!NotificationAPI) status.textContent = 'Este navegador no admite notificaciones del sistema.';
    else if (NotificationAPI.permission === 'denied') status.textContent = 'El navegador las bloqueó. Cambia el permiso de este sitio en la configuración del navegador.';
    else if (state.browserNotificationsEnabled) status.textContent = 'Activas para nuevas finalizaciones y solicitudes de asistencia.';
    else if (NotificationAPI.permission === 'granted') status.textContent = 'Permiso concedido; activa la opción para recibir avisos.';
    else status.textContent = 'Al activarlas, el navegador solicitará permiso. No se concede automáticamente.';
}

function loadAgentNotificationPreferences() {
    try {
        state.browserNotificationsEnabled = localStorage.getItem(BROWSER_NOTIFICATIONS_KEY) === 'true';
        const saved = JSON.parse(localStorage.getItem(NOTIFICATION_FINGERPRINTS_KEY) || 'null');
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            state.notificationFingerprints = new Map(Object.entries(saved).filter(([, value]) => value === null || typeof value === 'string'));
            state.notificationFingerprintBaselineReady = true;
        }
    } catch (_) {}
    const NotificationAPI = window.Notification;
    if (!NotificationAPI || NotificationAPI.permission !== 'granted') state.browserNotificationsEnabled = false;
    syncBrowserNotificationControls();
}

function setBrowserNotificationsEnabled(enabled) {
    state.browserNotificationsEnabled = Boolean(enabled);
    try { localStorage.setItem(BROWSER_NOTIFICATIONS_KEY, String(state.browserNotificationsEnabled)); } catch (_) {}
    syncBrowserNotificationControls();
}

async function handleBrowserNotificationPreferenceChange(event) {
    const toggle = event.currentTarget;
    if (!toggle.checked) {
        setBrowserNotificationsEnabled(false);
        return;
    }
    const NotificationAPI = window.Notification;
    if (!NotificationAPI) {
        setBrowserNotificationsEnabled(false);
        return;
    }
    try {
        const permission = NotificationAPI.permission === 'default'
            ? await NotificationAPI.requestPermission() : NotificationAPI.permission;
        setBrowserNotificationsEnabled(permission === 'granted');
    } catch (_) {
        setBrowserNotificationsEnabled(false);
    }
}

function projectWorkspace(projectId, workspaceId) {
    if (state.workspaceData?.project?.id === projectId) {
        return state.workspaceData.workspaces.find(item => item.id === workspaceId) || null;
    }
    return state.workspacesByProject.get(projectId)?.workspaces?.find(item => item.id === workspaceId) || null;
}

async function refreshAll({refreshOpen = false} = {}) {
    if (state.busy) return;
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (!state.nextInventoryRefreshAt) state.nextInventoryRefreshAt = Date.now() + WORKSPACE_INVENTORY_REFRESH_MS;
    if (refreshOpen) state.nextInventoryRefreshAt = Date.now() + WORKSPACE_INVENTORY_REFRESH_MS;
    state.busy = true;
    try {
        const requests = [api('/api/sessions', {cache:false})];
        if (!state.projectsLoaded) requests.push(api('/api/projects', {cache:false}));
        const [sessionData, projectData] = await Promise.all(requests);
        if (projectData) {
            state.projects = projectData.projects || [];
            state.projectsLoaded = true;
        }
        state.sessions = sessionData.sessions || [];
        processAgentNotifications(state.sessions);
        renderAgentHistory();
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
        const selectedProjectOpen = state.selectedProjectId && state.expandedProjects.has(state.selectedProjectId);
        if (selectedProjectOpen && !state.workspaceData) await loadWorkspaces(state.selectedProjectId);
        else if (state.selectedProjectId) refreshWorkspaceAgentCounts();
        if (!state.projects.length) renderCenter();
        if (state.selectedProjectId) loadMessages(state.selectedProjectId).catch(() => {});
        const projectsToRefresh = new Set(state.expandedProjects);
        for (const tab of state.tabs) {
            const session = tab.type === 'terminal' && (sessionFor(tab.sessionId) || tab.session);
            if (session?.project_id) projectsToRefresh.add(session.project_id);
        }
        for (const projectId of projectsToRefresh) {
            if (refreshOpen) {
                loadProjectWorkspaces(projectId, {force:true}).then(data => {
                    if (data && state.selectedProjectId === projectId) {
                        state.workspaceData = data;
                        renderWorkspaceChrome();
                        renderTree();
                    }
                }).catch(() => {});
            } else if (!state.workspacesByProject.has(projectId)) {
                loadProjectWorkspaces(projectId).catch(() => {});
            }
        }
        renderTree();
    } catch (error) {
        setStatus('No se pudo actualizar el workspace', 'warning');
        if (!state.projects.length) {
            $('welcome-title').textContent = 'No se pudo cargar el workspace';
            $('welcome-copy').textContent = error.message;
        }
    } finally {
        state.busy = false;
        if (!document.hidden) {
            const inventoryDelay = Math.max(0, state.nextInventoryRefreshAt - Date.now());
            const delay = Math.min(SESSION_NOTIFICATION_POLL_MS, inventoryDelay);
            state.pollTimer = setTimeout(() => refreshAll({refreshOpen:inventoryRefreshDue()}), delay);
        }
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

function loadProjectWorkspaces(projectId, {force = false} = {}) {
    if (!force && state.workspacesByProject.has(projectId)) return Promise.resolve(state.workspacesByProject.get(projectId));
    if (state.workspaceLoads.has(projectId)) return state.workspaceLoads.get(projectId);
    const request = api(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, {cache:false})
        .then(data => {
            if (!state.projects.some(project => project.id === projectId)) return null;
            state.workspacesByProject.set(projectId, data);
            renderTree();
            return data;
        })
        .finally(() => {
            if (state.workspaceLoads.get(projectId) === request) state.workspaceLoads.delete(projectId);
        });
    state.workspaceLoads.set(projectId, request);
    return request;
}

async function loadWorkspaces(projectId, {force = false} = {}) {
    const data = await loadProjectWorkspaces(projectId, {force});
    if (projectId !== state.selectedProjectId) return;
    if (!data) return;
    state.workspaceData = data;
    if (!data.workspaces.some(item => item.id === state.selectedWorkspaceId)) {
        state.selectedWorkspaceId = data.workspaces[0]?.id || null;
    }
    if (state.selectedWorkspaceId) state.expandedWorkspaces.add(state.selectedWorkspaceId);
    state.directoryCache.clear();
    state.searchGeneration++;
    state.nameSearchResponse = null;
    state.nameSearchWorkspaceId = null;
    renderTree();
    renderCenter();
    renderWorkspaceChrome();
    if (state.explorerMode === 'names' && $('file-search').value.trim()) scheduleWorkspaceSearch('names');
    else if (state.explorerMode === 'content' && $('content-search').value.trim()) scheduleWorkspaceSearch('content');
    await Promise.all([loadDirectory(''), refreshMessagesAndGit()]);
}

async function selectWorkspaceInProject(projectId, workspaceId) {
    if (state.selectedProjectId !== projectId || !state.workspaceData) await selectProject(projectId);
    if (state.selectedProjectId === projectId) selectWorkspace(workspaceId);
}

function toggleProjectExpansion(projectId) {
    if (state.expandedProjects.has(projectId)) state.expandedProjects.delete(projectId);
    else {
        state.expandedProjects.add(projectId);
        if (!state.workspacesByProject.has(projectId)) loadProjectWorkspaces(projectId).catch(() => renderTree());
    }
    renderTree();
}
function toggleWorkspaceExpansion(workspaceId) {
    if (state.expandedWorkspaces.has(workspaceId)) state.expandedWorkspaces.delete(workspaceId);
    else state.expandedWorkspaces.add(workspaceId);
    renderTree();
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
    state.searchGeneration++;
    state.nameSearchResponse = null;
    state.nameSearchWorkspaceId = null;
    const tab = activeTab();
    const associated = tab?.type === 'terminal' ? (sessionFor(tab.sessionId) || tab.session)?.workspace_id : tab?.workspaceId;
    if (associated && associated !== workspaceId) state.activeTabId = null;
    state.directoryCache.clear();
    renderTree();
    renderCenter();
    renderWorkspaceChrome();
    if (state.explorerMode === 'names' && $('file-search').value.trim()) scheduleWorkspaceSearch('names');
    else if (state.explorerMode === 'content' && $('content-search').value.trim()) scheduleWorkspaceSearch('content');
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
    const inspectorSurface = projectsDrawer && (
        ['history', 'git', 'messages'].includes(state.mobileSurface)
        || state.mobileSurface === 'files' && state.mobileFilesBrowser
    );
    const inspectorOpen = inspectorDrawer && document.body.classList.contains('inspector-open');
    const projectsButton = $('toggle-projects');
    const inspectorButton = $('toggle-inspector');
    projectsButton?.setAttribute('aria-expanded', String(projectsOpen));
    projectsButton?.setAttribute('aria-label', projectsOpen ? 'Ocultar proyectos' : 'Mostrar proyectos');
    inspectorButton?.setAttribute('aria-expanded', String(inspectorOpen));
    inspectorButton?.setAttribute('aria-label', inspectorOpen ? 'Ocultar inspector' : 'Mostrar inspector');
    projects.inert = projectsDrawer && !projectsOpen;
    inspector.inert = inspectorDrawer && !inspectorOpen && !inspectorSurface;
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

function notifyTerminalFrameVisibility(frame, visible, immediate = false) {
    // A hidden terminal must release its tmux attach instead of waiting for a
    // render-lag watchdog to declare the view stale. The iframe cannot always
    // observe its own display:none reliably, so the workspace tells it directly.
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage({type:'webconsole:view-visibility', visible: Boolean(visible), immediate}, window.location.origin);
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
    const mobileShellToggle = $('mobile-shell-open');
    const content = $('terminal-drawer-content');
    const frame = $('shell-frame');
    toggle.disabled = !workspace;
    if (mobileShellToggle) mobileShellToggle.disabled = !workspace;
    toggle.setAttribute('aria-expanded', String(Boolean(workspace && state.terminalExpanded)));
    toggle.setAttribute('aria-label', state.terminalExpanded ? 'Plegar terminal del workspace' : 'Abrir terminal del workspace');
    drawer.classList.toggle('expanded', Boolean(workspace && state.terminalExpanded));
    document.body.classList.toggle('workspace-shell-open', Boolean(workspace && state.terminalExpanded));
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
    const frame = activeTerminalFrame();
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
        requestTerminalFrameResize(activeTerminalFrame());
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
        && state.frameSessionId === sessionId && activeTerminalFrame()?.contentWindow);
}

function insertAttachment(attachment) {
    if (!canInsertForSession(attachment.session_id)) {
        toast('Vuelve a la pestaña de esa sesión cuando esté lista para insertar la referencia.');
        return;
    }
    attachment.inserting = true;
    renderAttachmentTray();
    activeTerminalFrame().contentWindow.postMessage({
        type: 'webconsole:insert-attachment', session_id: attachment.session_id, attachment_id: attachment.id,
    }, window.location.origin);
}

function uploadPickedAttachments(files) {
    const session = currentAgentSession();
    if (!session || sessionEnded(session) || session.state === 'permission') {
        toast('Selecciona una sesión de agente que esté lista para recibir entrada.');
        return;
    }
    const frame = activeTerminalFrame();
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
        const loadedWorktrees = (state.workspacesByProject.get(item.id)?.workspaces || [])
            .filter(workspace => workspace.kind === 'managed_worktree').length;
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
            menuEntry('Seleccionar workspace', () => selectWorkspaceInProject(item.project_id, item.id)),
            menuEntry('Crear agente', async () => { await selectWorkspaceInProject(item.project_id, item.id); openAgentDialog(); }),
            menuEntry('Abrir terminal', async () => { await selectWorkspaceInProject(item.project_id, item.id); setTerminalExpanded(true); }),
            menuEntry('Crear worktree', async () => { await selectWorkspaceInProject(item.project_id, item.id); openWorktreeDialog(); }, {
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
        disposeTerminalView(session.id);
        if (state.frameSessionId === session.id) {
            state.frameSessionId = null;
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
        for (const tab of removedTabs) if (tab.type === 'terminal') disposeTerminalView(tab.sessionId);
        state.tabs = state.tabs.filter(tab => !removedTabs.includes(tab));
        const activeWasRemoved = removedTabs.some(tab => tab.id === state.activeTabId);
        if (activeWasRemoved) { state.activeTabId = null; state.selectedSessionId = null; }
        state.projects = state.projects.filter(item => item.id !== project.id);
        state.workspacesByProject.delete(project.id);
        state.workspaceLoads.delete(project.id);
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
    const project = state.projects.find(item => item.id === workspace.project_id);
    const projectData = project && state.workspacesByProject.get(project.id);
    if (!project || !projectData?.workspaces.some(item => item.id === workspace.id)) {
        toast('Actualiza el proyecto antes de retirar este workspace.');
        return;
    }
    if (!await confirmDangerousAction({
        title:'¿Retirar este worktree?',
        copy:`Se retirará el worktree limpio «${workspace.name}» en ${workspace.worktree_root}. Se conserva su rama Git. No se puede deshacer.`,
        confirmLabel:'Retirar worktree',
    })) return;
    const projectId = project.id;
    const affectsSelectedProject = state.selectedProjectId === projectId;
    const active = activeTab();
    const activeWorkspaceId = affectsSelectedProject ? (active?.type === 'terminal'
        ? (sessionFor(active.sessionId) || active.session)?.workspace_id : active?.workspaceId) : null;
    try {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {method:'DELETE'});
        const cached = state.workspacesByProject.get(projectId);
        if (cached) cached.workspaces = cached.workspaces.filter(item => item.id !== workspace.id);
        const projectRecord = state.projects.find(item => item.id === projectId);
        if (projectRecord) {
            projectRecord.workspace_count = Math.max(0, (projectRecord.workspace_count || 0) - 1);
            projectRecord.managed_worktree_count = Math.max(0, (projectRecord.managed_worktree_count || 0) - 1);
        }
        const removedTabs = state.tabs.filter(tab => tab.type === 'file' && tab.workspaceId === workspace.id
            || tab.type === 'terminal' && (sessionFor(tab.sessionId) || tab.session)?.workspace_id === workspace.id);
        for (const tab of removedTabs) if (tab.type === 'terminal') disposeTerminalView(tab.sessionId);
        state.tabs = state.tabs.filter(tab => !removedTabs.includes(tab));
        if (removedTabs.some(tab => tab.id === state.activeTabId)) {
            state.activeTabId = null; state.selectedSessionId = null;
        }
        state.directoryCache.clear();
        if (affectsSelectedProject) {
            state.workspaceData = projectData;
            state.selectedWorkspaceId = activeWorkspaceId && activeWorkspaceId !== workspace.id
                ? activeWorkspaceId : projectData.workspaces[0]?.id || null;
            state.terminalPrefsWorkspaceId = null;
            await loadWorkspaces(projectId, {force:true});
        } else {
            renderTree();
        }
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
        toggle.addEventListener('click', () => toggleProjectExpansion(project.id));
        const quickAdd = node('button', 'tree-add', '+');
        quickAdd.type = 'button'; quickAdd.title = 'Crear agente en este proyecto'; quickAdd.setAttribute('aria-label', `Crear agente en ${project.name}`);
        quickAdd.addEventListener('click', event => { event.stopPropagation(); selectProject(project.id).then(openAgentDialog); });
        const context = node('button', 'tree-context', '⋯');
        context.type = 'button'; context.title = 'Opciones del proyecto'; context.setAttribute('aria-label', `Opciones de ${project.name}`);
        context.setAttribute('aria-haspopup', 'menu'); context.setAttribute('aria-expanded', 'false');
        context.addEventListener('click', event => { event.stopPropagation(); openContextMenu('project', project, event); });
        bindContextMenu(row, context, 'project', project);
        row.append(toggle, quickAdd, context); group.append(row);
        if (expanded) {
            const list = node('div', 'workspace-list');
            const projectData = state.workspacesByProject.get(project.id);
            if (!projectData) {
                list.append(node('div', 'sidebar-loading', state.workspaceLoads.has(project.id) ? 'Cargando ramas…' : 'No se pudieron cargar las ramas. Contrae y vuelve a desplegar para reintentar.'));
                group.append(list);
                fragment.append(group);
                continue;
            }
            if (!projectData.workspaces?.length) list.append(node('div', 'no-agents', 'Este proyecto no tiene ramas o workspaces disponibles.'));
            for (const workspace of projectData.workspaces || []) {
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
                workspaceButton.addEventListener('click', () => toggleWorkspaceExpansion(workspace.id));
                const workspaceContext = {...workspace, project_id:project.id};
                workspaceRow.append(workspaceButton);
                const add = node('button', 'tree-add', '+'); add.type = 'button'; add.title = 'Crear agente en este workspace'; add.setAttribute('aria-label', `Crear agente en ${workspace.name}`);
                add.addEventListener('click', event => { event.stopPropagation(); selectWorkspaceInProject(project.id, workspace.id).then(openAgentDialog); });
                const context = node('button', 'tree-context', '⋯');
                context.type = 'button'; context.title = 'Opciones del workspace'; context.setAttribute('aria-label', `Opciones de ${workspace.name}`);
                context.setAttribute('aria-haspopup', 'menu'); context.setAttribute('aria-expanded', 'false');
                context.addEventListener('click', event => { event.stopPropagation(); openContextMenu('workspace', workspaceContext, event); });
                bindContextMenu(workspaceRow, context, 'workspace', workspaceContext);
                workspaceRow.append(add, context); workspaceNode.append(workspaceRow);
                if (isOpen) {
                    const agents = node('div', 'agent-list');
                    const filtered = sessions.filter(session => !query || `${session.title} ${agentName(session)} ${session.id}`.toLocaleLowerCase().includes(query));
                    if (!filtered.length) agents.append(node('div', 'no-agents', 'Sin agentes en este workspace'));
                    for (const agent of filtered) {
                        const agentRow = node('div', `agent-row ${state.selectedSessionId === agent.id ? 'active' : ''}`);
                        const select = node('button', 'agent-select'); select.type = 'button';
                        const indicator = agentIndicator(agent);
                        const statusDot = node('span', `agent-state ${indicator.status}${indicator.estimated ? ' estimated' : ''}`);
                        statusDot.setAttribute('aria-hidden', 'true');
                        select.append(statusDot, node('span', 'agent-name', agent.title || agentName(agent)));
                        select.title = `${agentName(agent)} · ${indicator.label} · ${agent.id}`;
                        select.setAttribute('aria-label', `${agent.title || agentName(agent)} · ${indicator.label}`);
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
            const indicator = agentIndicator(session);
            const statusDot = node('span', `agent-state ${indicator.status}${indicator.estimated ? ' estimated' : ''}`);
            statusDot.setAttribute('aria-hidden', 'true');
            select.append(statusDot, node('span', 'agent-name', session.title || agentName(session)));
            select.title = `${agentName(session)} · ${indicator.label} · ${session.id}`;
            select.setAttribute('aria-label', `${session.title || agentName(session)} · ${indicator.label}`);
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
    $('work-title').textContent = workspace?.name || project?.name || 'Workspace';
    $('work-subtitle').textContent = workspace ? `${workspace.path}${workspace.git?.branch ? ` · ${workspace.git.branch}` : ''}` : 'Selecciona un proyecto';
    $('workspace-path').textContent = workspace?.path || '';
    renderExplorerWorkspacePicker();
    $('new-worktree').disabled = !project || !workspace?.git?.is_git;
    $('branch-picker').disabled = !workspace;
    renderBranchPicker();
    renderGit();
    renderAgentHistory();
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
    const view = terminalViewFor(sessionId);
    if (status === 'rendered' && view) {
        view.ready = true;
        clearTimeout(view.loadTimer);
        view.loadTimer = null;
    }
    if ((status === 'ended' || status === 'unavailable') && view) {
        clearTimeout(view.loadTimer);
        view.loadTimer = null;
    }
    if (sessionId !== state.frameSessionId) return;
    state.terminalFrameReady = Boolean(view?.ready);
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
        offline: ['Sin conexión de red', 'La terminal se reconectará cuando vuelva la red.'],
        error: ['Conexión inestable', 'Se volverá a intentar automáticamente.'],
        unavailable: ['Conexión no disponible', 'Revisa el límite de vistas y vuelve a intentarlo.'],
        ended: ['Sesión finalizada', 'El proceso terminó; no se iniciará de nuevo automáticamente.'],
    };
    if (status === 'rendered') {
        loading.hidden = true;
        loading.setAttribute('aria-busy', 'false');
        return;
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
    const view = terminalViewFor(sessionId);
    if (!view) return;
    clearTimeout(view.loadTimer);
    view.loadTimer = setTimeout(() => {
        if (view.ready) return;
        setTerminalFrameStatus(sessionId, 'error');
        if (state.frameSessionId === sessionId) {
            $('terminal-loading-title').textContent = 'La conexión está tardando más de lo normal';
            $('terminal-loading-detail').textContent = 'La sesión no se ha reiniciado. Puedes reintentar la vista.';
        }
    }, 30000);
}

function retryTerminalFrame() {
    const session = sessionFor(state.frameSessionId);
    if (!session?.token) return;
    const frame = activeTerminalFrame();
    state.terminalFrameReady = false;
    const view = terminalViewFor(session.id);
    if (view) view.ready = false;
    setTerminalFrameStatus(session.id, 'loading');
    startTerminalLoadTimer(session.id);
    // Reload only the disposable browser attachment; tmux continues running.
    frame.src = `/c/${encodeURIComponent(session.token)}?embed=1&retry=${Date.now()}`;
}

function renderCenter() {
    renderAgentControls();
    const tab = activeTab();
    const editor = $('editor-view');
    const welcome = $('welcome-view');
    if (!tab) {
        disposeEditorView(); disposeMergeView();
        $('terminal-loading').hidden = true;
        deactivateTerminalViews();
        state.frameSessionId = null; state.terminalFrameReady = false;
        editor.hidden = true; welcome.hidden = false;
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
        const session = sessionFor(tab.sessionId) || tab.session;
        if (!session?.token) {
            deactivateTerminalViews();
            state.frameSessionId = null; state.terminalFrameReady = false;
            $('terminal-loading').hidden = true;
            welcome.hidden = false;
            $('welcome-title').textContent = 'No se puede recuperar esta terminal';
            $('welcome-copy').textContent = 'Actualiza las sesiones; no se ha detenido el proceso tmux.';
            return;
        }
        const view = ensureTerminalView(session);
        deactivateTerminalViews(session.id);
        const frame = view.frame;
        const switched = state.frameSessionId !== session.id;
        state.frameSessionId = session.id;
        state.terminalFrameReady = view.ready;
        frame.hidden = false;
        notifyTerminalFrameVisibility(frame, true);
        if (!view.loaded) {
            view.loaded = true;
            setTerminalFrameStatus(session.id, 'loading');
            startTerminalLoadTimer(session.id);
            frame.src = `/c/${encodeURIComponent(session.token)}?embed=1`;
        } else if (switched && view.ready) {
            $('terminal-loading').hidden = true;
            $('terminal-loading').setAttribute('aria-busy', 'false');
        } else if (!view.ready && (switched || $('terminal-loading').hidden)) {
            setTerminalFrameStatus(session.id, view.loaded ? 'connecting' : 'loading');
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
        requestTerminalFrameResize(frame);
    } else if (tab.type === 'file') {
        disposeMergeView();
        $('terminal-loading').hidden = true;
        deactivateTerminalViews();
        state.frameSessionId = null; state.terminalFrameReady = false;
        editor.hidden = false;
        state.selectedSessionId = null;
        renderEditor(tab);
        if (!restoringNavigation) recordNavigation(tab);
        setStatus(`Editando ${tab.path}${tab.dirty ? ' · sin guardar' : ''}`, tab.dirty ? 'warning' : '');
    } else if (tab.type === 'diff') {
        disposeEditorView();
        $('terminal-loading').hidden = true;
        deactivateTerminalViews();
        state.frameSessionId = null; state.terminalFrameReady = false;
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
    if (mobileViewport()) setMobileSurface('agents');
    if (window.matchMedia('(max-width:650px)').matches) closeMobileDrawers(true);
    state.directoryCache.clear();
    renderTree(); renderWorkspaceChrome(); renderCenter();
    loadDirectory('');
    refreshMessagesAndGit();
}

function renderTabs() {
    const strip = $('workspace-tabs');
    const fragment = document.createDocumentFragment();
    for (const tab of state.tabs) {
        const wrapper = node('div', `tab ${tab.id === state.activeTabId ? 'active' : ''}`);
        const open = node('button', 'tab-open'); open.type = 'button';
        open.append(node('span', 'tab-icon', tab.type === 'terminal' ? '●' : '▤'));
        const label = tab.type === 'terminal' ? (sessionFor(tab.sessionId)?.title || tab.label || agentName(sessionFor(tab.sessionId)))
            : tab.type === 'diff' ? `⇄ ${tab.path.split('/').at(-1)}` : tab.path.split('/').at(-1);
        open.append(node('span', 'tab-label', label));
        if (tab.type === 'file' && tab.dirty) open.append(node('span', 'dirty-mark', '●'));
        else if (tab.type === 'terminal' && terminalViewFor(tab.sessionId)?.mobileDraftDirty) open.append(node('span', 'dirty-mark', '●'));
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
    if (mobileViewport()) {
        if (tab.type === 'terminal') setMobileSurface('agents');
        else if (tab.type === 'diff') setMobileSurface('git');
        else setMobileSurface('files', {filesBrowser:false});
    }
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
    if (tab.type === 'terminal' && terminalViewFor(tab.sessionId)?.mobileDraftDirty
            && !confirm('Descartar el borrador móvil no enviado de esta sesión? La sesión tmux seguirá activa.')) return;
    if (state.activeTabId === tabId && tab.type === 'file') {
        clearTimeout(navigationTimer);
        recordNavigation(tab);
    }
    const index = state.tabs.indexOf(tab);
    state.tabs.splice(index, 1);
    if (tab.type === 'terminal') disposeTerminalView(tab.sessionId);
    if (state.activeTabId === tabId) {
        const next = state.tabs[Math.max(0, index - 1)] || state.tabs[0] || null;
        state.activeTabId = next?.id || null;
        if (next) activateTab(next.id); else renderCenter();
    } else renderTabs();
}

const GIT_STATUS_LABELS = {modified:'M', added:'A', deleted:'D', renamed:'R', untracked:'U'};
const GIT_STATUS_PRIORITY = {copied:1, renamed:2, added:3, untracked:3, modified:4, deleted:5};
const FILE_NAME_COLLATOR = new Intl.Collator(undefined, {numeric:true, sensitivity:'base'});
const FILE_ICON_BY_EXTENSION = {
    js:'javascript', cjs:'javascript', mjs:'javascript',
    ts:'typescript', cts:'typescript', mts:'typescript', tsx:'typescript',
    py:'python', pyw:'python', rs:'rust', go:'go',
    json:'json', json5:'json', jsonc:'json',
    css:'style', scss:'style', sass:'style', less:'style',
    html:'markup', htm:'markup', xhtml:'markup', xml:'markup',
    md:'markdown', mdx:'markdown', rst:'markdown', txt:'text', log:'text',
    png:'image', jpg:'image', jpeg:'image', gif:'image', svg:'image', webp:'image', ico:'image', avif:'image',
    sql:'database', db:'database', sqlite:'database', sqlite3:'database',
    sh:'terminal', bash:'terminal', zsh:'terminal', fish:'terminal', ps1:'terminal', bat:'terminal',
    yaml:'config', yml:'config', toml:'config', ini:'config', cfg:'config', conf:'config', env:'config',
    zip:'archive', gz:'archive', bz2:'archive', xz:'archive', tar:'archive', rar:'archive', '7z':'archive',
    mp3:'audio', wav:'audio', aac:'audio', flac:'audio', ogg:'audio',
    mp4:'video', mov:'video', webm:'video', mkv:'video', avi:'video',
    csv:'spreadsheet', tsv:'spreadsheet', xls:'spreadsheet', xlsx:'spreadsheet',
    diff:'diff', patch:'diff',
};
const FILE_ICON_BY_NAME = {
    'package.json':'package', 'package-lock.json':'package', 'pnpm-lock.yaml':'package', 'yarn.lock':'package', 'bun.lock':'package',
    dockerfile:'config', makefile:'terminal', readme:'markdown', 'readme.md':'markdown',
    '.gitignore':'config', '.gitattributes':'config', '.editorconfig':'config',
};
const FILE_ICON_PATHS = {
    generic:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.25 8h5.5M5.25 10.25h5.5'],
    folder:['M1.5 4h4l1.5 1.6h7.5v7.9h-13z','M1.75 6h12.5'],
    'folder-open':['M1.5 5h4l1.5 1.3h7.5l-1.3 6.2h-12.2z','M2 6.3l1 5.8'],
    symlink:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5 10.5l2-2 1.3 1.3L11 7'],
    javascript:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M6 7.5v3.1c0 .8.5 1.1 1.2.8M9 7.5v4'],
    typescript:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.2 7.7h3M6.7 7.7v3.8M9.1 10.7c.4.7 1.8.7 2 0 .2-.7-1.8-.8-1.6-1.7.1-.6 1.2-.7 1.7-.2'],
    python:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.25 7.4h3.2a1 1 0 0 1 0 2h-1.7a1 1 0 0 0 0 2h3.8'],
    rust:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.2 7.6h5.6M5.2 9.3h5.6M5.2 11h3.4'],
    go:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5 9.2h5.8M8.9 7.6a2 2 0 1 0 0 3.2'],
    json:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M6.2 7c-.8 0-1 .4-1 1v.4c0 .5-.2.7-.7.9.5.2.7.4.7.9v.4c0 .6.2 1 1 1M9.8 7c.8 0 1 .4 1 1v.4c0 .5.2.7.7.9-.5.2-.7.4-.7.9v.4c0 .6-.2 1-1 1'],
    style:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.3 7.4h5.4M5.3 9.1h3.7M5.3 10.8h5.4'],
    markup:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M6.2 7.5 5 9l1.2 1.5M9.8 7.5 11 9l-1.2 1.5'],
    markdown:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.3 10.8V7.6l1.2 1.5 1.2-1.5v3.2M9.2 9.2h2M10.2 7.8v2.8'],
    text:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.2 7.4h5.5M5.2 9.1h5.5M5.2 10.8h3.5'],
    image:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5 11l2.2-2.5 1.4 1.3 1.2-1.2 1.4 2.4z','M6 7.3h.1'],
    database:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.2 7.3c0 .8 4.8.8 4.8 0M5.2 7.3v3c0 .8 4.8.8 4.8 0v-3M5.2 8.8c0 .8 4.8.8 4.8 0'],
    terminal:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.1 7.5l1.5 1.3-1.5 1.3M7.8 10.1h2.6'],
    config:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5 7.3h5.5M5 9.2h5.5M5 11.1h5.5','M6.6 6.8v1M8.9 8.7v1M6.1 10.6v1'],
    archive:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.3 7h5.3v4.4H5.3zM7.9 7v1.2M7.9 9.2v.8'],
    audio:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M8.7 7v3.2a1 1 0 1 1-.8-1M8.7 7l2-.5v2.7'],
    video:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M6 7.3v3.4l3-1.7z'],
    spreadsheet:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5 7h6v4.5H5zM7 7v4.5M9 7v4.5M5 8.5h6M5 10h6'],
    diff:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5.2 7.4h3M6.7 6v2.8M9.1 9.8h2.1'],
    package:['M3.25 1.5h6.1l3.4 3.4v9.6h-9.5z','M9.25 1.75v3.3h3.25','M5 7.2 8 5.8l3 1.4-3 1.4zM5 7.2v3.5l3 1.4 3-1.4V7.2M8 8.6v3.5'],
};
function gitStatusForChange(change) {
    if (GIT_STATUS_LABELS[change.status]) return change.status;
    const code = `${change.index || ' '}${change.worktree || ' '}`;
    if (code.includes('D')) return 'deleted';
    if (code.includes('R')) return 'renamed';
    if (code.includes('A')) return 'added';
    if (code.includes('?')) return 'untracked';
    return 'modified';
}
function gitChangeAreas(change) {
    const status = gitStatusForChange(change);
    const index = change.index || ' ';
    const worktree = change.worktree || ' ';
    const staged = status !== 'untracked' && index !== ' ' && index !== '?';
    const unstaged = status === 'untracked' || worktree !== ' ' && worktree !== '?';
    return {staged, unstaged:unstaged || !staged};
}
function buildGitDecorationMaps(changes = []) {
    const files = new Map();
    const folders = new Map();
    const addStatus = (map, path, status) => {
        const current = map.get(path);
        if (!current || GIT_STATUS_PRIORITY[status] > GIT_STATUS_PRIORITY[current]) map.set(path, status);
    };
    for (const change of changes) {
        if (!change.path) continue;
        const status = gitStatusForChange(change);
        addStatus(files, change.path, status);
        if (status === 'deleted') continue;
        const segments = change.path.split('/');
        let parent = '';
        for (const segment of segments.slice(0, -1)) {
            parent = parent ? `${parent}/${segment}` : segment;
            addStatus(folders, parent, status);
        }
    }
    return {files, folders};
}
function fileIconCategoryForPath(path) {
    const filename = (path || '').split(/[\\/]/).pop().toLocaleLowerCase();
    if (!filename) return 'generic';
    if (Object.hasOwn(FILE_ICON_BY_NAME, filename)) return FILE_ICON_BY_NAME[filename];
    const dot = filename.lastIndexOf('.');
    const extension = dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1) : '';
    return Object.hasOwn(FILE_ICON_BY_EXTENSION, extension) ? FILE_ICON_BY_EXTENSION[extension] : 'generic';
}
function createExplorerIcon(category) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', `file-type-icon file-icon-${category}`);
    svg.setAttribute('aria-hidden', 'true');
    const iconPaths = Object.hasOwn(FILE_ICON_PATHS, category) ? FILE_ICON_PATHS[category] : FILE_ICON_PATHS.generic;
    for (const shape of iconPaths) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', shape);
        svg.append(path);
    }
    return svg;
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

function refreshFiles() {
    const workspace = selectedWorkspace();
    if (!workspace) return renderFileTree();
    const prefix = `${workspace.id}:`;
    for (const key of state.directoryCache.keys()) {
        if (key.startsWith(prefix)) state.directoryCache.delete(key);
    }
    state.nameSearchResponse = null;
    if (state.explorerMode === 'names' && $('file-search').value.trim()) scheduleWorkspaceSearch('names');
    else if (state.explorerMode === 'content' && $('content-search').value.trim()) scheduleWorkspaceSearch('content');
    else renderFileTree();
}

function collapseFileTree() {
    const workspace = selectedWorkspace();
    if (!workspace) return;
    const prefix = `${workspace.id}:`;
    for (const key of state.expandedWorkspaces) {
        if (key.startsWith(prefix)) state.expandedWorkspaces.delete(key);
    }
    renderFileTree();
}

function renderFileTree() {
    const workspace = selectedWorkspace();
    renderExplorerWorkspacePicker();
    const dotfilesButton = $('toggle-dotfiles');
    dotfilesButton?.setAttribute('aria-pressed', String(state.showDotfiles));
    dotfilesButton?.setAttribute('aria-label', state.showDotfiles ? 'Ocultar archivos ocultos' : 'Mostrar archivos ocultos');
    dotfilesButton?.setAttribute('title', state.showDotfiles ? 'Ocultar archivos ocultos' : 'Mostrar archivos ocultos');
    if (!workspace) {
        $('file-tree').replaceChildren(node('div', 'inspector-empty', 'Selecciona un workspace.'));
        return;
    }
    const filter = $('file-search').value.trim();
    if (filter) {
        if (state.nameSearchWorkspaceId === workspace.id && state.nameSearchResponse) {
            renderNameSearchResults(state.nameSearchResponse);
        } else $('file-tree').replaceChildren(node('div', 'inspector-empty', 'Buscando nombres en el workspace…'));
        return;
    }
    const decorations = buildGitDecorationMaps(workspace.git?.changes || []);
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
        let entries = [...(data.entries || [])].sort((left, right) => {
            const typeOrder = Number(left.type !== 'directory') - Number(right.type !== 'directory');
            return typeOrder || FILE_NAME_COLLATOR.compare(left.name, right.name);
        });
        if (!state.showDotfiles) entries = entries.filter(item => !item.name.startsWith('.'));
        for (const entry of entries) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            const item = node('li', 'file-node');
            const button = node('button', `file-entry ${entry.type}`); button.type = 'button';
            const expanded = state.expandedWorkspaces.has(`${workspace.id}:${path}`);
            const gitStatus = entry.type === 'directory'
                ? decorations.folders.get(path) || decorations.files.get(path)
                : decorations.files.get(path);
            if (entry.type === 'directory') {
                button.append(node('span', `file-chevron ${expanded ? 'open' : ''}`, '›'));
            }
            const iconCategory = entry.type === 'directory' ? expanded ? 'folder-open' : 'folder'
                : entry.type === 'symlink' ? 'symlink'
                    : entry.type === 'file' ? fileIconCategoryForPath(entry.name) : 'generic';
            button.append(createExplorerIcon(iconCategory), node('span', 'file-name', entry.name));
            if (gitStatus) {
                const status = node('span', `file-git-status ${gitStatus}`, GIT_STATUS_LABELS[gitStatus] || 'M');
                status.setAttribute('aria-label', `Estado Git: ${gitStatus}`);
                button.append(status);
                button.classList.add(`git-status-${gitStatus}`);
            }
            button.title = entry.type === 'symlink' ? 'Los enlaces simbólicos se muestran, pero no se siguen.'
                : `${path}${entry.type === 'file' && entry.size != null ? ` · ${formatBytes(entry.size)}` : ''}${gitStatus ? ` · ${gitStatus}` : ''}`;
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
            const empty = node('li', 'file-node'); empty.append(node('span', 'inspector-empty', 'Carpeta vacía.')); list.append(empty);
        }
        if (data.truncated) {
            const more = node('li', 'file-node'); more.append(node('span', 'inspector-empty', 'Listado limitado a 500 entradas.')); list.append(more);
        }
        return list;
    };
    $('file-tree').replaceChildren(buildList(''));
}

function renderExplorerWorkspacePicker() {
    const select = $('explorer-workspace-picker');
    if (!select) return;
    const workspaces = state.workspaceData?.workspaces || [];
    const selected = selectedWorkspace();
    select.replaceChildren(new Option(workspaces.length ? 'Selecciona un workspace' : 'Sin workspaces', ''));
    for (const workspace of workspaces) {
        select.append(new Option(`${workspace.name}${workspace.git?.branch ? ` · ${workspace.git.branch}` : ''}`, workspace.id));
    }
    select.value = selected?.id || '';
    select.disabled = workspaces.length < 2;
    select.title = selected?.path || 'Selecciona un workspace';
}

function renderNameSearchResults(data) {
    const host = $('file-tree');
    const results = data?.results || [];
    if (!results.length) {
        host.replaceChildren(node('div', 'inspector-empty', data?.truncated
            ? 'No hubo coincidencias en el tramo revisado; la búsqueda alcanzó un límite.'
            : 'No se encontraron archivos con ese nombre.'));
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const result of results) {
        const button = node('button', 'name-search-result');
        button.type = 'button';
        const name = result.path.split('/').pop();
        button.append(createExplorerIcon(fileIconCategoryForPath(name)),
            node('span', 'file-name', result.path));
        button.title = `Abrir ${result.path}`;
        button.addEventListener('click', () => openFile(result.path));
        fragment.append(button);
    }
    if (data.truncated) fragment.append(node('div', 'search-truncated', 'Resultados parciales · el workspace supera el límite de búsqueda.'));
    host.replaceChildren(fragment);
}

function renderContentSearchResults(data) {
    const host = $('search-results');
    const results = data?.results || [];
    $('search-results-meta').textContent = results.length
        ? `${results.length} coincidencias${data.truncated ? ' · resultados parciales' : ''}`
        : data?.truncated ? 'Búsqueda parcial; no se encontraron coincidencias dentro del límite.' : 'Sin coincidencias.';
    if (!results.length) {
        host.replaceChildren(node('div', 'inspector-empty', data?.truncated
            ? 'Se alcanzó un límite de búsqueda. Ajusta los filtros para acotar.' : 'No se encontraron coincidencias.'));
        return;
    }
    const groups = new Map();
    for (const result of results) {
        if (!groups.has(result.path)) groups.set(result.path, []);
        groups.get(result.path).push(result);
    }
    const fragment = document.createDocumentFragment();
    for (const [path, matches] of groups) {
        const group = node('section', 'search-result-group');
        const heading = node('button', 'search-result-path', path);
        heading.type = 'button'; heading.title = `Abrir ${path}`;
        heading.addEventListener('click', () => openFile(path));
        group.append(heading);
        for (const result of matches) {
            const row = node('button', 'search-result-line');
            row.type = 'button';
            const excerpt = node('span', 'search-result-excerpt');
            const matchStart = Math.max(0, Math.min(result.excerpt.length, result.excerpt_match_offset_utf16 ?? result.excerpt_match_offset ?? 0));
            const matchEnd = Math.max(matchStart, Math.min(result.excerpt.length, matchStart + (result.match_length_utf16 ?? result.match_length ?? 0)));
            excerpt.append(document.createTextNode(result.excerpt.slice(0, matchStart)));
            if (matchEnd > matchStart) excerpt.append(node('mark', 'search-match', result.excerpt.slice(matchStart, matchEnd)));
            excerpt.append(document.createTextNode(result.excerpt.slice(matchEnd)));
            row.append(node('span', 'search-result-line-number', String(result.line)), excerpt);
            row.title = `${path}:${result.line}:${result.column}`;
            row.addEventListener('click', () => openFileAtSearchResult(result));
            group.append(row);
        }
        fragment.append(group);
    }
    if (data.truncated) fragment.append(node('div', 'search-truncated', 'Resultados parciales · acota la búsqueda para ver más.'));
    host.replaceChildren(fragment);
}

function scheduleWorkspaceSearch(mode = state.explorerMode) {
    clearTimeout(workspaceSearchTimer);
    const query = $(mode === 'names' ? 'file-search' : 'content-search').value.trim();
    const workspace = selectedWorkspace();
    state.searchGeneration++;
    if (mode === 'names') {
        state.nameSearchWorkspaceId = workspace?.id || null;
        state.nameSearchResponse = null;
        if (!query) { renderFileTree(); return; }
        $('file-tree').replaceChildren(node('div', 'inspector-empty', 'Buscando nombres en el workspace…'));
    } else {
        $('search-results-meta').textContent = '';
        if (!query) {
            $('search-results').replaceChildren(node('div', 'inspector-empty', 'Escribe para buscar en el workspace.'));
            return;
        }
        $('search-results').replaceChildren(node('div', 'inspector-empty', 'Buscando contenido…'));
    }
    if (!workspace) {
        if (mode === 'names') $('file-tree').replaceChildren(node('div', 'inspector-empty', 'Selecciona un workspace.'));
        else $('search-results').replaceChildren(node('div', 'inspector-empty', 'Selecciona un workspace.'));
        return;
    }
    workspaceSearchTimer = setTimeout(() => runWorkspaceSearch(mode), 220);
}

async function runWorkspaceSearch(mode = state.explorerMode) {
    const workspace = selectedWorkspace();
    const query = $(mode === 'names' ? 'file-search' : 'content-search').value.trim();
    if (!workspace || !query) return;
    const generation = ++state.searchGeneration;
    const workspaceId = workspace.id;
    const payload = {
        query, mode,
        include: mode === 'content' ? $('search-include').value : '',
        exclude: mode === 'content' ? $('search-exclude').value : '',
        case_sensitive: mode === 'content' && $('search-case-sensitive').checked,
        whole_word: mode === 'content' && $('search-whole-word').checked,
        regex: mode === 'content' && $('search-regex').checked,
        show_dotfiles: state.showDotfiles,
        limit: 200,
    };
    try {
        const data = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/search`, jsonOptions('POST', payload));
        if (generation !== state.searchGeneration || selectedWorkspace()?.id !== workspaceId) return;
        if (mode === 'names') {
            state.nameSearchWorkspaceId = workspaceId;
            state.nameSearchResponse = data;
            renderNameSearchResults(data);
        } else renderContentSearchResults(data);
    } catch (error) {
        if (generation !== state.searchGeneration || selectedWorkspace()?.id !== workspaceId) return;
        const host = mode === 'names' ? $('file-tree') : $('search-results');
        host.replaceChildren(node('div', 'inspector-empty', error.message));
        if (mode === 'content') $('search-results-meta').textContent = 'No se pudo completar la búsqueda.';
    }
}

async function openFileAtSearchResult(result) {
    const tab = await openFile(result.path);
    if (!tab || activeTab()?.id !== tab.id || !currentEditorView || currentEditorTabId !== tab.id) return;
    let lineStart = 0;
    for (let line = 1; line < result.line; line++) {
        const newline = tab.content.indexOf('\n', lineStart);
        if (newline < 0) break;
        lineStart = newline + 1;
    }
    const position = Math.min(tab.content.length, lineStart + Math.max(0, (result.column_utf16 || result.column) - 1));
    currentEditorView.dispatch({selection:{anchor:position}, scrollIntoView:true});
    currentEditorView.focus();
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
    if (existing) { activateTab(existing.id); return existing; }
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
        if (mobileViewport()) setMobileSurface('files', {filesBrowser:false});
        renderCenter();
        if (window.matchMedia('(max-width:1050px)').matches) closeMobileDrawers(true);
        return tab;
    } catch (error) {
        if (generation === state.fileGeneration) toast(error.message);
        return null;
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
    if (state.gitStatsWorkspaceId !== (workspace?.id || null)) {
        state.gitStats = {};
        state.gitStatsWorkspaceId = workspace?.id || null;
    }
    $('github-mark').hidden = !git?.github_available;
    $('git-branch').textContent = !workspace ? 'Sin workspace' : git?.is_git ? `${git.branch || 'detached'}${git.detached ? ' · HEAD separado' : ''}` : git?.available === false ? 'Git no disponible' : 'Sin repositorio Git';
    $('git-branch').title = git?.root || '';
    const remotePicker = $('remote-picker');
    const remotes = git?.remotes || [];
    remotePicker.hidden = remotes.length === 0;
    remotePicker.replaceChildren(...remotes.map(remote => new Option(`${remote.name}${remote.provider === 'github' ? ' · GitHub' : ''}`, remote.name)));
    $('fetch-branches').hidden = remotes.length === 0;
    const canCreatePr = Boolean(git?.is_git && !git.detached && git.branch && git.default_branch
        && git.branch !== git.default_branch
        && remotes.some(remote => remote.name === 'origin' && remote.provider === 'github')
        && state.githubStatus?.authenticated);
    $('create-pr').hidden = !canCreatePr;
    const host = $('git-changes');
    const count = $('git-change-count');
    const allChanges = git?.changes || [];
    count.hidden = !workspace || !git?.is_git || !allChanges.length;
    count.textContent = `${allChanges.length}${git?.changes_truncated ? '+' : ''}`;
    count.title = git?.changes_truncated ? 'La lista está limitada a los primeros 500 cambios.'
        : `${allChanges.length} ${allChanges.length === 1 ? 'archivo modificado' : 'archivos modificados'}`;
    syncGitCommitDraft(workspace?.id || null);
    const stagedChanges = allChanges.filter(change => gitChangeAreas(change).staged);
    const unstagedChanges = allChanges.filter(change => gitChangeAreas(change).unstaged);
    $('stage-all').disabled = !workspace || !git?.is_git || !unstagedChanges.length;
    $('commit-changes').disabled = !workspace || !git?.is_git || !stagedChanges.length || !$('commit-message').value.trim();
    if (!workspace) { host.replaceChildren(node('div', 'inspector-empty', 'Selecciona un workspace para ver sus cambios.')); renderGitHistory(); return; }
    if (!git?.is_git) { host.replaceChildren(node('div', 'inspector-empty', git?.error || 'Este workspace no tiene Git.')); renderGitHistory(); return; }
    if (!allChanges.length) { host.replaceChildren(node('div', 'inspector-empty', 'Working tree limpio.')); renderGitHistory(); return; }
    const filter = $('git-search').value.trim().toLocaleLowerCase();
    const changes = filter ? allChanges.filter(change =>
        change.path.toLocaleLowerCase().includes(filter)
        || gitStatusForChange(change).includes(filter)
    ) : allChanges;
    if (!changes.length) { host.replaceChildren(node('div', 'inspector-empty', 'No hay cambios que coincidan.')); renderGitHistory(); return; }
    const sections = [
        {id:'unstaged', label:'Changes', kind:'worktree', changes:[]},
        {id:'untracked', label:'Untracked Files', kind:'worktree', changes:[]},
        {id:'staged', label:'Staged Changes', kind:'staged', changes:[]},
    ];
    for (const change of changes) {
        const areas = gitChangeAreas(change);
        if (areas.unstaged) sections[change.status === 'untracked' ? 1 : 0].changes.push(change);
        if (areas.staged) sections[2].changes.push(change);
    }
    const fragment = document.createDocumentFragment();
    for (const section of sections) {
        if (!section.changes.length) continue;
        const group = node('section', `git-change-group git-change-group-${section.id}`);
        const collapsed = state.gitCollapsedSections.has(section.id);
        const heading = node('div', 'git-group-heading-row');
        const toggle = node('button', 'git-group-heading'); toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.append(node('span', `git-group-chevron ${collapsed ? '' : 'open'}`, '›'),
            node('span', 'git-group-label', section.label),
            node('span', 'git-group-count', String(section.changes.length)));
        toggle.addEventListener('click', () => {
            if (state.gitCollapsedSections.has(section.id)) state.gitCollapsedSections.delete(section.id);
            else state.gitCollapsedSections.add(section.id);
            renderGit();
        });
        heading.append(toggle);
        if (section.id === 'unstaged' || section.id === 'untracked') {
            const stage = node('button', 'git-group-action', section.id === 'untracked' ? '＋' : 'Stage All');
            stage.type = 'button'; stage.title = `Stage ${section.label}`;
            stage.setAttribute('aria-label', `Preparar ${section.label}`);
            stage.addEventListener('click', () => performGitAction('stage', section.changes.map(change => change.path)));
            heading.append(stage);
        }
        group.append(heading);
        if (!collapsed) {
            for (const change of section.changes) {
                const status = gitStatusForChange(change);
                const code = GIT_STATUS_LABELS[status] || `${change.index}${change.worktree}`.trim() || 'M';
                const row = node('div', `git-entry-row git-entry-${section.kind} git-status-${status}`);
                const open = node('button', 'git-entry'); open.type = 'button';
                const segments = change.path.split('/');
                const filename = segments.pop();
                const filePath = node('span', 'git-path');
                filePath.append(node('strong', 'git-file-name', filename));
                if (segments.length) filePath.append(node('small', 'git-file-parent', segments.join('/')));
                const stats = state.gitStats[change.path]?.[section.kind];
                const statLabel = stats && (stats.additions !== null || stats.deletions !== null)
                    ? `+${stats.additions ?? '–'} −${stats.deletions ?? '–'}` : '';
                open.append(node('span', `git-code ${status}`, code), filePath,
                    node('span', 'git-line-stats', statLabel));
                open.title = `${section.kind === 'staged' ? 'HEAD → índice' : 'Índice → disco'} · ${status} · ${change.path}`;
                open.addEventListener('click', () => openGitDiff(change, section.kind));
                const actions = node('span', 'git-entry-actions');
                if (section.kind === 'staged') {
                    const unstage = node('button', 'git-row-action', '−'); unstage.type = 'button';
                    unstage.title = `Quitar ${change.path} de Stage`; unstage.setAttribute('aria-label', `Quitar de preparados: ${change.path}`);
                    unstage.addEventListener('click', () => performGitAction('unstage', [change.path]));
                    actions.append(unstage);
                } else {
                    const stage = node('button', 'git-row-action', '+'); stage.type = 'button';
                    stage.title = `Stage ${change.path}`; stage.setAttribute('aria-label', `Preparar: ${change.path}`);
                    stage.addEventListener('click', () => performGitAction('stage', [change.path]));
                    const discard = node('button', 'git-row-action destructive', '×'); discard.type = 'button';
                    discard.title = `Descartar cambios de ${change.path}`; discard.setAttribute('aria-label', `Descartar cambios de ${change.path}`);
                    discard.addEventListener('click', () => {
                        if (confirm(`¿Descartar los cambios sin preparar de ${change.path}? Esta acción no se puede deshacer.`)) {
                            performGitAction('discard', [change.path]);
                        }
                    });
                    actions.append(stage, discard);
                }
                row.append(open, actions);
                group.append(row);
            }
        }
        fragment.append(group);
    }
    if (git?.changes_truncated) fragment.append(node('div', 'search-truncated',
        'Se muestran los primeros 500 cambios. Actualiza o usa Git desde la terminal para revisar el resto.'));
    host.replaceChildren(fragment);
    renderGitHistory();
}

async function refreshGit() {
    const workspace = selectedWorkspace();
    if (!workspace) return;
    try {
        const workspaceId = workspace.id;
        const data = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/git`, {cache:false});
        if (selectedWorkspace()?.id !== workspace.id) return;
        if (state.gitStatsWorkspaceId !== workspaceId) {
            state.gitStats = {};
            state.gitStatsWorkspaceId = workspaceId;
        }
        workspace.git = data.git;
        renderBranchPicker(); renderGit(); renderFileTree(); renderTree();
        refreshGitStats(workspaceId);
        if (!$('git-history-list').hidden && state.gitHistoryWorkspaceId !== workspaceId) loadGitHistory(workspaceId);
        if (data.git?.github_available && state.githubStatus === null) {
            state.githubStatus = {loading:true};
            api('/api/github/status', {cache:false}).then(status => {
                state.githubStatus = status;
                renderGit();
            }).catch(() => { state.githubStatus = {authenticated:false}; renderGit(); });
        }
    } catch (error) { toast(error.message); }
}

async function refreshGitStats(workspaceId = selectedWorkspace()?.id) {
    if (!workspaceId) return;
    try {
        const data = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/stats`, {cache:false});
        if (selectedWorkspace()?.id !== workspaceId) return;
        state.gitStats = data.stats || {};
        state.gitStatsWorkspaceId = workspaceId;
        renderGit();
    } catch (_) {
        if (selectedWorkspace()?.id === workspaceId) { state.gitStats = {}; state.gitStatsWorkspaceId = workspaceId; }
    }
}

function syncGitCommitDraft(workspaceId) {
    const input = $('commit-message');
    if (state.gitCommitDraftWorkspaceId === workspaceId) return;
    if (state.gitCommitDraftWorkspaceId) state.gitCommitDrafts.set(state.gitCommitDraftWorkspaceId, input.value);
    state.gitCommitDraftWorkspaceId = workspaceId;
    input.value = workspaceId ? state.gitCommitDrafts.get(workspaceId) || '' : '';
}

async function performGitAction(action, paths = []) {
    const workspace = selectedWorkspace();
    if (!workspace) return;
    const payload = action === 'commit'
        ? {action, message:$('commit-message').value}
        : {action, paths};
    const button = action === 'commit' ? $('commit-changes') : $('stage-all');
    if (button) button.disabled = true;
    try {
        const data = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/git/actions`, jsonOptions('POST', payload));
        if (selectedWorkspace()?.id !== workspace.id) return;
        workspace.git = data.git;
        if (action === 'commit') {
            state.gitCommitDrafts.delete(workspace.id);
            $('commit-message').value = '';
            toast('Commit creado.');
        }
        renderGit(); renderFileTree(); renderTree();
        refreshGitStats(workspace.id);
        if (!$('git-history-list').hidden) loadGitHistory(workspace.id);
    } catch (error) { toast(error.message); }
    finally { if (button) button.disabled = false; renderGit(); }
}

function renderGitHistory() {
    const host = $('git-history-list');
    if (!host) return;
    const workspace = selectedWorkspace();
    if (host.hidden) return;
    if (state.gitHistoryWorkspaceId && state.gitHistoryWorkspaceId !== workspace?.id) {
        state.gitHistoryWorkspaceId = null;
        state.gitHistory = [];
        $('git-history-count').textContent = '';
    }
    if (!workspace?.git?.is_git) {
        host.replaceChildren(node('div', 'inspector-empty', 'El historial requiere un repositorio Git.'));
        return;
    }
    if (state.gitHistoryWorkspaceId !== workspace.id) {
        host.replaceChildren(node('div', 'inspector-empty', 'Cargando commits…'));
        return;
    }
    if (!state.gitHistory.length) {
        host.replaceChildren(node('div', 'inspector-empty', 'Este repositorio todavía no tiene commits.'));
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const commit of state.gitHistory) {
        const row = node('article', 'git-commit-row');
        row.append(node('strong', 'git-commit-subject', commit.subject || '(sin mensaje)'),
            node('span', 'git-commit-meta', `${commit.short_hash} · ${commit.author} · ${new Date(commit.timestamp * 1000).toLocaleDateString()}`));
        row.title = `${commit.hash}\n${commit.subject}`;
        fragment.append(row);
    }
    host.replaceChildren(fragment);
}

async function loadGitHistory(workspaceId = selectedWorkspace()?.id) {
    if (!workspaceId) return;
    state.gitHistoryWorkspaceId = null;
    state.gitHistory = [];
    renderGitHistory();
    try {
        const data = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/history`, {cache:false});
        if (selectedWorkspace()?.id !== workspaceId || $('git-history-list').hidden) return;
        state.gitHistoryWorkspaceId = workspaceId;
        state.gitHistory = data.commits || [];
        $('git-history-count').textContent = state.gitHistory.length ? String(state.gitHistory.length) : '';
        renderGitHistory();
    } catch (error) {
        if (selectedWorkspace()?.id === workspaceId) {
            state.gitHistoryWorkspaceId = workspaceId;
            $('git-history-list').replaceChildren(node('div', 'inspector-empty', error.message));
        }
    }
}

function openCreatePrDialog() {
    const git = selectedWorkspace()?.git;
    if (!git?.default_branch || !git.branch) return;
    $('pr-title').value = `Update ${git.branch}`;
    $('pr-base').value = git.default_branch;
    $('pr-body').value = '';
    $('pr-error').hidden = true;
    $('pr-error').replaceChildren();
    $('create-pr-dialog').showModal();
}

async function createPullRequest(event) {
    event.preventDefault();
    const workspace = selectedWorkspace();
    if (!workspace) return;
    const submit = $('pr-submit');
    const result = $('pr-error');
    submit.disabled = true;
    result.hidden = true;
    try {
        const data = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/pull-request`, jsonOptions('POST', {
            title:$('pr-title').value.trim(), base:$('pr-base').value.trim(), body:$('pr-body').value,
        }));
        result.className = 'pr-success';
        result.hidden = false;
        result.replaceChildren(node('span', '', 'Pull Request creado: '));
        const link = node('a', '', data.url); link.href = data.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        result.append(link);
        refreshGit();
    } catch (error) {
        result.className = 'dialog-error'; result.textContent = error.message; result.hidden = false;
    } finally { submit.disabled = false; }
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

function renderAgentHistory() {
    const host = $('history-list');
    if (!host) return;
    const workspace = selectedWorkspace();
    const project = selectedProject();
    const scope = state.historyScope;
    if (scope === 'workspace' && !workspace || scope === 'project' && !project) {
        host.replaceChildren(node('div', 'inspector-empty', 'Selecciona un workspace o proyecto para ver sus sesiones.'));
        return;
    }
    const query = $('history-search')?.value.trim().toLocaleLowerCase() || '';
    const sessions = state.sessions.filter(session => {
        if (isWorkspaceShell(session)) return false;
        if (scope === 'workspace' && session.workspace_id !== workspace?.id) return false;
        if (scope === 'project' && session.project_id !== project?.id) return false;
        if (!query) return true;
        const searchable = [session.title, session.id, session.launcher, session.agent?.name,
            session.agent?.key, session.preview, session.state, session.workspace_id]
            .filter(Boolean).join(' ').toLocaleLowerCase();
        return searchable.includes(query);
    }).sort((left, right) => Date.parse(right.last_active || right.created_at || 0)
        - Date.parse(left.last_active || left.created_at || 0));
    if (!sessions.length) {
        host.replaceChildren(node('div', 'inspector-empty', query ? 'No hay sesiones que coincidan.' : 'No hay sesiones registradas en este ámbito.'));
        return;
    }
    const fragment = document.createDocumentFragment();
    let activeDay = '';
    for (const session of sessions) {
        const dayLabel = sessionDayGroupLabel(session.last_active || session.created_at);
        if (dayLabel !== activeDay) {
            activeDay = dayLabel;
            fragment.append(node('div', 'history-day-heading', dayLabel));
        }
        const row = node('button', `history-session ${sessionEnded(session) ? 'ended' : ''}`);
        row.type = 'button';
        const icon = node('span', 'history-agent-icon', (agentName(session).slice(0, 1) || 'A').toUpperCase());
        const content = node('span', 'history-session-content');
        const top = node('span', 'history-session-top');
        top.append(node('strong', '', session.title || agentName(session)),
            node('time', '', formatRelativeSessionTime(session.last_active || session.created_at)));
        const meta = node('span', 'history-session-meta');
        const projectName = state.projects.find(item => item.id === session.project_id)?.name;
        const workspaceName = projectWorkspace(session.project_id, session.workspace_id)?.name;
        meta.textContent = [agentName(session), projectName, workspaceName, stateLabel(session)].filter(Boolean).join(' · ');
        content.append(top, meta);
        if (session.preview) content.append(node('span', 'history-session-preview', session.preview));
        row.append(icon, content);
        row.title = `${session.title || agentName(session)} · ${stateLabel(session)} · Abrir sesión de WebConsole`;
        row.addEventListener('click', () => openTerminal(session));
        fragment.append(row);
    }
    host.replaceChildren(fragment);
}

function formatRelativeSessionTime(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '';
    const elapsed = Math.max(0, Date.now() - timestamp);
    if (elapsed < 60 * 60 * 1000) return `${Math.max(1, Math.floor(elapsed / 60000))}m`;
    if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)}h`;
    if (elapsed < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 86400000)}d`;
    return new Date(timestamp).toLocaleDateString(undefined, {month:'short', day:'numeric'});
}

function sessionDayGroupLabel(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return 'Older';
    const date = new Date(timestamp);
    const midnight = item => new Date(item.getFullYear(), item.getMonth(), item.getDate()).getTime();
    const days = Math.floor((midnight(new Date()) - midnight(date)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'Earlier this week';
    return date.toLocaleDateString(undefined, {year:'numeric', month:'long'});
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

const PREF_ACCENT_PRESETS = ['#8acfb3', '#e18b83', '#9dbde0', '#d8b873', '#c792ea', '#89ddff', '#e6edf3', '#3fb950'];
const PREF_TERMINAL_PRESETS = ['#0b0b0d', '#1a1a2e', '#0d1117', '#161b22', '#101113', '#141b2d', '#211c28', '#1c1e26', '#0b0f14'];

function hexToRgb(hex) {
    const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '000000';
    return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16),
    };
}

function rgbToHex(r, g, b) {
    const channel = value => Math.max(0, Math.min(255, Math.round(Number(value) || 0))).toString(16).padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function hexToRgba(hex, alpha) {
    const {r, g, b} = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyThemeVariables(theme) {
    const root = document.documentElement;
    root.style.setProperty('--accent', theme.accent_color);
    root.style.setProperty('--accent-soft', hexToRgba(theme.accent_color, 0.14));
    root.style.setProperty('--accent-faint', hexToRgba(theme.accent_color, 0.06));
    root.style.setProperty('--terminal-background', theme.terminal_background);
    const brand = document.querySelector('.brand-name');
    if (brand) brand.textContent = theme.brand_name;
    const title = document.querySelector('title');
    if (title) title.textContent = `Workspace · ${theme.brand_name}`;
}

function buildPresetRow(hostId, colorKey) {
    const host = $(hostId);
    host.replaceChildren();
    const presets = colorKey === 'accent' ? PREF_ACCENT_PRESETS : PREF_TERMINAL_PRESETS;
    for (const hex of presets) {
        const button = node('button', 'preset-circle');
        button.type = 'button';
        button.style.background = hex;
        button.setAttribute('aria-label', `Usar ${hex}`);
        button.title = hex;
        button.dataset.hex = hex;
        button.dataset.color = colorKey;
        button.addEventListener('click', () => setPreferenceColor(colorKey, hex));
        host.append(button);
    }
}

function syncPreferenceColorControls(colorKey, hex) {
    const {r, g, b} = hexToRgb(hex);
    const values = {r, g, b};
    document.querySelectorAll(`[data-color="${colorKey}"][data-channel]`).forEach(input => {
        const channel = input.dataset.channel;
        input.value = values[channel];
    });
    const swatch = $(colorKey === 'accent' ? 'accent-swatch' : 'terminal-swatch');
    if (swatch) swatch.style.background = hex;
    const code = $(colorKey === 'accent' ? 'accent-hex' : 'terminal-hex');
    if (code) code.textContent = hex;
    const native = $(colorKey === 'accent' ? 'accent-native' : 'terminal-native');
    if (native) native.value = hex;
    document.querySelectorAll(`#preset-row .preset-circle[data-color="${colorKey}"], .preset-row .preset-circle[data-color="${colorKey}"]`)
        .forEach(button => {
            const selected = button.dataset.hex.toLowerCase() === hex.toLowerCase();
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
}

function setPreferenceColor(colorKey, hex) {
    if (!state.preferences) return;
    state.preferences[colorKey === 'accent' ? 'accent_color' : 'terminal_background'] = hex.toLowerCase();
    syncPreferenceColorControls(colorKey, hex.toLowerCase());
    applyThemeVariables(state.preferences);
}

function setPreferenceChannel(colorKey, channel, rawValue) {
    if (!state.preferences) return;
    const field = colorKey === 'accent' ? 'accent_color' : 'terminal_background';
    const current = hexToRgb(state.preferences[field]);
    current[channel] = Math.max(0, Math.min(255, Math.round(Number(rawValue) || 0)));
    setPreferenceColor(colorKey, rgbToHex(current.r, current.g, current.b));
}

function populatePreferencesDialog() {
    const prefs = state.preferences;
    if (!prefs) return;
    $('pref-brand').value = prefs.brand_name;
    syncPreferenceColorControls('accent', prefs.accent_color);
    syncPreferenceColorControls('terminal', prefs.terminal_background);
}

function openPreferencesDialog() {
    $('preferences-error').hidden = true;
    buildPresetRow('accent-presets', 'accent');
    buildPresetRow('terminal-presets', 'terminal');
    populatePreferencesDialog();
    $('preferences-dialog').showModal();
    $('pref-brand').focus();
}

async function savePreferences(event) {
    event.preventDefault();
    const button = $('save-preferences');
    button.disabled = true;
    $('preferences-error').hidden = true;
    try {
        const data = await api('/api/preferences', jsonOptions('PUT', {
            brand_name: $('pref-brand').value,
            accent_color: state.preferences.accent_color,
            terminal_background: state.preferences.terminal_background,
        }));
        state.preferences = data;
        applyThemeVariables(data);
        $('preferences-dialog').close();
        toast('Apariencia guardada.');
    } catch (error) {
        $('preferences-error').hidden = false;
        $('preferences-error').textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

function wirePreferencesEvents() {
    $('open-preferences').addEventListener('click', openPreferencesDialog);
    $('preferences-form').addEventListener('submit', savePreferences);
    $('pref-browser-notifications').addEventListener('change', handleBrowserNotificationPreferenceChange);
    document.querySelectorAll('#preferences-dialog [data-color][data-channel]').forEach(input => {
        const handler = () => setPreferenceChannel(input.dataset.color, input.dataset.channel, input.value);
        input.addEventListener('input', handler);
        input.addEventListener('change', handler);
    });
    [['accent-native', 'accent'], ['terminal-native', 'terminal']].forEach(([id, colorKey]) => {
        $(id).addEventListener('input', event => setPreferenceColor(colorKey, event.target.value));
    });
    $('pref-brand').addEventListener('input', event => {
        if (!state.preferences) return;
        state.preferences.brand_name = event.target.value;
        applyThemeVariables(state.preferences);
    });
}

async function loadPreferences() {
    try {
        const data = await api('/api/preferences');
        state.preferences = data;
        applyThemeVariables(data);
    } catch (_) {
        // The template already rendered safe defaults; the dialog stays usable.
    }
}

function openProjectDialog() {
    $('project-error').hidden = true;
    $('project-form').reset();
    $('project-folder-panel').hidden = false;
    $('project-github-panel').hidden = true;
    $('project-directory-picker').hidden = true;
    $('project-dialog-actions').hidden = false;
    $('save-project').hidden = false;
    $('clone-project').hidden = true;
    $('github-publish').hidden = true;
    $('github-selected').hidden = true;
    $('github-branch-label').hidden = true;
    $('github-repositories').replaceChildren();
    $('github-repositories').hidden = true;
    $('github-search-label').hidden = true;
    $('github-url-label').hidden = true;
    $('github-load-url').hidden = true;
    $('github-destination-label').hidden = true;
    $('github-folder-label').hidden = true;
    $('new-branch-panel').hidden = true;
    $('github-new-branch-label').hidden = true;
    $('github-create-branch').checked = false;
    state.projectSource = 'folder';
    state.githubRepo = null;
    state.githubStatus = null;
    $('project-dialog').showModal();
    $('project-form').elements.path.focus();
}

function setProjectSource(source) {
    state.projectSource = source;
    const github = source === 'github';
    $('project-folder-panel').hidden = github;
    $('project-github-panel').hidden = !github;
    $('project-folder-tab').classList.toggle('active', !github);
    $('project-github-tab').classList.toggle('active', github);
    $('project-folder-tab').setAttribute('aria-selected', String(!github));
    $('project-github-tab').setAttribute('aria-selected', String(github));
    $('save-project').hidden = github;
    $('clone-project').hidden = !github || !state.githubRepo || !$('github-parent').value || !$('github-branch').value;
    $('project-error').hidden = true;
    if (github && !state.githubStatus) loadGitHubStatus();
}

async function loadGitHubStatus() {
    $('github-status').textContent = 'Comprobando GitHub en el servidor…';
    try {
        state.githubStatus = await api('/api/github/status', {cache:false});
        const gitWarning = state.githubStatus.git_available ? '' : ' Git no está instalado; no se podrán clonar repositorios.';
        $('github-status').textContent = (state.githubStatus.authenticated
            ? `Conectado como ${state.githubStatus.login}. Se mostrarán repositorios propios, de organizaciones y colaboraciones accesibles para esta cuenta.`
            : state.githubStatus.message) + gitWarning;
        $('github-search-label').hidden = !state.githubStatus.authenticated;
        $('github-url-label').hidden = false;
        $('github-load-url').hidden = false;
        if (state.githubStatus.authenticated) await loadGitHubRepositories();
    } catch (error) {
        $('github-status').textContent = `${error.message} También puedes introducir el enlace de un repositorio público.`;
        $('github-url-label').hidden = false;
    }
}

async function loadGitHubRepositories() {
    if (!state.githubStatus?.authenticated) return;
    const query = $('github-search').value.trim();
    $('github-repositories').hidden = false;
    $('github-repositories').replaceChildren(node('div', 'directory-empty', 'Cargando repositorios…'));
    try {
        const data = await api(`/api/github/repositories?q=${encodeURIComponent(query)}`, {cache:false});
        state.githubRepos = data.repositories || [];
        const host = $('github-repositories');
        host.replaceChildren();
        for (const repo of state.githubRepos) {
            const button = node('button', 'github-repository');
            button.type = 'button';
            button.setAttribute('aria-pressed', String(state.githubRepo?.full_name === repo.full_name));
            const title = node('strong', '', repo.full_name);
            const visibility = node('small', repo.visibility === 'private' ? 'repo-private' : '', repo.visibility === 'private' ? 'Privado' : 'Público');
            button.append(title, visibility);
            button.addEventListener('click', () => selectGitHubRepository(repo));
            host.append(button);
        }
        if (!state.githubRepos.length) host.append(node('div', 'directory-empty', 'No hay repositorios que coincidan.'));
        if (data.truncated) host.append(node('div', 'directory-empty', 'Se muestran hasta 500 repositorios. Usa la búsqueda para acotar.'));
    } catch (error) {
        $('github-repositories').replaceChildren(node('div', 'directory-empty', error.message));
    }
}

async function selectGitHubRepository(repo) {
    state.githubRepo = repo;
    state.githubBranch = '';
    $('github-selected').textContent = `${repo.full_name} · ${repo.visibility}${repo.archived ? ' · archivado' : ''}`;
    $('github-selected').hidden = false;
    $('github-repositories').querySelectorAll('.github-repository').forEach(button =>
        button.setAttribute('aria-pressed', String(button.querySelector('strong')?.textContent === repo.full_name)));
    $('github-branch-label').hidden = false;
    $('github-branch').replaceChildren(new Option('Cargando ramas…', ''));
    $('new-branch-panel').hidden = !repo.owned || repo.archived;
    $('github-parent').value ||= '';
    $('github-destination-label').hidden = false;
    $('github-folder-label').hidden = false;
    $('github-folder').value = repo.name;
    $('clone-project').hidden = true;
    try {
        const data = await api(`/api/github/branches?repo=${encodeURIComponent(repo.full_name)}&authenticated=1`, {cache:false});
        fillGitHubBranches(data.branches || [], repo.default_branch);
    } catch (error) {
        $('github-branch').replaceChildren(new Option(error.message, ''));
    }
}

function fillGitHubBranches(branches, defaultBranch = '') {
    const select = $('github-branch');
    select.replaceChildren(...branches.map(branch => new Option(branch, branch)));
    if (!branches.length) {
        select.append(new Option('No hay ramas disponibles', ''));
        select.disabled = true;
    } else {
        select.disabled = false;
        select.value = branches.includes(defaultBranch) ? defaultBranch : branches[0];
    }
    updateCloneAvailability();
}

async function loadPublicRepositoryBranches() {
    const input = $('github-url').value.trim();
    $('project-error').hidden = true;
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(input);
    if (!match) { showProjectError('Usa un enlace https://github.com/propietario/repositorio.'); return; }
    const repoName = `${match[1]}/${match[2]}`;
    state.githubRepo = {full_name:repoName, name:match[2], owner:match[1], owned:false, visibility:'public', default_branch:''};
    $('github-selected').textContent = `${repoName} · repositorio público por URL`;
    $('github-selected').hidden = false;
    $('github-branch-label').hidden = false;
    $('github-branch').replaceChildren(new Option('Consultando ramas…', ''));
    $('github-branch').disabled = true;
    $('github-destination-label').hidden = false;
    $('github-folder-label').hidden = false;
    $('github-folder').value = match[2];
    $('new-branch-panel').hidden = true;
    $('clone-project').hidden = true;
    try {
        const data = await api(`/api/github/branches?repo=${encodeURIComponent(repoName)}`, {cache:false});
        fillGitHubBranches(data.branches || []);
    } catch (error) { showProjectError(error.message); }
}

function showProjectError(message) {
    $('project-error').textContent = message;
    $('project-error').hidden = false;
}

function updateCloneAvailability() {
    const has = state.projectSource === 'github' && state.githubStatus?.git_available !== false
        && state.githubRepo && $('github-parent').value
        && $('github-folder').value.trim() && $('github-branch').value;
    $('clone-project').hidden = !has || Boolean($('github-create-branch').checked && !$('github-new-branch').value.trim());
}

async function openDirectoryPicker(target) {
    state.directoryTarget = target;
    state.directoryPath = target === 'folder' ? ($('project-form').elements.path.value || '') : ($('github-parent').value || '');
    $('project-folder-panel').hidden = true;
    $('project-github-panel').hidden = true;
    $('project-dialog-actions').hidden = true;
    $('project-directory-picker').hidden = false;
    try {
        const data = await api('/api/host-directories', {cache:false});
        if (!state.directoryPath) state.directoryPath = data.path;
        await navigateDirectories(state.directoryPath);
    } catch (error) { showProjectError(error.message); }
}

async function navigateDirectories(path) {
    const data = await api(`/api/host-directories?path=${encodeURIComponent(path)}`, {cache:false});
    state.directoryPath = data.path;
    state.directoryEntries = data.directories || [];
    $('directory-filter').value = '';
    $('directory-path').value = data.path;
    $('directory-selection-path').textContent = data.path;
    $('directory-up').disabled = !data.parent;
    const crumbs = $('directory-breadcrumbs');
    crumbs.replaceChildren();
    const pieces = data.path.split('/').filter(Boolean);
    let prefix = '/';
    const root = node('button', '', '/'); root.type = 'button';
    root.addEventListener('click', () => navigateDirectories('/').catch(error => showProjectError(error.message)));
    crumbs.append(root);
    for (const piece of pieces) {
        prefix = `${prefix.replace(/\/$/, '')}/${piece}`;
        const current = prefix;
        const item = node('button', '', piece); item.type = 'button';
        item.addEventListener('click', () => navigateDirectories(current).catch(error => showProjectError(error.message)));
        crumbs.append(item);
    }
    renderDirectoryEntries(data.truncated);
}

function renderDirectoryEntries(truncated = false) {
    const list = $('directory-list'); list.replaceChildren();
    const query = $('directory-filter').value.trim().toLocaleLowerCase();
    const visible = state.directoryEntries.filter(item => item.name.toLocaleLowerCase().includes(query));
    if (!visible.length) list.append(node('div', 'directory-empty', query ? 'No hay carpetas que coincidan.' : 'No hay subcarpetas legibles aquí.'));
    for (const item of visible) {
        const button = node('button', 'directory-entry', item.name); button.type = 'button'; button.setAttribute('role', 'option');
        button.addEventListener('click', () => navigateDirectories(item.path).catch(error => showProjectError(error.message)));
        list.append(button);
    }
    if (truncated) list.append(node('div', 'directory-empty', 'Se muestran las primeras 200 carpetas.'));
}

function closeDirectoryPicker(select = false) {
    if (select) {
        if (state.directoryTarget === 'folder') $('project-form').elements.path.value = state.directoryPath;
        else $('github-parent').value = state.directoryPath;
    }
    $('project-directory-picker').hidden = true;
    $('project-folder-panel').hidden = state.projectSource !== 'folder';
    $('project-github-panel').hidden = state.projectSource !== 'github';
    $('project-dialog-actions').hidden = false;
    updateCloneAvailability();
}

async function createProject(event) {
    event.preventDefault();
    const form = $('project-form');
    const button = $('save-project'); button.disabled = true; $('project-error').hidden = true;
    try {
        const data = await api('/api/projects', jsonOptions('POST', Object.fromEntries(new FormData(form))));
        await adoptCreatedProject(data.project);
        $('project-dialog').close(); form.reset();
        toast('Proyecto registrado; no se modificaron sus archivos.');
    } catch (error) { showProjectError(error.message); }
    finally { button.disabled = false; }
}

async function adoptCreatedProject(project) {
    state.selectedProjectId = project.id; state.workspaceData = null; state.selectedWorkspaceId = null;
    state.projects = [...state.projects.filter(item => item.id !== project.id), {...project, workspace_count:1, session_count:0}];
    state.projectsLoaded = true;
    state.expandedProjects.add(project.id);
    try { const sessionData = await api('/api/sessions'); state.sessions = sessionData.sessions || []; } catch (_) {}
    renderTree();
    await loadWorkspaces(project.id);
}

async function cloneProject() {
    const button = $('clone-project');
    button.disabled = true; $('project-error').hidden = true;
    const repo = state.githubRepo;
    const payload = {parent:$('github-parent').value, folder:$('github-folder').value.trim(), branch:$('github-branch').value,
        repo:repo?.full_name, url:$('github-url').value.trim() || `https://github.com/${repo?.full_name}`,
        new_branch:$('github-create-branch').checked ? $('github-new-branch').value.trim() : ''};
    try {
        const data = await api('/api/projects/clone', jsonOptions('POST', payload));
        await adoptCreatedProject(data.project);
        if (payload.new_branch) {
            $('github-publish-copy').textContent = `Rama ${data.branch} creada solo en local. No se ha enviado a GitHub.`;
            $('github-publish').hidden = false;
            $('publish-github-branch').dataset.path = data.project.path;
            $('publish-github-branch').dataset.repo = repo.full_name;
            $('publish-github-branch').dataset.branch = data.branch;
            $('publish-github-branch').dataset.baseBranch = payload.branch;
            $('clone-project').hidden = true;
            toast('Proyecto clonado y registrado; la rama nueva sigue solo en local.');
        } else {
            $('project-dialog').close();
            toast('Proyecto clonado y registrado.');
        }
    } catch (error) { showProjectError(error.message); }
    finally { button.disabled = false; }
}

async function publishGitHubBranch() {
    const button = $('publish-github-branch'); button.disabled = true;
    try {
        await api('/api/projects/publish-branch', jsonOptions('POST', {
            path:button.dataset.path, repo:button.dataset.repo, branch:button.dataset.branch,
            base_branch:button.dataset.baseBranch,
        }));
        $('github-publish-copy').textContent = `Rama ${button.dataset.branch} publicada en GitHub.`;
        button.hidden = true;
        toast('Rama publicada en GitHub.');
    } catch (error) { showProjectError(error.message); }
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
        await loadWorkspaces(project.id, {force:true});
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
        {id:'opencode-sidebar', title:'Alternar panel lateral', key:'Ctrl+X, B', note:'Alterna el panel de contexto, tokens, costos, MCP y LSP. Usa los keybinds predeterminados de OpenCode.'},
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
    if (state.pendingAction) { toast('Espera a que termine la acción actual antes de enviar otro atajo.'); return; }
    const currentSession = sessionFor(session.id);
    if (!currentSession?.token || sessionEnded(currentSession)) { toast('La sesión no está disponible. Actualiza antes de intentarlo.'); return; }
    if (action.id === 'opencode-sidebar') {
        if (detectedAgent(currentSession) !== 'opencode' || isWorkspaceShell(currentSession)
                || currentSession.state === 'permission' || currentSession.notification?.kind === 'permission') {
            toast('El panel lateral solo puede alternarse en una sesión OpenCode disponible y sin un aviso de permiso.');
            return;
        }
        if (state.activeTabId !== `terminal:${currentSession.id}`) openTerminal(currentSession);
        const frame = activeTerminalFrame();
        if (state.frameSessionId !== currentSession.id || !frame?.contentWindow || !state.terminalFrameReady) {
            toast('Abre la sesión OpenCode y espera a que la terminal esté conectada; el atajo no se reintentará.');
            return;
        }
        const requestId = `sidebar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        state.pendingAction = {sessionId:currentSession.id, action:action.id, requestId, attempts:1};
        state.actionTimer = setTimeout(() => {
            if (state.pendingAction?.requestId !== requestId) return;
            state.pendingAction = null; state.actionTimer = null;
            toast('Sin confirmación del atajo; no se reintentó. El panel puede haber cambiado si la terminal recibió ambas teclas.');
        }, 5000);
        try {
            frame.contentWindow.postMessage({
                type:'webconsole:agent-action', action:action.id, session_id:currentSession.id, request_id:requestId,
            }, window.location.origin);
        } catch (_) {
            clearTimeout(state.actionTimer); state.actionTimer = null; state.pendingAction = null;
            toast('No se pudo enviar el atajo a la terminal.');
        }
        return;
    }
    if (state.activeTabId !== `terminal:${session.id}`) openTerminal(currentSession);
    state.pendingAction = {sessionId:session.id, action:action.id, attempts:0};
    clearInterval(state.actionTimer);
    const attempt = () => {
        if (!state.pendingAction) return;
        const frame = activeTerminalFrame();
        if (state.frameSessionId !== session.id || !frame?.contentWindow) return;
        state.pendingAction.attempts++;
        frame.contentWindow.postMessage({type:'webconsole:agent-action', action:action.id, session_id:session.id}, window.location.origin);
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
    if (event.origin !== window.location.origin || event.data?.type !== 'webconsole:action-result') return;
    if (!state.pendingAction || state.pendingAction.action !== event.data.action
            || state.pendingAction.sessionId !== event.data.session_id) return;
    if (state.pendingAction.action === 'opencode-sidebar') {
        const expectedFrame = terminalFrameFor(state.pendingAction.sessionId);
        if (event.source !== expectedFrame?.contentWindow) return;
        if (!event.data.request_id || event.data.request_id !== state.pendingAction.requestId) return;
        clearTimeout(state.actionTimer); state.actionTimer = null;
        state.pendingAction = null;
        toast(event.data.success
            ? 'Atajo para alternar el panel lateral enviado; no se pudo verificar el estado del panel.'
            : 'No se completó el atajo para el panel lateral; no se reintentó.');
        return;
    }
    if (event.source !== activeTerminalFrame()?.contentWindow) return;
    if (event.data.success) {
        const action = state.pendingAction.action;
        clearInterval(state.actionTimer); state.actionTimer = null; state.pendingAction = null;
        toast(action === 'interrupt' ? 'Ctrl+C enviado al agente activo.' : `Acción enviada: ${action.replaceAll('-', ' ')}`);
    }
}

function handleTerminalMessage(event) {
    if (event.origin !== window.location.origin) return;
    const view = terminalViewFromSource(event.source);
    if (view) {
        const data = event.data || {};
        if (data.session_id !== view.sessionId) return;
        if (data.type === 'webconsole:mobile-keyboard-state') {
            if (view.sessionId === state.frameSessionId) document.body.classList.toggle('mobile-keyboard-open', Boolean(data.open));
        } else if (data.type === 'webconsole:mobile-draft-state') {
            view.mobileDraftDirty = Boolean(data.dirty);
            renderTabs();
        } else if (data.type === 'webconsole:terminal-status' && data.session_id === view.sessionId
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
        } else if (data.type === 'webconsole:attachment-error' && typeof data.error === 'string') {
            toast(data.error);
        }
        return;
    }
    const shellFrame = $('shell-frame');
    if (!shellFrame || event.source !== shellFrame.contentWindow) return;
    const data = event.data || {};
    if (data.session_id !== state.shellFrameSessionId) return;
    if (data.type === 'webconsole:mobile-keyboard-state') {
        document.body.classList.toggle('mobile-keyboard-open', Boolean(data.open));
    } else if (data.type === 'webconsole:interrupt-result') {
        toast(data.success ? 'Ctrl+C enviado a la terminal del workspace.' : 'La terminal no está conectada; no se envió Ctrl+C.');
    } else if (data.type === 'webconsole:attachment-error' && typeof data.error === 'string') {
        toast(data.error);
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

function setupSidebarResizing() {
    const workbench = $('workbench');
    const projectHandle = $('project-sidebar-resize');
    const inspectorHandle = $('inspector-sidebar-resize');
    if (!workbench || !projectHandle || !inspectorHandle) return;

    const defaults = {project:244, inspector:300};
    const keys = {project:'webconsole.projectSidebarWidth', inspector:'webconsole.inspectorWidth'};
    const loadWidth = side => {
        try {
            const saved = Number(localStorage.getItem(keys[side]));
            return Number.isFinite(saved) && saved > 0 ? saved : defaults[side];
        } catch (_) { return defaults[side]; }
    };
    let projectWidth = loadWidth('project');
    let inspectorWidth = loadWidth('inspector');
    const desktopLayout = () => window.innerWidth > 1050;
    const projectGridLayout = () => window.innerWidth > 650;

    function widthRange(side) {
        const available = workbench.clientWidth || window.innerWidth;
        if (side === 'project') {
            const reserved = desktopLayout() ? 360 + 16 + inspectorWidth : 300 + 8;
            return {min:180, max:Math.max(180, Math.min(420, available - reserved))};
        }
        return {min:220, max:Math.max(220, Math.min(480, available - 360 - 16 - projectWidth))};
    }

    function clampWidth(side, value) {
        const range = widthRange(side);
        return Math.max(range.min, Math.min(range.max, Math.round(value)));
    }

    function syncAria(handle, side, width) {
        const range = widthRange(side);
        handle.setAttribute('aria-valuemin', String(range.min));
        handle.setAttribute('aria-valuemax', String(range.max));
        handle.setAttribute('aria-valuenow', String(Math.round(width)));
        handle.setAttribute('aria-valuetext', `${Math.round(width)} píxeles`);
    }

    function applyWidths() {
        if (projectGridLayout()) projectWidth = clampWidth('project', projectWidth);
        if (desktopLayout()) {
            inspectorWidth = clampWidth('inspector', inspectorWidth);
            projectWidth = clampWidth('project', projectWidth);
        }
        workbench.style.setProperty('--project-sidebar-width', `${projectWidth}px`);
        workbench.style.setProperty('--inspector-width', `${inspectorWidth}px`);
        syncAria(projectHandle, 'project', projectWidth);
        syncAria(inspectorHandle, 'inspector', inspectorWidth);
    }

    function setWidth(side, value) {
        if (side === 'project') projectWidth = clampWidth(side, value);
        else inspectorWidth = clampWidth(side, value);
        applyWidths();
    }

    function persistWidths() {
        try {
            localStorage.setItem(keys.project, String(Math.round(projectWidth)));
            localStorage.setItem(keys.inspector, String(Math.round(inspectorWidth)));
        } catch (_) {}
    }

    function bindHandle(handle, side) {
        handle.addEventListener('keydown', event => {
            if (side === 'inspector' && !desktopLayout()) return;
            if (side === 'project' && !projectGridLayout()) return;
            let value = side === 'project' ? projectWidth : inspectorWidth;
            const range = widthRange(side);
            if (event.key === 'Home') value = range.min;
            else if (event.key === 'End') value = range.max;
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                const grows = side === 'project' ? event.key === 'ArrowRight' : event.key === 'ArrowLeft';
                value += grows ? 20 : -20;
            } else return;
            event.preventDefault();
            setWidth(side, value);
            persistWidths();
        });

        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || (side === 'inspector' && !desktopLayout())
                || (side === 'project' && !projectGridLayout())) return;
            event.preventDefault();
            const pointerId = event.pointerId;
            const startX = event.clientX;
            const startWidth = side === 'project' ? projectWidth : inspectorWidth;
            try { handle.setPointerCapture(pointerId); } catch (_) {}
            document.body.classList.add('sidebar-resizing');
            let finished = false;
            const move = moveEvent => {
                if (moveEvent.pointerId !== pointerId) return;
                const delta = moveEvent.clientX - startX;
                setWidth(side, startWidth + (side === 'project' ? delta : -delta));
            };
            const end = () => {
                if (finished) return;
                finished = true;
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', end);
                handle.removeEventListener('pointercancel', end);
                handle.removeEventListener('lostpointercapture', end);
                document.body.classList.remove('sidebar-resizing');
                persistWidths();
                try {
                    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
                } catch (_) {}
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', end);
            handle.addEventListener('pointercancel', end);
            handle.addEventListener('lostpointercapture', end);
        });
    }

    bindHandle(projectHandle, 'project');
    bindHandle(inspectorHandle, 'inspector');
    applyWidths();
    window.addEventListener('resize', applyWidths);
}

function attachEvents() {
    try {
        const savedTab = localStorage.getItem('webconsole.inspectorTab');
        if (INSPECTOR_TABS.some(item => item.id === savedTab)) state.inspectorTab = savedTab;
        state.showDotfiles = localStorage.getItem('webconsole.showDotfiles') !== 'false';
        state.sidebarVisibility.projects = localStorage.getItem('webconsole.projectSidebarHidden') !== 'true';
        state.sidebarVisibility.inspector = localStorage.getItem('webconsole.inspectorSidebarHidden') !== 'true';
    } catch (_) {}
    loadAgentNotificationPreferences();
    setSidebarVisibility('projects', state.sidebarVisibility.projects, {persist:false});
    setSidebarVisibility('inspector', state.sidebarVisibility.inspector, {persist:false});
    setInspectorTab(state.inspectorTab, {persist:false});
    $('inspector-tabs').addEventListener('click', event => {
        const button = event.target.closest('[data-inspector-tab]');
        if (button) setInspectorTab(button.dataset.inspectorTab);
    });
    $('inspector-tabs').addEventListener('keydown', handleInspectorTabKeydown);
    $('collapse-project-sidebar').addEventListener('click', () => toggleSidebarVisibility('projects'));
    $('restore-project-sidebar').addEventListener('click', () => toggleSidebarVisibility('projects'));
    $('collapse-inspector-sidebar').addEventListener('click', () => toggleSidebarVisibility('inspector'));
    $('restore-inspector-sidebar').addEventListener('click', () => toggleSidebarVisibility('inspector'));
    setupSidebarResizing();
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
    $('sidebar-add-project')?.addEventListener('click', openProjectDialog);
    $('welcome-action').addEventListener('click', () => {
        if (!selectedProject()) openProjectDialog();
        else if (!selectedWorkspace()) refreshAll();
        else openAgentDialog();
    });
    $('interrupt-agent')?.addEventListener('click', () => {
        const session = currentAgentSession();
        if (session) dispatchAgentAction(session, {id:'interrupt'});
    });
    if (hasWorkspaceTerminalUI()) {
        $('terminal-drawer-toggle').addEventListener('click', () => setTerminalExpanded(!state.terminalExpanded));
        $('mobile-shell-open')?.addEventListener('click', () => {
            if (mobileViewport()) setMobileSurface('agents');
            setTerminalExpanded(true);
        });
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
        await refreshAll({refreshOpen:true});
        if (state.selectedProjectId) await loadWorkspaces(state.selectedProjectId);
    });
    $('refresh-files').addEventListener('click', refreshFiles);
    $('collapse-file-tree').addEventListener('click', collapseFileTree);
    $('explorer-workspace-picker').addEventListener('change', event => {
        if (event.target.value) selectWorkspace(event.target.value);
    });
    $('toggle-dotfiles').addEventListener('click', () => {
        state.showDotfiles = !state.showDotfiles;
        $('toggle-dotfiles').closest('details')?.removeAttribute('open');
        try { localStorage.setItem('webconsole.showDotfiles', String(state.showDotfiles)); } catch (_) {}
        if (state.explorerMode === 'names' && $('file-search').value.trim()) scheduleWorkspaceSearch('names');
        else if (state.explorerMode === 'content' && $('content-search').value.trim()) scheduleWorkspaceSearch('content');
        else renderFileTree();
    });
    $('refresh-git').addEventListener('click', refreshGit);
    $('fetch-branches').addEventListener('click', fetchBranches);
    $('project-search').addEventListener('input', renderTree);
    $('file-search').addEventListener('input', () => scheduleWorkspaceSearch('names'));
    $('content-search').addEventListener('input', () => scheduleWorkspaceSearch('content'));
    for (const button of document.querySelectorAll('[data-explorer-mode]')) {
        button.addEventListener('click', () => setExplorerMode(button.dataset.explorerMode));
    }
    for (const input of ['search-case-sensitive', 'search-whole-word', 'search-regex', 'search-include', 'search-exclude']) {
        $(input).addEventListener('input', () => {
            if (state.explorerMode === 'content' && $('content-search').value.trim()) scheduleWorkspaceSearch('content');
        });
    }
    $('history-search').addEventListener('input', renderAgentHistory);
    document.querySelectorAll('[data-history-scope]').forEach(button => button.addEventListener('click', () => {
        state.historyScope = button.dataset.historyScope;
        for (const option of document.querySelectorAll('[data-history-scope]')) {
            option.setAttribute('aria-pressed', String(option === button));
        }
        renderAgentHistory();
    }));
    $('refresh-history').addEventListener('click', () => refreshAll({refreshOpen:true}));
    $('git-search').addEventListener('input', renderGit);
    $('commit-message').addEventListener('input', () => {
        const workspaceId = selectedWorkspace()?.id;
        if (workspaceId) state.gitCommitDrafts.set(workspaceId, $('commit-message').value);
        renderGit();
    });
    $('stage-all').addEventListener('click', () => {
        const changes = selectedWorkspace()?.git?.changes || [];
        const paths = changes.filter(change => gitChangeAreas(change).unstaged).map(change => change.path);
        if (paths.length) performGitAction('stage', paths);
    });
    $('commit-changes').addEventListener('click', () => performGitAction('commit'));
    $('toggle-git-history').addEventListener('click', () => {
        const list = $('git-history-list');
        const expanded = list.hidden;
        list.hidden = !expanded;
        $('toggle-git-history').setAttribute('aria-expanded', String(expanded));
        if (expanded) loadGitHistory();
    });
    $('create-pr').addEventListener('click', openCreatePrDialog);
    $('create-pr-form').addEventListener('submit', createPullRequest);
    $('project-form').addEventListener('submit', createProject);
    wirePreferencesEvents();
    $('project-folder-tab').addEventListener('click', () => setProjectSource('folder'));
    $('project-github-tab').addEventListener('click', () => setProjectSource('github'));
    $('browse-project-path').addEventListener('click', () => openDirectoryPicker('folder'));
    $('browse-clone-parent').addEventListener('click', () => openDirectoryPicker('clone'));
    $('directory-close').addEventListener('click', () => closeDirectoryPicker(false));
    $('directory-select').addEventListener('click', () => closeDirectoryPicker(true));
    $('directory-up').addEventListener('click', () => {
        const parent = $('directory-path').value.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
        navigateDirectories(parent).catch(error => showProjectError(error.message));
    });
    $('directory-path').addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); navigateDirectories(event.currentTarget.value).catch(error => showProjectError(error.message)); }
    });
    $('directory-filter').addEventListener('input', () => renderDirectoryEntries());
    $('github-search').addEventListener('input', debounce(() => loadGitHubRepositories(), 250));
    $('github-load-url').addEventListener('click', loadPublicRepositoryBranches);
    $('github-url').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); loadPublicRepositoryBranches(); } });
    $('github-branch').addEventListener('change', updateCloneAvailability);
    $('github-folder').addEventListener('input', updateCloneAvailability);
    $('github-create-branch').addEventListener('change', () => {
        $('github-new-branch-label').hidden = !$('github-create-branch').checked;
        updateCloneAvailability();
    });
    $('github-new-branch').addEventListener('input', updateCloneAvailability);
    $('github-parent').addEventListener('input', updateCloneAvailability);
    $('clone-project').addEventListener('click', cloneProject);
    $('publish-github-branch').addEventListener('click', publishGitHubBranch);
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
        requestTerminalFrameResize(activeTerminalFrame());
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
    $('shell-frame')?.addEventListener('load', () => {
        const content = $('terminal-drawer-content');
        if (content && !content.hidden) requestTerminalFrameResize($('shell-frame'));
    });
    terminalResizeObserver = new ResizeObserver(() => {
        for (const view of state.terminalViews.values()) {
            const frame = view.frame;
            if (frame && !frame.hidden && frame.getBoundingClientRect().width > 0 && frame.getBoundingClientRect().height > 0) {
                requestTerminalFrameResize(frame);
            }
        }
        const shell = $('shell-frame');
        const shellContent = $('terminal-drawer-content');
        if (shell && shellContent && !shell.hidden && !shellContent.hidden
            && shell.getBoundingClientRect().width > 0 && shell.getBoundingClientRect().height > 0) {
            requestTerminalFrameResize(shell);
        }
    });
    const workSurface = $('work-surface');
    if (workSurface) terminalResizeObserver.observe(workSurface);
    for (const view of state.terminalViews.values()) terminalResizeObserver.observe(view.frame);
    if ($('workspace-terminal')) terminalResizeObserver.observe($('workspace-terminal'));
    $('toggle-projects').addEventListener('click', event => {
        setMobileDrawer('projects', !$('project-sidebar').classList.contains('open'), event.currentTarget);
    });
    $('toggle-inspector').addEventListener('click', event => {
        setMobileDrawer('inspector', !document.body.classList.contains('inspector-open'), event.currentTarget);
    });
    $('mobile-workspace-nav')?.addEventListener('click', event => {
        const button = event.target.closest('[data-mobile-surface]');
        if (!button || !mobileViewport()) return;
        const surface = button.dataset.mobileSurface;
        if (surface === 'files' && state.mobileSurface === 'files' && state.mobileFilesBrowser
                && activeTab()?.type === 'file') {
            setMobileSurface('files', {filesBrowser:false});
            return;
        }
        setMobileSurface(surface, {filesBrowser:surface === 'files' ? true : undefined});
    });
    $('mobile-drawer-backdrop')?.addEventListener('click', () => closeMobileDrawers(true));
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
        const open = $('project-sidebar').classList.contains('open') || document.body.classList.contains('inspector-open');
        if (open) { event.preventDefault(); closeMobileDrawers(true); }
    });
    updateMobileDrawerState();
    document.addEventListener('visibilitychange', () => {
        // A backgrounded workspace tab must not keep a tmux attach alive while
        // its renderer is throttled; the iframe cannot observe the parent tab.
        const frame = activeTerminalFrame();
        if (frame && !frame.hidden) notifyTerminalFrameVisibility(frame, !document.hidden);
        clearTimeout(state.pollTimer);
        if (!document.hidden) refreshAll({refreshOpen:inventoryRefreshDue()});
    });
    window.addEventListener('online', () => refreshAll({refreshOpen:inventoryRefreshDue()}));
}

document.addEventListener('DOMContentLoaded', () => {
    attachEvents();
    setMobileSurface('agents');
    loadPreferences();
    refreshAll();
});
