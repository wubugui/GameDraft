import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { BlurFilter, ColorMatrixFilter } from '../../../../src/engine2d';
import { ObjectExamineContactAoFilter } from '../../../../src/systems/objectExamine/contactAo';

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 200, height: 150, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 200, height: 150 });
  return { rhi, renderer };
}

function label(t: any): string {
  if (t === 'canvas') return 'canvas';
  return t?.label || `src#${t?.uid}`;
}

function snapshot(renderer: WebGPURenderer): string[] {
  const cmds = (renderer as any).states[0].builder.commands as any[];
  return cmds.map((c) =>
    c.t === 'pass'
      ? `PASS ${label(c.target)} col=${c.load} st=${c.stencil ? c.stencilLoad : '-'} vp=${c.viewport.join(',')}`
      : `  draw ${c.pipeline.program.name ?? '?'} stencil=${c.pipeline.stencil}/${c.stencilRef} cm=${c.pipeline.colorMask} depth=${c.pipeline.depthFormat ?? '-'} blend=${c.pipeline.blend}`,
  );
}

describe('ObjectExamine topology', () => {
  it('command stream', () => {
    const { rhi, renderer } = setup();
    const stage = new Container();
    const root = new Container();
    stage.addChild(root);
    const bg = new Graphics().rect(0, 0, 200, 150).fill(0x101010);
    const viewMask = new Graphics().rect(20, 20, 160, 110).fill(0xffffff);
    const viewLayer = new Container();
    const cameraRoot = new Container();
    const focusRoot = new Container();
    const plateRoot = new Container();
    const objectRoot = new Container();
    const uiLayer = new Container();
    root.addChild(bg, viewLayer, uiLayer, viewMask);
    viewLayer.addChild(cameraRoot);
    cameraRoot.addChild(focusRoot);
    focusRoot.addChild(plateRoot, objectRoot);
    viewLayer.mask = viewMask;
    const bgSprite = new Sprite(Texture.WHITE);
    bgSprite.width = 220; bgSprite.height = 170; bgSprite.position.set(-10, -10);
    plateRoot.addChild(bgSprite);
    const cm = new ColorMatrixFilter();
    const blur = new BlurFilter({ strength: 3, quality: 3 });
    bgSprite.filters = [cm, blur];
    const image = new Sprite(Texture.WHITE);
    image.width = 80; image.height = 60; image.position.set(60, 40);
    const ground = new Container();
    const body = new Container();
    const bug = new Sprite(Texture.WHITE); bug.width = 5; bug.height = 5; bug.position.set(70, 50);
    body.addChild(bug);
    objectRoot.addChild(ground, image, body);
    const ui = new Graphics().rect(0, 0, 10, 10).fill(0xff0000);
    uiLayer.addChild(ui);

    const ao = new ObjectExamineContactAoFilter();
    ao.setCasters(image, [ground, body]);
    ao.setPixelsPerCm(4);
    ao.setCastArea(0, 0, 200, 150);
    ao.setStrength(1);
    ao.setRadiusCm(2);
    ao.setCritterShadow(1, 1);
    objectRoot.filters = [ao];

    const all: string[] = [];
    const orig = renderer.render.bind(renderer);
    (renderer as any).render = (o: any) => {
      orig(o);
      all.push(`=== render container=${o.container?.label || (o.container === stage ? 'stage' : '?')} target=${o.target ? label(o.target.source ?? o.target) : 'canvas'} clear=${o.clear}`);
      all.push(...snapshot(renderer));
    };
    for (let f = 0; f < 2; f++) {
      all.push(`######## frame ${f}`);
      renderer.render({ container: stage });
      ao.bake(renderer as any, objectRoot);
      renderer.render({ container: stage });
    }
    require('fs').writeFileSync('tmp/review/r2-mask-filter-rt/out.txt', all.join('\n') + '\n----\n' + rhi.log.filter((l) => /begin render|skip|abandon/.test(l)).join('\n'));
    console.log(rhi.log.filter((l) => /begin render|skip|abandon/.test(l)).slice(-40).join('\n'));
    expect((ao as any).failed).toBe(false);
  });
});
