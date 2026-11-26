import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KEY, json, httpMock, bodyOf, assertNoBlockedCalls } from '../test-support/gemini-offline-guard.mjs';
import { NORMAL, BOOST, IMAGE, BRIEF, PROMPT, ACTION, EXPECTED_USAGE, EXPECTED_CHAT_USAGE, ZERO_USAGE, text, output, ok, error, PNG, JPEG, WEBP, GIF, imageBlock, imageReply, chatArgs, tempRoot, cfg, abortOnSignal } from '../test-support/gemini-fixtures.mjs';
// Dynamic imports ensure the deny-by-default guard runs before app modules are loaded.
const { geminiChat, geminiImage, DEFAULT_IMAGE_MODEL } = await import('../lib/gemini-api.mjs');
const { Adapters } = await import('../lib/agents.mjs');
afterEach(assertNoBlockedCalls);

function assertSuccess(r, expected = ACTION) {
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.text, expected);
  assert.equal(r.detail, '');
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
}
function assertFailure(r, re) {
  assert.equal(r.ok, false);
  assert.match(r.detail, re);
  assert.equal(r.detail.includes(KEY), false);
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
}
function assertFile(r, file, bytes = PNG) {
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.file, file);
  assert.deepEqual(fs.readFileSync(r.file), bytes);
  assert.deepEqual(r.usage, EXPECTED_USAGE);
}

test('01 normal chat: complete brief and turn, stateless on subsequent call, store forced false', async (t) => {
  const calls = httpMock(t, ok({ id: 'ignored-mock-interaction-id' }), ok());
  const r = await geminiChat(chatArgs({ store: true, previous_interaction_id: 'injected' }));
  assertSuccess(r);
  assert.deepEqual(r.usage, EXPECTED_CHAT_USAGE);
  assertSuccess(await geminiChat(chatArgs({ system: `${BRIEF}\n이전 대화 요약`, prompt: '다음 턴' })));
  assert.deepEqual(bodyOf(calls), {
    model: NORMAL, input: [text(PROMPT)], system_instruction: BRIEF,
    generation_config: { thinking_level: 'medium' }, store: false,
  });
  assert.equal(bodyOf(calls, 1).system_instruction, `${BRIEF}\n이전 대화 요약`);
  assert.deepEqual(bodyOf(calls, 1).input, [text('다음 턴')]);
});

test('02 unset optional fields: no empty generation_config, system_instruction or tools', async (t) => {
  const calls = httpMock(t, ok());
  assertSuccess(await geminiChat({ key: KEY, model: NORMAL, prompt: PROMPT }));
  assert.deepEqual(bodyOf(calls), { model: NORMAL, input: [text(PROMPT)], store: false });
});

for (const [i, effort, expected] of [[3, 'low', 'low'], [4, 'medium', 'medium'], [5, 'high', 'high'], [6, 'XHIGH', 'xhigh'], [7, 'MiXeD', 'mixed']]) {
  test(`${i.toString().padStart(2, '0')} thinking level: ${effort} forwarded as ${expected}`, async (t) => {
    const calls = httpMock(t, ok());
    assertSuccess(await geminiChat(chatArgs({ effort })));
    assert.deepEqual(bodyOf(calls).generation_config, { thinking_level: expected });
    // Client forwards the value; success here is NOT evidence of provider model support.
  });
}

test('08 unsupported thinking level: provider 400 is returned; no retry or silent downgrade', async (t) => {
  const calls = httpMock(t, error(400, 'INVALID_ARGUMENT', 'unsupported thinking_level'));
  const r = await geminiChat(chatArgs({ effort: 'minimal' }));
  assertFailure(r, /HTTP 400 INVALID_ARGUMENT.*unsupported thinking_level/);
  assert.equal(bodyOf(calls).generation_config.thinking_level, 'minimal');
});

