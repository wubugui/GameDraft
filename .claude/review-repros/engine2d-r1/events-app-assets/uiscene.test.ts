/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import 'pixi.js/events';
import { describe, expect, it } from 'vitest';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Rectangle } from '../../../../src/engine2d/math/Rectangle';
import { Circle } from '../../../../src/engine2d/math/shapes/Circle';
import { EventBoundary } from '../../../../src/engine2d/events/EventBoundary';
import { FederatedPointerEvent } from '../../../../src/engine2d/events/FederatedPointerEvent';

interface Lib {
  name: string;
  root(): any; C(): any; G(): any; R(x: number, y: number, w: number, h: number): any; Circ(x: number, y: number, r: number): any;
  B(root: any): any; ev(): any; sync(root: any): void; hide(n: any): void; show(n: any): void;
}
const e2d: Lib = {
  name: 'e2d', root: () => new Container(), C: () => new Container(), G: () => new Graphics(),
  R: (x, y, w, h) => new Rectangle(x, y, w, h), Circ: (x, y, r) => new Circle(x, y, r),
  B: (r) => new EventBoundary(r), ev: () => new FederatedPointerEvent(null!), sync: () => {},
  hide: (n) => n.setActive(false), show: (n) => n.setActive(true),
};
const px: Lib = {
  name: 'pixi', root: () => new PIXI.Container({ isRenderGroup: true }), C: () => new PIXI.Container(), G: () => new PIXI.Graphics(),
  R: (x, y, w, h) => new PIXI.Rectangle(x, y, w, h), Circ: (x, y, r) => new PIXI.Circle(x, y, r),
  B: (r) => new PIXI.EventBoundary(r), ev: () => new PIXI.FederatedPointerEvent(null as any),
  sync: (root) => (PIXI as any).updateRenderGroupTransforms(root.renderGroup, true),
  hide: (n) => { n.visible = false; }, show: (n) => { n.visible = true; },
};

function build(L: Lib) {
  const nodes: Record<string, any> = {};
  const reg = (name: string, n: any) => { n.label = name; nodes[name] = n; return n; };
  const root = reg('root', L.root());
  // scroll view (UIScrollView pattern)
  const sv = reg('sv', L.C()); sv.position.set(50, 50); sv.eventMode = 'static'; sv.hitArea = L.R(0, 0, 300, 200);
  const maskG = reg('maskG', L.G()); maskG.rect(0, 0, 300, 200).fill({ color: 0xffffff });
  const content = reg('content', L.C()); content.y = -30;
  sv.addChild(maskG); content.mask = maskG; sv.addChild(content);
  for (let i = 0; i < 8; i++) {
    const row = reg(`row${i}`, L.C()); row.y = i * 40; row.eventMode = 'static'; row.cursor = 'pointer'; row.hitArea = L.R(0, 0, 280, 38);
    const bg = reg(`rowbg${i}`, L.G()); bg.roundRect(0, 0, 280, 38, 6).fill({ color: 0x333333 }); bg.eventMode = 'none';
    row.addChild(bg); content.addChild(row);
  }
  const bar = reg('bar', L.G()); bar.rect(290, 0, 6, 200).fill({ color: 0x888888 }); bar.eventMode = 'static'; bar.hitArea = L.R(284, 0, 18, 200);
  const thumb = reg('thumb', L.G()); thumb.rect(0, 0, 6, 50).fill({ color: 0xffffff }); thumb.x = 290; thumb.y = 20; thumb.eventMode = 'static'; thumb.hitArea = L.R(-6, 0, 18, 50);
  sv.addChild(bar, thumb);
  // DevModeUI item: static container whose hit comes from passive Graphics child
  const item = reg('item', L.C()); item.position.set(400, 50); item.eventMode = 'static';
  const hitG = reg('hitG', L.G()); hitG.rect(0, 0, 150, 30).fill({ color: 0xffffff, alpha: 0.01 });
  const ibg = reg('ibg', L.G()); ibg.roundRect(0, 0, 150, 30, 8).fill({ color: 0x222222 });
  item.addChildAt(ibg, 0); item.addChildAt(hitG, 0);
  // Button with stroke only ring + fill, rotated & scaled
  const btn = reg('btn', L.C()); btn.position.set(450, 200); btn.rotation = 0.3; btn.scale.set(1.5, 0.8); btn.eventMode = 'static';
  const ring = reg('ring', L.G()); ring.circle(0, 0, 40).stroke({ width: 8, color: 0xff0000 });
  const poly = reg('poly', L.G()); poly.poly([60, 0, 120, 20, 90, 60, 50, 40]).fill({ color: 0x00ff00 }); poly.eventMode = 'static';
  btn.addChild(ring, poly);
  // wheel with circle hitArea
  const wheel = reg('wheel', L.C()); wheel.position.set(650, 400); wheel.eventMode = 'static'; wheel.hitArea = L.Circ(0, 0, 80);
  const disc = reg('disc', L.G()); disc.circle(0, 0, 60).fill(0x123456); disc.eventMode = 'none'; wheel.addChild(disc);
  // hole
  const holed = reg('holed', L.G()); holed.rect(100, 350, 150, 150).fill(0xffffff).circle(175, 425, 40).cut(); holed.eventMode = 'static';
  // sortable overlap
  const sorted = reg('sorted', L.C()); sorted.sortableChildren = true; sorted.position.set(300, 350);
  for (let i = 0; i < 3; i++) {
    const s = reg(`s${i}`, L.G()); s.rect(i * 20, i * 10, 80, 80).fill(0xffffff); s.eventMode = 'static'; s.zIndex = 3 - i; sorted.addChild(s);
  }
  sorted.sortChildren();
  // npc: hidden via presence
  const npc = reg('npc', L.C()); npc.position.set(500, 500); npc.eventMode = 'static'; npc.hitArea = L.R(-20, -60, 40, 60);
  const shadow = reg('shadow', L.G()); shadow.ellipse(0, 0, 30, 8).fill(0); npc.addChild(shadow);
  root.addChild(sv, item, btn, wheel, holed, sorted, npc);
  return { root, nodes };
}

