/**
 * Request validation middleware.
 */

function validateQuestion(req, res, next) {
  const { question } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'A "question" string is required.' });
  }

  const trimmed = question.trim();
  if (trimmed.length < 3) {
    return res.status(400).json({ error: 'Question must be at least 3 characters.' });
  }
  if (trimmed.length > 2000) {
    return res.status(400).json({ error: 'Question must not exceed 2000 characters.' });
  }

  req.body.question = trimmed;
  next();
}

function validateFileUpload(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ error: 'A PDF file is required.' });
  }

  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Only PDF files are accepted.' });
  }

  // 20MB limit
  if (req.file.size > 20 * 1024 * 1024) {
    return res.status(400).json({ error: 'File must be under 20MB.' });
  }

  next();
}

module.exports = { validateQuestion, validateFileUpload };