test('09 adapter API mode: no agy dependency, 120000 char cap, ordinary model and usage', async (t) => {
  const root = tempRoot(t), config = cfg(root);
  const calls = httpMock(t, ok());
  const a = new Adapters(root, config);
  assert.equal(a.geminiApiMode(), true);
  assert.equal(a.geminiApiKeyMode(), false);
  assert.equal(a.available().gemini, true);
  assert.equal(a.canSee('gemini'), true);
  assert.equal(a.maxPromptChars('gemini'), 120000);
  assert.equal(fs.existsSync(config.bins.agy), false);
  const reply = await a.chat('gemini', BRIEF, PROMPT);
  assertSuccess(reply);
  assert.deepEqual(reply.usage, EXPECTED_CHAT_USAGE);
  const r = bodyOf(calls);
  assert.equal(r.model, NORMAL);
  assert.equal(r.generation_config.thinking_level, 'medium');
  assert.equal(Object.hasOwn(r, 'tools'), false);
  assert.deepEqual(r.input, [text(PROMPT)]);
  assert.equal(r.system_instruction, BRIEF);
  assert.deepEqual(a.sessions, {});
});

test('10 Boost: model/effort override, longer configured timeout, next ordinary turn unchanged', async (t) => {
  const root = tempRoot(t), config = cfg(root, { gemini: { boost: { model: BOOST, effort: 'xhigh' } } });
  const before = structuredClone(config);
  const calls = httpMock(t, ok(), ok());
  const originalTimeout = globalThis.setTimeout;
  const timeouts = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    timeouts.push(ms);
    return originalTimeout(fn, ms, ...rest);
  });
  const a = new Adapters(root, config);
  const boosted = await a.chat('gemini', BRIEF, PROMPT, { boost: true });
  assertSuccess(boosted);
  assert.deepEqual(boosted.usage, EXPECTED_CHAT_USAGE);
  assert.equal(bodyOf(calls).model, BOOST);
  assert.deepEqual(bodyOf(calls).generation_config, { thinking_level: 'xhigh' });
  assert.ok(timeouts.includes(9000));
  const ordinary = await a.chat('gemini', BRIEF, PROMPT, { boost: false });
  assertSuccess(ordinary);
  assert.equal(bodyOf(calls, 1).model, NORMAL);
  assert.deepEqual(bodyOf(calls, 1).generation_config, { thinking_level: 'medium' });
  assert.ok(timeouts.includes(3000));
  assert.deepEqual(config, before);
});

for (const [i, boost, model, level] of [[11, { model: BOOST }, BOOST, 'medium'], [12, { effort: 'high' }, NORMAL, 'high'], [13, undefined, NORMAL, 'medium'], [14, { model: BOOST, effort: 'medium' }, BOOST, 'medium']]) {
  test(`${i} Boost configuration: ${JSON.stringify(boost) || 'absent'}`, async (t) => {
    const root = tempRoot(t), calls = httpMock(t, ok());
    const a = new Adapters(root, cfg(root, { gemini: { boost } }));
    const r = await a.chat('gemini', BRIEF, PROMPT, { boost: true });
    assertSuccess(r);
    assert.equal(bodyOf(calls).model, model);
    assert.equal(bodyOf(calls).generation_config.thinking_level, level);
    assert.deepEqual(r.usage, EXPECTED_CHAT_USAGE);
  });
}

test('15 attached images: adapter preserves order/MIME/base64, skips missing file', async (t) => {
  const root = tempRoot(t), calls = httpMock(t, ok());
  const photo = path.join(root, 'first.PNG'), second = path.join(root, 'second.JPEG');
  const secondBytes = JPEG;
  fs.writeFileSync(photo, PNG); fs.writeFileSync(second, secondBytes);
  const a = new Adapters(root, cfg(root));
  assertSuccess(await a.chat('gemini', BRIEF, PROMPT, { images: [photo, path.join(root, 'missing.png'), second] }));
  assert.deepEqual(bodyOf(calls).input, [imageBlock('image/png'), imageBlock('image/jpeg', secondBytes), text(PROMPT)]);
});

