import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const TEMPLATE = new URL('../../templates/workspace.html', import.meta.url);
const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);

async function notificationContext({permission = 'granted', enabled = true, fingerprints = {}, requestPermission} = {}) {
  const source = await readFile(SOURCE, 'utf8');
  const start = source.indexOf('function formatAgentNotification(');
  const end = source.indexOf('\nfunction projectWorkspace(', start);
  assert.ok(start >= 0 && end > start, 'agent notification controller is present');

  const notifications = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission || (async () => FakeNotification.permission);
    constructor(title, options) {
      this.title = title;
      this.options = options;
      notifications.push(this);
    }
    close() { this.closed = true; }
  }
  const stored = new Map([
    ['webconsole.browserNotifications', String(enabled)],
    ['webconsole.agentNotificationFingerprints', JSON.stringify(fingerprints)],
  ]);
  const elements = {
    'pref-browser-notifications':{checked:false, disabled:false},
    'browser-notifications-status':{textContent:''},
  };
  const state = {
    browserNotificationsEnabled:enabled,
    notificationFingerprints:new Map(),
    notificationFingerprintBaselineReady:false,
  };
  const context = vm.createContext({
    state,
    BROWSER_NOTIFICATIONS_KEY:'webconsole.browserNotifications',
    NOTIFICATION_FINGERPRINTS_KEY:'webconsole.agentNotificationFingerprints',
    Notification:FakeNotification,
    window:{Notification:FakeNotification, focus() { this.focused = true; }},
    localStorage:{getItem:key => stored.get(key) ?? null, setItem:(key, value) => stored.set(key, value)},
    $:id => elements[id],
    agentName:() => 'Codex',
  });
  vm.runInContext(source.slice(start, end), context);
  return {context, state, elements, notifications, stored, FakeNotification};
}

test('browser notification preference is opt-in and requests permission only after interaction', async () => {
  let permissionRequests = 0;
  const setup = await notificationContext({permission:'default', enabled:false, requestPermission:async () => {
    permissionRequests++;
    setup.FakeNotification.permission = 'granted';
    return 'granted';
  }});

  setup.context.loadAgentNotificationPreferences();
  assert.equal(permissionRequests, 0);
  assert.equal(setup.elements['pref-browser-notifications'].checked, false);
  assert.match(setup.elements['browser-notifications-status'].textContent, /solicitará permiso/);

  setup.elements['pref-browser-notifications'].checked = true;
  await setup.context.handleBrowserNotificationPreferenceChange({currentTarget:setup.elements['pref-browser-notifications']});
  assert.equal(permissionRequests, 1);
  assert.equal(setup.state.browserNotificationsEnabled, true);
  assert.equal(setup.stored.get('webconsole.browserNotifications'), 'true');
});

test('new completion and assistance events notify once, distinguish screen estimates, and persist fingerprints', async () => {
  const {context, state, notifications, stored} = await notificationContext();
  const session = {id:'session-1', launcher:'codex', notification:{
    kind:'completed', source:'event', message:'Turno finalizado', fingerprint:'done-1',
  }};

  // Existing notices are a baseline on first load, not a burst of stale alerts.
  context.processAgentNotifications([session]);
  assert.equal(notifications.length, 0);

  session.notification = null;
  context.processAgentNotifications([session]);
  session.notification = {kind:'permission', source:'event', message:'Aprobar comando', fingerprint:'help-1'};
  context.processAgentNotifications([session]);
  context.processAgentNotifications([session]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Codex necesita tu permiso');
  assert.match(notifications[0].options.body, /Aprobar comando/);
  assert.equal(notifications[0].options.tag, 'session-1:help-1');

  session.notification = {kind:'permission', source:'screen', message:'¿Permitir ejecutar?', fingerprint:'screen-1'};
  context.processAgentNotifications([session]);
  context.processAgentNotifications([session]);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].title, 'Codex podría necesitar asistencia');
  assert.match(notifications[1].options.body, /Detección estimada en pantalla/);

  session.notification = {kind:'completed', source:'event', message:'Tarea terminada', fingerprint:'done-2'};
  context.processAgentNotifications([session]);
  assert.equal(notifications.length, 3);
  assert.equal(notifications[2].title, 'Codex terminó su turno');
  assert.match(stored.get('webconsole.agentNotificationFingerprints'), /done-2/);

  session.notification = {kind:'completed', source:'process', message:'Codex: el proceso finalizó', fingerprint:'exit-1'};
  context.processAgentNotifications([session]);
  assert.equal(notifications.length, 4);
  assert.equal(notifications[3].title, 'Codex finalizó su proceso');
  assert.match(notifications[3].options.body, /no confirma por sí solo/);
  assert.equal(state.notificationFingerprints.get('session-1'), 'exit-1');
});

test('events seen while notifications are disabled are not replayed after enabling', async () => {
  const {context, state, notifications} = await notificationContext({enabled:false});
  const session = {id:'session-2', notification:null};
  context.processAgentNotifications([session]);
  session.notification = {kind:'completed', source:'event', fingerprint:'done-1', message:'Listo'};
  context.processAgentNotifications([session]);
  assert.equal(notifications.length, 0);

  state.browserNotificationsEnabled = true;
  context.processAgentNotifications([session]);
  assert.equal(notifications.length, 0);
});

test('a recently-created session can notify even if its first poll already contains an event', async () => {
  const {context, state, notifications} = await notificationContext();
  state.notificationTrackingStartedAt = 100_000;
  const session = {id:'session-new', notification:{
    kind:'permission', source:'event', message:'Aprobación requerida', fingerprint:'help-new', at:101,
  }};
  context.processAgentNotifications([session]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Codex necesita tu permiso');
});

test('notification setting is present and session status polling remains responsive', async () => {
  const html = await readFile(TEMPLATE, 'utf8');
  const source = await readFile(SOURCE, 'utf8');
  assert.match(html, /id="pref-browser-notifications"[^>]*type="checkbox"|type="checkbox"[^>]*id="pref-browser-notifications"/);
  assert.match(html, /id="browser-notifications-status"[^>]*role="status"/);
  assert.match(source, /const SESSION_NOTIFICATION_POLL_MS = 5000/);
  assert.match(source, /processAgentNotifications\(state\.sessions\)/);
});
