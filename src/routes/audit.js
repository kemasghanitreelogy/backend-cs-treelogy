const { Router } = require('express');
const { handleGetAuditLogs } = require('../controllers/auditController');

const router = Router();

router.get('/', handleGetAuditLogs);

module.exports = router;
