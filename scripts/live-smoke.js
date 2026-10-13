// Opt-in live smoke test of the Stage 3 pipeline with a REAL model.
//   LLM_PROVIDER=ollama: the free local models (Stage 3b). Skips cleanly if Ollama is not reachable.
//   otherwise: the Anthropic API (costs money). Runs only if ANTHROPIC_API_KEY is set; otherwise it prints
//   the cost estimate and skips.
//   npm run test:live                  as above
//   npm run test:live -- --estimate    prints the Anthropic cost estimate only (no API call, no database)
// It uses its own database (MONGO_URI_LIVE, default .../aimemory_live), which it DROPS first.
// Real token usage and cost are read back from the llmcalls collection and written to results/.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const fixtures = require('./fixtures/live-conversations');
const { loadPrompt } = require('../services/llm/prompts');
const { PRICES } = require('../services/llm/pricing');
const { TASKS } = require('../services/llm');
const { llmConfig } = require('../services/llm/config');
const { embeddingConfig } = require('../services/embeddings/config');
const { listOllamaModels, hasModel } = require('../services/llm/ollamaProvider');

// ---- Estimate (before any call) -------------------------------------------------------------------------
// Token counts are ESTIMATED as characters / 4, times 1.35 because the Claude Opus 5.5 tokenizer can use up to
// ~35% more tokens than that rule of thumb. Output includes thinking tokens, which cannot be known in advance:
// "expected" assumes ASSUMED_OUTPUT tokens per call, "worst case" assumes every call uses its full max_tokens.
const ASSUMED_OUTPUT = { extract: 1500, reconcile: 800 };
const RECONCILE_PER_MESSAGE = 2; // assumed reconcile calls per user message (one per candidate that has a similar memory)
const tokens = (text) => Math.ceil((String(text).length / 4) * 1.35);

function estimate(model) {
  const price = PRICES[model];
  if (!price) throw new Error(`No price for ${model} in services/llm/pricing.js`);
  const userMessages = fixtures.conversations.flatMap((c) => c.messages.filter((m) => m.role === 'user'));
  const calls = { extract: userMessages.length, reconcile: userMessages.length * RECONCILE_PER_MESSAGE };
  const perTask = {};
  let expected = 0;
  let worst = 0;
  for (const task of ['extract', 'reconcile']) {
    const prompt = loadPrompt(task);
    const system = tokens(prompt.system);
    const user = tokens(prompt.userTemplate) + 400; // + the filled-in message, context window or memories
    const n = calls[task];
    // First call writes the cached system prompt, the others read it
    const input = (system * price.cacheWrite + (n - 1) * system * price.cacheRead + n * user * price.input) / 1e6;
    const exp = input + (n * ASSUMED_OUTPUT[task] * price.output) / 1e6;
    const max = input + (n * TASKS[task].maxTokens * price.output) / 1e6;
    perTask[task] = { calls: n, systemTokens: system, userTokens: user, expectedUsd: exp, worstCaseUsd: max };
    expected += exp;
    worst += max;
  }
  return { model, perTask, expectedUsd: expected, worstCaseUsd: worst };
}

function printEstimate(est) {
  console.log(`Cost ESTIMATE for the live smoke test on ${est.model} (3 conversations, ${est.perTask.extract.calls} user messages):`);
  for (const [task, t] of Object.entries(est.perTask)) {
    console.log(`  ${task.padEnd(9)} ${t.calls} calls, ~${t.systemTokens} cached system + ~${t.userTokens} input tokens each: expected $${t.expectedUsd.toFixed(3)}, worst case $${t.worstCaseUsd.toFixed(3)}`);
  }
  console.log(`  TOTAL expected ~$${est.expectedUsd.toFixed(2)} (assumes ${ASSUMED_OUTPUT.extract}/${ASSUMED_OUTPUT.reconcile} output+thinking tokens per call), worst case $${est.worstCaseUsd.toFixed(2)} (every call hits max_tokens)`);
  console.log('  This is an estimate from character counts, not a measurement. The real figures are printed after the run.');
}

