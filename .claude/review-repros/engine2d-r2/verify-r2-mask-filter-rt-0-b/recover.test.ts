import { it, expect } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { ObjectExamineContactAoFilter } from '../../../../src/systems/objectExamine/contactAo';
it('recovers after zoom-out', () => {
  const rhi = new NullRhiDevice();
  const canvas = { width: 3840, height: 2160, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 1920, height: 1080, resolution: 2 });
  const stage = new Container(); const cam = new Container(); const obj = new Container(); stage.addChild(cam); cam.addChild(obj);
  const img = new Sprite(Texture.WHITE); img.width = 1536; img.height = 1024; obj.addChild(img);
  const ao = new ObjectExamineContactAoFilter(); ao.setCasters(img, [new Container(), new Container()]);
  ao.setPixelsPerCm(1536/175); ao.setCastArea(0,0,1536,1024); ao.setStrength(1.2); ao.setRadiusCm(2.5); obj.filters=[ao];
  const res: string[] = [];
  for (const z of [0.863*3.2, 0.863*3.2, 0.863*2.25, 0.863*2.25]) {
    cam.scale.set(z);
    try { ao.bake(renderer as any, obj); renderer.render({ container: stage }); res.push('ok'); } catch (e) { res.push('throw:' + (e as Error).message.slice(0, 60)); }
  }
  console.log(res);
  expect(res[0].startsWith('throw')).toBe(true);
  expect(res[3]).toBe('ok');
});
