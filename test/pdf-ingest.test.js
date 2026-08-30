const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { truncateText, MAX_CONTEXT_CHARS, MIN_TEXT_CHARS } = require('../lib/pdf-ingest');

describe('pdf-ingest', () => {
  it('truncates long text to context limit', () => {
    const long = 'word '.repeat(3000);
    const out = truncateText(long);
    assert.equal(out.length, MAX_CONTEXT_CHARS);
  });

  it('preserves short text', () => {
    const short = 'Photosynthesis converts light into chemical energy in chloroplasts.';
    assert.equal(truncateText(short), short);
  });

  it('normalizes whitespace', () => {
    assert.equal(truncateText('hello   world\n\nfoo'), 'hello world foo');
  });

  it('exports sensible minimum text threshold', () => {
    assert.ok(MIN_TEXT_CHARS >= 40);
  });
});
