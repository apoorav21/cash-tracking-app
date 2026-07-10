# Cashflow — voice-driven money tracker

### ▶ [**Try it live →**](https://apoorav21.github.io/cash-tracking-app/)
No signup — open the link and tap **"Try the demo"** for a pre-loaded sandbox
(your changes stay in your browser and reset on refresh).

Track money you've **borrowed**, **lent**, or invested in **assets** — with interest
math, an Obsidian-style relationship graph, property/installment tracking, and a
floating **＋ button** where you just *speak* a transaction and an LLM fills in the
details for you to review before anything saves.

Built for how personal lending actually works in India: **रुपया सैकड़ा** (% per month)
rates, simple **and** compound interest, cash vs. bank, and a bilingual (Hindi/English)
AI assistant that knows your whole ledger.

- **Android-first** (also builds for iOS and web) via **Capacitor 6** — one web UI, native app. A push to `main` auto-builds the APK in **GitHub Actions**.
- **Voice capture** — tap the mic and speak in Hindi or English; the audio is transcribed by **OpenAI `gpt-4o-transcribe`** and returned as text.
- **AI parsing** — the transcript goes to **OpenAI `gpt-5.4-mini`**, which streams back structured JSON (party, amount, rate, term, method…) token-by-token into an **editable preview**. Nothing writes until you confirm.
- **Munshi — a Hindi/English accounting assistant** (the **₹ Munshi** tab): chat about your money, get step-by-step interest math in the **रुपया सैकड़ा** convention, and let it propose new entries, repayments, or **linked deals** (e.g. *"took ₹5L from X at 1% and lent it to Y at 2%"* → two transactions in one go) that you confirm before saving.
- **Sendable hisab** — ask Munshi for anyone's statement (*"Deepak ka hisab bana ke do, bhejne ke liye"*) and it writes a clean, ready-to-send हिसाब — principal, interest, repayments, balance — with a one-tap **WhatsApp / share** button.
- **Money graph** — a draggable, force-directed **SVG** graph of everyone you owe or who owes you, with **directional arrows** showing which way the money flows.
- **Assets / property** — record plots, flats, land, commercial, gold/silver with **size + unit**, **location**, **installment payments** (progress bar + % paid), **market value** (gain/loss), **rental income**, and a **"next payment due"** reminder.
- **Repayments & partial payments** — record किश्तें against any loan; interest stops accruing on returned principal from its repayment date.
- **Cloud sync** with **DynamoDB**, per-user rows secured by a **Cognito** JWT.
- **Works offline too** — if the cloud isn't configured it falls back to on-device speech recognition, an on-device parser, and `localStorage`.

> **Deployed:** CloudFormation stack `cashflow` in **ap-south-1** (Mumbai). All AI runs
> on **OpenAI** (`gpt-4o-transcribe` for speech, `gpt-5.4-mini` for parsing + Munshi);
> the key lives only in Lambda env vars, never on the device. Endpoints are filled into
> `app/www/config.js`.

---

## Repo layout

```
.
├── app/                    # Capacitor app (the real, installable Android app)
│   ├── capacitor.config.json
│   └── www/                # the UI — index.html, backend.js, config.js
├── backend/                # AWS SAM: DynamoDB + HTTP API + streaming OpenAI Lambdas + Cognito
│   ├── template.yaml
│   ├── deploy.sh           # reads openai.env, passes the key as a NoEcho param
│   └── src/{parse,chat,txns,transcribe}/
└── .github/workflows/
    └── android.yml         # builds the debug APK (and a signed release) on every push
```

---

## Architecture

```
 Android app (Capacitor WebView)
   │
   ├─ mic ──audio──▶ Lambda Function URL (transcribe) ──▶ OpenAI gpt-4o-transcribe
   │                    └─ text ──────────────────────────▶ "Listening…" → transcript
   │
   ├─ transcript ───▶ Lambda Function URL (parse, stream) ─▶ OpenAI gpt-5.4-mini
   │                    └─ streamed JSON draft ────────────▶ editable preview
   │
   ├─ Munshi chat ──▶ Lambda Function URL (chat, stream) ──▶ OpenAI gpt-5.4-mini
   │                    └─ reply + optional <<<ACTION>>> ──▶ "Confirm & save" card
   │
   └─ confirm ──────▶ HTTP API (Cognito JWT authorizer) ──▶ Lambda ──▶ DynamoDB
                          (list / add / delete — rows namespaced by the user's sub)
```

- **Auth:** a **Cognito User Pool** handles email/password sign-up + sign-in. The HTTP API sits behind a **JWT authorizer**, so each request is tied to a verified user and can only touch that user's rows (partition key = Cognito `sub`).
- **AI stays server-side:** speech, parsing, and Munshi all run in **Lambda Function URLs** (`RESPONSE_STREAM` for parse/chat so JSON streams token-by-token; `BUFFERED` for transcription). The OpenAI API key is a **NoEcho CloudFormation parameter** injected into Lambda env — it never ships to the client.
- **Offline fallback:** with the cloud unconfigured, the app uses the browser's `SpeechRecognition`, a local regex/NLP parser, and `localStorage`, so the UI is never blank.

