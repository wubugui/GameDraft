/** Tool regression: direct UV + one material/glow pass, matching the legacy BurnGL preview.
 * Real legacy WebGL pixel oracle lives in tests/parity, not the game's filter chain.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { NullRhiDevice } from '../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { BufferImageSource, Mesh, Texture, WebGPURenderer } from '../../../src/engine2d';
import { traceRhi } from '../../workbench_rhi/rhiTrace';
import { BurnStage, artHotspotDef, type BurnHotspotInput } from './burnView';
import { BurnPreviewQuad, loadPreviewTexture } from './burnPreview';
import { createPerspectiveScaleResolver } from '../../../src/utils/perspectiveScale';
// @ts-expect-error shared with the plain Node/Playwright runner
import { compareCanvasRgba } from '../tests/parity/compare.mjs';

function fixture() {
  const texture = new Texture({ source: new BufferImageSource({ resource: new Uint8Array(16).fill(255), width: 2, height: 2 }) });
  const item: BurnHotspotInput = { key: 'paper', kind: 'hotspot', def: artHotspotDef('/paper.png', 96, 64), texture,
    burn: { gridW: 2, gridH: 2, source: {}, gen: 0, encode: (d) => d.fill(0), params: {
      gridW: 2, gridH: 2, now: 20, timeStep: 1 / 16, flameSeconds: 1.5, emberSeconds: 1,
      scorchSeconds: .3, ashFadeSeconds: .5, edgeNoise: .8, scorchColor: [.8, .6, .3], charColor: [.1, .1, .1],
      ashColor: [.5, .5, .5], ashAlpha: 0, glow: [2, 1, .3], emberGlow: [1, .3, .1],
    } } };
  return { texture, item };
}

describe('legacy burn workbench preview contract', () => {
  it('burnt20 uses one quad draw, with no intermediate material/glow render targets', () => {
    const rhi = new NullRhiDevice({ swapchainSize: [580, 690] });
    const trace = traceRhi(rhi);
    const renderer = new WebGPURenderer({ rhi, canvas: { width: 580, height: 690, style: {} } as HTMLCanvasElement, width: 580, height: 690 });
    const stage = new BurnStage();
    const { texture, item } = fixture();
    stage.setCamera(5, 60, 197);
    stage.sync([item], 0);
    renderer.render(stage.root);
    // One preview quad plus engine2d's final canvas flip; no two extra filter draws.
    expect(trace.lines.filter((l) => l.startsWith('  draw'))).toHaveLength(2);
    stage.destroy(); texture.destroy(true); renderer.destroy();
  });

  it('camera offset changes only the four screen corners; source UV remains 0..1', () => {
    const stage = new BurnStage();
    const { texture, item } = fixture();
    stage.setCamera(5, 60, 197);
    stage.sync([item], 0);
    const node = stage.world.children[0];
    expect(node).toBeInstanceOf(Mesh);
    const mesh = node as Mesh;
    expect(Array.from(mesh.geometry.getBuffer('aPosition').data)).toEqual([60,197,540,197,540,517,60,517]);
    expect(Array.from(mesh.geometry.getBuffer('aUV').data)).toEqual([0,0,1,0,1,1,0,1]);
    stage.setCamera(5, 320, 367);
    stage.sync([item], 1);
    expect(stage.world.children[0]).toBe(mesh);
    expect(Array.from(mesh.geometry.getBuffer('aPosition').data)).toEqual([320,367,800,367,800,687,320,687]);
    expect(Array.from(mesh.geometry.getBuffer('aUV').data)).toEqual([0,0,1,0,1,1,0,1]);
    stage.destroy(); texture.destroy(true);
  });

  it('multi-instance order, mirrored perspective and rotated frame survive fractional camera/DPR', () => {
    const { texture, item } = fixture();
    const stage = new BurnStage();
    stage.setScreen(320, 200);
    stage.setCamera(.8, 12.5, -6);
    const perspective = createPerspectiveScaleResolver({ near: { x: 0, y: 100, scale: 1 }, far: { x: 0, y: 0, scale: .5 } });
    const mirror: BurnHotspotInput = { ...item, key: 'mirror', perspective,
      def: { id: 'mirror', x: 100, y: 50, perspectiveScaleEnabled: true,
        displayImage: { image: '/paper.png', worldWidth: 40, worldHeight: 20, facing: 'left' } } };
    const rot: BurnHotspotInput = { ...item, key: 'rot', burn: null,
      def: { id: 'rot', x: 40, y: 30, rotation: 90, scale: 2,
        displayImage: { image: '/paper.png', worldWidth: 20, worldHeight: 10 } } };
    stage.setBackground(texture, 400, 250);
    stage.sync([rot, mirror], 0);
    expect(stage.frameOf('mirror')).toEqual({ ox: 115, oy: 35, ux: -30, uy: -0, vx: -0, vy: 15, footX: 100, footY: 50 });
    expect(stage.frameOf('rot')!.ox).toBeCloseTo(60);
    expect(stage.frameOf('rot')!.oy).toBeCloseTo(10);
    const meshes = stage.world.children.slice() as Mesh[];
    expect(meshes).toHaveLength(3);
    expect(Array.from(meshes[2].geometry.getBuffer('aPosition').data)).toEqual(Array.from(new Float32Array([104.5,22,80.5,22,80.5,34,104.5,34])));
    const rhi = new NullRhiDevice({ swapchainSize: [400, 250] });
    const trace = traceRhi(rhi);
    const renderer = new WebGPURenderer({ rhi, canvas: { width: 400, height: 250, style: {} } as HTMLCanvasElement,
      width: 320, height: 200, resolution: 1.25, antialias: true });
    renderer.render(stage.root);
    expect(trace.lines.filter((l) => l.startsWith('  draw'))).toHaveLength(4);
    stage.sync([mirror, rot], 1);
    expect(stage.world.children[1]).toBe(meshes[2]);
    stage.forgetTexture(texture);
    expect(stage.world.children).toHaveLength(0);
    expect(texture.destroyed).toBe(false);
    stage.destroy(); renderer.destroy(); texture.destroy(true);
  });

  it('field updates track source/generation/size, release on reset and never own caller artwork', () => {
    const { texture, item } = fixture();
    const quad = new BurnPreviewQuad(texture);
    const burn = item.burn!;
    const encode = vi.fn((d: Uint8Array) => d.fill(125));
    burn.encode = encode;
    quad.setBurn(burn);
    const first = quad.shader.resources.uBurnField;
    quad.setBurn(burn);
    expect(encode).toHaveBeenCalledTimes(1);
    quad.setBurn({ ...burn, gen: 1 });
    quad.setBurn({ ...burn, source: {} });
    expect(encode).toHaveBeenCalledTimes(3);
    quad.setBurn({ ...burn, gridW: 3 });
    expect(first.destroyed).toBe(true);
    expect(encode).toHaveBeenCalledTimes(4);
    const replacement = quad.shader.resources.uBurnField;
    quad.setBurn(null);
    expect(replacement.destroyed).toBe(true);
    expect(quad.burning).toBe(false);
    quad.destroy(); quad.destroy();
    expect(texture.destroyed).toBe(false);
    texture.destroy(true);
  });

  it('loads an HTML image as straight alpha without global Assets/ImageBitmap settings', async () => {
    class ImageMock {
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      crossOrigin = ''; width = 2; height = 3;
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', ImageMock);
    try {
      const t = await loadPreviewTexture('/paper.png');
      expect(t.source.resource).toBeInstanceOf(ImageMock);
      expect(t.source.alphaMode).toBe('no-premultiply-alpha');
      expect(t.source.style.minFilter).toBe('linear');
      expect(t.source.style.addressModeU).toBe('clamp-to-edge');
      expect((t.source.resource as unknown as ImageMock).onload).toBeNull();
      t.destroy(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it('dropping a pending viewer texture destroys its late result without reviving the cache entry', async () => {
    let resolve!: (texture: { destroy: ReturnType<typeof vi.fn> }) => void;
    const pending = new Promise<{ destroy: ReturnType<typeof vi.fn> }>((r) => { resolve = r; });
    const destroy = vi.fn();
    const context = { S: { rt: { burnView: { loadPreviewTexture: () => pending } } }, requestDraw: vi.fn(), Promise };
    const BurnGpu = runInNewContext(readFileSync(new URL('../viewer/render.js', import.meta.url), 'utf8') + '\nBurnGpu;', context);
    const gpu = new BurnGpu({});
    gpu.ok = true; gpu.stage = { forgetTexture: vi.fn() };
    const old = gpu.textureEntry('/paper.png');
    gpu.dropTexture('/paper.png');
    resolve({ destroy }); await old.promise;
    expect(destroy).toHaveBeenCalledExactlyOnceWith(true);
    expect(gpu.textures.size).toBe(0);
    expect(old.tex).toBeNull();
    expect(gpu.pendingTextures).toBe(0);
  });

  it('uses original CSS dimensions as legacy uScreen, not rounded backing dimensions divided by DPR', () => {
    const BurnGpu = runInNewContext(readFileSync(new URL('../viewer/render.js', import.meta.url), 'utf8') + '\nBurnGpu;', { performance });
    const gpu = new BurnGpu({});
    gpu.ok = true;
    const setScreen = vi.fn();
    gpu.stage = { setScreen, setBackground: vi.fn(), sync: vi.fn() };
    gpu.host = { resize: vi.fn(), render: vi.fn(), renderer: { screen: { width: 719 / 1.24, height: 856 / 1.24 } } };
    gpu.resize(580, 690, 1.24);
    gpu.end();
    expect(setScreen).toHaveBeenCalledExactlyOnceWith(580, 690);
  });
});

describe('master GL / WebGPU channel comparison', () => {
  const image = (data: number[]) => ({ width: 2, height: 1, data: Uint8Array.from(data) });
  const a = image([10, 20, 30, 250, 100, 110, 120, 250]);
  it('reports exact equality separately from accepted +/-1 channel rounding', () => {
    expect(compareCanvasRgba(a, a)).toMatchObject({ exactEqual: true, diffPixels: 0, pixelsOver1: 0, passed: true });
    expect(compareCanvasRgba(a, image([11, 19, 30, 251, 100, 111, 119, 249])))
      .toMatchObject({ exactEqual: false, diffPixels: 2, maxChannelDiff: 1, pixelsOver1: 0, passed: true });
  });
  it.each([0, 1, 2, 3])('rejects +/-2 in channel %i even if every other pixel is exact', (channel) => {
    for (const delta of [-2, 2]) {
      const data = Array.from(a.data); data[4 + channel] += delta;
      expect(compareCanvasRgba(a, image(data))).toMatchObject({ exactEqual: false, diffPixels: 1, maxChannelDiff: 2, pixelsOver1: 1, passed: false });
    }
  });
  it('rejects dimension mismatch and truncated buffers', () => {
    expect(compareCanvasRgba(a, { ...a, width: 1, height: 2 })).toMatchObject({ dimensionsMatch: false, passed: false });
    expect(compareCanvasRgba(a, { ...a, data: a.data.subarray(0, 4) })).toMatchObject({ dimensionsMatch: false, passed: false });
  });
});
