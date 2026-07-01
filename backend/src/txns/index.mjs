// Transactions CRUD on DynamoDB, behind the HTTP API.
// Demo-grade auth: the caller passes an `x-user-id` header. Swap this for a
// Cognito/JWT authorizer before any real use (see README → Security).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const headers = {
  'content-type': 'application/json',
  'access-control-allow-origin': ORIGIN,
  'access-control-allow-headers': 'content-type,x-user-id',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

const KINDS = new Set(['borrowed', 'lent', 'asset']);
const METHODS = new Set(['cash', 'bank']);
const ASSET_TYPES = new Set(['plot', 'flat', 'land', 'house', 'commercial', 'gold', 'silver', 'other']);
const AREA_UNITS = new Set(['sqft', 'gaj', 'sqyd', 'sqm', 'acre', 'bigha', 'marla']);
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v, max = 200) => (v == null ? '' : String(v).slice(0, max));

// Normalise an incoming transaction into a clean, storable shape.
function clean(input) {
  const repayments = Array.isArray(input.repayments)
    ? input.repayments.slice(0, 200).map((r) => {
        const principal = r && r.principal != null ? num(r.principal) : num(r && r.amount);
        const interest = num(r && r.interest);
        return {
          date: str(r && r.date, 10) || new Date().toISOString().slice(0, 10),
          principal,
          interest,
          amount: principal + interest,
          method: METHODS.has(r && r.method) ? r.method : 'cash',
          note: str(r && r.note, 300),
        };
      })
    : [];
  // Asset instalments — money paid toward a property/asset over time (purchase
  // splits and later किश्तें). Same shape as a plain payment.
  const payments = Array.isArray(input.payments)
    ? input.payments.slice(0, 200).map((r) => ({
        date: str(r && r.date, 10) || new Date().toISOString().slice(0, 10),
        amount: num(r && r.amount),
        method: METHODS.has(r && r.method) ? r.method : 'cash',
        note: str(r && r.note, 300),
      }))
    : [];
  return {
    txnId: str(input.id || input.txnId) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: KINDS.has(input.kind) ? input.kind : 'borrowed',
    party: str(input.party) || 'Unknown',
    amount: num(input.amount),
    date: str(input.date, 10) || new Date().toISOString().slice(0, 10),
    rate: num(input.rate),
    rateBasis: input.rateBasis === 'annual' ? 'annual' : 'monthly',
    interestType: input.interestType === 'compound' ? 'compound' : 'simple',
    term: num(input.term),
    method: METHODS.has(input.method) ? input.method : 'cash',
    purpose: str(input.purpose, 300),
    notes: str(input.notes, 1000),
    repayments,
    // ---- Asset / property extras (ignored for loans) ----
    subtype: ASSET_TYPES.has(input.subtype) ? input.subtype : 'plot',
    area: num(input.area),
    areaUnit: AREA_UNITS.has(input.areaUnit) ? input.areaUnit : 'sqft',
    location: str(input.location, 200),
    marketValue: num(input.marketValue),
    rent: num(input.rent),
    nextDue: str(input.nextDue, 10),
    payments,
    createdAt: Date.now(),
  };
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  if (method === 'OPTIONS') return { statusCode: 204, headers };

  // Identity comes from the verified Cognito JWT (the API has a JWT authorizer),
  // so each signed-in user only ever sees their own rows. Fall back to the
  // x-user-id header only if the token claim is somehow absent.
  const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  const userId = str(claims.sub || event.headers?.['x-user-id'] || event.headers?.['X-User-Id'], 80) || 'demo-user';

  try {
    if (method === 'GET') {
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
      }));
      const items = (res.Items || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return reply(200, { transactions: items });
    }

    if (method === 'POST') {
      const input = event.body ? JSON.parse(event.body) : {};
      const txn = clean(input);
      await ddb.send(new PutCommand({ TableName: TABLE, Item: { userId, ...txn } }));
      return reply(201, { transaction: txn });
    }

    if (method === 'DELETE') {
      const id = str(event.pathParameters?.id);
      if (!id) return reply(400, { error: 'missing id' });
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { userId, txnId: id } }));
      return reply(200, { ok: true });
    }

    return reply(405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    return reply(500, { error: 'server error' });
  }
};
