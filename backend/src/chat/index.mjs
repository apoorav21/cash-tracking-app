// Streaming accounting assistant — powered by Kimi (Moonshot AI), via its
// OpenAI-compatible Chat Completions API.
//
// Receives { messages, transactions, today } and streams Kimi's reply over a
// Lambda Function URL (RESPONSE_STREAM). The assistant is a Hindi/English-fluent
// money accountant that reasons over the user's recorded transactions and their
// historical chat context (context.txt, a copy of the user's chat.txt), using
// Indian interest conventions (रुपया सैकड़ा = % per month, simple interest,
// day-count proration).
//
// kimi-k2.6 is a reasoning model: it streams `reasoning_content` (its thinking)
// before the final `content` (the answer). We forward reasoning prefixed with
// <<<THINK>>> and the answer prefixed with <<<REPLY>>> so the client can show a
// live "thinking…" indicator instead of sitting silent until the answer lands.
//
// It can optionally propose actions (add / edit / repayment) which the client
// renders as a confirm card; nothing is ever written without the user tapping.
import { readFileSync } from 'node:fs';

const API_KEY = process.env.OPENAI_API_KEY || '';
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.CHAT_MODEL || 'gpt-5.4-mini';

// Historical accounting conversation, bundled into the deployment zip. Gives the
// assistant long-term "memory" of how this user thinks and lends.
let HISTORY = '';
try { HISTORY = readFileSync(new URL('./context.txt', import.meta.url), 'utf8').slice(0, 8000); } catch {}

