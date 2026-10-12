const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const userService = require('../services/userService');

const router = express.Router();
router.use(requireAuth);

// Self only: ":id" must be your own id or the word "me".
// (Creating an account is POST /api/auth/register.)
router.get('/:id', asyncHandler(async (req, res) => res.json(await userService.getUser(req.user, req.params.id))));

router.put('/:id', asyncHandler(async (req, res) => res.json(await userService.updateUser(req.user, req.params.id, req.body))));

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const deleted = await userService.deleteUser(req.user, req.params.id);
    res.json({ message: 'Account and all related data deleted', deleted });
  })
);

module.exports = router;
