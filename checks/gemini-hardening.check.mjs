// Explicit opt-in only: desired future behavior, NOT a passing baseline suite.
// Written against b651038, where all seven failed. Since ecb9533 H01, H03 and H06 pass
// (fixed and also covered in test/gemini-hardening.test.mjs). H02, H04, H05 and H07 were
// judged low risk and left open on purpose, so this file still exits nonzero.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KEY, httpMock, assertNoBlockedCalls } from '../test-support/gemini-offline-guard.mjs';
import { BRIEF, PROMPT, ACTION, text, output, ok, chatArgs, tempRoot, cfg, imageReply } from '../test-support/gemini-fixtures.mjs';
const { geminiChat, geminiImage } = await import('../lib/gemini-api.mjs');
const { Adapters } = await import('../lib/agents.mjs');
afterEach(assertNoBlockedCalls);

test('H01 malformed steps should return controlled failure, not reject', async (t) => {
  httpMock(t, ok({ steps: { type: 'model_output', content: [text(ACTION)] } }));
  const r = await geminiChat(chatArgs());
  assert.equal(r.ok, false);
  assert.ok(r.detail);
});

test('H02 API interaction errors[] should preserve diagnostic on failed status', async (t) => {
  httpMock(t, ok({ status: 'failed', steps: [], errors: [{ code: 'urn:mock:failure', message: `diagnostic marker ${KEY}` }] }));
  const r = await geminiChat(chatArgs());
  assert.equal(r.ok, false);
  assert.equal(r.detail.includes(KEY), false);
  assert.match(r.detail, /diagnostic marker/);
});

test('H03 incomplete status with nonempty text should remain visible through Adapters.chat', async (t) => {
  const root = tempRoot(t);
  httpMock(t, ok({ status: 'incomplete', steps: [output(text('partial'))] }));
  const r = await new Adapters(root, cfg(root)).chat('gemini', BRIEF, PROMPT);
  // Either a controlled failure or partial success is acceptable, but do not lose the status.
  // ecb9533 keeps it with the usage (logged as status=incomplete) instead of in detail.
  assert.match(`${r.detail} ${r.usage?.status || ''}`, /incomplete/);
});

test('H04 missing local attachment should return controlled failure, without fetch', async (t) => {
  const root = tempRoot(t);
  httpMock(t);
  const r = await geminiChat(chatArgs({ images: [path.join(root, 'missing.png')] }));
  assert.equal(r.ok, false);
  assert.ok(r.detail);
});

test('H05 image output write error should return controlled failure', async (t) => {
  const root = tempRoot(t);
  httpMock(t, imageReply());
  const notDir = path.join(root, 'not-a-directory');
  fs.writeFileSync(notDir, 'fixture');
  const r = await geminiImage({ key: KEY, prompt: 'draw', outDir: notDir });
  assert.equal(r.ok, false);
  assert.ok(r.detail);
});

test('H06 invalid base64 should not be reported as successfully generated file', async (t) => {
  const root = tempRoot(t);
  httpMock(t, ok({ steps: [output({ type: 'image', mime_type: 'image/png', data: '!!!!' })] }));
  const r = await geminiImage({ key: KEY, prompt: 'draw', outDir: root });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'out.png')), false);
});

test('H07 image error detail from HTTP 200 text should also redact key', async (t) => {
  const root = tempRoot(t);
  httpMock(t, ok({ steps: [output(text(`upstream diagnostic ${KEY}`))] }));
  const r = await geminiImage({ key: KEY, prompt: 'draw', outDir: root });
  assert.equal(r.ok, false);
  assert.equal(r.detail.includes(KEY), false);
});
