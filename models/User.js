const mongoose = require('mongoose');
const { datasetField, sourceSchema } = require('./dataset');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'name is required'], trim: true },
    email: {
      type: String,
      required: [true, 'email is required'],
      unique: true, // creates a unique index on email
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'please provide a valid email'],
    },
    occupation: { type: String, trim: true },
    // bcrypt hash; never returned by queries unless explicitly selected
    passwordHash: { type: String, select: false },
    // Only admins may change the shared categories; nobody can grant it through the API
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    // Stage 5: set only on users created by a dataset loader or the synthetic generator
    dataset: datasetField,
    source: { type: sourceSchema, default: undefined },
  },
  { timestamps: true } // adds createdAt and updatedAt
);

// A dataset sample is loaded at most once: the loader looks it up by (source.name, source.id) to skip or
// reset it. Partial, so the many API-created users without a source are not in the index at all.
userSchema.index(
  { 'source.name': 1, 'source.id': 1 },
  { unique: true, partialFilterExpression: { 'source.name': { $exists: true } } }
);

// Never leak the hash if a document is serialised by accident
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
