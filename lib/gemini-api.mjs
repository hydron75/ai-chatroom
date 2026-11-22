// [fork] Gemini members straight on the Gemini API (Google AI Studio key), no agy in between.
// Used when config agents.gemini.auth = "api". Plain fetch (no packages) against
// generateContent. Stateless like every other member: the room sends the whole brief and
// turn on each call, so there is nothing to keep between calls.
//
// The key comes from the caller (.env GEMINI_API_KEY) and only ever travels in the
// x-goog-api-key header. A missing or wrong key just fails; nothing here falls back to agy
// or to a subscription login.
//
// Docs: thinking levels  https://ai.google.dev/gemini-api/docs/thinking
//       image models     https://ai.google.dev/gemini-api/docs/image-generation
//       prices           https://ai.google.dev/gemini-api/docs/pricing

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Image model used when agents.gemini.imageModel is not set (Nano Banana 2.1).
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const inlineImage = (file) => ({
  inlineData: { mimeType: MIME[path.extname(file).toLowerCase()] || 'image/png', data: fs.readFileSync(file).toString('base64') },
});

// One generateContent call. Returns {ok, json, ms, detail, timedOut}; never throws.
async function post({ key, model, body, timeoutMs }) {
  const t0 = Date.now();
  if (!key) {
    return { ok: false, ms: 0, detail: 'GEMINI_API_KEY is missing from .env (auth "api" never falls back to agy or a subscription login)' };
  }
  const scrub = (s) => String(s ?? '').split(key).join('***');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* not json */ }
    const ms = Date.now() - t0;
    if (!res.ok || !json) {
      const e = json?.error;
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
  const u = json?.usageMetadata || {};
  return { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0, total: u.totalTokenCount || 0 };
};

// One chat turn. `system` is the room's brief, `prompt` the turn, `images` absolute paths of
// photos sent inline. `effort` is the thinking level (low | medium | high | xhigh; the model
// decides which it accepts) and is left out when unset, so the model's own default applies.
// `search` turns on Grounding with Google Search (config webSearch).
// Returns {ok, text, ms, usage, detail, timedOut}.
export async function geminiChat({ key, model, effort, system, prompt, images = [], search = false, timeoutMs = 150000 }) {
  const body = {
    contents: [{ role: 'user', parts: [...images.map(inlineImage), { text: prompt }] }],
    generationConfig: {},
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (effort) body.generationConfig.thinkingConfig = { thinkingLevel: String(effort).toLowerCase() };
  if (search) body.tools = [{ google_search: {} }];

  const r = await post({ key, model, body, timeoutMs });
  if (!r.ok) return { ok: false, text: '', ms: r.ms, timedOut: r.timedOut, detail: r.detail };
  const cand = r.json.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  const usage = usageOf(r.json);
  let detail = '';
  if (!text.trim()) {
    const block = r.json.promptFeedback?.blockReason;
    detail = block ? `blocked: ${block}` : `empty reply (finishReason=${cand?.finishReason || 'none'})`;
  } else if (cand?.finishReason && cand.finishReason !== 'STOP') {
    detail = `finishReason=${cand.finishReason}`; // text came back, so this is only a note
  }
  return { ok: !!text.trim(), text, ms: r.ms, usage, detail };
}

// One image. `refImage` is an optional reference picture (looks only), `outDir` where to save.
// Returns {ok, file, ms, usage, detail}, the same shape as the other members' image().
export async function geminiImage({ key, model = DEFAULT_IMAGE_MODEL, prompt, refImage, refNote, outDir, timeoutMs = 240000 }) {
  const ask = `Generate this image:\n${prompt}${refImage && refNote ? `\n\n${refNote}` : ''}`;
  const body = {
    contents: [{ role: 'user', parts: [...(refImage ? [inlineImage(refImage)] : []), { text: ask }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };
  const r = await post({ key, model, body, timeoutMs });
  if (!r.ok) return { ok: false, ms: r.ms, detail: r.detail };
  const parts = r.json.candidates?.[0]?.content?.parts || [];
  const img = parts.map((p) => p.inlineData || p.inline_data).find((d) => d?.data);
  if (!img) {
    const note = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join(' ').slice(0, 300);
    const block = r.json.promptFeedback?.blockReason;
    return { ok: false, ms: r.ms, usage: usageOf(r.json), detail: block ? `blocked: ${block}` : `no image in reply${note ? `: ${note}` : ''}` };
  }
  const mime = img.mimeType || img.mime_type || 'image/png';
  const file = path.join(outDir, `out${EXT[mime] || '.png'}`);
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
  return { ok: true, file, ms: r.ms, usage: usageOf(r.json), detail: '' };
}