// ---- Live run -------------------------------------------------------------------------------------------
async function live(provider) {
  const mongoose = require('mongoose');
  const uri = process.env.MONGO_URI_LIVE || 'mongodb://127.0.0.1:27017/aimemory_live';
  if (uri === process.env.MONGO_URI) throw new Error('MONGO_URI_LIVE must not be your main database: this test drops it');
  process.env.LLM_PROVIDER = provider;
  const models = ['User', 'Category', 'Conversation', 'Message', 'Memory', 'AuditLog', 'Job', 'LlmCall'].map((name) => require(`../models/${name}`));
  const [User, Category, , , Memory, , Job, LlmCall] = models;
  const conversationService = require('../services/conversationService');
  const worker = require('../services/worker');
  const { hashPassword } = require('../services/authService');

  await mongoose.connect(uri);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error('MongoDB must run as a replica set (see the README)');
  await mongoose.connection.dropDatabase();
  await Promise.all(models.map((Model) => Model.init()));
  await Category.insertMany(['Personal', 'Health', 'Learning', 'Hobbies'].map((name) => ({ name })));
  const user = await User.create({ name: 'Live Smoke', email: 'live-smoke@example.com', passwordHash: await hashPassword('LiveSmoke123') });

  const started = Date.now();
  for (const conv of fixtures.conversations) {
    const conversation = await conversationService.createConversation(user._id, { title: conv.title });
    for (const message of conv.messages) {
      await conversationService.createMessage(user._id, conversation._id, message);
      await worker.drain(); // process each message before the next, as a live chat would
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const jobs = await Job.find().lean();
  const calls = await LlmCall.find().lean();
  const memories = await Memory.find({ userId: user._id }).sort({ recordedAt: 1 }).lean();
  const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] || 0), 0);
  const byTask = {};
  for (const task of ['extract', 'reconcile']) {
    const rows = calls.filter((c) => c.task === task);
    byTask[task] = {
      calls: rows.length,
      inputTokens: sum(rows, 'inputTokens'),
      outputTokens: sum(rows, 'outputTokens'),
      cacheReadTokens: sum(rows, 'cacheReadTokens'),
      cacheWriteTokens: sum(rows, 'cacheWriteTokens'),
      costUsd: sum(rows, 'costUsd'),
      p50LatencyMs: rows.length ? rows.map((r) => r.latencyMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)] : null,
    };
  }
  const summary = {
    label: `live smoke test (${provider === 'ollama' ? 'local Ollama models' : 'real API'}), 3 synthetic conversations`,
    provider,
    dataset: fixtures.dataset,
    command: 'npm run test:live',
    commit: execSync('git rev-parse --short HEAD').toString().trim(),
    date: new Date().toISOString(),
    model: llmConfig().models,
    embeddings: embeddingConfig().provider,
    wallClockSeconds: Number(seconds),
    jobs: { total: jobs.length, done: jobs.filter((j) => j.status === 'done').length, failed: jobs.filter((j) => j.status === 'failed').length },
    llmCalls: { total: calls.length, notOk: calls.filter((c) => c.status !== 'ok').length, byTask },
    totalCostUsd: sum(calls, 'costUsd'),
    memories: memories.map((m) => ({ content: m.content, current: m.validTo === null && m.retractedAt === null, validFrom: m.validFrom, sensitivity: m.sensitivity })),
    decisions: jobs.flatMap((j) => (j.result && j.result.decisions) || []).map((d) => ({ action: d.action, topic: d.topic, reason: d.reason })),
  };

  const out = path.join(__dirname, '..', 'results', `stage3-live-smoke-${provider === 'ollama' ? 'ollama-' : ''}${summary.date.slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nMEASURED: ${calls.length} calls in ${seconds}s, total cost $${summary.totalCostUsd.toFixed(4)}`);
  for (const [task, t] of Object.entries(byTask)) {
    console.log(`  ${task.padEnd(9)} ${t.calls} calls, input ${t.inputTokens}, output ${t.outputTokens}, cache read ${t.cacheReadTokens}, cache write ${t.cacheWriteTokens}, $${t.costUsd.toFixed(4)}`);
  }
  console.log(`  memories: ${memories.length} versions; jobs done ${summary.jobs.done}/${jobs.length}`);
  console.log(`  saved to ${path.relative(process.cwd(), out)}`);
  await mongoose.disconnect();

  // The checks: everything ran and something was learned from each conversation. Model quality is judged by a person.
  const failures = [];
  if (summary.jobs.failed > 0) failures.push(`${summary.jobs.failed} job(s) failed`);
  if (summary.llmCalls.notOk > 0) failures.push(`${summary.llmCalls.notOk} call(s) were not ok`);
  if (memories.length < 3) failures.push(`only ${memories.length} memories were extracted`);
  if (failures.length > 0) throw new Error(failures.join('; '));
  console.log('LIVE SMOKE TEST PASSED');
}

// Ollama: skip if the server does not answer; fail with the fix if a model is missing
async function liveOllama() {
  const config = llmConfig();
  const names = await listOllamaModels({ url: config.ollama.url });
  if (!names) {
    console.log(`Ollama is not reachable at ${config.ollama.url}: live smoke test SKIPPED (nothing was called).`);
    return;
  }
  const wanted = [...new Set(Object.values(config.models))];
  const emb = embeddingConfig();
  if (emb.provider === 'ollama') wanted.push(emb.ollama.model);
  const missing = wanted.filter((m) => !hasModel(names, m));
  if (missing.length) throw new Error(`Ollama is running but these models are not pulled: ${missing.map((m) => `ollama pull ${m}`).join('; ')}`);
  console.log(`Running against Ollama at ${config.ollama.url} (${wanted.join(', ')}); cost $0, this can take a few minutes...`);
  await live('ollama');
}

async function main() {
  const onlyEstimate = process.argv.includes('--estimate');
  // --estimate never runs anything, whatever LLM_PROVIDER says (it used to start the Ollama run)
  if (!onlyEstimate && (process.env.LLM_PROVIDER || '').toLowerCase() === 'ollama') return liveOllama();
  const est = estimate(llmConfig({ ...process.env, LLM_PROVIDER: 'anthropic' }).models.extract);
  printEstimate(est);
  if (onlyEstimate) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\nANTHROPIC_API_KEY is not set: live smoke test SKIPPED (nothing was called).');
    return;
  }
  console.log('\nRunning against the real API...');
  await live('anthropic');
}

main().catch((err) => {
  console.error('LIVE SMOKE TEST FAILED:', err.message);
  process.exit(1);
});
