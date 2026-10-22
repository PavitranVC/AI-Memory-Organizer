// The conditions a long evaluation must meet BEFORE it starts, so that it cannot fail the way the LoCoMo
// full-context baseline did (1,486 prompts longer than the window, found after three days). Every check names what
// it looked at. Nothing here calls a model.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { listOllamaModels, hasModel, contextSize, NUM_PREDICT } = require('../services/llm/ollamaProvider');
const { fullContextFit, gpuShare } = require('./preflight');
const { assertDisposable } = require('./meta');

const CHARS_PER_TOKEN = 3.3; // the estimate services/llm/ollamaProvider uses
// Fixed text around the retrieved items in an answer prompt (system prompt, instructions, question), generous
const ANSWER_OVERHEAD_CHARS = 3000;
// Longest part of one retrieved MEMORY line: its content, two 300-character source quotes, dates and labels
const MEMORY_ITEM_CHARS = 1400;
const MESSAGE_ITEM_OVERHEAD = 80; // "[session:turn] 2023-05-08 user: "

// The longest answer prompt any system can send with k items and a cap on one message, against the SMALL window.
// A system within the small window never needs the large one, so nothing spills.
function worstAnswerPrompt({ k, maxItemChars, numCtx }) {
  const perMessage = (maxItemChars || Infinity) + MESSAGE_ITEM_OVERHEAD;
  const perItem = Math.max(perMessage, MEMORY_ITEM_CHARS);
  const chars = ANSWER_OVERHEAD_CHARS + k * perItem;
  const needed = Math.ceil(chars / CHARS_PER_TOKEN) + NUM_PREDICT.eval_answer + 512;
  return { chars, needed, fits: Number.isFinite(chars) && needed <= numCtx };
}

// samples: the prepared samples' messages are checked for the full-context fit and for over-long messages
async function checkEnvironment({ llm, systems, k, maxItemChars, dataFile, mongoUri, samplesMessages = [], requireGpu = true }) {
  const checks = [];
  const add = (name, ok, detail, blocking = true) => checks.push({ name, ok, detail, blocking });

  add('data file present', !!dataFile && fs.existsSync(dataFile), dataFile ? path.relative(process.cwd(), dataFile) : 'no file');

  if (llm.provider === 'ollama') {
    const names = await listOllamaModels({ url: llm.ollama.url.replace(/\/+$/, '') });
    add('Ollama reachable', names !== null, names === null ? `${llm.ollama.url} does not answer` : `${names.length} models installed`);
    if (names) {
      for (const [role, model] of [['answer/extract/reconcile', llm.models.answer], ['judge', llm.models.judge], ['embeddings', process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text']]) {
        add(`model for ${role}`, hasModel(names, model), model);
      }
      const loaded = await gpuShare(llm.ollama.url);
      const spilled = (loaded || []).filter((m) => m.gpuPercent !== null && m.gpuPercent < 100);
      add('loaded models fully on the GPU', !requireGpu || spilled.length === 0, spilled.length ? spilled.map((m) => `${m.model} ${m.gpuPercent}%`).join(', ') : loaded && loaded.length ? 'yes' : 'no model loaded yet (checked again by the run itself)', requireGpu);
    }
  }

  const worst = worstAnswerPrompt({ k, maxItemChars, numCtx: (llm.ollama || {}).numCtx || 8192 });
  add('worst-case answer prompt fits the SMALL window', worst.fits, `k=${k}, cap ${maxItemChars || 'none'} characters per message: about ${worst.needed} tokens needed of ${(llm.ollama || {}).numCtx || 8192}`);

  if (systems.includes('full_context') && llm.ollama) {
    const unfit = samplesMessages.filter((messages) => !fullContextFit(messages, llm.ollama).fits).length;
    add('full_context fits the window', unfit === 0, unfit ? `${unfit} of ${samplesMessages.length} samples are longer than the window; leave full_context out` : 'all samples fit');
  }

  if (llm.ollama) {
    const long = samplesMessages.reduce((n, messages) => n + messages.filter((m) => m.role === 'user' && contextSize(m.content.length + 7000, NUM_PREDICT.extract, llm.ollama) !== llm.ollama.numCtx).length, 0);
    add('long messages to extract', true, `${long} user message(s) are long enough to need the large window for extraction (slower, still within it)`, false);
  }

  try {
    assertDisposable(mongoUri, 'eval');
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    add('MongoDB reachable, replica set', !!hello.setName, hello.setName ? `set ${hello.setName}` : 'not a replica set (transactions need one)');
  } catch (err) {
    add('MongoDB reachable, replica set', false, err.message.slice(0, 160));
  } finally {
    await mongoose.disconnect().catch(() => {});
  }

  return { ok: checks.every((c) => c.ok || !c.blocking), checks };
}

const formatChecks = (checks) => checks.map((c) => `  [${c.ok ? 'ok' : c.blocking ? 'FAIL' : 'note'}] ${c.name}: ${c.detail}`).join('\n');

module.exports = { checkEnvironment, worstAnswerPrompt, formatChecks, MEMORY_ITEM_CHARS };
