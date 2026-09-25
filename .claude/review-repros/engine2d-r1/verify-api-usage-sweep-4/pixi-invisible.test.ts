import { it, expect } from 'vitest';
import { AbstractRenderer, Container, RenderTexture } from 'pixi.js';
it('pixi 8.17 render() of invisible root never emits renderStart (no clear)', () => {
  const calls: string[] = [];
  const mk = (n: string) => ({ emit: () => calls.push(n) });
  const fake: any = {
    tick: 0, view: { renderTarget: {} }, background: { colorRgba: [0, 0, 0, 1], clearBeforeRender: true },
    runners: { prerender: mk('prerender'), renderStart: mk('renderStart'), render: mk('render'), renderEnd: mk('renderEnd'), postrender: mk('postrender') },
  };
  const root = new Container();
  const rt = RenderTexture.create({ width: 8, height: 8 });
  root.visible = false;
  (AbstractRenderer.prototype as any).render.call(fake, { container: root, target: rt, clear: true, clearColor: [1, 0, 0, 1] });
  expect(calls).toEqual([]);
  root.visible = true;
  (AbstractRenderer.prototype as any).render.call(fake, { container: root, target: rt, clear: true, clearColor: [1, 0, 0, 1] });
  expect(calls).toContain('renderStart');
});
