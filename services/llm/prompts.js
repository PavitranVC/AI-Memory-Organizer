const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The prompt version each task uses. Changing a prompt means adding a new file (extract.v2.md) and changing
// this line, so every row in llmcalls says exactly which wording produced it.
const ACTIVE = { extract: 'extract.v2', reconcile: 'reconcile.v1', answer: 'answer.v1', eval_answer: 'eval-answer.v1', judge: 'judge.v1' };
const DIR = path.join(__dirname, '..', '..', 'prompts');
const cache = new Map();

// A prompt file has front matter (id, version), a "## System" section (stable, cacheable) and a "## User"
// section (a template with {{placeholders}} filled per call).
function parsePrompt(raw, file) {
  // Windows checkouts with core.autocrlf=true turn \n into \r\n. The sections below are found by \n, and the
  // hash must not depend on the machine, so line endings are normalised first.
  // Strip all \r characters (handles \r\n, bare \r, and \r\r\n from double-conversion on CRLF files).
  const text = raw.replace(/\r/g, '');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!front) throw new Error(`${file}: missing front matter`);
  const meta = Object.fromEntries(
    front[1].split('\n').map((line) => line.split(':').map((part) => part.trim())).filter((pair) => pair.length === 2)
  );
  const system = /\n## System\n([\s\S]*?)\n## User\n/.exec(text);
  const user = /\n## User\n([\s\S]*)$/.exec(text);
  if (!system || !user) throw new Error(`${file}: needs a "## System" and a "## User" section`);
  return { meta, system: system[1].trim(), userTemplate: user[1].trim() };
}

function loadPrompt(task) {
  const name = ACTIVE[task];
  if (!name) throw new Error(`No prompt for task "${task}"`);
  if (cache.has(name)) return cache.get(name);
  const file = path.join(DIR, `${name}.md`);
  const { meta, system, userTemplate } = parsePrompt(fs.readFileSync(file, 'utf8'), file);
  if (`${meta.id}.v${meta.version}` !== name) throw new Error(`${file}: front matter says ${meta.id}.v${meta.version}`);
  const hash = crypto.createHash('sha256').update(system).update('\0').update(userTemplate).digest('hex').slice(0, 12);
  const prompt = { id: name, hash, system, userTemplate };
  cache.set(name, prompt);
  return prompt;
}

// Fills {{name}} placeholders. A missing value is an error, so a typo cannot silently send "{{recent}}".
function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (vars[key] === undefined || vars[key] === null) throw new Error(`Prompt variable "${key}" is missing`);
    return String(vars[key]);
  });
}

module.exports = { ACTIVE, loadPrompt, render, parsePrompt };
