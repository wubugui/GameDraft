import { describe, it } from 'vitest';
import * as P from 'pixi.js';
import * as E from '../../../../src/engine2d';
function scenario(lib: any, tex: any) {
  const out: string[] = [];
  const root = new lib.Container();
  const a = new lib.Container(); root.addChild(a);
  const b = new lib.Container(); a.addChild(b);
  const s = new lib.Sprite(tex); b.addChild(s);
  const g = new lib.Graphics().rect(0, 0, 10, 10).fill(0); a.addChild(g);
  const m = new lib.Graphics().rect(0, 0, 3, 3).fill(0); root.addChild(m);
  const f = () => { const lb = root.getLocalBounds(); out.push([lb.minX, lb.minY, lb.maxX, lb.maxY].join(',')); };
  f();
  s.x = 50; f();
  b.visible = false; f();
  b.visible = true; f();
  g.clear().rect(-20, -20, 5, 5).fill(0); f();
  s.texture = lib.Texture.WHITE; f();
  s.anchor.set(0.5); f();
  b.removeChild(s); f();
  a.addChild(s); f();
  a.mask = m; f();
  a.mask = null; f();
  s.alpha = 0; f();
  root.scale.set(2); f();
  a.removeChildren(); f();
  for (let i = 0; i < 70000; i++) s.x = i % 7; a.addChild(s); f();
  return out;
}
describe('local bounds cache', () => {
  it('matches', () => {
    const pt = new P.Texture({ source: new P.TextureSource({ width: 13, height: 7 }) });
    const et = new E.Texture({ source: new E.TextureSource({ width: 13, height: 7 }) });
    const p = scenario(P, pt), e = scenario(E, et);
    for (let i = 0; i < p.length; i++) console.log(i, p[i] === e[i] ? 'same' : 'DIFF', p[i], '|', e[i]);
  });
});
