// A viewer may inspect a large raw RT without loading the entire file.
// Ranges are closed byte intervals and deliberately bounded per request.
export const MAX_VIEWER_RANGE_BYTES = 8 * 1024 * 1024;

export function parseViewerByteRange(header, size) {
  if (typeof header !== 'string' || !Number.isSafeInteger(size) || size < 1) return null;
  const match = /^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start > end || end >= size || end - start + 1 > MAX_VIEWER_RANGE_BYTES) return null;
  return { start, end, length: end - start + 1 };
}
