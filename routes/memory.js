const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const memoryService = require('../services/memoryService');

const router = express.Router();
router.use(requireAuth);

// The user always comes from the token, never from the request, so every query below is scoped to the caller.
const uid = (req) => req.user._id;

// Declared before "/:id" so "stats" and "search" are not treated as ids
router.get('/stats/by-category', asyncHandler(async (req, res) => res.json(await memoryService.statsByCategory(uid(req)))));
router.get('/stats/status-ratio', asyncHandler(async (req, res) => res.json(await memoryService.statusRatio(uid(req)))));
router.get('/search', asyncHandler(async (req, res) => res.json(await memoryService.searchMemories(uid(req), req.query))));

// CREATE: body { content, category: "Health" (or categoryId), importance?, status?, tags?, conversationId? }
router.post('/', asyncHandler(async (req, res) => res.status(201).json(await memoryService.createMemory(uid(req), req.body))));

// READ ALL: ?status=&category=&categoryId=&minImportance=&limit=&cursor=   (newest first)
router.get('/', asyncHandler(async (req, res) => res.json(await memoryService.listMemories(uid(req), req.query))));

router.get('/:id', asyncHandler(async (req, res) => res.json(await memoryService.getMemory(uid(req), req.params.id))));

// UPDATE: any of { content, category / categoryId, importance, status, tags, conversationId }
router.put('/:id', asyncHandler(async (req, res) => res.json(await memoryService.updateMemory(uid(req), req.params.id, req.body))));

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const memory = await memoryService.deleteMemory(uid(req), req.params.id);
    res.json({ message: 'Memory deleted successfully', deleted: memory });
  })
);

module.exports = router;
