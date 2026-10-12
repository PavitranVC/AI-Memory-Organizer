const { LlmError, LlmRefusalError } = require('./errors');

// A deterministic stand-in for the LLM, used by every test and by default (LLM_PROVIDER=mock), so CI never
// needs an API key and never spends money. It answers the same three tasks (extract, reconcile, answer) with
// the same JSON shapes as the real model, using simple patterns instead of understanding. It is a test double, NOT a baseline: its
// output must never be reported as a model result.
//
// Test hooks: a message containing "[mock:fail]" raises a retryable error, "[mock:refuse]" a refusal.

const NAME = "([A-Z][\\w&'-]*(?: [A-Z][\\w&'-]*)*)"; // capitalised words: "Pune", "Tata Steel"
const THING = '([A-Za-z][\\w+# -]*?)'; // lowercase phrase, cut by the stop words below
const END = '(?=\\s+(?:since|in|for|because|from|at|now|too|also|as well)\\b|$)';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// pattern -> fact. "single" topics can hold one value at a time (a new value supersedes the old one).
const RULES = [
  { re: new RegExp(`\\bI(?:'ve| have)? (?:just |recently )?(?:moved|relocated) to ${NAME}`), fact: (m) => ['Lives in ' + m[1], 'home city', 'Personal', 4, 0.9, 'normal'] },
  { re: new RegExp(`\\bI (?:now )?(?:live|am living|'m living) in ${NAME}`), fact: (m) => ['Lives in ' + m[1], 'home city', 'Personal', 4, 0.9, 'normal'] },
  { re: new RegExp(`\\b[Mm]y name is ${NAME}`), fact: (m) => ['Is called ' + m[1], 'name', 'Personal', 3, 0.95, 'normal'] },
  { re: new RegExp(`\\bI (?:now )?work (?:at|for) ${NAME}`), fact: (m) => ['Works at ' + m[1], 'employer', 'Personal', 3, 0.9, 'normal'] },
  { re: new RegExp(`\\bI(?:'m| am) allergic to ${THING}${END}`, 'i'), fact: (m) => ['Is allergic to ' + m[1].toLowerCase(), 'allergy', 'Health', 5, 0.95, 'special'] },
  { re: new RegExp(`\\bI(?:'m| am) (?:a )?(vegetarian|vegan|pescatarian)\\b`, 'i'), fact: (m) => ['Is ' + m[1].toLowerCase(), 'diet', 'Health', 4, 0.9, 'special'] },
  { re: new RegExp(`\\bI(?:'m| am) (?:learning|studying) ${THING}${END}`, 'i'), fact: (m) => ['Is learning ' + m[1], 'language learning', 'Learning', 3, 0.85, 'normal'] },
  { re: new RegExp(`\\bI (?:really )?(?:love|enjoy|like) ${THING}${END}`, 'i'), fact: (m) => ['Likes ' + m[1].toLowerCase(), 'hobby', 'Hobbies', 2, 0.8, 'normal'] },
];
const SINGLE_VALUED = new Set(['home city', 'name', 'employer', 'diet']);

// "since 2020", "in March 2024", "since june 2023" -> 2020-01-01 / 2024-03-01 / 2023-06-01
function statedDate(clause) {
  const m = /\b(?:since|in) (?:([A-Za-z]+) )?((?:19|20)\d{2})\b/.exec(clause);
  if (!m) return null;
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return `${m[2]}-${String(month >= 0 ? month + 1 : 1).padStart(2, '0')}-01`;
}

function extract(message) {
  const clauses = String(message)
    .split(/[.!?;\n]+|,\s*|\s+(?:and|but)\s+(?=I\b)/)
    .map((c) => c.trim())
    .filter(Boolean);
  const candidates = [];
  for (const clause of clauses) {
    for (const rule of RULES) {
      const m = rule.re.exec(clause);
      if (!m) continue;
      const [content, topic, category, importance, confidence, sensitivity] = rule.fact(m);
      if (!candidates.some((c) => c.content === content)) {
        candidates.push({ content: content.trim(), topic, category, importance, confidence, sensitivity, validFrom: statedDate(clause) });
      }
      break; // one fact per clause
    }
  }
  return { candidates };
}

const words = (s) => String(s).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
const norm = (s) => words(s).join(' ');

function reconcile(candidate, existing) {
  const same = existing.find((e) => norm(e.content) === norm(candidate.content));
  if (same) return { action: 'NOOP', targetMemoryId: same.id, content: same.content, reason: 'An existing memory already states this fact.' };
  const sameTopic = existing.find((e) => candidate.topic && (e.tags || []).includes(candidate.topic));
  if (sameTopic) {
    const newWords = new Set(words(candidate.content));
    if (words(sameTopic.content).every((w) => newWords.has(w))) {
      return { action: 'UPDATE', targetMemoryId: sameTopic.id, content: candidate.content, reason: 'The new fact adds detail to an existing memory.' };
    }
    if (SINGLE_VALUED.has(candidate.topic)) {
      return { action: 'SUPERSEDE', targetMemoryId: sameTopic.id, content: candidate.content, reason: `The user's ${candidate.topic} changed.` };
    }
  }
  return { action: 'ADD', targetMemoryId: null, content: candidate.content, reason: 'No existing memory states this fact.' };
}

// Stage 4: "answers" with the best-ranked memory and cites it. It does not read the question; it only proves
// that retrieval, citations and logging are wired up.
function answer(memories) {
  if (memories.length === 0) return { answer: 'I have no memories about that.', citedMemories: [], insufficient: true };
  const top = memories[0];
  return { answer: `From your memories: ${top.content.replace(/[.!?]+$/, '')}.`, citedMemories: [top.label], insufficient: false };
}

const estimateTokens = (text) => Math.ceil(String(text).length / 4);

class MockProvider {
  constructor() {
    this.name = 'mock';
  }

  async generateJson({ task, model, system, user, vars = {} }) {
    const text = String(vars.message || vars.question || (vars.candidate && vars.candidate.content) || '');
    if (text.includes('[mock:fail]')) throw new LlmError('mock: simulated temporary failure');
    if (text.includes('[mock:refuse]')) throw new LlmRefusalError('mock: simulated refusal');

    let data;
    if (task === 'extract') data = extract(vars.message);
    else if (task === 'reconcile') data = reconcile(vars.candidate, vars.existing || []);
    else if (task === 'answer') data = answer(vars.memories || []);
    else throw new LlmError(`mock: unknown task ${task}`, { retryable: false });

    return {
      data,
      servedModel: model,
      stopReason: 'end_turn',
      // Estimated (characters / 4), not real token counts: llmcalls marks these rows tokensEstimated
      usage: { inputTokens: estimateTokens(system) + estimateTokens(user), outputTokens: estimateTokens(JSON.stringify(data)), cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

module.exports = { MockProvider, extract, reconcile, answer, SINGLE_VALUED };
