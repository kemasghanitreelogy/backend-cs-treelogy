const fs = require('fs');
const path = require('path');

// Lazy-load parsers to avoid crashes in serverless environments
let pdfParse;
function getPdfParse() {
  if (!pdfParse) pdfParse = require('pdf-parse');
  return pdfParse;
}

let mammoth;
function getMammoth() {
  if (!mammoth) mammoth = require('mammoth');
  return mammoth;
}

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx'];

/**
 * Load and parse a PDF file, returning structured text with metadata.
 */
async function loadPDF(filePath) {
  const absolutePath = path.resolve(filePath);
  const buffer = fs.readFileSync(absolutePath);
  const data = await getPdfParse()(buffer);

  return {
    text: data.text,
    metadata: {
      name: path.basename(filePath),
      path: absolutePath,
      pages: data.numpages,
      type: 'pdf',
      info: data.info,
    },
  };
}

/**
 * Load and parse a DOCX file, returning structured text with metadata.
 */
async function loadDOCX(filePath) {
  const absolutePath = path.resolve(filePath);
  const buffer = fs.readFileSync(absolutePath);
  const result = await getMammoth().extractRawText({ buffer });

  return {
    text: result.value,
    metadata: {
      name: path.basename(filePath),
      path: absolutePath,
      type: 'docx',
    },
  };
}

/**
 * Load a document by detecting its file type (PDF or DOCX).
 */
async function loadDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') return loadPDF(filePath);
  if (ext === '.docx') return loadDOCX(filePath);

  throw new Error(`Unsupported file type: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
}

/**
 * Load all supported documents (PDF + DOCX) from a directory.
 */
async function loadDirectory(dirPath) {
  const absoluteDir = path.resolve(dirPath);
  const files = fs.readdirSync(absoluteDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return SUPPORTED_EXTENSIONS.includes(ext);
  });

  const documents = await Promise.all(
    files.map((file) => loadDocument(path.join(absoluteDir, file)))
  );

  return documents;
}

module.exports = { loadPDF, loadDOCX, loadDocument, loadDirectory, SUPPORTED_EXTENSIONS };
