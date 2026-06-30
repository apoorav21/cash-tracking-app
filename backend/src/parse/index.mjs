// Streaming transaction parser — powered by Kimi (Moonshot AI) via its
// OpenAI-compatible Chat Completions API.
// Receives { text } and streams back the model's JSON token-by-token over a
// Lambda Function URL (RESPONSE_STREAM). The client renders the stream live and
// JSON.parses the final accumulated text into a transaction draft.

const API_KEY = process.env.OPENAI_API_KEY || '';
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
// Parsing one sentence into a small JSON object is a simple, well-bounded task,
// so we use a small, fast, cheap model (gpt-5.4-mini by default).
const MODEL = process.env.PARSE_MODEL || 'gpt-5.4-mini';

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const SYSTEM = `You convert a spoken/typed sentence about an Indian personal loan, asset, or money transfer into ONE JSON object describing the transaction. Output ONLY the JSON object — no prose, no markdown, no code fences.

Schema (use exactly these keys):
{
  "kind": "borrowed" | "lent" | "asset",   // borrowed = I took money; lent = I gave money; asset = I bought property/land/etc.
  "party": string,                          // the other person, lender, borrower, or asset name. "" if unknown.
  "amount": number,                          // rupees as an integer. "1 lakh" = 100000, "2 cr" = 20000000, "50k" = 50000.
  "rate": number,                            // interest percent (a plain number). 0 if none/asset.
  "rateBasis": "monthly" | "annual",        // "रुपया सैकड़ा"/"saikda"/"per month" => "monthly" (DEFAULT). "per annum"/"p.a."/"yearly" => "annual".
  "interestType": "simple" | "compound",    // "simple" by DEFAULT. "compound"/"चक्रवृद्धि"/"chakravriddhi" => "compound".
  "term": number,                            // duration in MONTHS. "1 year" = 12. 0 if not stated/asset.
  "method": "cash" | "bank",                // default "cash"; "bank" for transfer/upi/neft/cheque/account/online.
  "date": string,                            // YYYY-MM-DD. Use today's date unless another date is clearly stated.
  "purpose": string,                         // short reason if stated, else "".
  "notes": string                            // anything extra worth keeping, else "".
}

Rules:
- ALWAYS write every string field (party, purpose, notes) in ENGLISH using the Latin/Roman alphabet, even when the user speaks or types in Hindi/Devanagari. Transliterate names to their normal English spelling: "रमेश" -> "Ramesh", "सुरेश पटेल" -> "Suresh Patel", "मेहता फाइनेंस" -> "Mehta Finance". Never output Devanagari in the JSON.
- Infer kind from verbs: took/borrowed/got -> borrowed; lent/gave/loaned -> lent; bought/purchased + property/plot/land/flat/house -> asset.
- "रुपया सैकड़ा" means rupees-per-hundred PER MONTH: "do rupaye saikda"=2 (monthly), "dedh"=1.5, "sava"=1.25, "paune do"=1.75. Set rateBasis="monthly" for these.
- Default rateBasis to "monthly" unless the sentence clearly says per-annum/yearly.
- Default interestType to "simple" unless the sentence says compound / चक्रवृद्धि / chakravriddhi.
- amount is always a plain integer number of rupees, never a string.
- Today's date is ${today()}.
- If a field is genuinely unknown, use "" for strings and 0 for numbers. Never invent specifics.`;

// Stream an OpenAI chat completion, calling onText(delta) per token.
async function streamChat(messages, onText) {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    // GPT-5 family requires max_completion_tokens and only the default temperature.
    body: JSON.stringify({ model: MODEL, messages, max_completion_tokens: 800, stream: true }),
  });
  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${detail.slice(0, 300)}`);
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of resp.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (delta) onText(delta);
      } catch { /* ignore */ }
    }
  }
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // Do NOT set access-control-allow-origin here — the Function URL CORS config
  // already adds it; setting it twice makes browsers reject the response.
  const meta = {
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  };
  const stream = awslambda.HttpResponseStream.from(responseStream, meta);

  let text = '';
  try {
    const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
    text = (body.text || '').toString().slice(0, 1000);
  } catch { /* ignore — handled below */ }

  if (!text.trim()) {
    stream.write('{}');
    stream.end();
    return;
  }
  if (!API_KEY) {
    stream.write('\n__ERROR__ OPENAI_API_KEY not set on the server.');
    stream.end();
    return;
  }

  try {
    await streamChat(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
      (t) => stream.write(t),
    );
  } catch (err) {
    // Surface a parseable error so the client can fall back to its offline parser.
    console.error('openai parse failed', err);
    stream.write('\n__ERROR__ ' + (err?.message || 'openai error'));
  } finally {
    stream.end();
  }
});
