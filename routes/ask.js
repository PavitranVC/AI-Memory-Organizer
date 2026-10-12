const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const askService = require('../services/askService');

const router = express.Router();
router.use(requireAuth);

// POST /api/ask { question, asOf?, k? } -> { answer, citedMemoryIds, citations, memories (retrieved, with scores) }
// The user comes from the token, so only the caller's own memories are ever retrieved.
router.post('/', asyncHandler(async (req, res) => res.json(await askService.ask(req.user._id, req.body))));

module.exports = router;
