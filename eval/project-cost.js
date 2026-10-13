// COST and TIME PROJECTION (not a measurement) for the LoCoMo evaluation, made from the real data and prompts.
//   npm run eval:cost                          full LoCoMo (10 samples, every question) and the 10-question pilot
//   npm run eval:cost -- --facts-per-message 1 --output-tokens 400 --k 10 --out results/stage6-cost-projection
//   npm run eval:cost -- --provider ollama --pilot results/<pilot run-id>   (Stage 3b: local models)
// --provider (default LLM_PROVIDER; the mock is projected as Anthropic): with ollama every cost is $0.
// --pilot <run dir>: the TIME projection. It reads the seconds per item MEASURED by that pilot run
// (timing.json, written by npm run eval) and multiplies them by the number of items in the full run. Without
// it there is no time projection, because time cannot be guessed from the prompts.
// Input tokens are ESTIMATED as characters / 4 of the exact prompt text each call would send (Anthropic's
// tokenizer is not available offline). Output tokens and the number of facts per message cannot be known
// before running, so they are ASSUMPTIONS given on the command line; the paid 10-question pilot measures them.
// Prices: services/llm/pricing.js. Caching: the system part of every prompt is cached; in the full-context
// baseline the conversation is cached too (written once per sample, then read by the sample's other
// questions, assuming they run within the 5-minute cache lifetime).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadPrompt } = require('../services/llm/prompts');
const { llmConfig } = require('../services/llm/config');
const { PRICES } = require('../services/llm/pricing');
const { buildSample } = require('../services/datasets/locomo');
const { formatMessage } = require('./systems');
const { gitCommit, command, option, toCsv } = require('./meta');

const DATA = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'locomo', 'locomo10.json');
const tok = (chars) => Math.ceil(chars / 4);
const RECENT = 6; // EXTRACTION_CONTEXT_MESSAGES default
const MEMORY_CHARS = 260; // one memory line with dates and a source quote (format in eval/systems.js); an assumption
const STORES = 2; // the bi-temporal store and the overwrite store reconcile separately (extraction is shared)

function price(model, t, provider) {
  if (provider === 'ollama') return 0; // local: no money, only time (see the time projection)
  const p = PRICES[model];
  if (!p) throw new Error(`No price for ${model} in services/llm/pricing.js`);
  return (t.input * p.input + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead + t.output * p.output) / 1e6;
}

