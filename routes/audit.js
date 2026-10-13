const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const auditService = require('../services/auditService');

const router = express.Router();
router.use(requireAuth);

// The caller's own audit log, newest first: ?memoryId=&limit=&cursor=
router.get('/', asyncHandler(async (req, res) => res.json(await auditService.listAudit(req.user._id, req.query))));

module.exports = router;
