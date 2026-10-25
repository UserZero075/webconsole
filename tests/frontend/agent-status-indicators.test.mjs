import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);
const STYLES = new URL('../../static/css/workspace.css', import.meta.url);

test('left-panel status mapping follows explicit turn states and keeps process estimates unconfirmed', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const start = source.indexOf('function agentIndicator(session)');
  const end = source.indexOf('\nfunction formatAgentNotification(', start);
  assert.ok(start >= 0 && end > start, 'agent status indicator mapping is present');
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  const indicator = session => ({...context.agentIndicator(session)});

  assert.deepEqual(indicator({state:'working'}), {status:'working', label:'Trabajando', estimated:false});
  assert.deepEqual(indicator({state:'working', state_source:'estimated'}), {
    status:'unconfirmed', label:'Actividad detectada · turno no confirmado', estimated:true,
  });
  assert.deepEqual(indicator({state:'working', state_source:'estimated', notification:{kind:'completed', source:'event'}}), {
    status:'unconfirmed', label:'Actividad detectada · turno no confirmado', estimated:true,
  });
  assert.deepEqual(indicator({state:'permission', notification:{kind:'permission', source:'event'}}), {
    status:'permission', label:'Necesita permiso', estimated:false,
  });
  assert.deepEqual(indicator({state:'permission', state_source:'estimated', notification:{kind:'permission', source:'screen'}}), {
    status:'permission', label:'Posible solicitud de permiso', estimated:true,
  });
  assert.deepEqual(indicator({state:'done', state_source:'event', notification:{kind:'completed', source:'event'}}), {
    status:'done', label:'Turno completado', estimated:false,
  });
  assert.deepEqual(indicator({state:'idle', state_source:'estimated', notification:{kind:'completed', source:'event'}}), {
    status:'unconfirmed', label:'Turno no confirmado', estimated:true,
  });
  assert.deepEqual(indicator({state:'ended', notification:{kind:'completed', source:'process'}}), {
    status:'ended', label:'Proceso finalizado', estimated:false,
  });
  assert.deepEqual(indicator({state:'idle', notification:{kind:'completed', source:'process'}}), {
    status:'ended', label:'Proceso finalizado', estimated:false,
  });
  assert.deepEqual(indicator({state:'idle', state_source:'event', notification:{kind:'completed', source:'process'}}), {
    status:'idle', label:'En espera', estimated:false,
  });
  assert.deepEqual(indicator({notification:{kind:'error'}}), {
    status:'failed', label:'Error del agente', estimated:false,
  });
  assert.deepEqual(indicator({state:'idle', state_source:'event', notification:{kind:'error'}}), {
    status:'idle', label:'En espera', estimated:false,
  });
  assert.deepEqual(indicator({state:'interrupted'}), {status:'interrupted', label:'Interrumpido', estimated:false});
  assert.deepEqual(indicator({state:'idle', state_source:'estimated'}), {
    status:'unconfirmed', label:'Turno no confirmado', estimated:true,
  });
});

test('both left-panel agent lists use accessible status dots and Orca-like status colors', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const css = await readFile(STYLES, 'utf8');
  assert.match(source, /const indicator = agentIndicator\(agent\);[\s\S]*?agent-state \$\{indicator\.status\}/);
  assert.match(source, /const indicator = agentIndicator\(session\);[\s\S]*?agent-state \$\{indicator\.status\}/);
  assert.match(source, /statusDot\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(source, /select\.setAttribute\('aria-label', `\$\{[^\n]+indicator\.label/);
  assert.match(css, /\.agent-state\.working \{background:#eab308/);
  assert.match(css, /\.agent-state\.done \{background:#10b981/);
  assert.match(css, /\.agent-state\.permission \{background:#f59e0b/);
  assert.match(css, /\.agent-state\.failed \{background:#ef4444/);
  assert.match(css, /\.agent-state\.unconfirmed \{background:#a78bfa/);
  assert.match(css, /\.agent-state\.estimated \{outline:1px dashed/);
});
