import { beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { Text } from '../../../../src/engine2d/text/Text';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { Rectangle } from '../../../../src/engine2d/math/Rectangle';
import { Container } from '../../../../src/engine2d/scene/Container';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

let seed = 99;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick<T>(a: T[]): T { return a[Math.floor(rnd() * a.length)]; }

function sigText(t: any) {
  const lb = t.getLocalBounds();
  const b = t.getBounds();
  return { w: t.width, h: t.height, lb: [lb.x, lb.y, lb.width, lb.height], b: [b.x, b.y, b.width, b.height], sx: t.scale.x, sy: t.scale.y,
    cp: [t.containsPoint({ x: 3, y: 4 }), t.containsPoint({ x: -10, y: -3 })], size: t.getSize() };
}

describe('Text api', () => {
  it('random ops', () => {
    const fails: string[] = [];
    for (let trial = 0; trial < 300; trial++) {
      const opts: any = { text: pick(['hi', '你好世界', 'a\nbb\nccc', '']), style: { fontSize: pick([12, 20]), wordWrap: rnd() < 0.5, wordWrapWidth: 50, trim: rnd() < 0.2, padding: pick([0, 3]) } };
      if (rnd() < 0.3) opts.anchor = pick([0.5, { x: 1, y: 0 }, 0]);
      if (rnd() < 0.2) opts.width = 100;
      const pc = new PIXI.Container(); const mc = new Container();
      const p = new PIXI.Text(structuredClone(opts)); const m = new Text(structuredClone(opts));
      pc.addChild(p); mc.addChild(m); pc.position.set(5, 7); mc.position.set(5, 7);
      const log: string[] = [];
      for (let s = 0; s < 8; s++) {
        const op = Math.floor(rnd() * 9);
        const v = pick([0, 1, 10, 55.5, 200]);
        const txt = pick(['x', '长一点的中文文本', 'abc def ghi', '']);
        const fn = [
          (o: any) => { o.text = txt; },
          (o: any) => { o.width = v; },
          (o: any) => { o.height = v; },
          (o: any) => { o.anchor.set(v / 200); },
          (o: any) => { o.style.fontSize = 10 + v / 10; },
          (o: any) => { o.style.wordWrapWidth = v; },
          (o: any) => { o.setSize(v, v / 2); },
          (o: any) => { o.scale.set(-1, 2); },
          (o: any) => { o.style = { fontSize: 15, letterSpacing: 2 }; },
        ][op];
        log.push(String(op) + ':' + v + ':' + txt);
        fn(p); fn(m);
        try { expect(sigText(m)).toEqual(sigText(p)); } catch (e) { fails.push(JSON.stringify(opts) + ' ' + log.join(',') + '\n' + String(e).slice(0, 600)); break; }
      }
    }
    console.log(fails.length, fails.slice(0, 4).join('\n---\n'));
    expect(fails.length).toBe(0);
  });

  it('Sprite api with trimmed textures', () => {
    const fails: string[] = [];
    const mkP = (trim: boolean) => new PIXI.Texture({ source: new PIXI.TextureSource({ width: 64, height: 64 }), frame: new PIXI.Rectangle(4, 4, 20, 30), orig: trim ? new PIXI.Rectangle(0, 0, 40, 50) : undefined, trim: trim ? new PIXI.Rectangle(5, 6, 20, 30) : undefined });
    const mkM = (trim: boolean) => new Texture({ source: new TextureSource({ width: 64, height: 64 }), frame: new Rectangle(4, 4, 20, 30), orig: trim ? new Rectangle(0, 0, 40, 50) : undefined, trim: trim ? new Rectangle(5, 6, 20, 30) : undefined });
    for (let trial = 0; trial < 300; trial++) {
      const trim = rnd() < 0.5;
      const opts: any = {};
      if (rnd() < 0.3) opts.anchor = pick([0.5, { x: 1, y: 0 }]);
      if (rnd() < 0.3) opts.width = 77;
      const p = new PIXI.Sprite({ ...opts, texture: mkP(trim) }); const m = new Sprite({ ...opts, texture: mkM(trim) });
      const log: string[] = [];
      for (let s = 0; s < 8; s++) {
        const op = Math.floor(rnd() * 6); const v = pick([0, 10, 33, 100]); const t2 = rnd() < 0.5;
        log.push(op + ':' + v + ':' + t2);
        if (op === 0) { p.texture = mkP(t2); m.texture = mkM(t2); }
        if (op === 1) { p.width = v; m.width = v; }
        if (op === 2) { p.height = v; m.height = v; }
        if (op === 3) { p.anchor.set(v / 100); m.anchor.set(v / 100); }
        if (op === 4) { p.setSize(v); m.setSize(v); }
        if (op === 5) { p.scale.x = -2; m.scale.x = -2; }
        const sp = { ...sigText(p), vb: { ...p.visualBounds } }; const sm = { ...sigText(m), vb: { ...m.visualBounds } };
        try { expect(sm).toEqual(sp); } catch (e) { fails.push(trim + JSON.stringify(opts) + ' ' + log.join(',') + '\n' + String(e).slice(0, 600)); break; }
      }
    }
    console.log(fails.length, fails.slice(0, 4).join('\n---\n'));
    expect(fails.length).toBe(0);
  });
});
