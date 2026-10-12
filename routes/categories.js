const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const categoryService = require('../services/categoryService');

const router = express.Router();
router.use(requireAuth);

// Categories are shared by all users: anyone signed in can read them, only admins can change them.
router.get('/', asyncHandler(async (req, res) => res.json(await categoryService.listCategories(req.query))));
router.get('/:id', asyncHandler(async (req, res) => res.json(await categoryService.getCategory(req.params.id))));

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => res.status(201).json(await categoryService.createCategory(req.body)))
);
router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await categoryService.updateCategory(req.params.id, req.body)))
);
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const deleted = await categoryService.deleteCategory(req.params.id);
    res.json({ message: 'Category deleted successfully', deleted });
  })
);

module.exports = router;
