const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

/**
 * Load and parse a PDF file, returning structured text with metadata.
 */
async function loadPDF(filePath) {
  const absolutePath = path.resolve(filePath);
  const buffer = fs.readFileSync(absolutePath);
  const data = await pdfParse(buffer);

  return {
    text: data.text,
    metadata: {
      name: path.basename(filePath),
      path: absolutePath,
      pages: data.numpages,
      info: data.info,
    },
  };
}

/**
 * Load all PDFs from a directory.
 */
async function loadDirectory(dirPath) {
  const absoluteDir = path.resolve(dirPath);
  const files = fs.readdirSync(absoluteDir).filter((f) => f.endsWith('.pdf'));

  const documents = await Promise.all(
    files.map((file) => loadPDF(path.join(absoluteDir, file)))
  );

  return documents;
}

module.exports = { loadPDF, loadDirectory };
