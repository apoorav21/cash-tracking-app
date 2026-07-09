// Per-IP fixed-window rate limiter backed by DynamoDB, shared by the open
// (AuthType: NONE) AI Function URLs so a stranger can't hammer them and run up
// OpenAI cost. FAIL-OPEN: any limiter error allows the request, so a DynamoDB
// hiccup never breaks the app.
//
// One shared budget per IP across parse + chat + transcribe (keyed only by IP and
// the time bucket), so the whole AI surface is bounded per visitor. The AWS SDK v3
// is provided by the Node.js 20 Lambda runtime — nothing to bundle.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.RATE_TABLE || '';
const LIMIT = parseInt(process.env.RATE_LIMIT || '30', 10);
const WINDOW = parseInt(process.env.RATE_WINDOW_SEC || '300', 10); // seconds

let _doc;
const doc = () => (_doc ||= DynamoDBDocumentClient.from(new DynamoDBClient({})));

// Returns { ok, count, retryAfter }. ok=false => the caller should reply 429.
export async function checkRateLimit(event) {
  if (!TABLE) return { ok: true };
  const ip = event?.requestContext?.http?.sourceIp || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / WINDOW);
  const windowEnd = (bucket + 1) * WINDOW;
  try {
    const res = await doc().send(new UpdateCommand({
      TableName: TABLE,
      Key: { id: `${ip}#${bucket}` },
      // Atomic increment; set a TTL so old buckets self-delete.
      UpdateExpression: 'SET expireAt = if_not_exists(expireAt, :exp) ADD reqCount :one',
      ExpressionAttributeValues: { ':one': 1, ':exp': windowEnd + 60 },
      ReturnValues: 'UPDATED_NEW',
    }));
    const count = Number(res.Attributes?.reqCount || 0);
    if (count > LIMIT) return { ok: false, count, retryAfter: windowEnd - now };
    return { ok: true, count };
  } catch (e) {
    return { ok: true, error: String((e && e.message) || e) }; // fail open
  }
}
