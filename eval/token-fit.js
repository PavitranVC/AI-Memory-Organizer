// Did the full-context prompts of the finished LoCoMo runs really not fit the model's window?
//   npm run eval:token-fit        writes results/stage6e-locomo-fullcontext-token-fit.txt
// Uses only the committed answers.csv files. For the samples where the full-context system DID answer, Ollama's own
// count (input_tokens) against the prompt's characters gives the real characters per token; that ratio is then
// applied to every sample to see how many tokens its whole conversation needs, plus the room the harness keeps for
// the answer (2048 tokens) and a margin (512), against the model's window.
const fs = require('fs');
const path = require('path');
const { parseCsv, gitCommit, command } = require('./meta');

const RESULTS = path.join(__dirname, '..', 'results');
const WINDOW = 32768; // OLLAMA_NUM_CTX_LARGE in the run; qwen2.5's native context length
const RESERVE = 2048 + 512;

function main() {
  const perSample = [];
  const ratios = [];
  for (const d of fs.readdirSync(RESULTS).filter((x) => x.startsWith('stage6-locomo-ollama-conv-')).sort()) {
    const rows = parseCsv(fs.readFileSync(path.join(RESULTS, d, 'answers.csv'), 'utf8')).filter((r) => r.system === 'full_context');
    if (!rows.length) continue;
    const answered = rows.filter((r) => !r.error && Number(r.input_tokens) > 0);
    // context_tokens_est is characters / 4 (eval/systems.js estimateTokens), so characters = est * 4
    const chars = Math.max(...rows.map((r) => Number(r.context_tokens_est))) * 4;
    for (const r of answered) ratios.push((Number(r.context_tokens_est) * 4) / Number(r.input_tokens));
    perSample.push({ sample: rows[0].sample, questions: rows.length, answered: answered.length, chars, timeouts: rows.filter((r) => /did not answer within/.test(r.error)).length, notFit: rows.filter((r) => /does not fit/.test(r.error)).length });
  }
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const lines = [
    'Full-context prompt size against the context window, LoCoMo runs on local models (dataset: benchmark, LoCoMo)',
    `command: ${command('eval:token-fit', [])}`,
    `commit: ${gitCommit()} (the code that ran; the results are committed in a later commit)`,
    `date: ${new Date().toISOString()}`,
    `real characters per token (Ollama's input_tokens against the prompt, ${ratios.length} answered questions): mean ${mean.toFixed(2)}, min ${Math.min(...ratios).toFixed(2)}, max ${Math.max(...ratios).toFixed(2)}; the harness assumed 3.3`,
    `window ${WINDOW} tokens; the harness reserves ${RESERVE} for the answer and a margin`,
    '',
    'sample   questions  answered  timeouts  not-fit  conversation tokens (measured ratio)  needed  fits',
    ...perSample.map((s) => {
      const tokens = Math.round(s.chars / mean);
      return `${s.sample.padEnd(8)} ${String(s.questions).padStart(9)}  ${String(s.answered).padStart(8)}  ${String(s.timeouts).padStart(8)}  ${String(s.notFit).padStart(7)}  ${String(tokens).padStart(36)}  ${String(tokens + RESERVE).padStart(6)}  ${tokens + RESERVE <= WINDOW ? 'yes' : 'NO'}`;
    }),
    '',
  ];
  fs.writeFileSync(path.join(RESULTS, 'stage6e-locomo-fullcontext-token-fit.txt'), lines.join('\n'));
  console.log(lines.join('\n'));
}

main();
