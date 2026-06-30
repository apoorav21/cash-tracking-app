#!/usr/bin/env bash
# Deploy the Cashflow backend (OpenAI-powered parser + assistant + transcription)
# to the live `cashflow` CloudFormation stack. Reads your key from openai.env and
# passes it as a NoEcho parameter — the key never lands in source or the template.
set -euo pipefail
cd "$(dirname "$0")"

[ -f openai.env ] || { echo "✗ openai.env not found. Paste your key into it first."; exit 1; }
set -a; source ./openai.env; set +a
case "${OPENAI_API_KEY:-}" in
  ''|sk-REPLACE_WITH_YOUR_OPENAI_KEY) echo "✗ Edit openai.env and paste your real OPENAI_API_KEY first."; exit 1;;
esac

REGION="ap-south-1"
BUCKET="cashflow-deploy-914210060536-${REGION}"

echo "→ Packaging…"
aws cloudformation package \
  --template-file template.yaml --s3-bucket "$BUCKET" \
  --output-template-file packaged.yaml --region "$REGION"

echo "→ Deploying to stack 'cashflow'…"
aws cloudformation deploy \
  --template-file packaged.yaml --stack-name cashflow \
  --capabilities CAPABILITY_IAM --region "$REGION" \
  --parameter-overrides \
    OpenAiApiKey="$OPENAI_API_KEY" \
    ChatModel="${CHAT_MODEL:-gpt-5.4-mini}" \
    ParseModel="${PARSE_MODEL:-gpt-5.4-mini}" \
    TranscribeModel="${TRANSCRIBE_MODEL:-gpt-4o-transcribe}" \
    TranscribeLanguage="${TRANSCRIBE_LANGUAGE:-}" \
    OpenAiBaseUrl="${OPENAI_BASE_URL:-https://api.openai.com/v1}"

echo "✓ Done. Chat=${CHAT_MODEL:-gpt-5.4-mini}, parser=${PARSE_MODEL:-gpt-5.4-mini}, STT=${TRANSCRIBE_MODEL:-gpt-4o-mini-transcribe}."
echo
echo "→ Fetching the new Transcribe URL (add it to app/www/config.js as transcribeUrl):"
aws cloudformation describe-stacks --stack-name cashflow --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='TranscribeUrl'].OutputValue" --output text