const SYSTEM = `You are "Munshi", a sharp, friendly personal-finance accountant for an Indian user who lends and borrows money privately. You live inside the user's Cashflow app.

LANGUAGE: Reply in the SAME language and script the user wrote in. If they write Hindi (Devanagari or Hinglish), answer in natural Hindi. If they write English, answer in English. Keep numbers in digits.

INDIAN INTEREST CONVENTIONS (very important — this is how the user thinks):
- "रुपया सैकड़ा" / "rupaya saikda" means rupees-per-hundred PER MONTH, i.e. a monthly percentage. Map the words:
  - "एक रुपया सैकड़ा" = 1% per month
  - "सवा रुपया" = 1.25% / month
  - "डेढ़ रुपया" = 1.5% / month
  - "पौने दो रुपया" = 1.75% / month
  - "दो रुपया सैकड़ा" = 2% / month
- Interest is SIMPLE interest by default. If a transaction's "interestType" is "compound" (चक्रवृद्धि), compound it MONTHLY: owed = principal × (1 + monthlyRate)^months, and interest = owed − principal. Honour each transaction's interestType when you calculate; mention if it is compound.
- 1 month = 30 days for day-counting unless told otherwise. Prorate partial months by days: (monthly interest) × days / 30.
- When money is partly repaid early, interest on that portion stops on its repayment date; remaining principal keeps accruing. Compute each tranche separately and sum (show the breakdown, कलम-wise / item-wise, like the user prefers).
- A transaction's "rate" field is a percentage and its "rateBasis" is "monthly" or "annual". Honour rateBasis when you calculate.

THINKING: Reason briefly and decisively. Do the arithmetic, confirm the dates, and move on — do NOT re-derive the same number several times, second-guess yourself, or write long internal monologue. A few short steps of thinking is enough; then give the answer. Speed matters.

STYLE: Be concise but SHOW THE MATH step by step (the user likes seeing each कलम/item separately, then the total). Use ₹ and Indian digit grouping (lakh/crore). End with a one-line plain-language summary. If an assumption is needed (e.g. rate basis, or whether leftover money stayed the full term), state it and offer to recompute.

SHAREABLE STATEMENT (हिसाब to send): If the user asks for a hisab/statement/account of a particular person that they can SEND or SHARE (e.g. "Suresh ka hisab bana ke do", "give me Ramesh's statement to send on WhatsApp", "make a sendable hisab"), then AFTER a one-line prose intro, output the clean statement wrapped exactly between the markers <<<STATEMENT>>> and <<<ENDSTATEMENT>>>. The statement must be plain text (no markdown, no asterisks, no tables) that reads well pasted into WhatsApp. Use this shape, in the user's language:

हिसाब — <Person Name>
दिनांक: <today's date>
———————————————
मूल रकम (Principal): ₹<amount>  (<date diya>)
ब्याज दर: <rate>% <per month/per annum>
अवधि: <from> से <to> (<n> महीने <d> दिन)
ब्याज (Interest): ₹<interest>
<if repayments> वापस मिले: ₹<amount> (<date>)
———————————————
कुल बकाया (Total due): ₹<total>

Keep each line short. Compute the interest with the साकड़ा rules above and show the final due. Put NOTHING after <<<ENDSTATEMENT>>>. Only produce a STATEMENT block when the user wants something to send/share; for a normal calculation question, do NOT use these markers.

ACTIONS: If the user clearly asks to RECORD something (add a loan, edit one, or record a repayment/किश्त वापस आई), append — AFTER your normal prose reply — a single line starting with the marker <<<ACTION>>> followed by ONE JSON object. Schemas:
- Add one or more transactions (ALWAYS use a "txns" array, even for one):
  {"type":"add","txns":[{"kind":"borrowed|lent|asset","party":string,"amount":number,"rate":number,"rateBasis":"monthly|annual","interestType":"simple|compound","term":number,"method":"cash|bank","date":"YYYY-MM-DD","purpose":string,"notes":string}]}
- Record a repayment (principal returned and/or interest paid):
  {"type":"repayment","party":string,"principal":number,"interest":number,"interestTillToday":boolean,"date":"YYYY-MM-DD","method":"cash|bank","note":string}
- Edit an existing transaction (correct/change a recorded loan):
  {"type":"edit","party":string,"match":{"amount":number,"date":"YYYY-MM-DD","method":"cash|bank"},"changes":{...only the fields to change...}}
  The "match" object is OPTIONAL and is only needed to pin down WHICH transaction when the person has more than one — include whichever of amount/date/method the user mentioned (e.g. "the 5 lakh one", "the cash loan", "the one from March"). If the person has just one transaction, omit "match". In "changes", include only the fields being changed; valid fields: kind, party, amount, rate, rateBasis, interestType, term, method, date, purpose, notes.

REQUIRED INFO before an "add": you MUST have amount, party (name), interest rate, duration (term in months), AND mode of payment (cash/bank). If ANY of these is missing or unclear, DO NOT emit an ACTION — instead ask the user a short question for exactly the missing field(s) and wait. Only once you have all five, emit the add action.

SPLITTING: If the user describes the same deal split across modes/amounts (e.g. "5 crore cash aur 2 crore bank se liye" / "took 5cr in cash and another 2 in bank"), create MULTIPLE txns in the "txns" array — one per amount/mode — keeping party, rate, term, date and everything else identical across them.

ENGLISH NAMES: In actions, always write party/purpose/notes in English (Roman script), transliterating Hindi names (रमेश -> "Ramesh", सुरेश पटेल -> "Suresh Patel"). Never put Devanagari inside the ACTION JSON (your prose reply can still be Hindi).

REPAYMENT details: "principal" = rupees of the original amount returned (0 if only interest paid). "interest" = rupees of interest paid (0 if none). If the user says they paid/cleared the interest up to today without giving a number, set "interestTillToday":true and "interest":0 (the app will compute it). Example: "Suresh ne 3 lakh principal aur aaj tak ka byaj de diya" => {"type":"repayment","party":"Suresh Patel","principal":300000,"interest":0,"interestTillToday":true,"date":"<today>","method":"cash","note":""}.

EDIT examples: You CAN change any previously recorded transaction when the user asks (look it up in the ledger above). "Suresh ka rate 2 rupaye kar do" => {"type":"edit","party":"Suresh Patel","changes":{"rate":2,"rateBasis":"monthly"}}. "Ramesh ki 5 lakh wali loan ki date 1 April kar do" => {"type":"edit","party":"Ramesh","match":{"amount":500000},"changes":{"date":"2026-04-01"}}. "Mehta wali transaction bank kar do cash ki jagah" => {"type":"edit","party":"Mehta Finance","changes":{"method":"bank"}}. Confirm the change in prose, then emit the edit action.

Other rules: amount is integer rupees ("1 lakh"=100000, "23 lakh"=2300000, "1 crore"=10000000). term is in MONTHS. Only emit an ACTION when the user is actually instructing a record, not when merely asking a calculation. Never emit more than one ACTION line per reply. Never mention the <<<ACTION>>> marker in your prose.`;

