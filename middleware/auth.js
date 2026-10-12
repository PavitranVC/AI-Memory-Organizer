const asyncHandler = require('./asyncHandler');
const User = require('../models/User');
const { verifyToken } = require('../services/authService');
const { unauthorized, forbidden } = require('../services/errors');

// Requires "Authorization: Bearer <token>" and loads the user, so a token of a deleted user stops working.
const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();

  const payload = verifyToken(token);
  const user = await User.findById(payload.sub).lean();
  if (!user) throw unauthorized('User no longer exists');
  req.user = user;
  next();
});

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return next(forbidden('Admin role required'));
  next();
};

module.exports = { requireAuth, requireAdmin };
