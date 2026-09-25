const mongoose = require('mongoose');

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
  },
  { timestamps: true } // adds createdAt and updatedAt
);

module.exports = mongoose.model('User', userSchema);
