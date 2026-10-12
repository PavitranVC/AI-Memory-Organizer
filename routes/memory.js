const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const memoryService = require('../services/memoryService');
const { retrieve } = require('../services/retrieval');

const router = express.Router();
router.use(requireAuth);

// The user always comes from the token, never from the request, so every query below is scoped to the caller.
const uid = (req) => req.user._id;

// Declared before "/:id" so "stats" and "search" are not treated as ids
router.get('/stats/by-category', asyncHandler(async (req, res) => res.json(await memoryService.statsByCategory(uid(req)))));
router.get('/stats/status-ratio', asyncHandler(async (req, res) => res.json(await memoryService.statusRatio(uid(req)))));
router.get('/search', asyncHandler(async (req, res) => res.json(await memoryService.searchMemories(uid(req), req.query))));
// Stage 4: hybrid retrieval without the answer model, with each memory's score parts: ?q=&asOf=&k=
router.get('/retrieve', asyncHandler(async (req, res) => res.json(await retrieve(uid(req), { query: req.query.q, asOf: req.query.asOf, k: req.query.k }))));

// CREATE: body { content, category: "Health" (or categoryId), importance?, status?, tags?, conversationId? }
router.post('/', asyncHandler(async (req, res) => res.status(201).json(await memoryService.createMemory(uid(req), req.body))));

// READ ALL: ?status=&category=&categoryId=&minImportance=&limit=&cursor=   (newest first)
// Current versions by default. Time travel: ?asOf=<ISO date> (valid time) and/or ?knownAt=<ISO date> (transaction time)
router.get('/', asyncHandler(async (req, res) => res.json(await memoryService.listMemories(uid(req), req.query))));

// The version chain of a memory (oldest first), from any of its versions
router.get('/:id/history', asyncHandler(async (req, res) => res.json(await memoryService.getHistory(uid(req), req.params.id))));

router.get('/:id', asyncHandler(async (req, res) => res.json(await memoryService.getMemory(uid(req), req.params.id))));

// UPDATE = SUPERSEDE: creates a new version and closes this one; returns the new version.
// Any of { content, category / categoryId, importance, status, tags, conversationId, confidence, sensitivity,
// sourceMessageIds, validFrom (when the change happened, default now) }, or "correction": true to fix a mistake.
router.put('/:id', asyncHandler(async (req, res) => res.json(await memoryService.updateMemory(uid(req), req.params.id, req.body))));

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // A retraction: the version is kept (with retractedAt) for the history and the audit trail
    const memory = await memoryService.deleteMemory(uid(req), req.params.id);
    res.json({ message: 'Memory deleted (retracted) successfully', deleted: memory });
  })
);

module.exports = router;
