// [fork] Gemini members straight on the Gemini API (Google AI Studio key), no agy in between.
// Used when config agents.gemini.auth = "api". Plain fetch (no packages) against the
// Interactions API (POST /v1beta/interactions), Google's recommended interface; the older
// generateContent still works but is called legacy. Stateless like every other member: the
// room sends the whole brief and turn on each call, so there is nothing to keep between calls.
//
// store: false is NOT optional. By default the Interactions API keeps every request on
// Google's side (55 days on the paid tier), and these requests hold the room's chat and the
// photos the owner posts. With store:false nothing is kept and no interaction id comes back.
//
// The key comes from the caller (.env GEMINI_API_KEY) and only ever travels in the
// x-goog-api-key header. A missing or wrong key just fails; nothing here falls back to agy
// or to a subscription login.
//
// Docs: interactions    https://ai.google.dev/gemini-api/docs/interactions
//       thinking levels https://ai.google.dev/gemini-api/docs/thinking
//       image models    https://ai.google.dev/gemini-api/docs/image-generation
//       prices          https://ai.google.dev/gemini-api/docs/pricing

import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// Image model used when agents.gemini.imageModel is not set (Nano Banana 2.1).
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const imageInput = (file) => ({
  type: 'image',
  mime_type: MIME[path.extname(file).toLowerCase()] || 'image/png',
  data: fs.readFileSync(file).toString('base64'),
});

// One interactions call. Returns {ok, json, ms, detail, timedOut}; never throws.
async function post({ key, body, timeoutMs }) {
  const t0 = Date.now();
  if (!key) {
    return { ok: false, ms: 0, detail: 'GEMINI_API_KEY is missing from .env (auth "api" never falls back to agy or a subscription login)' };
  }
  const scrub = (s) => String(s ?? '').split(key).join('***');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, store: false }),
      signal: ac.signal,
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* not json */ }
    const ms = Date.now() - t0;
    const e = (Array.isArray(json) ? json[0] : json)?.error; // errors can arrive as [{error: ...}]
    if (!res.ok || !json || e) {
      return { ok: false, ms, detail: scrub(`HTTP ${res.status}${e?.status ? ` ${e.status}` : ''} ${e?.message || raw.slice(0, 300)}`) };
    }
    return { ok: true, json, ms };
  } catch (e) {
    const timedOut = e?.name === 'AbortError';
    return { ok: false, ms: Date.now() - t0, timedOut, detail: scrub(timedOut ? `timeout after ${Math.round(timeoutMs / 1000)}s` : `${e?.name}: ${e?.message}`) };
  } finally {
    clearTimeout(timer);
  }
}

const usageOf = (json) => {
  const u = json?.usage || {};
  return { input: u.total_input_tokens || 0, output: u.total_output_tokens || 0, thoughts: u.total_thought_tokens || 0, total: u.total_tokens || 0 };
};

// The model's own output: content blocks of the model_output steps (thoughts and search
// call/result steps are left out).
const outputBlocks = (json) => (json.steps || []).filter((s) => s.type === 'model_output').flatMap((s) => s.content || []);

// One chat turn. `system` is the room's brief, `prompt` the turn, `images` absolute paths of
// photos sent inline. `effort` is the thinking level (low | medium | high | xhigh; the model
// decides which it accepts) and is left out when unset, so the model's own default applies.
// `search` turns on Grounding with Google Search (config webSearch).
// Returns {ok, text, ms, usage, detail, timedOut}.
export async function geminiChat({ key, model, effort, system, prompt, images = [], search = false, timeoutMs = 150000 }) {
  const body = { model, input: [...images.map(imageInput), { type: 'text', text: prompt }] };
  if (system) body.system_instruction = system;
  if (effort) body.generation_config = { thinking_level: String(effort).toLowerCase() };
  if (search) body.tools = [{ type: 'google_search' }];

  const r = await post({ key, body, timeoutMs });
  if (!r.ok) return { ok: false, text: '', ms: r.ms, timedOut: r.timedOut, detail: r.detail };
  const text = outputBlocks(r.json).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  const usage = usageOf(r.json);
  let detail = '';
  if (!text.trim()) detail = `empty reply (status=${r.json.status || 'none'})`;
  else if (r.json.status && r.json.status !== 'completed') detail = `status=${r.json.status}`; // text came back, so only a note
  return { ok: !!text.trim(), text, ms: r.ms, usage, detail };
}

// One image. `refImage` is an optional reference picture (looks only), `outDir` where to save.
// Returns {ok, file, ms, usage, detail}, the same shape as the other members' image().
export async function geminiImage({ key, model = DEFAULT_IMAGE_MODEL, prompt, refImage, refNote, outDir, timeoutMs = 240000 }) {
  const ask = `Generate this image:\n${prompt}${refImage && refNote ? `\n\n${refNote}` : ''}`;
  const body = { model, input: [...(refImage ? [imageInput(refImage)] : []), { type: 'text', text: ask }] };
  const r = await post({ key, body, timeoutMs });
  if (!r.ok) return { ok: false, ms: r.ms, detail: r.detail };
  const blocks = outputBlocks(r.json);
  const img = blocks.find((c) => c.type === 'image' && c.data);
  if (!img) {
    const note = blocks.filter((c) => typeof c.text === 'string').map((c) => c.text).join(' ').slice(0, 300);
    return { ok: false, ms: r.ms, usage: usageOf(r.json), detail: `no image in reply${note ? `: ${note}` : ` (status=${r.json.status || 'none'})`}` };
  }
  const file = path.join(outDir, `out${EXT[img.mime_type] || '.png'}`);
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
  return { ok: true, file, ms: r.ms, usage: usageOf(r.json), detail: '' };
}
