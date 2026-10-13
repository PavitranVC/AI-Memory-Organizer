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
    const { conversation, deletedMessages, unlinkedMemories, erasure } = await conversationService.deleteConversation(uid(req), req.params.id);
    res.json({ message: 'Conversation deleted successfully', deleted: conversation, deletedMessages, unlinkedMemories, erasure });
  })
);

// Messages of a conversation (kept in their own collection)
router.get('/:id/messages', asyncHandler(async (req, res) => res.json(await conversationService.listMessages(uid(req), req.params.id, req.query))));
router.post('/:id/messages', asyncHandler(async (req, res) => res.status(201).json(await conversationService.createMessage(uid(req), req.params.id, req.body))));
// Stage 7: deleting a message erases every memory derived only from it (lineage-based erasure)
router.delete(
  '/:id/messages/:messageId',
  asyncHandler(async (req, res) => {
    const { message, erasure } = await conversationService.deleteMessage(uid(req), req.params.id, req.params.messageId);
    res.json({ message: 'Message deleted and everything derived from it erased', deleted: { _id: message._id, conversationId: message.conversationId }, erasure });
  })
);

module.exports = router;
