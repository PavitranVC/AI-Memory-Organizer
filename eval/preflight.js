// Device-limit check for an evaluation: does the whole history of each sample fit the model's context window?
//   npm run eval:preflight                                       LoCoMo, every sample
//   npm run eval:preflight -- --dataset longmemeval --types knowledge-update,temporal-reasoning --per-type 12
// It sends nothing to a model. It estimates the full-context prompt of each sample the way services/llm does and
// compares it with OLLAMA_NUM_CTX_LARGE, so a system that is certain to fail (the full-context baseline on a
// history longer than the window) is found BEFORE a run of days, not after it. If Ollama is reachable it also
// shows how much of the loaded model sits on the GPU (a model that spills onto the CPU answers much slower).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { llmConfig } = require('../services/llm/config');
const { contextSize, NUM_PREDICT } = require('../services/llm/ollamaProvider');
const S = require('./systems');
const { option, gitCommit, command } = require('./meta');
const { selectQuestions } = require('../services/datasets/longmemeval');

// Fixed text added around the history (system prompt, instructions, question): a generous allowance in characters
const PROMPT_OVERHEAD_CHARS = 4000;
const CHARS_PER_TOKEN = 3.3; // the estimate services/llm/ollamaProvider uses

// messages: the sample's messages in time order. Returns the estimate and whether the baseline can run.
function fullContextFit(messages, ollamaConfig) {
  const chars = S.fullContext(messages).items.reduce((n, i) => n + i.text.length + 1, 0) + PROMPT_OVERHEAD_CHARS;
  const window = contextSize(chars, NUM_PREDICT.eval_answer, ollamaConfig);
  return { estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN), fits: window !== null, window };
}

// How much of each loaded model is in GPU memory, from Ollama's /api/ps. null when Ollama is not reachable.
async function gpuShare(url) {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const { models = [] } = await response.json();
    return models.map((m) => ({ model: m.name, gpuPercent: m.size ? Math.round((100 * (m.size_vram || 0)) / m.size) : null, contextLength: m.context_length || null }));
  } catch (err) {
    return null;
  }
}

// Seconds one sample would take, from the per-item times MEASURED in the LoCoMo pilot on the laptop
// (results/stage6-pilot-ollama/timing.json). A projection, not a measurement on this dataset: build time per
// message is taken from the pilot, and only the user's turns are mined in LongMemEval.
function projectSeconds(timing, minedMessages, systems) {
  const answer = systems.reduce((n, id) => n + (timing.seconds_per_answer[id] || 0) + timing.seconds_per_judge, 0);
  return minedMessages * (timing.seconds_per_message.bitemporal + timing.seconds_per_message.overwrite) + answer;
}

function sampleList(args) {
  const dataset = option(args, '--dataset', 'locomo');
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  if (dataset === 'longmemeval') {
    const file = path.join(dataDir, 'longmemeval', option(args, '--file', 'longmemeval_s_cleaned.json'));
    if (!fs.existsSync(file)) throw new Error(`${file} not found: run "npm run data:download -- longmemeval" first`);
    const list = (name) => (option(args, name) ? String(option(args, name)).split(',') : undefined);
    const items = selectQuestions(JSON.parse(fs.readFileSync(file, 'utf8')), { types: list('--types'), ids: list('--ids'), perType: option(args, '--per-type') ? Number(option(args, '--per-type')) : undefined, seed: Number(option(args, '--seed', 1)) });
    return { dataset, samples: items.map((item) => ({ sample_id: item.question_id, item })) };
  }
  const file = path.join(dataDir, 'locomo', 'locomo10.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found: run "npm run data:download" first`);
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wanted = option(args, '--samples', 'all');
  return { dataset, samples: wanted === 'all' ? all : wanted.split(',').map((id) => all.find((s) => s.sample_id === id)) };
}

async function main() {
  const args = process.argv.slice(2);
  const llm = llmConfig();
  const { dataset, samples } = sampleList(args);
  const { prepareLocomo, prepareLongMemEval } = require('./harness');
  const cfg = llm.ollama || { numCtx: 8192, numCtxLarge: 32768 };
  console.log(`${command('eval:preflight', args)}; commit ${gitCommit()}; ${new Date().toISOString()}`);
  console.log(`dataset ${dataset} (benchmark), ${samples.length} sample(s); context windows ${cfg.numCtx} (small) and ${cfg.numCtxLarge} (large)`);
  const timingFile = path.join(__dirname, '..', 'results', 'stage6-pilot-ollama', 'timing.json');
  const timing = fs.existsSync(timingFile) ? JSON.parse(fs.readFileSync(timingFile, 'utf8')) : null;
  const systems = String(option(args, '--systems', S.SYSTEM_IDS.filter((id) => id !== 'full_context').join(','))).split(',');
  let tooLong = 0;
  let seconds = 0;
  for (const sample of samples) {
    const { messages } = dataset === 'longmemeval' ? prepareLongMemEval(sample) : prepareLocomo(sample, { questions: 1, seed: 1 });
    const fit = fullContextFit(messages, cfg);
    if (!fit.fits) tooLong += 1;
    if (timing) seconds += projectSeconds(timing, messages.filter((m) => m.role === 'user').length, systems);
    console.log(`  ${sample.sample_id}: ${messages.length} messages, about ${fit.estimatedTokens} tokens -> full_context ${fit.fits ? `fits (window ${fit.window})` : 'DOES NOT FIT, every full_context answer would fail'}`);
  }
  console.log(`${tooLong} of ${samples.length} sample(s) cannot run the full_context system with this window.`);
  if (timing) console.log(`Projected time for ${systems.join(', ')}: about ${(seconds / 3600).toFixed(1)} hours (${(seconds / 3600 / samples.length).toFixed(2)} h per sample), from the LoCoMo pilot's measured per-item times; NOT measured on this dataset.`);
  if (tooLong) console.log('Leave full_context out (--systems), or raise OLLAMA_NUM_CTX_LARGE if the model and the GPU memory allow it.');
  if (llm.provider === 'ollama') {
    const loaded = await gpuShare(llm.ollama.url);
    if (loaded === null) console.log('Ollama is not reachable, so the GPU share of the loaded model is unknown.');
    else if (!loaded.length) console.log('No model is loaded in Ollama right now; run a question first, then check again (or use "ollama ps").');
    else for (const m of loaded) console.log(`  loaded: ${m.model}, ${m.gpuPercent}% on the GPU${m.gpuPercent !== null && m.gpuPercent < 100 ? ' (the rest runs on the CPU and is much slower)' : ''}, context ${m.contextLength}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { fullContextFit, gpuShare, projectSeconds };
