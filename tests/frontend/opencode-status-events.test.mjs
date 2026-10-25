import assert from 'node:assert/strict';
import test from 'node:test';
import {createOpenCodeStatusHandler} from '../../integrations/opencode/opencode_events.mjs';

test('OpenCode V2 events emit one working transition and a confirmed completion', async () => {
  const published = [];
  const recorded = [];
  let flushes = 0;
  let mainSessionID = null;
  const handler = createOpenCodeStatusHandler({
    publish:async event => published.push(event),
    flushMessages:async () => { flushes++; },
    recordMainSession:async info => { mainSessionID = info.id; recorded.push(info.id); },
    getMainSessionID:() => mainSessionID,
  });

  await handler({type:'session.created', properties:{info:{id:'ses_main'}}});
  await handler({type:'session.status', properties:{sessionID:'ses_main', status:{type:'busy'}}});
  await handler({type:'session.status', properties:{sessionID:'ses_main', status:{type:'retry'}}});
  await handler({type:'session.idle', properties:{sessionID:'ses_main'}});
  await handler({type:'session.idle', properties:{sessionID:'ses_main'}});

  assert.deepEqual(recorded, ['ses_main']);
  assert.deepEqual(published.map(event => event.type), ['working', 'completed']);
  assert.equal(flushes, 1);
});

test('OpenCode V2 data envelopes and next-generation lifecycle events confirm turn state', async () => {
  const published = [];
  const recorded = [];
  let flushes = 0;
  let mainSessionID = null;
  const handler = createOpenCodeStatusHandler({
    publish:async event => published.push(event),
    flushMessages:async () => { flushes++; },
    recordMainSession:async info => { mainSessionID = info.id; recorded.push(info.id); },
    getMainSessionID:() => mainSessionID,
  });

  await handler({type:'session.created', data:{sessionID:'ses_v2', info:{id:'ses_v2'}}});
  await handler({type:'session.next.prompt.admitted', data:{sessionID:'ses_v2'}});
  await handler({type:'session.next.step.started', data:{sessionID:'ses_v2'}});
  await handler({type:'session.next.tool.called', data:{sessionID:'ses_v2', tool:'shell'}});
  await handler({type:'session.execution.succeeded', data:{sessionID:'ses_v2'}});
  await handler({type:'session.idle', data:{sessionID:'ses_v2'}});

  assert.deepEqual(recorded, ['ses_v2']);
  assert.deepEqual(published.map(event => event.type), ['working', 'completed']);
  assert.equal(flushes, 1);
});

test('OpenCode V2 interruption stays distinct from completion', async () => {
  const published = [];
  const handler = createOpenCodeStatusHandler({
    publish:async event => published.push(event),
    flushMessages:async () => {},
    recordMainSession:async () => {},
    getMainSessionID:() => 'ses_v2',
  });

  await handler({type:'session.next.step.started', data:{sessionID:'ses_v2'}});
  await handler({type:'session.execution.interrupted', data:{sessionID:'ses_v2'}});

  assert.deepEqual(published.map(event => event.type), ['working', 'interrupted']);
});

test('OpenCode permissions resume the turn and child sessions do not complete the parent', async () => {
  const published = [];
  const childSessions = new Set();
  let mainSessionID = 'ses_main';
  const handler = createOpenCodeStatusHandler({
    publish:async event => published.push(event),
    flushMessages:async () => {},
    recordMainSession:async info => { mainSessionID = info.id; },
    getMainSessionID:() => mainSessionID,
    childSessions,
  });

  await handler({type:'session.created', properties:{info:{id:'ses_child', parentID:'ses_main'}}});
  await handler({type:'session.status', properties:{sessionID:'ses_child', status:{type:'busy'}}});
  await handler({type:'session.idle', properties:{sessionID:'ses_child'}});
  await handler({type:'permission.v2.asked', data:{sessionID:'ses_main', action:'shell'}});
  await handler({type:'permission.v2.replied', data:{sessionID:'ses_main'}});
  await handler({type:'session.idle', properties:{sessionID:'ses_main'}});

  assert.deepEqual([...childSessions], ['ses_child']);
  assert.deepEqual(published.map(event => event.type), ['permission', 'working', 'completed']);
  assert.match(published[0].message, /shell/);
});
