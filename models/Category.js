const mongoose = require('mongoose');

// Categories live in their own collection; memories reference them through categoryId
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'name is required'], trim: true },
    description: { type: String, trim: true },
  },
  { timestamps: true }
);

// Names are unique ignoring case ("health" and "Health" are the same category).
// Lookups by name must use the same collation to be able to use this index.
// Explicitly named so it can never be mistaken for the old case-sensitive "name_1" index the migration drops.
categorySchema.index({ name: 1 }, { name: 'name_unique_ci', unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('Category', categorySchema);
