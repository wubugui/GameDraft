import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { TexturePool as PixiTexturePool, Bounds as PixiBounds } from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { ObjectExamineContactAoFilter } from '../../../../src/systems/objectExamine/contactAo';

const log: string[] = [];
function build(sw: number, sh: number, res: number, step: number, aspect: number) {
  const rhi = new NullRhiDevice();
  const canvas = { width: sw * res, height: sh * res, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: sw, height: sh, resolution: res });
  const vw = sw - 48, vh = sh - 84 - 64 - 48;
  const texH = 2000, texW = Math.round(texH * aspect);
  const z = Math.min(vw / texW, vh / texH) * step;
  const stage = new Container();
  const viewMask = new Graphics().rect(24, 108, vw, vh).fill(0xffffff);
  const viewLayer = new Container();
  const cam = new Container();
  const objectRoot = new Container();
  stage.addChild(viewLayer, viewMask);
  viewLayer.mask = viewMask;
  viewLayer.addChild(cam);
  cam.addChild(objectRoot);
  cam.position.set(24 + vw / 2 - texW * 0.3 * z, 108 + vh / 2 - texH * 0.3 * z);
  cam.scale.set(z);
  const image = new Sprite(Texture.WHITE);
  image.width = texW; image.height = texH;
  const ground = new Container(), body = new Container();
  objectRoot.addChild(ground, image, body);
  const ao = new ObjectExamineContactAoFilter();
  ao.setCasters(image, [ground, body]);
  ao.setPixelsPerCm(texW / 175);
  ao.setCastArea(0, 0, texW, texH);
  ao.setStrength(1.2);
  ao.setRadiusCm(2.5);
  objectRoot.filters = [ao];
  return { rhi, renderer, stage, objectRoot, ao };
}

describe('verify contact AO > 8192', () => {
  const cases: Array<[number, number, number, number, number]> = [
    [1920, 1080, 1, 3.2, 1.5],
    [1920, 1080, 2, 3.2, 1.5],
    [1920, 1080, 1.5, 3.2, 1.5],
    [1920, 1080, 1, 6, 1.5],
  ];
  for (const [sw, sh, res, step, aspect] of cases) {
    it(`${sw}x${sh} dpr${res} step${step}`, () => {
      const { rhi, renderer, stage, objectRoot, ao } = build(sw, sh, res, step, aspect);
      const errs: string[] = [];
      for (let f = 0; f < 3; f++) {
        try { ao.bake(renderer as any, objectRoot); renderer.render({ container: stage }); errs.push('ok'); }
        catch (e) { errs.push((e as Error).message); }
      }
      const b = objectRoot.getBounds();
      const pad = ao.padding;
      // Pixi 8.17: what FilterSystem would ask the pool for (clipToViewport:false -> no fitBounds), no size limit
      const pb = new PixiBounds(b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad);
      pb.scale(res).ceil().scale(1 / res);
      const pixiTex = PixiTexturePool.getOptimalTexture(pb.width, pb.height, res, false);
      log.push(`${sw}x${sh} dpr${res} step${step}: caps=${rhi.caps.maxTextureSize} bounds(css)=${Math.round(b.width)}x${Math.round(b.height)} pad=${pad} pixiPoolTex=${pixiTex.source.pixelWidth}x${pixiTex.source.pixelHeight} engine2d frames=${JSON.stringify(errs)}`);
      fs.writeFileSync('tmp/review/verify-r2-mask-filter-rt-0/out.txt', log.join('\n') + '\n');
      expect(true).toBe(true);
    });
  }
});
