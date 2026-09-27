import { beforeAll, describe, expect, it } from 'vitest';
import { EmoteBubbleManager, pinBubbleInsideView, type EmoteBubbleViewRect } from './EmoteBubbleManager';
import { Container } from '../engine2d';
import { makeFakeAdapter } from '../engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../engine2d/text/adapter';
import { Hotspot } from '../entities/Hotspot';
import type { IEmoteBubbleAnchor } from '../data/types';

// 跑马梁「有人喊」：镜头约 800×600 世界单位，路边身影在画面右外侧
const view = { minX: 333, minY: 552, maxX: 1133, maxY: 1152 };
const m = 600 * 0.02;

describe('pinOnScreen 气泡贴边', () => {
  it('人在画面里：气泡原地不动', () => {
    expect(pinBubbleInsideView(700, 800, 120, 30, view)).toEqual({ x: 700, y: 800 });
  });
  it('人在画面右外侧：气泡贴右边、高度不变', () => {
    const at = pinBubbleInsideView(1218, 580, 120, 30, view);
    expect(at).toEqual({ x: 1133 - m - 120, y: 580 });
  });
  it('人在画面左上外：两个方向都推回来', () => {
    expect(pinBubbleInsideView(100, 300, 120, 30, view)).toEqual({ x: 333 + m, y: 552 + m });
  });
  it('人在画面下方外：贴底边', () => {
    expect(pinBubbleInsideView(700, 1400, 120, 30, view)).toEqual({ x: 700, y: 1152 - m - 30 });
  });
  it('气泡比画面还宽：靠左上，不越出左边', () => {
    expect(pinBubbleInsideView(2000, 800, 900, 30, view).x).toBe(333 + m);
  });
});

// ---------------------------------------------------------------------------
// engine2d 分支：整条气泡管线（engine2d Container / Text / Graphics）上的贴边与显隐。
// 分支把 NPC / 热点的"在不在场"从 `visible` 改到了节点激活（activeSelf / setActive）：
// 贴边只管位置，人被藏（setActive(false)）时气泡照旧不显示——两件事互不干扰。
// ---------------------------------------------------------------------------

beforeAll(() => {
  setTextDOMAdapter(makeFakeAdapter() as unknown as TextDOMAdapter);
});

const HEAD_Y = -60;

function rig(viewRef: { v: EmoteBubbleViewRect | null }) {
  const layer = new Container();
  layer.sortableChildren = true;
  const entity = new Container();
  layer.addChild(entity);
  const anchor: IEmoteBubbleAnchor = {
    getDisplayObject: () => entity,
    getEmoteBubbleAnchorLocalY: () => HEAD_Y,
  };
  const mgr = new EmoteBubbleManager();
  mgr.setEntityAttachLayer(layer);
  mgr.setViewRectProvider(() => viewRef.v);
  const bubbleOf = () => layer.children.find((c) => c !== entity) as Container | undefined;
  return { layer, entity, anchor, mgr, bubbleOf };
}

/** 同一句话、不贴边时的挂载位（= home）与外框：跟随泡 bx = 脚点 x − bw/2，by = 脚点 y + 头顶锚 − bh */
function homeOf(text: string, x: number, y: number) {
  const r = rig({ v: null });
  r.entity.x = x;
  r.entity.y = y;
  r.mgr.show(r.anchor, text, 2000);
  const b = r.bubbleOf()!;
  const out = { x: b.x, y: b.y, bw: 2 * (x - b.x), bh: y + HEAD_Y - b.y };
  r.mgr.destroy();
  return out;
}

