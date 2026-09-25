import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc, RhiSamplerDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { Rectangle } from '../../../../src/engine2d/math/Rectangle';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { TextureSource as PixiTextureSource } from 'pixi.js';

describe('autoGenerateMipmaps (HUD flame sheet path)', () => {
  it('engine2d creates a single-level texture; Pixi GL would allocate floor(log2(max))+1 levels', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const texDescs: RhiTextureDesc[] = [];
    const samplerDescs: RhiSamplerDesc[] = [];
    const origScopeCreate = (renderer as any).scope.createTexture.bind((renderer as any).scope);
    (renderer as any).scope.createTexture = (d: RhiTextureDesc) => { texDescs.push(d); return origScopeCreate(d); };
    const origSamp = (renderer as any).scope.createSampler.bind((renderer as any).scope);
    (renderer as any).scope.createSampler = (d: RhiSamplerDesc) => { samplerDescs.push(d); return origSamp(d); };
    const writeTex = vi.spyOn(rhi, 'writeTexture');

    // sheet 588x612 like HUD (12 cols x 49, 6 rows x 102)
    const W = 588, H = 612;
    const src = new BufferImageSource({ resource: new Uint8Array(W * H * 4), width: W, height: H, label: 'flame-sheet' });
    const updMip = vi.fn();
    src.on('updateMipmaps', updMip);
    // exactly what HUD.loadFlameSheet does
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    const frame = new Texture({ source: src, frame: new Rectangle(0, 0, 49, 102) });
    const root = new Container();
    const sp = root.addChild(new Sprite(frame));
    sp.scale.set(0.25);
    renderer.render({ container: root });

    const sheet = texDescs.filter((d) => d.label === 'flame-sheet');
    console.log('sheet texture descs:', JSON.stringify(sheet.map((d) => ({ w: d.width, h: d.height, mipLevels: d.mipLevels }))));
    console.log('samplers:', JSON.stringify(samplerDescs));
    console.log('writeTexture calls:', writeTex.mock.calls.length, 'source.mipLevelCount=', src.mipLevelCount, 'updateMipmaps emitted:', updMip.mock.calls.length);

    // Pixi GL _initSource: mipLevelCount = floor(log2(max(width,height)))+1 when autoGenerateMipmaps (WebGL2 nonPowOf2mipmaps)
    const pixiExpected = Math.floor(Math.log2(Math.max(W, H))) + 1;
    const ps = new PixiTextureSource({ width: W, height: H });
    ps.autoGenerateMipmaps = true;
    console.log('pixi expected mipLevelCount:', pixiExpected, 'pixi source default mipLevelCount before GL init:', ps.mipLevelCount);

    expect(sheet.length).toBe(1);
    expect(sheet[0].mipLevels ?? 1).toBe(1);        // branch: single level
    expect(pixiExpected).toBe(10);                   // master: 10 levels + generateMipmap
  });
});
