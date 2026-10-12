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
    // bcrypt hash; never returned by queries unless explicitly selected
    passwordHash: { type: String, select: false },
    // Only admins may change the shared categories; nobody can grant it through the API
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
  },
  { timestamps: true } // adds createdAt and updatedAt
);

// Never leak the hash if a document is serialised by accident
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
