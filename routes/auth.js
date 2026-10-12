const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const authService = require('../services/authService');

const router = express.Router();

// POST /api/auth/register  { name, email, password, occupation? }  ->  201 { user, token }
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    res.status(201).json(await authService.register(req.body));
  })
);

// POST /api/auth/login  { email, password }  ->  { user, token }
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    res.json(await authService.login(req.body));
  })
);

module.exports = router;
