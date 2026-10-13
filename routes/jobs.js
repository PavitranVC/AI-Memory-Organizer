const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const jobService = require('../services/jobService');

const router = express.Router();
router.use(requireAuth);

// The caller's own extraction jobs, newest first: ?status=pending|running|done|failed&limit=&cursor=
router.get('/', asyncHandler(async (req, res) => res.json(await jobService.listJobs(req.user._id, req.query))));
// One job, with what the extractor decided for each candidate fact
router.get('/:id', asyncHandler(async (req, res) => res.json(await jobService.getJob(req.user._id, req.params.id))));

module.exports = router;
