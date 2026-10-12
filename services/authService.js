const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const { badRequest, unauthorized, conflict } = require('./errors');

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt ignores everything after 72 bytes, so longer passwords are refused

let warnedAboutDefaultSecret = false;

function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
  if (!warnedAboutDefaultSecret) {
    console.warn('JWT_SECRET is not set: using an insecure development secret');
    warnedAboutDefaultSecret = true;
  }
  return 'insecure-development-secret';
}

const bcryptRounds = () => Number(process.env.BCRYPT_ROUNDS) || 10;

// Request bodies are JSON, so a field may be an object such as { "$gt": "" }.
// Anything that goes into a query filter must be checked to be a plain string first.
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${field} is required`);
  return value;
}

function validatePassword(password) {
  requireString(password, 'password');
  if (password.length < PASSWORD_MIN) throw badRequest(`password must be at least ${PASSWORD_MIN} characters`);
  if (Buffer.byteLength(password) > PASSWORD_MAX) throw badRequest(`password must be at most ${PASSWORD_MAX} bytes`);
}

const hashPassword = (password) => bcrypt.hash(password, bcryptRounds());

function signToken(user) {
  return jwt.sign({ sub: String(user._id) }, jwtSecret(), { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
  }
}

async function register({ name, email, password, occupation } = {}) {
  requireString(email, 'email');
  validatePassword(password);
  const user = new User({ name, email, occupation, passwordHash: await hashPassword(password) });
  try {
    await user.save();
  } catch (err) {
    if (err.code === 11000) throw conflict('An account with this email already exists');
    throw err;
  }
  return { user, token: signToken(user) };
}

async function login({ email, password } = {}) {
  requireString(email, 'email');
  requireString(password, 'password');
  const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash');
  // Same message for "no such user" and "wrong password" so emails cannot be probed
  const ok = user && user.passwordHash && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) throw unauthorized('Invalid email or password');
  return { user, token: signToken(user) };
}

module.exports = { register, login, signToken, verifyToken, hashPassword, validatePassword, requireString };
