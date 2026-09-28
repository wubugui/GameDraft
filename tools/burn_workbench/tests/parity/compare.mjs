/** Master GL / migrated WebGPU comparison: use the migration's existing per-channel <=1 rule.
 * Keep exact equality visible. A two-level difference, including alpha, is always a failure.
 * This is not an image-percentage allowance: zero pixels may exceed the channel threshold.
 */
export function compareCanvasRgba(a, b) {
  const dimensionsMatch = Number.isInteger(a.width) && a.width > 0 && Number.isInteger(a.height) && a.height > 0
    && a.width === b.width && a.height === b.height
    && a.data.length === a.width * a.height * 4 && b.data.length === b.width * b.height * 4;
  if (!dimensionsMatch) return { dimensionsMatch: false, threshold: 1, exactEqual: false,
    diffPixels: null, maxChannelDiff: null, pixelsOver1: null, passed: false };
  let diffPixels = 0, maxChannelDiff = 0, pixelsOver1 = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(a.data[i + c] - b.data[i + c])));
    if (d > 0) diffPixels++;
    if (d > 1) pixelsOver1++;
    maxChannelDiff = Math.max(maxChannelDiff, d);
  }
  return { dimensionsMatch: true, threshold: 1, exactEqual: diffPixels === 0,
    diffPixels, maxChannelDiff, pixelsOver1, passed: pixelsOver1 === 0 };
}