function grid(L: Lib, mutate?: (n: Record<string, any>, L: Lib) => void): string[] {
  const { root, nodes } = build(L);
  mutate?.(nodes, L);
  L.sync(root);
  const b = L.B(root);
  const out: string[] = [];
  for (let y = 0; y <= 600; y += 3) for (let x = 0; x <= 800; x += 3) {
    const h = b.hitTest(x, y);
    out.push(h ? h.label : '-');
  }
  return out;
}

function diff(a: string[], b: string[]): string[] {
  const d: string[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(`${i}: e2d=${a[i]} pixi=${b[i]}`);
  return d.slice(0, 30);
}

describe('UI-like hit test parity', () => {
  it('grid', () => {
    const a = grid(e2d); const b = grid(px);
    expect(diff(a, b)).toEqual([]);
  });
  it('grid with hidden npc / scroll offset / thumb inactive', () => {
    const m = (n: any, L: Lib) => { L.hide(n.npc); L.hide(n.thumb); n.content.y = -95; n.row3.interactiveChildren = false; };
    expect(diff(grid(e2d, m), grid(px, m))).toEqual([]);
  });
});

function seq(L: Lib): string[] {
  const { root, nodes } = build(L);
  const log: string[] = [];
  for (const [name, n] of Object.entries(nodes)) {
    for (const t of ['pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointerdown', 'pointerup', 'pointerupoutside', 'pointertap', 'click', 'globalpointermove']) {
      n.on(t, (e: any) => { if (t !== 'globalpointermove' || name === 'thumb') log.push(`${name}.${t}@${e.eventPhase}>${e.target?.label}:${e.global.x},${e.global.y}`); });
    }
  }
  const b = L.B(root);
  const fire = (type: string, x: number, y: number, buttons = 0) => {
    L.sync(root);
    const e = L.ev();
    e.nativeEvent = { type, clientX: x, clientY: y };
    e.pointerId = 1; e.width = 1; e.height = 1; e.isPrimary = true; e.pointerType = 'mouse';
    e.pressure = 0.5; e.tangentialPressure = 0; e.tiltX = 0; e.tiltY = 0; e.twist = 0; e.isTrusted = true;
    e.type = type; e.altKey = e.ctrlKey = e.metaKey = e.shiftKey = false; e.button = 0; e.buttons = buttons;
    e.client.set(x, y); e.movement.set(0, 0); e.page.set(x, y); e.screen.set(x, y); e.global.set(x, y); e.offset.set(x, y);
    b.mapEvent(e);
    log.push(`cursor=${b.cursor}`);
  };
  const pts: Array<[number, number]> = [[10, 10], [60, 60], [60, 100], [340, 100], [345, 80], [410, 60], [450, 200], [520, 215], [650, 400], [175, 425], [110, 360], [310, 360], [345, 375], [500, 470], [700, 590]];
  for (const [x, y] of pts) fire('pointermove', x, y);
  fire('pointerdown', 60, 100, 1); fire('pointermove', 60, 140, 1); fire('pointerup', 60, 140);
  fire('pointerdown', 345, 80, 1); fire('pointermove', 400, 300, 1); fire('pointerup', 400, 300);
  fire('pointerdown', 410, 60, 1); fire('pointerupoutside', 900, 900);
  L.hide(nodes.row1); fire('pointermove', 60, 60); L.show(nodes.row1); fire('pointermove', 61, 61);
  nodes.row0.removeFromParent(); fire('pointermove', 62, 62);
  fire('pointerout', 62, 62);
  return log;
}

describe('UI-like dispatch parity', () => {
  it('sequence', () => {
    const a = seq(e2d); const b = seq(px);
    expect(a).toEqual(b);
  });
});
describe('sanity', () => {
  it('non-trivial', () => {
    const a = seq(e2d); const g = grid(e2d);
    const labels = new Set(g);
    console.log('seqlen', a.length, 'labels', [...labels].join(','));
    console.log(a.filter((s) => !s.startsWith('cursor')).slice(0, 12).join('\n'));
  });
});
