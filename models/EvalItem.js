const mongoose = require('mongoose');
const { datasetField } = require('./dataset');

const { ObjectId } = mongoose.Schema.Types;

// Stage 5: a benchmark's question-answer LABELS, kept apart from the chat data. The app never reads this
// collection, so the gold answers cannot leak into memories or retrieval; only the Stage 6 evaluation does.
const evalItemSchema = new mongoose.Schema(
  {
    dataset: { ...datasetField, required: [true, 'dataset is required'] },
    source: {
      name: { type: String, required: true, trim: true }, // 'locomo'
      id: { type: String, required: true, trim: true }, // the sample the question belongs to, e.g. 'conv-26'
      index: { type: Number, required: true, min: 0 }, // position of the question in the sample's qa list
    },
    // The loaded user whose conversations hold the answer (each LoCoMo sample becomes one user)
    userId: { type: ObjectId, ref: 'User', required: true },
    question: { type: String, required: true },
    // Kept as the benchmark's text (a few LoCoMo answers are numbers, stored as their string form).
    // null for adversarial questions, whose correct behaviour is to say the conversation does not answer it.
    answer: { type: String, default: null },
    adversarialAnswer: { type: String, default: null }, // LoCoMo category 5: the tempting WRONG answer
    category: { type: Number, required: true }, // the benchmark's own label, unchanged (LongMemEval has none: ours, see docs/DATASETS.md)
    questionType: { type: String, required: true }, // our readable name for the category (see docs/DATASETS.md)
    // Stage 5b (LongMemEval): the date the question is asked (a memory system must answer as of this date), and
    // whether the question has no answer in the history (the benchmark marks those with an "_abs" id suffix).
    // LoCoMo items leave both unset.
    questionDate: { type: Date },
    abstention: { type: Boolean },
    // Evidence: the benchmark's dialog ids as written, the ones we could match to a loaded message, and the
    // rest. Needed for retrieval recall@k in Stage 6.
    evidence: { type: [String], default: [] },
    evidenceMessageIds: { type: [{ type: ObjectId, ref: 'Message' }], default: [] },
    unresolvedEvidence: { type: [String], default: [] },
  },
  { timestamps: true, versionKey: false }
);

// Each question is loaded once (re-running the loader skips or replaces it, never duplicates it)
evalItemSchema.index({ 'source.name': 1, 'source.id': 1, 'source.index': 1 }, { unique: true });
// Stage 6 reads one user's questions, often one question type at a time. E: userId, category.
evalItemSchema.index({ userId: 1, category: 1 });

module.exports = mongoose.model('EvalItem', evalItemSchema);
