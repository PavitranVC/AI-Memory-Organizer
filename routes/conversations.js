const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const conversationService = require('../services/conversationService');

const router = express.Router();
router.use(requireAuth);

const uid = (req) => req.user._id;

router.get('/', asyncHandler(async (req, res) => res.json(await conversationService.listConversations(uid(req), req.query))));
router.post('/', asyncHandler(async (req, res) => res.status(201).json(await conversationService.createConversation(uid(req), req.body))));
router.get('/:id', asyncHandler(async (req, res) => res.json(await conversationService.getConversation(uid(req), req.params.id))));
router.put('/:id', asyncHandler(async (req, res) => res.json(await conversationService.updateConversation(uid(req), req.params.id, req.body))));

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { conversation, deletedMessages, unlinkedMemories } = await conversationService.deleteConversation(uid(req), req.params.id);
    res.json({ message: 'Conversation deleted successfully', deleted: conversation, deletedMessages, unlinkedMemories });
  })
);

// Messages of a conversation (kept in their own collection)
router.get('/:id/messages', asyncHandler(async (req, res) => res.json(await conversationService.listMessages(uid(req), req.params.id, req.query))));
router.post('/:id/messages', asyncHandler(async (req, res) => res.status(201).json(await conversationService.createMessage(uid(req), req.params.id, req.body))));

module.exports = router;
