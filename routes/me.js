const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { resolveCategoryId } = require('../services/categoryService');
const consentService = require('../services/consentService');
const suggestionService = require('../services/suggestionService');
const exportService = require('../services/exportService');
const { verifyErasure } = require('../services/erasureVerifier');

// Stage 7: privacy controls of the signed-in user (consent, suggestions, export, erasure check).
// Everything is scoped to the user in the token; no id in the URL can reach another user's data.
const router = express.Router();
router.use(requireAuth);

const uid = (req) => req.user._id;

// Consent per category: { mode: "store" | "ask" | "never", eraseExisting?: boolean }
router.get('/consent', asyncHandler(async (req, res) => res.json(await consentService.listConsent(uid(req)))));
router.put(
  '/consent/:category',
  asyncHandler(async (req, res) => {
    // ":category" is a name ("Health") or a categoryId
    const raw = req.params.category;
    const categoryId = await resolveCategoryId(/^[0-9a-f]{24}$/i.test(raw) ? { categoryId: raw } : { category: raw });
    res.json(await consentService.setConsent(uid(req), categoryId, req.body));
  })
);

// Facts waiting for a decision (categories set to "ask")
router.get('/suggestions', asyncHandler(async (req, res) => res.json(await suggestionService.listSuggestions(uid(req), req.query))));
router.post('/suggestions/:id/accept', asyncHandler(async (req, res) => res.status(201).json(await suggestionService.acceptSuggestion(uid(req), req.params.id))));
router.delete(
  '/suggestions/:id',
  asyncHandler(async (req, res) => {
    const deleted = await suggestionService.rejectSuggestion(uid(req), req.params.id);
    res.json({ message: 'Suggestion rejected and deleted', deleted: { _id: deleted._id } });
  })
);

// Everything stored about me, as one JSON file (?embeddings=true adds the vectors)
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const data = await exportService.exportUserData(uid(req), { embeddings: req.query.embeddings === 'true' });
    res.set('Content-Disposition', `attachment; filename="ai-memory-export-${uid(req)}.json"`);
    res.json(data);
  })
);

// Checks that nothing derived from erased data remains in my account (the same checks as "npm run erasure:verify")
router.get('/erasure-check', asyncHandler(async (req, res) => res.json(await verifyErasure({ userId: uid(req), text: req.query.text }))));

module.exports = router;