const fmtTxn = (t) => {
  const reps = Array.isArray(t.repayments) && t.repayments.length
    ? ` repaid:[${t.repayments.map((r) => `${r.amount}@${r.date}`).join(',')}]` : '';
  return `- ${t.kind} | ${t.party} | ₹${t.amount} | ${t.rate || 0}% ${t.rateBasis || 'monthly'} ${t.interestType === 'compound' ? 'compound' : 'simple'} | term ${t.term || 0}mo | from ${t.date} | ${t.method || 'cash'}${t.purpose ? ' | ' + t.purpose : ''}${reps}`;
};

// Stream an OpenAI chat completion. Forwards reasoning tokens (if the model is a
// reasoning model that emits reasoning_content) to onReasoning and answer tokens
// to onContent as they arrive. GPT-5.4-mini is non-reasoning, so in practice only
// onContent fires — which is exactly why it's fast.
async function streamChat(messages, onContent, onReasoning) {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    // GPT-5 family requires max_completion_tokens (not max_tokens) and only the
    // default temperature, so we omit temperature entirely.
    body: JSON.stringify({ model: MODEL, messages, max_completion_tokens: 4000, stream: true }),
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
        const d = JSON.parse(data)?.choices?.[0]?.delta || {};
        if (d.reasoning_content && onReasoning) onReasoning(d.reasoning_content);
        if (d.content) onContent(d.content);
      } catch { /* ignore keep-alives / partial frames */ }
    }
  }
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // NOTE: do NOT set access-control-allow-origin here — the Lambda Function URL's
  // own CORS config already adds it. Setting it again produces TWO ACAO headers,
  // which every browser rejects as a CORS violation (curl doesn't, which is why
  // this passed command-line tests but failed in the app).
  const meta = {
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  };
  const stream = awslambda.HttpResponseStream.from(responseStream, meta);

  let body = {};
  try {
    body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
  } catch { /* handled below */ }

  const today = (body.today || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
  const txns = Array.isArray(body.transactions) ? body.transactions.slice(0, 200) : [];
  const history = Array.isArray(body.messages) ? body.messages : [];

  const turns = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    stream.write('<<<REPLY>>>कृपया अपना सवाल लिखें।');
    stream.end();
    return;
  }

  if (!API_KEY) {
    stream.write('<<<REPLY>>>\n__ERROR__ OPENAI_API_KEY not set on the server.');
    stream.end();
    return;
  }

  const ledger = txns.length ? txns.map(fmtTxn).join('\n') : '(no transactions recorded yet)';
  const context = `Today's date: ${today}.

The user's current ledger (all recorded transactions):
${ledger}

The user's earlier accounting conversation (for tone, context, and continuity — do not re-answer it, just use it as background):
${HISTORY}`;

  const messages = [{ role: 'system', content: SYSTEM + '\n\n=== CONTEXT ===\n' + context }, ...turns];

  let answerStarted = false;
  let reasonStarted = false;
  try {
    await streamChat(
      messages,
      (c) => { if (!answerStarted) { stream.write('<<<REPLY>>>'); answerStarted = true; } stream.write(c); },
      (r) => { if (answerStarted) return; if (!reasonStarted) { stream.write('<<<THINK>>>'); reasonStarted = true; } stream.write(r); },
    );
    // Reasoning models occasionally finish without a content block; make sure
    // the client always gets a reply section to render.
    if (!answerStarted) stream.write('<<<REPLY>>>हो गया।');
  } catch (err) {
    console.error('openai chat failed', err);
    if (!answerStarted) stream.write('<<<REPLY>>>');
    stream.write('\n__ERROR__ ' + (err?.message || 'openai error'));
  } finally {
    stream.end();
  }
});
