const mongoose = require('mongoose');

// Categories live in their own collection; memories reference them through categoryId
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'name is required'], unique: true, trim: true },
    description: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Category', categorySchema);
