import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VIEWER_RANGE_BYTES, parseViewerByteRange } from './viewer_range.mjs';

test('viewer ranges use closed byte offsets and permit the exact request limit', () => {
  assert.deepEqual(parseViewerByteRange('bytes=0-0', 10), { start: 0, end: 0, length: 1 });
  assert.deepEqual(parseViewerByteRange(`bytes=0-${MAX_VIEWER_RANGE_BYTES - 1}`,
    MAX_VIEWER_RANGE_BYTES), { start: 0, end: MAX_VIEWER_RANGE_BYTES - 1,
    length: MAX_VIEWER_RANGE_BYTES });
});

test('viewer ranges reject ambiguous, excessive, or out-of-file reads', () => {
  for (const header of [
    'bytes=0-', 'bytes=-1', 'bytes=0-1,4-5', 'bytes=00-1', 'bytes=2-1',
    `bytes=0-${MAX_VIEWER_RANGE_BYTES}`,
    'bytes=0-9007199254740992', 'items=0-1', '',
  ]) assert.equal(parseViewerByteRange(header, MAX_VIEWER_RANGE_BYTES + 1), null, header);
  assert.equal(parseViewerByteRange('bytes=0-0', 0), null);
  assert.equal(parseViewerByteRange('bytes=0-10', 10), null);
});