test('16 Google Search enabled: include only tool and concatenate model_output text, not thought/tool data', async (t) => {
  const root = tempRoot(t), calls = httpMock(t, ok({ steps: [
    { type: 'thought', summary: [text('hidden thought')], signature: 'mock' },
    { type: 'function_call', name: 'google:search', id: 'call-1', arguments: { queries: ['mock search'] } },
    { type: 'function_result', name: 'google:search', call_id: 'call-1', result: [text('untrusted tool text')] },
    output(text('{"action":'), imageBlock(), { type: 'text', text: 123 }),
    output(text('"pass"}')),
  ] }));
  const a = new Adapters(root, cfg(root, { webSearch: true }));
  const r = await a.chat('gemini', BRIEF, PROMPT);
  assertSuccess(r);
  assert.deepEqual(JSON.parse(r.text), { action: 'pass' });
  assert.deepEqual(bodyOf(calls).tools, [{ type: 'google_search' }]);
  assert.deepEqual(r.usage, EXPECTED_CHAT_USAGE);
});

test('17 Google Search disabled: tools absent, caller store:true ignored', async (t) => {
  const root = tempRoot(t), calls = httpMock(t, ok());
  const a = new Adapters(root, cfg(root, { webSearch: false, gemini: { store: true } }));
  assertSuccess(await a.chat('gemini', BRIEF, PROMPT));
  assert.equal(Object.hasOwn(bodyOf(calls), 'tools'), false);
});

test('18 usage mapping: missing usage becomes zero; partial counts not recalculated', async (t) => {
  httpMock(t, ok({ usage: undefined }), ok({ usage: { total_input_tokens: 7, total_output_tokens: 0, total_tokens: 42 } }));
  const a = await geminiChat(chatArgs()), b = await geminiChat(chatArgs());
  assertSuccess(a); assertSuccess(b);
  assert.deepEqual(a.usage, ZERO_USAGE);
  assert.deepEqual(b.usage, { input: 7, cached: 0, output: 0, thoughts: 0, tool: 0, total: 42, status: 'completed' });
});

test('19 direct image: default model, base64 file written, no search/thinking config, store forced false', async (t) => {
  const root = tempRoot(t), calls = httpMock(t, imageReply());
  const r = await geminiImage({ key: KEY, prompt: 'draw a test image', outDir: root, store: true });
  assert.equal(DEFAULT_IMAGE_MODEL, IMAGE);
  assertFile(r, path.join(root, 'out.png'));
  assert.deepEqual(bodyOf(calls), { model: IMAGE, input: [text('Generate this image:\ndraw a test image')], store: false });
});

test('20 adapter image: configured image model, reference note, MIME and directory, usage', async (t) => {
  const root = tempRoot(t), ref = path.join(root, 'reference.png');
  fs.writeFileSync(ref, PNG);
  const calls = httpMock(t, imageReply());
  const a = new Adapters(root, cfg(root, { gemini: { imageModel: 'test-image-model-override' }, webSearch: true }));
  const r = await a.image('gemini', 'reference test', { refSheet: ref });
  assertFile(r, r.file);
  assert.equal(path.dirname(path.dirname(r.file)), path.join(root, 'data', 'cwd', 'gemini'));
  assert.match(path.basename(path.dirname(r.file)), /^img-\d+$/);
  assert.equal(path.basename(r.file), 'out.png');
  const body = bodyOf(calls);
  assert.equal(body.model, 'test-image-model-override');
  assert.deepEqual(body.input[0], imageBlock());
  assert.match(body.input[1].text, /^Generate this image:\nreference test\n\nThe attached character design sheet is an appearance reference only/);
  assert.equal(Object.hasOwn(body, 'tools'), false);
  assert.equal(Object.hasOwn(body, 'generation_config'), false);
});

