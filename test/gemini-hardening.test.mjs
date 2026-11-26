// Fork hardening (ecb9533): malformed replies, incomplete status, image byte checks, token log.
// Offline like gemini-interactions.test.mjs: the guard blocks real fetch, sockets and CLIs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KEY, httpMock, assertNoBlockedCalls } from '../test-support/gemini-offline-guard.mjs';
import { BRIEF, PROMPT, ACTION, text, output, ok, chatArgs, tempRoot, cfg, imageBlock, PNG } from '../test-support/gemini-fixtures.mjs';
const { geminiChat, geminiImage } = await import('../lib/gemini-api.mjs');
const { Adapters } = await import('../lib/agents.mjs');
afterEach(assertNoBlockedCalls);

for (const [name, steps] of [
  ['steps is an object', { type: 'model_output', content: [text(ACTION)] }],
  ['steps is a string', 'model_output'],
  ['a null step', [null, output(text(''))]],
  ['content is not an array', [{ type: 'model_output', content: text(ACTION) }]],
  ['a null content item', [{ type: 'model_output', content: [null] }]],
]) {
  test(`malformed reply (${name}): controlled failure, no throw`, async (t) => {
    httpMock(t, ok({ steps }));
    const r = await geminiChat(chatArgs());
    assert.equal(r.ok, false);
    assert.match(r.detail, /empty reply/);
  });
}

test('usage carries cached and tool tokens', async (t) => {
  httpMock(t, ok({ usage: { total_input_tokens: 7000, total_cached_tokens: 3000, total_output_tokens: 50, total_thought_tokens: 200, total_tool_use_tokens: 12, total_tokens: 7262 } }));
  const r = await geminiChat(chatArgs());
  assert.deepEqual(r.usage, { input: 7000, cached: 3000, output: 50, thoughts: 200, tool: 12, total: 7262, status: 'completed' });
});

test('incomplete reply with text: status survives Adapters.chat in usage', async (t) => {
  const root = tempRoot(t);
  httpMock(t, ok({ status: 'incomplete', steps: [output(text('partial'))] }));
  const r = await new Adapters(root, cfg(root)).chat('gemini', BRIEF, PROMPT);
  assert.equal(r.ok, true);
  assert.equal(r.usage.status, 'incomplete');
});

test('image: declared MIME wrong, bytes are PNG -> saved as out.png', async (t) => {
  const root = tempRoot(t);
  httpMock(t, ok({ steps: [output(imageBlock('image/jpeg', PNG))] }));
  const r = await geminiImage({ key: KEY, prompt: 'draw', outDir: root });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.file, path.join(root, 'out.png'));
});

for (const [name, data] of [['invalid base64', '!!!!not-base64!!!!'], ['non-image bytes', Buffer.from('hello, this is not an image').toString('base64')]]) {
  test(`image: ${name} rejected, nothing written`, async (t) => {
    const root = tempRoot(t);
    httpMock(t, ok({ steps: [output({ type: 'image', mime_type: 'image/png', data })] }));
    const r = await geminiImage({ key: KEY, prompt: 'draw', outDir: root });
    assert.equal(r.ok, false);
    assert.match(r.detail, /not a valid png\/jpeg\/webp\/gif/);
    assert.deepEqual(fs.readdirSync(root), ['.env']);
  });
}

test('server.mjs turn log shows in/cached/out/think/tool and a non-completed status', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = '${res.usage ? ', end = " : ''}\\n${res.text";
  const a = src.indexOf(start) + start.length, b = src.indexOf(end, a);
  assert.ok(a > start.length && b > a, 'turn log usage fragment not found in server.mjs');
  const line = new Function('res', `return ${src.slice(a, b)}`);
  assert.equal(line({ usage: { input: 1, cached: 2, output: 3, thoughts: 4, tool: 5, status: 'completed' } }), ' tokens in=1 cached=2 out=3 think=4 tool=5');
  assert.equal(line({ usage: { input: 1, output: 3, thoughts: 4, status: 'incomplete' } }), ' tokens in=1 cached=0 out=3 think=4 tool=0 status=incomplete');
});
