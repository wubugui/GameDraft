import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { path as e2dPath } from '../../../../src/engine2d/assets/utils/path';
import { DOMAdapter as E2DAdapter } from '../../../../src/engine2d/environment/adapter';

const bases = [
  'http://localhost:5173/', 'http://localhost:5173/index.html', 'http://localhost:5173/sub/dir/page.html?x=1#h',
  'tauri://localhost/', 'http://tauri.localhost/index.html', 'file:///C:/game/dist/index.html', 'https://a.b/c/d/',
];
const urls = [
  'assets/images/a.png', '/assets/images/a.png', './a/b/../c.png', '../x.png', 'a.png?v=3', 'http://cdn.x/y.png',
  'data:image/png;base64,AAAA', 'blob:http://localhost/1234', 'assets\\win\\p.png', 'a/b/c.normal.png',
  'tauri://localhost/assets/a.png', '//cdn.x/y.png', 'a b/c d.png', 'assets/images/中文.png',
];
describe('path parity', () => {
  it('toAbsolute / extname / basename / dirname / normalize', () => {
    const P = (PIXI as any).path;
    const out: string[] = [];
    for (const b of bases) {
      const pa = { ...PIXI.DOMAdapter.get(), getBaseUrl: () => b };
      const ea = { ...E2DAdapter.get(), getBaseUrl: () => b };
      PIXI.DOMAdapter.set(pa as any); E2DAdapter.set(ea as any);
      for (const u of urls) {
        for (const fn of ['toAbsolute', 'extname', 'dirname', 'normalize', 'isAbsolute', 'rootname']) {
          let p: string, e: string;
          try { p = JSON.stringify(P[fn](u)); } catch (err) { p = 'ERR'; }
          try { e = JSON.stringify((e2dPath as any)[fn](u)); } catch (err) { e = 'ERR'; }
          if (p !== e) out.push(`${b} ${fn}(${u}): pixi=${p} e2d=${e}`);
        }
      }
    }
    expect(out).toEqual([]);
  });
});
