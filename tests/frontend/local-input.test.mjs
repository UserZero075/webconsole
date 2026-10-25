import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const CONSOLE = new URL('../../templates/console.html', import.meta.url);

test('Shift+Enter inserts a local newline without submitting the input', async () => {
  const source = await readFile(CONSOLE, 'utf8');
  const start = source.indexOf('function handleLocalInputKeydown(');
  const end = source.indexOf('\n        function updateLocalInputUI', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the local input key handler is present');

  let buffer = 'first';
  const sent = [];
  const context = vm.createContext({
    localInputMode:true,
    insertLocalVisual:text => { buffer += text; },
    sendInput:data => { sent.push(data); },
  });
  vm.runInContext(`${implementation}\nthis.handleKeydown = handleLocalInputKeydown;`, context);

  let prevented = false;
  const handled = context.handleKeydown({
    type:'keydown', key:'Enter', shiftKey:true,
    preventDefault() { prevented = true; },
  });
  assert.equal(handled, false, 'xterm must not forward Shift+Enter as a submit');
  assert.equal(prevented, true);
  assert.equal(buffer, 'first\n');

  prevented = false;
  assert.equal(context.handleKeydown({
    type:'keydown', key:'Enter', shiftKey:false,
    preventDefault() { prevented = true; },
  }), true, 'plain Enter remains available to submit');
  assert.equal(prevented, false);

  context.localInputMode = false;
  assert.equal(context.handleKeydown({
    type:'keydown', key:'Enter', shiftKey:true,
    ctrlKey:false, metaKey:false, altKey:false,
    preventDefault() {},
  }), false, 'live terminals must not treat Shift+Enter as plain Enter');
  assert.deepEqual(sent, ['\x1b[13;2u']);
  assert.match(source, /if \(!handleLocalInputKeydown\(e\)\) return false;/);
});

test('local input sends embedded newlines as modified Enter key events', async () => {
  const source = await readFile(CONSOLE, 'utf8');
  const start = source.indexOf('function completedLocalInputPayload(');
  const end = source.indexOf('\n        function getLineContext', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the completed input encoder is present');

  const context = vm.createContext({});
  vm.runInContext(`${implementation}\nthis.encodeInput = completedLocalInputPayload;`, context);
  assert.equal(context.encodeInput('first\nsecond'), 'first\x1b[13;2usecond\r');
  assert.match(source, /sendInput\(completedLocalInputPayload\(line\)\)/);
});
