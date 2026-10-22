// The systems the Stage 6 evaluation compares. They all answer with the SAME prompt (prompts/eval-answer.v1.md)
// and the same model; only the CONTEXT differs, so a difference in accuracy comes from what each system keeps
// and retrieves.
//
//   full_context        the whole conversation (no memory at all): the usual upper-bound-style baseline
//   rag_messages        top-k raw messages by embedding similarity (plain RAG, no extraction)
//   overwrite_memory    the same extraction pipeline, but an UPDATE/SUPERSEDE rewrites the memory in place
//                       (no versions, no valid time history), as most assistant memories work
//   ours                bi-temporal memories: current facts at the question date, with valid time and a quote
//                       of the source message (provenance)
//   ours_no_temporal    ablation: every version the store still believes (superseded ones too), with no
//                       validFrom/validTo and no dates, so the answer model cannot tell old from current
//   ours_no_provenance  ablation: as "ours", but without the source quote and dialog id
//
// LoCoMo is a chat between TWO people, while the extractor (prompts/extract.v1.md, and extract.v2 since Stage 3b)
// mines memories about "the user" who wrote the message. The harness therefore builds two perspectives per sample: user A (speaker A
// is the 'user', as Stage 5 loads it) and a mirror user B (the same messages with the roles swapped). Every
// message is mined exactly once, in the perspective of the person who said it, and each memory is labelled
// with the person whose store it is in. This keeps the extractor itself unchanged.
const { retrieve } = require('../services/retrieval');
const { embedDocuments, embedQuery, cosine } = require('../services/embeddings');

const SYSTEMS = [
  { id: 'full_context', store: null },
  { id: 'rag_messages', store: null },
  { id: 'overwrite_memory', store: 'overwrite', temporal: true, provenance: true },
  { id: 'ours', store: 'bitemporal', temporal: true, provenance: true },
  { id: 'ours_no_temporal', store: 'bitemporal', temporal: false, provenance: true, allVersions: true },
  { id: 'ours_no_provenance', store: 'bitemporal', temporal: true, provenance: false },
];
const SYSTEM_IDS = SYSTEMS.map((s) => s.id);

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const estimateTokens = (text) => Math.ceil(String(text).length / 4);

// Optional cap on the text of ONE message shown to the answer model (LongMemEval turns can be 10,000 characters;
// ten of them would not fit the small context window). null = no cap, as for LoCoMo. Set by eval/run.js.
let itemCharCap = null;
const setItemCharCap = (n) => {
  itemCharCap = n > 0 ? n : null;
};
const TRUNCATED = ' [truncated]';
const clip = (text) => (itemCharCap && text.length > itemCharCap ? `${text.slice(0, itemCharCap - TRUNCATED.length)}${TRUNCATED}` : text);

// A message as the answer model sees it, e.g.  [D1:3] 2023-05-08 Asha: I have 2 cats at home.
function formatMessage(m) {
  return `[${m.source.id}] ${day(m.sentAt)} ${m.source.speaker}: ${clip(m.content)}`;
}

// A memory as the answer model sees it. sources: Map(messageId -> message) for the provenance quote.
function formatMemory(label, memory, person, sources, { temporal, provenance }) {
  let line = `[${label}] about ${person}: ${memory.content}`;
  if (temporal) line += ` | validFrom ${day(memory.validFrom)} | validTo ${day(memory.validTo)}`;
  if (provenance) {
    const quotes = (memory.sourceMessageIds || []).map((id) => sources.get(String(id))).filter(Boolean);
    for (const m of quotes.slice(-2)) {
      const quote = m.content.length > 300 ? `${m.content.slice(0, 300)}...` : m.content;
      // No date in the quote when the temporal fields are ablated, so dates cannot leak in through it
      line += ` | source [${m.source.id}]${temporal ? ` ${day(m.sentAt)}` : ''} ${m.source.speaker}: "${quote}"`;
    }
  }
  return line;
}

// The whole conversation in time order. The same text for every question about this sample, so the
// provider caches it (see CACHE_BREAK in services/llm).
function fullContext(messages) {
  const items = messages.map((m) => ({ label: m.source.id, text: formatMessage(m), dia: [m.source.id] }));
  return { kind: 'the whole conversation', items };
}

// Plain RAG: embed every message once, then cosine top-k for the question.
async function buildMessageIndex(messages) {
  const vectors = [];
  for (let i = 0; i < messages.length; i += 64) {
    const batch = messages.slice(i, i + 64);
    vectors.push(...(await embedDocuments(batch.map((m) => `${m.source.speaker}: ${m.content}`))).vectors);
  }
  return messages.map((m, i) => ({ message: m, vector: vectors[i] }));
}

async function ragContext(index, question, k) {
  const { vector } = await embedQuery(question);
  const top = index
    .map((e) => ({ message: e.message, score: cosine(vector, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .sort((a, b) => a.message.sentAt - b.message.sentAt); // shown in time order
  return { kind: `the ${k} most similar messages`, items: top.map((t) => ({ label: t.message.source.id, text: formatMessage(t.message), dia: [t.message.source.id] })) };
}

// Memory systems: retrieve from both perspectives (the two people) and keep the k best by score.
// The scores of the two calls use the same formula; the keyword part is scaled per call, so a merged
// ranking is close to, not exactly, one ranking over both stores (a stated limitation).
async function memoryContext(system, perspectives, sources, question, k, asOf) {
  const hits = [];
  for (const p of perspectives) {
    const found = await retrieve(p.userId, { query: question, k, touch: false, allVersions: !!system.allVersions, asOf: system.allVersions ? undefined : asOf });
    for (const r of found.results) hits.push({ ...r, person: p.person });
  }
  hits.sort((a, b) => b.score - a.score);
  const items = hits.slice(0, k).map((h, i) => {
    const label = `m${i + 1}`;
    const dia = (h.memory.sourceMessageIds || []).map((id) => sources.get(String(id))).filter(Boolean).map((m) => m.source.id);
    return { label, text: formatMemory(label, h.memory, h.person, sources, system), dia };
  });
  return { kind: `${items.length} retrieved memories`, items };
}

module.exports = { SYSTEMS, SYSTEM_IDS, setItemCharCap, formatMessage, formatMemory, fullContext, buildMessageIndex, ragContext, memoryContext, estimateTokens };
