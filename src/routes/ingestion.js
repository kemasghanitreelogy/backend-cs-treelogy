const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const {
  handleFileIngest,
  handleDirectoryIngest,
  handleClearStore,
} = require('../controllers/ingestionController');
const { validateFileUpload } = require('../middleware/validator');
const { ingestionLimiter } = require('../middleware/rateLimiter');

const router = Router();

const ALLOWED_MIMETYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

// Configure multer for document uploads (PDF + DOCX) — use /tmp on serverless
const upload = multer({
  dest: path.join(require('os').tmpdir(), 'treelogy-uploads'),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and DOCX files are accepted.'));
    }
  },
});

// Upload and ingest a single document (PDF or DOCX)
router.post('/file', ingestionLimiter, upload.single('document'), validateFileUpload, handleFileIngest);

// Ingest all documents from data/documents/
router.post('/directory', ingestionLimiter, handleDirectoryIngest);

// Clear vector store
router.delete('/', handleClearStore);

module.exports = router;
