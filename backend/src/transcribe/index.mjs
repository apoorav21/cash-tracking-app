// Speech-to-text — powered by OpenAI's audio transcription API
// (gpt-4o-mini-transcribe by default). The browser records a short voice note,
// base64-encodes it, and POSTs { audio, mime } here; we forward it to OpenAI and
// return { text }. OpenAI auto-detects the language (Hindi or English), which is
// why we switched off Amazon Transcribe's weaker language identification.
//
// Buffered Function URL (not streaming): a voice note is short, so we return the
// whole transcript in one JSON response.

import { checkRateLimit } from './ratelimit.mjs';

const API_KEY = process.env.OPENAI_API_KEY || '';
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
// Optional hard lock to one language (ISO-639-1, e.g. 'hi'). Empty = auto-detect.
const LANGUAGE = (process.env.TRANSCRIBE_LANGUAGE || '').trim();

// Biases the model to Hindi (Devanagari) + English (Latin), away from Urdu/Arabic
// script. The Devanagari sample anchors the script; on silence the model tends to
// echo it, which isNoise() then filters out.
const BIAS = 'Transcribe in Hindi (Devanagari script) or English (Latin script) only. Never use Urdu, Arabic, Persian, or Nastaliq script. यह बातचीत हिंदी और English (Hinglish) में है। उदाहरण: रमेश को पाँच लाख रुपये दिए, दो रुपये सैकड़ा ब्याज, तीन महीने के लिए, cash या bank से, किश्त वापस आई।';

// Strip punctuation/spaces for fuzzy comparison.
const norm = (s) => (s || '').toLowerCase().replace(/[\s।॥.,!?;:'"()\-—]+/g, '');
// Common silence hallucinations across Whisper/gpt-4o-transcribe.
const HALLUCINATIONS = [
  'thank you', 'thanks for watching', 'please subscribe', 'subscribe', 'you', 'bye',
  'शुक्रिया', 'धन्यवाद', 'सब्सक्राइब', 'उपशीर्षक', 'जय हिंद', 'नमस्ते', 'thank you.',
];
// True when `text` is empty, an echo of our prompt, or a known noise phrase.
function isNoise(text) {
  const t = norm(text);
  if (!t) return true;
  const b = norm(BIAS);
  if (b.includes(t) || t.includes(b)) return true;          // echoed the whole/most of the prompt
  if (t.length >= 8 && b.includes(t.slice(0, Math.min(t.length, 30)))) return true; // echoed a chunk
  if (HALLUCINATIONS.some((h) => t === norm(h))) return true;
  return false;
}

// Do NOT set access-control-allow-origin here — the Function URL CORS config adds it.
const reply = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

const extFor = (mime) => {
  if (!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
};

export const handler = async (event) => {
  const rl = await checkRateLimit(event);
  if (!rl.ok) return reply(429, { error: 'Rate limit reached — please wait a minute.' });
  if (!API_KEY) return reply(500, { error: 'OPENAI_API_KEY not set on the server.' });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
  } catch { return reply(400, { error: 'bad json' }); }

  const b64 = (body.audio || '').toString();
  if (!b64) return reply(400, { error: 'no audio' });
  const mime = (body.mime || 'audio/webm').toString();

  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return reply(400, { error: 'bad audio' }); }
  if (!buf.length) return reply(400, { error: 'empty audio' });

  try {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), `audio.${extFor(mime)}`);
    form.append('model', MODEL);
    form.append('response_format', 'json');
    // Bias the model toward HINDI (Devanagari) + ENGLISH (Latin) and away from
    // Urdu/Arabic script. Hindi and Urdu are the same spoken language, so without
    // this hint the model sometimes returns Urdu script; the Devanagari + English
    // sample text in the prompt steers it to the scripts we want. We deliberately
    // do NOT set `language` (that would force a single language and break the
    // Hindi/English mix the user speaks).
    form.append('prompt', (body.prompt ? String(body.prompt).slice(0, 200) + ' ' : '') + BIAS);
    // Hard language lock when configured (guarantees Devanagari, no Urdu).
    if (LANGUAGE) form.append('language', LANGUAGE);

    const resp = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: form,
    });
    const txt = await resp.text();
    if (!resp.ok) {
      console.error('openai transcribe failed', resp.status, txt.slice(0, 300));
      return reply(502, { error: `transcribe ${resp.status}` });
    }
    let text = '';
    try { text = JSON.parse(txt).text || ''; } catch { text = ''; }
    text = text.trim();
    // On silence, transcription models hallucinate — usually echoing our bias
    // prompt or a stock phrase. Drop those so an empty recording stays empty.
    if (isNoise(text)) text = '';
    return reply(200, { text });
  } catch (err) {
    console.error('transcribe error', err);
    return reply(502, { error: err?.message || 'transcribe error' });
  }
};
