/**
 * Calls the real API (in process, through supertest) on a seeded database and writes the responses to
 * results/stage9-api-samples.txt, with the command, commit, date and dataset first. The report uses them as its
 * sample outputs.
 *   npm run seed && npm run report:api
 * Run it on a database you can empty: the last step deletes a conversation, which erases the memories derived
 * from it (that is the point of the demonstration). Run "npm run seed" again afterwards.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../app');
const Memory = require('../models/Memory');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const AuditLog = require('../models/AuditLog');
const { CURRENT } = require('../services/memoryService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';
const OUT = path.join(__dirname, '..', 'results', 'stage9-api-samples.txt');
const PASSWORD = process.env.SEED_PASSWORD || 'DevPassword123';
const lines = [];
const say = (text = '') => lines.push(text);

// Keeps only the named keys, so a sample stays short and never prints a token
const pick = (object, keys) => Object.fromEntries(keys.filter((k) => object[k] !== undefined).map((k) => [k, object[k]]));
const block = (value) => JSON.stringify(value, null, 2).split('\n').map((l) => `  ${l}`).join('\n');
const version = (m) => pick(m, ['content', 'importance', 'status', 'validFrom', 'validTo', 'recordedAt']);

async function main() {
  await mongoose.connect(MONGO_URI);
  const login = await request(app).post('/api/auth/login').send({ email: 'priya.nair@example.com', password: PASSWORD });
  if (login.status !== 200) throw new Error('Could not log in as the seeded user. Run "npm run seed" first.');
  const auth = { Authorization: `Bearer ${login.body.token}` };
  const get = (url) => request(app).get(url).set(auth);

  say('Sample API outputs on the seeded sample database (application data, no dataset label)');
  say('command: npm run seed && npm run report:api');
  say(`commit: ${execSync('git rev-parse --short HEAD').toString().trim()} (the code that ran; the results are committed in a later commit)`);
  say(`date: ${new Date().toISOString()}`);
  say(`database: ${mongoose.connection.name}`);

  say();
  say('POST /api/auth/login  { "email": "priya.nair@example.com", "password": "<seed password>" }');
  say(`-> ${login.status}`);
  say(block({ user: pick(login.body.user, ['name', 'email', 'occupation', 'role']), token: '<JWT, valid for 7 days>' }));

  let res = await get('/api/memories?limit=2&category=Personal');
  say();
  say('GET /api/memories?limit=2&category=Personal');
  say(`-> ${res.status}`);
  say(block({ count: res.body.count, limit: res.body.limit, nextCursor: res.body.nextCursor ? '<cursor for the next page>' : null, memories: res.body.memories.map(version) }));

  res = await get('/api/memories?category=Personal&asOf=2023-06-01');
  say();
  say('GET /api/memories?category=Personal&asOf=2023-06-01   (valid time: what was true on that day)');
  say(`-> ${res.status}`);
  say(block({ count: res.body.count, asOf: res.body.asOf, memories: res.body.memories.map(version) }));

  res = await get('/api/memories?category=Personal&asOf=2024-08-10&knownAt=2024-08-15');
  say();
  say('GET /api/memories?category=Personal&asOf=2024-08-10&knownAt=2024-08-15   (both axes: true on the 10th, as known on the 15th)');
  say(`-> ${res.status}`);
  say(block({ count: res.body.count, asOf: res.body.asOf, knownAt: res.body.knownAt, memories: res.body.memories.map(version) }));

  const current = (await get('/api/memories?category=Personal&limit=5')).body.memories;
  const chained = current.find((m) => m.supersedes);
  res = await get(`/api/memories/${chained._id}/history`);
  say();
  say('GET /api/memories/<id>/history   (the version chain, oldest first)');
  say(`-> ${res.status}`);
  say(block({ versions: res.body.versions.map(version) }));

  res = await get('/api/memories/stats/by-category');
  say();
  say('GET /api/memories/stats/by-category');
  say(`-> ${res.status}`);
  say(block(res.body.map((r) => pick(r, ['category', 'count', 'activeCount', 'avgImportance']))));

  res = await get('/api/memories/stats/status-ratio');
  say();
  say('GET /api/memories/stats/status-ratio');
  say(`-> ${res.status}`);
  say(block(pick(res.body, ['total', 'active', 'archived', 'activePercent', 'archivedPercent', 'ratio'])));

  res = await get('/api/memories/search?q=kochi&limit=3');
  say();
  say('GET /api/memories/search?q=kochi&limit=3');
  say(`-> ${res.status}`);
  say(block({ count: res.body.count, results: (res.body.results || []).map((m) => pick(m, ['content', 'score'])) }));

  res = await get('/api/audit?limit=3');
  say();
  say('GET /api/audit?limit=3   (newest entries of the append-only log)');
  say(`-> ${res.status}`);
  say(block({ count: res.body.count, entries: res.body.entries.map((e) => pick(e, ['action', 'at', 'via'])) }));

  // The erasure demonstration: delete a conversation and show what went with it, then verify
  const conversations = (await get('/api/conversations')).body.conversations;
  const target = conversations.find((c) => c.title === 'Getting my weekends back') || conversations[0];
  const before = { conversations: await Conversation.countDocuments({ userId: login.body.user._id }), messages: await Message.countDocuments({ conversationId: target._id }), memoryVersions: await Memory.countDocuments({ userId: login.body.user._id }), auditEntries: await AuditLog.countDocuments({ userId: login.body.user._id }) };
  res = await request(app).delete(`/api/conversations/${target._id}`).set(auth);
  say();
  say(`DELETE /api/conversations/<id>   (the conversation "${target.title}")`);
  say(`-> ${res.status}`);
  say(block(pick(res.body, ['message', 'erasure'])));
  const after = { conversations: await Conversation.countDocuments({ userId: login.body.user._id }), messagesOfThatConversation: await Message.countDocuments({ conversationId: target._id }), memoryVersions: await Memory.countDocuments({ userId: login.body.user._id }), currentMemories: await Memory.countDocuments({ userId: login.body.user._id, ...CURRENT }), auditEntries: await AuditLog.countDocuments({ userId: login.body.user._id }) };
  say();
  say('Counts for Priya before and after that deletion');
  say(block({ before, after }));

  res = await get('/api/me/erasure-check');
  say();
  say('GET /api/me/erasure-check   (looks for anything left that was derived from erased data)');
  say(`-> ${res.status}`);
  say(block({ ok: res.body.ok, checks: res.body.checks.map((c) => pick(c, ['check', 'ok', 'violations'])) }));
  say();
  say('The database now has this conversation erased. Run "npm run seed" to restore the sample data.');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
