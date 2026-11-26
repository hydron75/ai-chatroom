import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEY, json } from './gemini-offline-guard.mjs';

export const NORMAL = 'gemini-4-hydrogen';
export const BOOST = 'gemini-4-neon';
export const IMAGE = 'gemini-nano-banana-2.1';
export const BRIEF = '방 브리프: 다른 멤버와 한국어로 대화합니다.';
export const PROMPT = '방장: 테스트 메시지';
export const ACTION = '{"action":"pass"}';
export const USAGE = { total_input_tokens: 117, total_output_tokens: 23, total_thought_tokens: 41, total_tokens: 188, total_tool_use_tokens: 7 };
// Image calls report usage only; chat calls also carry the reply status (ecb9533).
export const EXPECTED_USAGE = { input: 117, cached: 0, output: 23, thoughts: 41, tool: 7, total: 188 };
export const EXPECTED_CHAT_USAGE = { ...EXPECTED_USAGE, status: 'completed' };
export const ZERO_USAGE = { input: 0, cached: 0, output: 0, thoughts: 0, tool: 0, total: 0, status: 'completed' };
export const text = (value) => ({ type: 'text', text: value });
export const output = (...content) => ({ type: 'model_output', content });
export const complete = (overrides = {}) => ({
  object: 'interaction', status: 'completed', steps: [output(text(ACTION))], usage: USAGE, ...overrides,
});
export const ok = (overrides = {}) => json(complete(overrides));
export const error = (status, code, message, array = false) => {
  const payload = { error: { code: status, status: code, message } };
  return json(array ? [payload] : payload, status);
};
// Valid 2x2 image fixtures; generated offline and embedded so no dependencies are needed.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMM6DnBwMDAxMDAwMDAAAATYgGoi/w1rQAAAABJRU5ErkJggg==', 'base64');
export const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBaKKK+kPAP/9k=', 'base64');
export const WEBP = Buffer.from('UklGRjYAAABXRUJQVlA4ICoAAADwAQCdASoCAAIAAUAmJaACdLoB+AAEyAAAm//LPn8NnHv/5BcsLriMAAA=', 'base64');
export const GIF = Buffer.from('R0lGODdhAgACAIEAAFCMyAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7', 'base64');
export const imageBlock = (mime = 'image/png', data = PNG) => ({ type: 'image', mime_type: mime, data: data.toString('base64') });
export const imageReply = (mime = 'image/png', data = PNG) => ok({ steps: [output(text('done'), imageBlock(mime, data))] });
export const chatArgs = (overrides = {}) => ({ key: KEY, model: NORMAL, effort: 'medium', system: BRIEF, prompt: PROMPT, ...overrides });
export function tempRoot(t, { key = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (key) fs.writeFileSync(path.join(root, '.env'), `GEMINI_API_KEY=${KEY}\n`, { mode: 0o600 });
  return root;
}
export function cfg(root, { gemini = {}, ...overrides } = {}) {
  return {
    // Nonexistent paths deliberately prevent CLI discovery and execution.
    bins: Object.fromEntries(['claude', 'codex', 'grok', 'agy'].map((x) => [x, path.join(root, `never-run-${x}`)])),
    webSearch: false, turnTimeoutSec: 3, boost: { timeoutSec: 9 },
    agents: { gemini: { auth: 'api', model: NORMAL, effort: 'medium', boost: { model: BOOST, effort: 'medium' }, imageModel: IMAGE, ...gemini } },
    ...overrides,
  };
}
export function abortOnSignal(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