test('21 adapter image: absent imageModel defaults; nonexistent reference not sent', async (t) => {
  const root = tempRoot(t), calls = httpMock(t, imageReply());
  const a = new Adapters(root, cfg(root, { gemini: { imageModel: undefined } }));
  const r = await a.image('gemini', 'no ref', { refSheet: path.join(root, 'missing.png') });
  assertFile(r, r.file);
  assert.equal(bodyOf(calls).model, IMAGE);
  assert.deepEqual(bodyOf(calls).input, [text('Generate this image:\nno ref')]);
});

for (const [i, mime, ext, bytes] of [[22, 'image/jpeg', '.jpg', JPEG], [23, 'image/webp', '.webp', WEBP], [24, 'image/gif', '.gif', GIF], [25, 'image/unknown', '.png', PNG]]) {
  test(`${i} image output MIME: ${mime} -> ${ext} (byte transport only)`, async (t) => {
    const root = tempRoot(t);
    httpMock(t, ok({ steps: [{ type: 'thought', summary: [imageBlock('image/png')] }, output(imageBlock(mime, bytes), imageBlock())] }));
    assertFile(await geminiImage({ key: KEY, prompt: 'draw', outDir: root }), path.join(root, `out${ext}`), bytes);
  });
}

test('26 image reply contains text only: failure, usage preserved, no output file', async (t) => {
  const root = tempRoot(t);
  httpMock(t, ok({ steps: [output(text('image unavailable'))] }));
  const r = await geminiImage({ key: KEY, prompt: 'draw', outDir: root });
  assertFailure(r, /no image in reply: image unavailable/);
  assert.deepEqual(r.usage, EXPECTED_USAGE);
  assert.equal(r.file, undefined);
  assert.deepEqual(fs.readdirSync(root), ['.env']);
});

test('27 empty or whitespace chat reply: failure with status and usage', async (t) => {
  httpMock(t, ok({ steps: [{ type: 'thought', summary: [text('hidden')] }] }), ok({ status: 'incomplete', steps: [output(text('  \n'))] }));
  const a = await geminiChat(chatArgs()), b = await geminiChat(chatArgs());
  assertFailure(a, /empty reply \(status=completed\)/);
  assertFailure(b, /empty reply \(status=incomplete\)/);
  assert.deepEqual(a.usage, EXPECTED_CHAT_USAGE);
});

test('28 incomplete response with text: direct API currently preserves partial text and status note', async (t) => {
  httpMock(t, ok({ status: 'incomplete', steps: [output(text('partial text'))] }));
  const r = await geminiChat(chatArgs());
  assert.equal(r.ok, true);
  assert.equal(r.text, 'partial text');
  assert.equal(r.detail, 'status=incomplete');
});

for (const [i, status, code, array] of [[29, 400, 'INVALID_ARGUMENT', false], [30, 401, 'UNAUTHENTICATED', true], [31, 403, 'PERMISSION_DENIED', false], [32, 429, 'RESOURCE_EXHAUSTED', true], [33, 503, 'UNAVAILABLE', false]]) {
  test(`${i} HTTP ${status}: ${array ? 'array' : 'object'} error, secret redacted, no retry`, async (t) => {
    httpMock(t, error(status, code, `provider error ${KEY} again ${KEY}`, array));
    const r = await geminiChat(chatArgs());
    assertFailure(r, new RegExp(`HTTP ${status} ${code} provider error \\*\\*\\* again \\*\\*\\*`));
    assert.equal(r.text, '');
  });
}

test('34 HTTP 200 with error field (object and wrapped array) must still fail', async (t) => {
  const e = { error: { status: 'INTERNAL', message: `upstream ${KEY}` } };
  httpMock(t, json(e), json([e]));
  for (let i = 0; i < 2; i++) assertFailure(await geminiChat(chatArgs()), /HTTP 200 INTERNAL upstream \*\*\*/);
});

test('35 non-JSON and empty response bodies: fail without leaking credentials', async (t) => {
  httpMock(t, new Response(`gateway ${KEY}`, { status: 502 }), new Response('<html>not JSON</html>'), new Response(null, { status: 204 }));
  assertFailure(await geminiChat(chatArgs()), /HTTP 502 gateway \*\*\*/);
  assertFailure(await geminiChat(chatArgs()), /HTTP 200.*not JSON/);
  assertFailure(await geminiChat(chatArgs()), /HTTP 204/);
});

