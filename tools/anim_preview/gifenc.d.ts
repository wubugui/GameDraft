declare module 'gifenc' {
  export function GIFEncoder(options?: Record<string, unknown>): any;
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number, options?: Record<string, unknown>): number[][];
  export function applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: number[][], format?: string): Uint8Array;
}
