// ─────────────────────────────────────────────────────────────
//  cricket-live API (AWS Lambda, Node 20)
//
//  GET  /health
//  GET  /ch/{code}/feed?rev=N&srev=M   what the overlay polls: live + cmd + prefs
//                                      (204 if nothing changed since rev N;
//                                       setup only included when it changed since M)
//  GET  /ch/{code}/doc/{path+}         read a doc (scorer/library need the scorer key)
//  PUT  /ch/{code}/doc/{path+}         write a doc or a path inside it (needs the scorer key)
//  POST /playhq/{secret}               PlayHQ webhook receiver (stores raw events for now)
//
//  A channel is claimed by the first scorer key that writes to it;
//  after that only that key can write. Everything on the stream is public to read.
//
//  DynamoDB (single table): pk = "ch#<code>", sk = live | cmd | prefs | scorer | library | ping | meta
//    meta = { keyHash, rev, r_live, r_cmd, r_prefs, r_setup }
//  PlayHQ raw events: pk = "playhq#raw", sk = "<iso time>#<uuid>", ttl = 30 days
// ─────────────────────────────────────────────────────────────
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE;
const FEED = ['live', 'cmd', 'prefs'];
const DOCS = ['live', 'cmd', 'prefs', 'scorer', 'library', 'ping'];
const PRIVATE = ['scorer', 'library'];
const CODE_RE = /^[a-z0-9]{6,32}$/;
const MAX_BODY = 350_000, MAX_DOC = 390_000;

const res = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: body === undefined ? '' : JSON.stringify(body),
});
const sha = s => createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bodyOf = e => (e.isBase64Encoded ? Buffer.from(e.body || '', 'base64').toString('utf8') : e.body || '');

function setPath(root, parts, data) {
  if (!parts.length) return data;
  root = root && typeof root === 'object' ? root : {};
  let o = root;
  for (const k of parts.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  const last = parts[parts.length - 1];
  if (data === null) delete o[last]; else o[last] = data;
  return root;
}
const getPath = (o, parts) => parts.reduce((v, k) => (v == null ? null : v[k] ?? null), o ?? null);

const getItem = async (pk, sk) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item;
const parseDoc = it => (it && it.doc ? JSON.parse(it.doc) : null);

async function keyOk(pk, key, claim) {
  if (!key || key.length < 16) return false;
  const h = sha(key), meta = await getItem(pk, 'meta');
  if (meta && meta.keyHash) return same(meta.keyHash, h);
  if (!claim) return false;
  try {
    await db.send(new UpdateCommand({
      TableName: TABLE, Key: { pk, sk: 'meta' },
      UpdateExpression: 'SET keyHash = :h, created = if_not_exists(created, :now)',
      ConditionExpression: 'attribute_not_exists(keyHash)',
      ExpressionAttributeValues: { ':h': h, ':now': Date.now() },
    }));
    return true;
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    const again = await getItem(pk, 'meta');
    return !!(again && again.keyHash && same(again.keyHash, h));
  }
}

async function writePath(pk, top, sub, data) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const it = await getItem(pk, top), v = (it && it.v) || 0;
    const json = JSON.stringify(sub.length ? setPath(parseDoc(it), sub, data) : data);
    if (json.length > MAX_DOC) { const err = new Error('too big'); err.status = 413; throw err; }
    try {
      await db.send(new PutCommand({
        TableName: TABLE, Item: { pk, sk: top, doc: json, v: v + 1, updated: Date.now() },
        ConditionExpression: 'attribute_not_exists(v) OR v = :v', ExpressionAttributeValues: { ':v': v },
      }));
      break;
    } catch (e) { if (e.name !== 'ConditionalCheckFailedException' || attempt === 4) throw e; }
  }
  if (FEED.includes(top)) {
    const setupChanged = top === 'live' && (!sub.length || sub[0] === 'setup');
    await db.send(new UpdateCommand({
      TableName: TABLE, Key: { pk, sk: 'meta' },
      UpdateExpression: `ADD rev :one, r_${top} :one${setupChanged ? ', r_setup :one' : ''}`,
      ExpressionAttributeValues: { ':one': 1 },
    }));
  }
}

async function feed(pk, q) {
  const meta = (await getItem(pk, 'meta')) || {};
  const rev = meta.rev || 0;
  if (q.rev !== undefined && +q.rev === rev) return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
  const out = { rev, revs: { live: meta.r_live || 0, cmd: meta.r_cmd || 0, prefs: meta.r_prefs || 0, setup: meta.r_setup || 0 }, live: null, cmd: null, prefs: null };
  if (rev) {
    const r = await db.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: FEED.map(sk => ({ pk, sk })) } } }));
    for (const it of r.Responses[TABLE] || []) out[it.sk] = parseDoc(it);
    if (out.live && q.srev !== undefined && +q.srev === out.revs.setup) delete out.live.setup;   // client already has it
  }
  return res(200, out);
}

async function playhq(event, secret) {
  const expected = process.env.PLAYHQ_SECRET || '';
  if (!expected || !secret || !same(sha(secret), sha(expected))) return res(404, { error: 'not found' });
  const raw = bodyOf(event).slice(0, MAX_BODY);
  const h = event.headers || {};
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: 'playhq#raw', sk: `${new Date().toISOString()}#${randomUUID()}`, body: raw,
      headers: JSON.stringify(Object.fromEntries(Object.entries(h).filter(([k]) => !/^(x-amzn|x-forwarded|cookie|authorization)/i.test(k)))),
      ttl: Math.floor(Date.now() / 1000) + 30 * 86400,
    },
  }));
  // TODO when PlayHQ access arrives: look up the channel linked to this game
  // (pk "playhq#game#<gameId>"), convert to { setup, tick: { state, event } } and write ch#<code>/live.
  return res(200, { ok: true });
}

export const handler = async event => {
  const route = event.routeKey, p = event.pathParameters || {};
  try {
    if (route === 'GET /health') return res(200, { ok: true });
    if (route === 'POST /playhq/{secret}') return await playhq(event, p.secret);
    const code = String(p.code || '').toLowerCase();
    if (!CODE_RE.test(code)) return res(400, { error: 'bad channel code' });
    const pk = `ch#${code}`;
    if (route === 'GET /ch/{code}/feed') return await feed(pk, event.queryStringParameters || {});

    const parts = String(p.path || '').split('/').filter(Boolean), top = parts[0];
    if (!DOCS.includes(top)) return res(404, { error: 'unknown document' });
    const key = (event.headers || {})['x-scorer-key'] || '';

    if (route === 'GET /ch/{code}/doc/{path+}') {
      if (PRIVATE.includes(top) && !(await keyOk(pk, key, false))) return res(403, { error: 'scorer key needed' });
      return res(200, getPath(parseDoc(await getItem(pk, top)), parts.slice(1)));
    }
    if (route === 'PUT /ch/{code}/doc/{path+}') {
      if (!key || key.length < 16) return res(401, { error: 'scorer key needed' });
      if (!(await keyOk(pk, key, true))) return res(403, { error: 'this channel belongs to another scorer' });
      const raw = bodyOf(event);
      if (raw.length > MAX_BODY) return res(413, { error: 'too big' });
      await writePath(pk, top, parts.slice(1), JSON.parse(raw || 'null'));
      return res(200, { ok: true });
    }
    return res(404, { error: 'not found' });
  } catch (e) {
    if (e.status) return res(e.status, { error: e.message });
    if (e instanceof SyntaxError) return res(400, { error: 'bad JSON' });
    console.error(e);
    return res(500, { error: 'server error' });
  }
};
