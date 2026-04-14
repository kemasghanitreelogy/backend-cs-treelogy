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

// Configure multer for PDF uploads
const upload = multer({
  dest: path.resolve(__dirname, '../../data/uploads/'),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted.'));
    }
  },
});

// Upload and ingest a single PDF
router.post('/file', ingestionLimiter, upload.single('document'), validateFileUpload, handleFileIngest);

// Ingest all PDFs from data/documents/
router.post('/directory', ingestionLimiter, handleDirectoryIngest);

// Clear vector store
router.delete('/', handleClearStore);

module.exports = router;
