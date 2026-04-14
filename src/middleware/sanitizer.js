/**
 * Sanitization Middleware
 *
 * Strips sensitive user data before it reaches AI APIs.
 * Removes PII patterns: emails, phone numbers, SSNs, credit cards.
 */

const PII_PATTERNS = [
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL_REDACTED]' },
  { name: 'phone', regex: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, replacement: '[PHONE_REDACTED]' },
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN_REDACTED]' },
  { name: 'creditCard', regex: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, replacement: '[CARD_REDACTED]' },
];

function sanitizeText(text) {
  let sanitized = text;
  for (const pattern of PII_PATTERNS) {
    sanitized = sanitized.replace(pattern.regex, pattern.replacement);
  }
  return sanitized;
}

function sanitizerMiddleware(req, res, next) {
  if (req.body?.question) {
    req.body.originalQuestion = req.body.question;
    req.body.question = sanitizeText(req.body.question);
  }
  next();
}

module.exports = { sanitizerMiddleware, sanitizeText };
