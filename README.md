# Cashflow — voice-driven money tracker

Track money you've **borrowed**, **lent**, or invested in **assets** — interest,
maturities, an Obsidian-style relationship map, and a floating **＋ button** where
you just *speak* the transaction and an LLM fills in the details for you to review
before saving.

- **Android-first** (also builds for iOS and web) via **Capacitor** — one web UI, native app.
- **Live speech-to-text** with **Amazon Transcribe streaming** (words appear as you speak).
- **AI parsing** with **Kimi (Moonshot AI)** — streamed back into an editable preview.
- **Munshi — a Hindi/English accounting assistant** (the **₹ Munshi** tab): chat about
  your money, get step-by-step interest math in the Indian **रुपया सैकड़ा** (% per month)
  convention, and let it propose new entries / repayments that you confirm before saving.
  It has full context of every recorded transaction plus your historical `chat.txt`.
- **Repayments & partial payments** — record किश्तें against any loan; interest stops
  accruing on returned principal from its repayment date (day-count, 30-day month).
- **Edit / delete** any transaction, **monthly (सैकड़ा) or annual** rate basis per loan.
- **Cloud sync** with **DynamoDB**.

> **Deployed:** CloudFormation stack `cashflow` in **ap-south-1** (Mumbai), model
> `global.anthropic.claude-sonnet-4-5-20250929-v1:0`. Endpoints are already filled
> into `app/www/config.js`.
- **Works offline too**: if the cloud isn't configured it falls back to on-device speech
  recognition, an on-device parser, and `localStorage`.

```
.
├── prototype.html        # static design preview (no backend) — open in any browser
├── backend/              # AWS SAM: DynamoDB + HTTP API + streaming Bedrock parser + Cognito
│   ├── template.yaml
│   └── src/{parse,txns}/
└── app/                  # Capacitor app (the real, installable Android app)
    ├── capacitor.config.json
    └── www/              # the UI — index.html, backend.js, config.js
```

> The original static prototype lives at `prototype.html` and `index.html` (same file)
> for a no-setup look at the design. The deployable app is under `app/`.

---

## Architecture

```
 Android app (Capacitor WebView)
   │
   ├─ mic ──PCM16/16kHz──▶ Amazon Transcribe Streaming      (direct, via Cognito guest creds)
   │                          └─ partial/final transcript ──▶ live "Listening…" UI
   │
   ├─ final text ─────────▶ Lambda Function URL (stream) ──▶ Bedrock / Claude Sonnet 4.5
   │                          └─ streamed JSON draft ───────▶ editable preview
   │
   └─ confirm ────────────▶ HTTP API → Lambda → DynamoDB     (list / add / delete)
```

Transcribe runs **straight from the device** (lowest latency) using temporary
**Cognito Identity Pool** credentials scoped to `transcribe:StartStreamTranscription*`.
Bedrock is called from a Lambda (your AWS account never exposes Bedrock to the client),
and the JSON is **streamed** back token-by-token over a Lambda Function URL.

---

## 1. Deploy the backend

> Already deployed to **ap-south-1**; this section documents how to (re)deploy.

**Prerequisites:** an AWS account + credentials, Node.js 20+, and **Bedrock model
access** for Claude Sonnet 4.5 (enable once in the Bedrock console → *Model access*).
In ap-south-1 Sonnet 4.5 is **inference-profile-only**, so we invoke the
`global.anthropic.claude-sonnet-4-5-20250929-v1:0` profile.

Deploy with the AWS CLI (no SAM CLI required — CloudFormation runs the Serverless
transform):

```bash
cd backend
# install the parser's dependency so it gets zipped into the Lambda
( cd src/parse && npm install --omit=dev )

BUCKET="cashflow-deploy-<account-id>-ap-south-1"
aws s3 mb "s3://$BUCKET" --region ap-south-1   # one time

aws cloudformation package \
  --template-file template.yaml --s3-bucket "$BUCKET" \
  --output-template-file packaged.yaml --region ap-south-1

aws cloudformation deploy \
  --template-file packaged.yaml --stack-name cashflow \
  --capabilities CAPABILITY_IAM --region ap-south-1 \
  --parameter-overrides BedrockModelId=global.anthropic.claude-sonnet-4-5-20250929-v1:0
```