function main() {
  const args = process.argv.slice(2);
  const factsPerMessage = Number(option(args, '--facts-per-message', 0.5));
  const outTok = Number(option(args, '--output-tokens', 300)); // per call, thinking included; an assumption
  const k = Number(option(args, '--k', 10));
  const pilotQuestions = Number(option(args, '--pilot-questions', 10));
  const out = option(args, '--out', 'results/stage6-cost-projection');
  const asked = String(option(args, '--provider', process.env.LLM_PROVIDER || 'mock')).toLowerCase();
  const provider = asked === 'mock' ? 'anthropic' : asked;
  const models = llmConfig({ ...process.env, LLM_PROVIDER: provider }).models;
  const pilotDir = option(args, '--pilot', null);
  const pilot = pilotDir ? JSON.parse(fs.readFileSync(path.join(pilotDir, 'timing.json'), 'utf8')) : null;
  const P = Object.fromEntries(['extract', 'reconcile', 'eval_answer', 'judge'].map((t) => [t, loadPrompt(t)]));
  const sys = (t) => tok(P[t].system.length);
  const samples = JSON.parse(fs.readFileSync(DATA, 'utf8'));

  const rows = [];
  const add = (scope, component, model, calls, t) => rows.push({ scope, component, model, calls, input_tokens: t.input, cache_write_tokens: t.cacheWrite, cache_read_tokens: t.cacheRead, output_tokens: t.output, cost_usd: Math.round(price(model, t, provider) * 100) / 100 });
  const times = [];

  for (const [scope, list, qPer] of [['pilot (1 sample, 10 questions)', samples.slice(0, 1), pilotQuestions], ['full LoCoMo (10 samples, all questions)', samples, 0]]) {
    const z = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    const ext = z();
    const rec = z();
    const ans = { full_context: z(), full_context_no_cache: z(), rag_messages: z(), memory_systems: z() };
    const jud = z();
    let nMsg = 0;
    let nQ = 0;
    for (const sample of list) {
      const { messages } = buildSample(sample);
      const questions = qPer ? Math.min(qPer, sample.qa.length) : sample.qa.length;
      nMsg += messages.length;
      nQ += questions;
      // Extraction: one call per message (each mined once, by its speaker's perspective); system part cached
      // after the first call of the run
      messages.forEach((m, i) => {
        const recent = messages.slice(Math.max(0, i - RECENT), i).reduce((s, r) => s + Math.min(1000, r.content.length) + 12, 0);
        ext.input += tok(80 + recent + m.content.length);
        ext.cacheRead += sys('extract');
        ext.output += outTok;
      });
      // Reconcile: one call per extracted fact per store, with up to 5 similar memories (~120 chars each)
      const facts = messages.length * factsPerMessage * STORES;
      rec.input += Math.round(facts * tok(150 + 5 * 120));
      rec.cacheRead += Math.round(facts * sys('reconcile'));
      rec.output += Math.round(facts * outTok);
      // Answers. Full context: the conversation as the harness formats it
      const conv = tok(messages.map(formatMessage).join('\n').length + 60);
      const q = tok(120);
      ans.full_context.cacheWrite += conv + sys('eval_answer');
      ans.full_context.cacheRead += (questions - 1) * (conv + sys('eval_answer'));
      ans.full_context.input += questions * q;
      ans.full_context_no_cache.input += questions * (conv + sys('eval_answer') + q);
      const avgMsg = messages.reduce((s, m) => s + formatMessage(m).length, 0) / messages.length;
      ans.rag_messages.input += questions * (tok(k * (avgMsg + 1)) + q);
      ans.rag_messages.cacheRead += questions * sys('eval_answer');
      // ours, overwrite, ours without temporal, ours without provenance: 4 systems with k memories each
      ans.memory_systems.input += 4 * questions * (tok(k * MEMORY_CHARS) + q);
      ans.memory_systems.cacheRead += 4 * questions * sys('eval_answer');
      for (const a of [ans.full_context, ans.full_context_no_cache, ans.rag_messages]) a.output += questions * outTok;
      ans.memory_systems.output += 4 * questions * outTok;
      // Judge: one call per answer (6 systems)
      jud.input += 6 * questions * tok(300);
      jud.cacheRead += 6 * questions * sys('judge');
      jud.output += 6 * questions * outTok;
    }
    // The first call of each kind writes the cached system part; the later ones read it
    for (const [t, task] of [[ext, 'extract'], [rec, 'reconcile'], [jud, 'judge'], [ans.rag_messages, 'eval_answer']]) {
      t.cacheWrite += sys(task);
      t.cacheRead = Math.max(0, t.cacheRead - sys(task));
    }
    add(scope, `extract (${nMsg} messages)`, models.extract, nMsg, ext);
    add(scope, `reconcile (${factsPerMessage} facts/message x ${STORES} stores)`, models.reconcile, Math.round(nMsg * factsPerMessage * STORES), rec);
    add(scope, 'answer: full_context, conversation cached', models.answer, nQ, ans.full_context);
    add(scope, 'answer: rag_messages', models.answer, nQ, ans.rag_messages);
    add(scope, 'answer: 4 memory systems', models.answer, 4 * nQ, ans.memory_systems);
    add(scope, 'judge (6 systems)', models.judge, 6 * nQ, jud);
    const total = rows.filter((r) => r.scope === scope).reduce((s, r) => s + r.cost_usd, 0);
    rows.push({ scope, component: 'TOTAL (projection)', model: '', calls: '', cost_usd: Math.round(total * 100) / 100 });
    if (provider !== 'ollama') add(scope, 'for comparison only: full_context WITHOUT caching (not in the total)', models.answer, nQ, ans.full_context_no_cache);
    if (pilot) {
      // Measured seconds per item x items in this scope
      const addTime = (component, items, perItem) => perItem !== undefined && perItem !== null && times.push({ scope, component, items, seconds_per_item: perItem, seconds: Math.round(items * perItem) });
      for (const [store, perMessage] of Object.entries(pilot.seconds_per_message)) addTime(`build ${store} store (per message)`, nMsg, perMessage);
      for (const [system, perAnswer] of Object.entries(pilot.seconds_per_answer)) addTime(`answer: ${system} (per question)`, nQ, perAnswer);
      addTime('judge (per answer)', nQ * Object.keys(pilot.seconds_per_answer).length, pilot.seconds_per_judge);
      const seconds = times.filter((r) => r.scope === scope).reduce((s, r) => s + r.seconds, 0);
      times.push({ scope, component: 'TOTAL (projection)', items: '', seconds_per_item: '', seconds, hours: Math.round((seconds / 3600) * 10) / 10 });
    }
  }

  const header = ['scope', 'component', 'model', 'calls', 'input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'cost_usd'];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.csv`, toCsv(rows, header));
  if (pilot) fs.writeFileSync(`${out}-time.csv`, toCsv(times, ['scope', 'component', 'items', 'seconds_per_item', 'seconds', 'hours']));
  const lines = [
    `Stage 6 COST${pilot ? ' AND TIME' : ''} PROJECTION for the LoCoMo evaluation (${provider}). A projection, NOT a measured cost or time.`,
    `command: ${command('eval:cost', args)}`,
    `git commit: ${gitCommit()}`,
    `date: ${new Date().toISOString()}`,
    `dataset: BENCHMARK - LoCoMo (${DATA.replace(process.cwd() + path.sep, '')}), used only for its sizes`,
    `models (from the env, else the default): extract ${models.extract}, reconcile ${models.reconcile}, answer ${models.answer}, judge ${models.judge}`,
    provider === 'ollama' ? 'prices: none, the models run locally through Ollama (cost 0; electricity is not counted)' : 'prices: services/llm/pricing.js (USD per million tokens; cache write 1.25 x input, cache read listed rate)',
    'input tokens: characters / 4 of the prompt text (an estimate; real tokenization differs)',
    `ASSUMPTIONS: ${factsPerMessage} facts per message reach reconcile; ${outTok} output tokens per call (thinking included);`,
    `  k = ${k}; a memory line is ~${MEMORY_CHARS} characters; the cache stays warm between calls (5-minute lifetime).`,
    '  The pilot measures real facts/message and output tokens: re-run this script with them before the full run.',
    '',
    ...rows.filter((r) => String(r.component).startsWith('TOTAL')).map((r) => `${r.scope}: ${r.cost_usd} USD`),
    '',
    ...(pilot
      ? [
          `TIME: seconds per item MEASURED by the pilot ${path.relative(process.cwd(), pilotDir)} (${pilot.provider}; models ${JSON.stringify(pilot.models)}), times the items`,
          '  in each scope. Assumes the full run goes at the pilot\'s speed (same machine, same models; the full-context',
          '  answers of longer conversations take longer than the pilot sample\'s). Details: the -time.csv file.',
          ...(pilot.provider !== provider ? [`  WARNING: the pilot ran on "${pilot.provider}", not "${provider}": these times do not describe ${provider}.`] : []),
          ...times.filter((r) => String(r.component).startsWith('TOTAL')).map((r) => `${r.scope}: ${r.seconds} s (${r.hours} h)`),
          '',
        ]
      : ['TIME: not projected (add --pilot <run dir> after a pilot run; time cannot be estimated from the prompts).', '']),
  ];
  fs.writeFileSync(`${out}.txt`, lines.join('\n'));
  console.log(lines.filter((l) => /: [\d.]+ (USD|s)/.test(l) || l.startsWith('TIME') || l.includes('WARNING')).join('\n'));
}

main();
