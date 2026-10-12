// JSON schemas for the two LLM tasks. The Anthropic provider sends them as structured outputs, so the API
// itself constrains the answer to this shape. The answer is still checked again here (validateX), because the
// mock, a future provider or a truncated answer must never put malformed data into the database.
const SENSITIVITIES = ['normal', 'personal', 'special'];
const ACTIONS = ['ADD', 'UPDATE', 'SUPERSEDE', 'NOOP'];
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          topic: { type: 'string' },
          category: { type: 'string' },
          importance: { type: 'integer', enum: [1, 2, 3, 4, 5] },
          confidence: { type: 'number' },
          sensitivity: { type: 'string', enum: SENSITIVITIES },
          validFrom: nullableString,
        },
        required: ['content', 'topic', 'category', 'importance', 'confidence', 'sensitivity', 'validFrom'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

const RECONCILE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS },
    targetMemoryId: nullableString,
    content: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['action', 'targetMemoryId', 'content', 'reason'],
  additionalProperties: false,
};

const isText = (v) => typeof v === 'string' && v.trim() !== '';

// Returns { candidates, rejected }: well-formed candidates (trimmed, clamped) and the reasons others were dropped
function validateExtraction(data) {
  if (!data || !Array.isArray(data.candidates)) throw new Error('extraction output must be {"candidates": [...]}');
  const candidates = [];
  const rejected = [];
  data.candidates.forEach((c, i) => {
    const problems = [];
    if (!c || typeof c !== 'object') problems.push('not an object');
    else {
      if (!isText(c.content)) problems.push('content');
      if (!isText(c.category)) problems.push('category');
      if (!Number.isInteger(c.importance) || c.importance < 1 || c.importance > 5) problems.push('importance');
      if (typeof c.confidence !== 'number' || !(c.confidence >= 0 && c.confidence <= 1)) problems.push('confidence');
      if (!SENSITIVITIES.includes(c.sensitivity)) problems.push('sensitivity');
      if (c.validFrom !== null && c.validFrom !== undefined && Number.isNaN(new Date(c.validFrom).getTime())) problems.push('validFrom');
    }
    if (problems.length > 0) {
      rejected.push({ index: i, reason: `invalid ${problems.join(', ')}` });
      return;
    }
    candidates.push({
      content: c.content.trim().slice(0, 500),
      topic: isText(c.topic) ? c.topic.trim().toLowerCase().slice(0, 50) : '',
      category: c.category.trim(),
      importance: c.importance,
      confidence: c.confidence,
      sensitivity: c.sensitivity,
      validFrom: c.validFrom ? new Date(c.validFrom) : null,
    });
  });
  return { candidates, rejected };
}

// Checks a decision against the ids the model was shown, so it can never point at another user's memory
function validateDecision(data, allowedIds) {
  if (!data || !ACTIONS.includes(data.action)) throw new Error(`reconcile output: action must be one of ${ACTIONS.join(', ')}`);
  const target = data.targetMemoryId === undefined ? null : data.targetMemoryId;
  if (data.action === 'ADD') return { action: 'ADD', targetMemoryId: null, content: isText(data.content) ? data.content.trim().slice(0, 500) : null, reason: String(data.reason || '').slice(0, 300) };
  if (!allowedIds.includes(String(target))) throw new Error(`reconcile output: targetMemoryId ${target} is not one of the memories shown`);
  if (data.action !== 'NOOP' && !isText(data.content)) throw new Error('reconcile output: content is required');
  return {
    action: data.action,
    targetMemoryId: String(target),
    content: isText(data.content) ? data.content.trim().slice(0, 500) : null,
    reason: String(data.reason || '').slice(0, 300),
  };
}

module.exports = { EXTRACT_SCHEMA, RECONCILE_SCHEMA, ACTIONS, validateExtraction, validateDecision };