describe('pinOnScreen 在 engine2d 实体层上（跟随泡）', () => {
  it('挂载当帧就贴边；镜头走回来气泡回到头顶；没开 pinOnScreen 的不动', () => {
    const viewRef: { v: EmoteBubbleViewRect | null } = { v: view };
    const r = rig(viewRef);
    r.entity.x = 1218;
    r.entity.y = 640;
    const home = homeOf('有人喊', 1218, 640);
    expect(home.bw).toBeGreaterThan(0);
    expect(home.bh).toBeGreaterThan(0);

    r.mgr.show(r.anchor, '有人喊', 2000, { pinOnScreen: true });
    const b = r.bubbleOf()!;
    const want = pinBubbleInsideView(home.x, home.y, home.bw, home.bh, view);
    expect(want.x).toBeLessThan(home.x - 1); // 场面确实需要贴边（不是空测）
    expect(b.x).toBeCloseTo(want.x, 6);
    expect(b.y).toBeCloseTo(want.y, 6);
    expect(b.x + home.bw).toBeLessThanOrEqual(view.maxX - m + 1e-6);

    // 每帧：跟随重摆后再推（人还在画面外 ⇒ 仍贴边）
    r.mgr.update(1 / 60);
    expect(b.x).toBeCloseTo(want.x, 6);

    // 镜头挪过去把人框进来：气泡回到头顶的跟随位
    viewRef.v = { minX: 900, minY: 300, maxX: 1700, maxY: 900 };
    r.mgr.update(1 / 60);
    expect(b.x).toBeCloseTo(home.x, 6);
    expect(b.y).toBeCloseTo(home.y, 6);

    // 同一场面不开 pinOnScreen：气泡照旧在画面外
    const r2 = rig({ v: view });
    r2.entity.x = 1218;
    r2.entity.y = 640;
    r2.mgr.show(r2.anchor, '有人喊', 2000);
    r2.mgr.update(1 / 60);
    expect(r2.bubbleOf()!.x).toBeCloseTo(home.x, 6);
    r.mgr.destroy();
    r2.mgr.destroy();
  });

  it('贴边不管显隐：人按分支的在场开关（setActive(false)）被藏，贴着边的气泡也不画；人回来话跟着回来', () => {
    const r = rig({ v: view });
    r.entity.x = 1218;
    r.entity.y = 640;
    const home = homeOf('有人喊', 1218, 640);
    const want = pinBubbleInsideView(home.x, home.y, home.bw, home.bh, view);
    r.mgr.show(r.anchor, '有人喊', 2000, { pinOnScreen: true });
    const b = r.bubbleOf()!;
    r.mgr.update(1 / 60);
    expect(b.visible).toBe(true);
    r.entity.setActive(false);
    r.mgr.update(1 / 60);
    expect(b.visible).toBe(false);
    // 位置仍是贴边位（只管位置，这条不因藏人而改）
    expect(b.x).toBeCloseTo(want.x, 6);
    expect(b.y).toBeCloseTo(want.y, 6);
    r.entity.setActive(true);
    r.mgr.update(1 / 60);
    expect(b.visible).toBe(true);
    r.mgr.destroy();
  });

  it('没注入可见矩形（provider 返回 null / 销毁后）：贴边不生效，不报错', () => {
    const r = rig({ v: null });
    r.entity.x = 1218;
    r.entity.y = 640;
    const home = homeOf('有人喊', 1218, 640);
    r.mgr.show(r.anchor, '有人喊', 2000, { pinOnScreen: true });
    r.mgr.update(1 / 60);
    expect(r.bubbleOf()!.x).toBeCloseTo(home.x, 6);
    r.mgr.destroy();
  });
});

describe('pinOnScreen 在 engine2d 实体层上（热点静止泡）', () => {
  /** 热点桩：走 `instanceof Hotspot` 那条"挂载时定位一次"的分支 */
  function hotspotRig(viewRef: { v: EmoteBubbleViewRect | null }) {
    const layer = new Container();
    const hc = new Container();
    layer.addChild(hc);
    const quad = { left: 1200, top: 560, width: 40, height: 80 };
    const hs = Object.assign(Object.create(Hotspot.prototype) as Hotspot, {
      getDisplayObject: () => hc,
      getEmoteBubbleAnchorLocalY: () => -88,
      getEmoteWorldQuad: () => quad,
    });
    const mgr = new EmoteBubbleManager();
    mgr.setEntityAttachLayer(layer);
    mgr.setViewRectProvider(() => viewRef.v);
    const bubbleOf = () => layer.children.find((c) => c !== hc) as Container | undefined;
    return { layer, hc, hs, mgr, bubbleOf, quad };
  }

  it('每帧先回挂载位再推：镜头走回来回到原处；退场下沉那 120ms 不再推', () => {
    const viewRef: { v: EmoteBubbleViewRect | null } = { v: null };
    const probe = hotspotRig(viewRef);
    probe.mgr.show(probe.hs, '有人喊', 2000);
    const homeB = probe.bubbleOf()!;
    const home = { x: homeB.x, y: homeB.y };
    probe.mgr.destroy();

    const r = hotspotRig(viewRef);
    viewRef.v = view;
    r.mgr.show(r.hs, '有人喊', 100, { pinOnScreen: true });
    const b = r.bubbleOf()!;
    expect(b.x).toBeLessThan(home.x);
    const pinnedX = b.x;
    r.mgr.update(1 / 60);
    expect(b.x).toBeCloseTo(pinnedX, 6);

    viewRef.v = { minX: 900, minY: 300, maxX: 1700, maxY: 900 };
    r.mgr.update(1 / 60);
    expect(b.x).toBeCloseTo(home.x, 6);
    expect(b.y).toBeCloseTo(home.y, 6);

    // 倒计时到 → 进退场；退场期间镜头再走开也不推（y 归退场下沉管）
    r.mgr.update(0.2);
    viewRef.v = view;
    r.mgr.update(1 / 60);
    expect(b.x).toBeCloseTo(home.x, 6);
    r.mgr.destroy();
  });
});
