const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const MIN_TEXT_CHARS = 80;
const MAX_CONTEXT_CHARS = 8000;

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncateText(text, max = MAX_CONTEXT_CHARS) {
  const trimmed = normalizeWhitespace(text);
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

async function extractTextFromPdf(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (readErr) {
    console.error('pdf read failed:', readErr);
    throw new Error('Could not read the uploaded file. Try again or type the topic manually.');
  }

  if (!buffer.length) {
    throw new Error('The uploaded file is empty. Try another file or type the topic manually.');
  }

  if (buffer.slice(0, 5).toString('utf8') !== '%PDF-') {
    throw new Error('This file does not look like a valid PDF. Try another file or type the topic manually.');
  }

  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const raw = normalizeWhitespace(result.text);
    if (raw.length < MIN_TEXT_CHARS) {
      throw new Error(
        'This PDF has little or no selectable text — it may be scanned or image-based. Type the topic manually instead.'
      );
    }
    return {
      charCount: raw.length,
      text: truncateText(raw),
      truncated: raw.length > MAX_CONTEXT_CHARS,
    };
  } catch (parseErr) {
    if (parseErr.message.includes('selectable text')) throw parseErr;
    console.error('pdf parse failed:', parseErr);
    throw new Error(
      'Could not read this PDF — it may be corrupt. Try another file or type the topic manually.'
    );
  } finally {
    if (parser) await parser.destroy().catch(() => {});
  }
}

function deletePdf(filePath) {
  fs.unlink(filePath, () => {});
}

module.exports = {
  extractTextFromPdf,
  deletePdf,
  truncateText,
  MIN_TEXT_CHARS,
  MAX_CONTEXT_CHARS,
};