(If you have the SAM CLI, `sam build && sam deploy --guided` also works — re-add the
`Metadata: BuildMethod: esbuild` block to `ParseFunction` first.)

Copy the stack **Outputs** (`Region`, `IdentityPoolId`, `ApiBaseUrl`, `ParseUrl`) into
`app/www/config.js`. Leave any field blank to keep that feature offline.

**Bedrock notes (learned during deploy):**
- The `AnthropicBedrockMantle` client needs the `bedrock-mantle:*` service, which was
  blocked on this account — so the parser uses the standard `AnthropicBedrock`
  (`bedrock:InvokeModelWithResponseStream`) client instead.
- A fresh Bedrock account starts with a low **tokens-per-day** quota; until it resets
  (or you raise it in **Service Quotas → Amazon Bedrock**) the parser returns HTTP 429
  and the app silently falls back to its on-device parser.

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

```bash
cd app
npm install
npx cap add android          # creates app/android (first time only)
npx cap sync android
```

**Grant the microphone permission** — add this line to
`app/android/app/src/main/AndroidManifest.xml` inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

(`INTERNET` is already included by Capacitor.) Then:

```bash
npx cap open android         # opens Android Studio → Run on a device/emulator
```

To ship an installable build, use Android Studio **Build → Generate Signed Bundle/APK**
(or `cd android && ./gradlew assembleRelease`).

> The first time the mic is used, Android asks for permission. If you ever see the
> permission denied, enable it under the app's system settings.

iOS is the same flow with `npx cap add ios` and a `NSMicrophoneUsageDescription`
key in `Info.plist`.

---

## Security notes (before real use)

This is wired for a fast demo. Harden before production:

- **API auth:** the CRUD API trusts an `x-user-id` header. Replace it with a Cognito
  **User Pool** JWT authorizer (or IAM auth) so users can only read/write their own rows.
- **Parse Function URL** is `AuthType: NONE`. Put it behind IAM/Cognito or add throttling
  so it can't be abused to run up Bedrock cost.
- **IAM scope:** the parser's Bedrock policy uses `Resource: '*'`. Pin it to your exact
  model / inference-profile ARN.
- **CORS** defaults to `*`. Restrict `AllowedOrigin` (the Capacitor origins are
  `https://localhost` and `capacitor://localhost`).

---

## The accounting assistant (Munshi)

`backend/src/chat/index.mjs` is a streaming Lambda (Function URL,
`RESPONSE_STREAM`) that calls **Kimi (Moonshot AI)** over its OpenAI-compatible API,
exposed as `chatUrl` in `app/www/config.js`. On each message the
app sends the assistant: the user's turns, a compact JSON of **all** transactions
(amounts, dates, rates, basis, repayments), and today's date. The Lambda also bundles
`backend/src/chat/context.txt` (a copy of `chat.txt`) so it remembers how you lend.

It replies in the **same language** you wrote in (Hindi/Hinglish → Hindi), shows the
math कलम-wise, and — only when you ask it to *record* something — appends a hidden
`<<<ACTION>>>` JSON block that the app turns into a **Confirm & save** card. Nothing is
written without your tap. If Bedrock's daily token quota is hit (HTTP 429) the app shows
a friendly "quota reached" note and keeps working offline.

> **Set the API key & deploy:** paste your Kimi key into `backend/kimi.env`, then run
> `cd backend && ./deploy.sh`. The script passes the key as a NoEcho CloudFormation
> parameter, so it never lands in source. (The parser and the assistant both use Kimi.)

## How the AI parsing works

`backend/src/parse/index.mjs` sends the transcript to Claude on Bedrock with a strict
JSON schema (kind / party / amount / rate / term / method / date / purpose / notes) and
streams the JSON back. The app shows an **instant on-device draft** first, then merges in
the model's result as it arrives (the *✨ refining…* indicator), so the preview is never
blank and you can edit anything before saving.
