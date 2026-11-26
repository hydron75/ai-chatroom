// Imported before application modules. Never delegates to real fetch, sockets or CLIs.
// Defense in depth for the current Node HTTP/CLI paths, not an OS sandbox.
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import assert from 'node:assert/strict';

export const KEY = 'FAKE_GEMINI_KEY_FOR_REGRESSION_ONLY_123';
export const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const blocked = [];
function deny(label) {
  return () => {
    blocked.push(label);
    throw new Error(`Offline regression: blocked ${label}`);
  };
}
for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete process.env[name];
mock.method(globalThis, 'fetch', deny('unexpected fetch'));
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  mock.method(childProcess, name, deny(`child_process.${name}`));
}
for (const [mod, label, names] of [
  [http, 'http', ['request', 'get']], [https, 'https', ['request', 'get']],
  [net, 'net', ['connect', 'createConnection']], [tls, 'tls', ['connect']],
  [dgram, 'dgram', ['createSocket']],
]) {
  for (const name of names) mock.method(mod, name, deny(`${label}.${name}`));
}
mock.method(net.Socket.prototype, 'connect', deny('net.Socket.connect'));
syncBuiltinESMExports();

export function assertNoBlockedCalls() {
  assert.deepEqual(blocked.splice(0), [], 'unexpected real network or CLI path attempted');
}

// Real Response objects, synthetic payloads. No server, no socket, no API credentials.
export function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
}
export function httpMock(t, ...responses) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    const next = responses[calls.length - 1];
    if (!next) throw new Error('Unexpected additional fetch');
    return typeof next === 'function' ? next(url, init) : next;
  });
  // Verify outside fetch: application catch blocks must not swallow test assertions.
  t.after(() => {
    assert.equal(calls.length, responses.length, 'unexpected request count / retry / fallback');
    for (const { url, init } of calls) {
      assert.equal(url, ENDPOINT);
      assert.equal(init.method, 'POST');
      assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
        'content-type': 'application/json', 'x-goog-api-key': KEY,
      });
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.body.includes(KEY), false, 'credential leaked into request body');
      const body = JSON.parse(init.body);
      assert.equal(Object.hasOwn(body, 'store'), true, 'store must be explicitly set');
      assert.strictEqual(body.store, false, 'store must be the boolean false on every request');
      for (const field of ['previous_interaction_id', 'contents', 'generationConfig', 'systemInstruction']) {
        assert.equal(Object.hasOwn(body, field), false, `unexpected ${field}`);
      }
    }
  });
  return calls;
}
export const bodyOf = (calls, i = 0) => JSON.parse(calls[i].init.body);