test('36 network failure: rejection converted to error and key scrubbed', async (t) => {
  httpMock(t, () => { throw new TypeError(`network unavailable ${KEY}`); });
  assertFailure(await geminiChat(chatArgs()), /TypeError: network unavailable \*\*\*/);
});

test('37 timeout: real AbortController signal aborts mock request, no network', { timeout: 3000 }, async (t) => {
  const calls = httpMock(t, abortOnSignal);
  const r = await geminiChat(chatArgs({ timeoutMs: 20 }));
  assertFailure(r, /timeout after/);
  assert.equal(r.timedOut, true);
  assert.equal(calls[0].init.signal.aborted, true);
});

test('38 no key: direct chat and image fail before fetch', async (t) => {
  const root = tempRoot(t, { key: false });
  httpMock(t);
  const r = await geminiChat(chatArgs({ key: undefined }));
  assertFailure(r, /GEMINI_API_KEY is missing/);
  assert.equal(r.ms, 0);
  assertFailure(await geminiImage({ prompt: 'draw', outDir: root }), /GEMINI_API_KEY is missing/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('39 adapter missing key: chat and image fail with no fetch, no CLI or subscription fallback', async (t) => {
  const root = tempRoot(t, { key: false });
  httpMock(t);
  const a = new Adapters(root, cfg(root));
  const r = await a.chat('gemini', BRIEF, PROMPT);
  assertFailure(r, /exit=1.*GEMINI_API_KEY is missing/);
  const im = await a.image('gemini', 'draw');
  assert.equal(im.ok, false);
  assert.match(im.detail, /GEMINI_API_KEY is missing/);
  assert.equal(im.file, undefined);
  assert.deepEqual(a.sessions, {});
});

test('40 adapter wrong key: API auth failure in normal and Boost and image, no fallback', async (t) => {
  const root = tempRoot(t);
  httpMock(t, error(401, 'UNAUTHENTICATED', KEY), error(403, 'PERMISSION_DENIED', KEY), error(401, 'UNAUTHENTICATED', KEY));
  const a = new Adapters(root, cfg(root));
  assertFailure(await a.chat('gemini', BRIEF, PROMPT), /exit=1.*HTTP 401 UNAUTHENTICATED \*\*\*/);
  assertFailure(await a.chat('gemini', BRIEF, PROMPT, { boost: true }), /exit=1.*HTTP 403 PERMISSION_DENIED \*\*\*/);
  const r = await a.image('gemini', 'draw');
  assert.equal(r.ok, false);
  assert.match(r.detail, /HTTP 401 UNAUTHENTICATED \*\*\*/);
  assert.equal(r.file, undefined);
  assert.deepEqual(a.sessions, {});
  assert.equal(fs.existsSync(path.join(root, 'data', 'agy-home')), false);
});

test('41 direct image HTTP failure: no file, credential redacted', async (t) => {
  const root = tempRoot(t);
  httpMock(t, error(429, 'RESOURCE_EXHAUSTED', `limit ${KEY}`, true));
  const r = await geminiImage({ key: KEY, prompt: 'draw', outDir: root });
  assertFailure(r, /HTTP 429 RESOURCE_EXHAUSTED limit \*\*\*/);
  assert.deepEqual(fs.readdirSync(root), ['.env']);
});

test('42 image timeout: abort observed and timeout error returned, no output file', { timeout: 3000 }, async (t) => {
  const root = tempRoot(t), calls = httpMock(t, abortOnSignal);
  const r = await geminiImage({ key: KEY, prompt: 'draw', outDir: root, timeoutMs: 20 });
  assertFailure(r, /timeout after/);
  assert.equal(calls[0].init.signal.aborted, true);
  assert.deepEqual(fs.readdirSync(root), ['.env']);
});
