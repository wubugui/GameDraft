/**
 * ObjectExamine focus zoom: objectRoot carries the contact-AO filter (clipToViewport:false), so the filter input texture
 * covers the whole zoomed object, not the view. At focus zoom (fitScale x 6) on a 2560x1440 window (DPR 1) the pool
 * texture becomes 16384 px wide. WebGPU's default maxTextureDimension2D is 8192 (luma only requests adapter limits for
 * featureLevel 'max'; createLumaRhiDevice does not), NullRhiDevice mirrors 8192.
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { ObjectExamineContactAoFilter } from '../../../../src/systems/objectExamine/contactAo';

function build(screenW: number, screenH: number, resolution: number, step: number, aspect: number) {
  const rhi = new NullRhiDevice();
  const canvas = { width: screenW * resolution, height: screenH * resolution, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: screenW, height: screenH, resolution });
  // layout as ObjectExamineScene.layout(): MARGIN 24, CHROME_TOP 84, CHROME_BOTTOM 64
  const vw = screenW - 48;
  const vh = screenH - 84 - 64 - 48;
  const texH = 2000;
  const texW = Math.round(texH * aspect);
  const fitScale = Math.min(vw / texW, vh / texH);
  const z = fitScale * step;

  const stage = new Container();
  const root = new Container();
  stage.addChild(root);
  const viewMask = new Graphics().rect(24, 108, vw, vh).fill(0xffffff);
  const viewLayer = new Container();
  const cameraRoot = new Container();
  const focusRoot = new Container();
  const objectRoot = new Container();
  root.addChild(viewLayer, viewMask);
  viewLayer.mask = viewMask;
  viewLayer.addChild(cameraRoot);
  cameraRoot.addChild(focusRoot);
  focusRoot.addChild(objectRoot);
  cameraRoot.position.set(24 + vw / 2, 108 + vh / 2);
  cameraRoot.scale.set(z);
  focusRoot.position.set(-texW * 0.3, -texH * 0.3); // gazing at a hotspot
  const image = new Sprite(Texture.WHITE);
  image.width = texW;
  image.height = texH;
  const ground = new Container();
  const body = new Container();
  objectRoot.addChild(ground, image, body);
  const ao = new ObjectExamineContactAoFilter();
  ao.setCasters(image, [ground, body]);
  ao.setPixelsPerCm(texW / 60); // a 60 cm wide object
  ao.setCastArea(0, 0, texW, texH);
  ao.setStrength(1);
  ao.setRadiusCm(1.5);
  objectRoot.filters = [ao];
  return { renderer, stage, objectRoot, ao, z, texW, texH };
}

describe('contact AO filter texture at focus zoom', () => {
  const cases: Array<[string, number, number, number, number, number]> = [
    ['1920x1080 DPR1 step3.2 3:2', 1920, 1080, 1, 3.2, 1.5],
    ['1920x1080 DPR1 focus6 3:2', 1920, 1080, 1, 6, 1.5],
    ['2560x1440 DPR1 focus6 3:2', 2560, 1440, 1, 6, 1.5],
    ['1920x1080 DPR1.25 focus6 3:2', 1920, 1080, 1.25, 6, 1.5],
    ['1920x1080 DPR2 step3.2 3:2', 1920, 1080, 2, 3.2, 1.5],
    ['1440x900 DPR2 step3.2 3:2', 1440, 900, 2, 3.2, 1.5],
    ['1920x1080 DPR1.5 step3.2 16:9', 1920, 1080, 1.5, 3.2, 16 / 9],
    ['1920x1080 DPR1.5 step2.25 16:9', 1920, 1080, 1.5, 2.25, 16 / 9],
    ['1920x1080 DPR1 step3.2 16:9', 1920, 1080, 1, 3.2, 16 / 9],
  ];
  const out: string[] = [];
  for (const [name, w, h, res, step, aspect] of cases) {
    it(name, () => {
      const { renderer, stage, objectRoot, ao } = build(w, h, res, step, aspect);
      let err: unknown = null;
      try {
        ao.bake(renderer as any, objectRoot); // updates padding first (game calls bake in update before render)
        renderer.render({ container: stage });
      } catch (e) {
        err = e;
      }
      const b = objectRoot.getBounds();
      out.push(`${name}: pad=${ao.padding} objectRoot on-screen ${Math.round(b.width)}x${Math.round(b.height)} css -> ${err ? 'THROWS ' + (err as Error).message : 'ok'}`);
      require('fs').writeFileSync('tmp/review/r2-mask-filter-rt/bigfilter.txt', out.join('\n'));
      expect(true).toBe(true);
    });
  }
});