---

## Tech stack

| Layer | Tech |
|---|---|
| **Frontend** | React 18 (UMD, single-file), Babel Standalone, SVG force-directed graph, Nunito |
| **Native** | Capacitor 6 (Android + iOS from one web codebase), GitHub Actions APK build |
| **AI** | OpenAI `gpt-4o-transcribe` (speech-to-text), `gpt-5.4-mini` (parser + Munshi), streaming JSON |
| **AWS** | Lambda Function URLs, HTTP API Gateway, DynamoDB, Cognito (User Pool + Identity Pool), CloudFormation / SAM |
| **Offline** | Browser SpeechRecognition + on-device parser + localStorage |

---

## 1. Deploy the backend

> Already deployed to **ap-south-1**; this documents how to (re)deploy.

**Prerequisites:** an AWS account + credentials, Node.js 20+, and an **OpenAI API key**.

```bash
cd backend
# paste your key into openai.env (gitignored), then:
echo 'OPENAI_API_KEY=sk-...' > openai.env
./deploy.sh
```

`deploy.sh` packages the SAM template and deploys the `cashflow` stack, passing the key
as a **NoEcho** parameter (never lands in source or the template). Model IDs default to
`gpt-5.4-mini` (chat + parse) and `gpt-4o-transcribe` (speech) and can be overridden with
`CHAT_MODEL` / `PARSE_MODEL` / `TRANSCRIBE_MODEL` in `openai.env`.

Copy the stack **Outputs** (`Region`, `ApiBaseUrl`, `ParseUrl`, `ChatUrl`,
`TranscribeUrl`, Cognito IDs) into `app/www/config.js`. Leave a field blank to keep that
feature offline.

---

## 2. Run on web (quick check)

```bash
cd app
npm install
npm run serve        # serves app/www on http://localhost:3000
```

Open it, tap **＋**, hit the mic, and speak: *"Took 3 lakh from Ravi at 15% for 1 year."*

---

## 3. Build the Android app

The APK builds automatically in **GitHub Actions** on every push to `main` — grab the
`cashflow-debug-apk` artifact from the latest run (a signed `cashflow-release` APK + AAB
is also produced when the release keystore secret is configured).

To build locally:

```bash
cd app
npm install
npx cap add android          # creates app/android (first time only)
npx cap sync android
npx cap open android         # opens Android Studio → Run on a device/emulator
```

The mic needs `RECORD_AUDIO` (the CI workflow injects it into the manifest; add it
manually for local builds). iOS is the same flow with `npx cap add ios` and an
`NSMicrophoneUsageDescription` key in `Info.plist`.

---

## The accounting assistant (Munshi)

`backend/src/chat/index.mjs` is a streaming Lambda (Function URL, `RESPONSE_STREAM`)
that calls **OpenAI `gpt-5.4-mini`**. On each message the app sends the assistant the
conversation, a compact JSON of **all** transactions (amounts, dates, rates, basis,
repayments, asset installments), and today's date, so its interest math is grounded in
your real ledger.

It replies in the **same language** you wrote in (Hindi/Hinglish → Hindi), shows the
math कलम-wise, and — only when you ask it to *record* something — appends a hidden
`<<<ACTION>>>` JSON block that the app turns into a **Confirm & save** card. It can emit
several actions at once (e.g. a borrow-and-relend becomes two linked transactions).
Nothing is written without your tap.

## How the AI parsing works

`backend/src/parse/index.mjs` sends the transcript to **OpenAI `gpt-5.4-mini`** with a
strict JSON schema (kind / party / amount / rate / term / method / date / purpose /
notes, plus asset fields: subtype / area / areaUnit / location / marketValue / rent /
nextDue) and streams the JSON back. The app shows an **instant on-device draft** first,
then merges in the model's result as it arrives (the *✨ refining…* indicator), so the
preview is never blank and you can edit anything before saving.

---

## Security notes

- **API auth:** the CRUD API is behind a **Cognito JWT authorizer**; the partition key is the verified `sub`, so users only ever read/write their own rows. The `x-user-id` header is a dev-only fallback for when no token is present.
- **Function URLs** (parse / chat / transcribe) are `AuthType: NONE` for low-latency streaming — add throttling or an authorizer before exposing them widely, so they can't be abused to run up OpenAI cost.
- **Secrets:** `openai.env` (and `*.keystore`) are gitignored; the key is passed to CloudFormation as a NoEcho parameter and only ever lives in Lambda env.
- **CORS:** restrict `AllowedOrigin` for production (the Capacitor origins are `https://localhost` and `capacitor://localhost`).
