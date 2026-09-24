import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { CanvasStage, CANVAS_ORDER_DEFAULT } from './CanvasStage';

/**
 * 画布那张有序 item 表。钉的是三条**违反即画面不对、且不报错**的性质:
 *
 * 1. 四个 kind 是四个命名空间 —— `hideOverlayImage` 永远收不到文档揭示
 *    (2026-09-12 制作人定调解耦;在画布里靠 kind 前缀落地)。
 * 2. `order` 写进 `zIndex`,同 order 保持登记先后 —— 这是"叠图 / 文档揭示从
 *    cutsceneOverlay 迁到画布后画面不变"的前提(迁移前顺序就是 addChild 先后)。
 * 3. `detach` / `clear` **只摘不销毁** —— 各类 item 的释放纪律归各自的所有者
 *    (叠图的 disposeGpu、实体的挂件与 lit mesh、粒子的网格池),收归这里就是第二份真相。
 */
describe('CanvasStage', () => {
  it('order 写进 zIndex，缺省走 CANVAS_ORDER_DEFAULT', () => {
    const stage = new CanvasStage();
    const a = new Container();
    const b = new Container();
    stage.attach('image', '告示', a, 30);
    stage.attach('entity', '关二狗', b);

    expect(a.zIndex).toBe(30);
    expect(b.zIndex).toBe(CANVAS_ORDER_DEFAULT);
    // 顺序全靠 zIndex：这一层一旦不可排序，order 就静默失效
    expect(stage.layer.sortableChildren).toBe(true);
  });

  it('四个 kind 是四个命名空间：同名互不寻址', () => {
    const stage = new CanvasStage();
    const overlay = new Container();
    const doc = new Container();
    // 作者的叠图句柄与 documentId 撞名 —— 现实里很容易发生（都叫「告示」）
    stage.attach('image', '告示', overlay, 10);
    stage.attach('document', '告示', doc, 20);

    expect(stage.has('image', '告示')).toBe(true);
    expect(stage.has('document', '告示')).toBe(true);

    // hideOverlayImage 那条路只摘 image 档，文档揭示必须原封不动
    stage.detach('image', '告示');
    expect(stage.has('image', '告示')).toBe(false);
    expect(stage.has('document', '告示')).toBe(true);
    expect(doc.parent).toBe(stage.layer);
  });

  it('setOrder 改得动在画布上的，改不动不在的（作者写错名字要能看见）', () => {
    const stage = new CanvasStage();
    const node = new Container();
    stage.attach('vfx', '香火烟', node, 5);

    expect(stage.setOrder('vfx', '香火烟', 99)).toBe(true);
    expect(node.zIndex).toBe(99);
    expect(stage.getOrder('vfx', '香火烟')).toBe(99);

    // 名字对但 kind 不对 = 另一个命名空间，改不到
    expect(stage.setOrder('entity', '香火烟', 1)).toBe(false);
    expect(stage.setOrder('vfx', '不存在', 1)).toBe(false);
  });

  it('list 按 order 升序；同 order 保持登记先后', () => {
    const stage = new CanvasStage();
    stage.attach('image', '底图', new Container(), 0);
    stage.attach('entity', '甲', new Container(), 0);   // 与底图同 order
    stage.attach('vfx', '烟', new Container(), -5);
    stage.attach('document', '告示', new Container(), 100);

    expect(stage.list().map((i) => i.key)).toEqual([
      'vfx:烟',          // -5
      'image:底图',      // 0，先登记
      'entity:甲',       // 0，后登记
      'document:告示',   // 100
    ]);
  });

  it('同键再 attach：旧 node 被摘下，新 node 上画布（旧的不销毁，归调用方）', () => {
    const stage = new CanvasStage();
    const oldNode = new Container();
    const newNode = new Container();
    stage.attach('image', '告示', oldNode, 1);
    stage.attach('image', '告示', newNode, 2);

    expect(oldNode.parent).toBeNull();
    expect(oldNode.destroyed).toBe(false);   // 只摘不销毁
    expect(stage.getNode('image', '告示')).toBe(newNode);
    expect(newNode.zIndex).toBe(2);
  });

  it('detach / clear 只摘不销毁', () => {
    const stage = new CanvasStage();
    const a = new Container();
    const b = new Container();
    stage.attach('entity', '甲', a);
    stage.attach('entity', '乙', b);

    const detached = stage.detach('entity', '甲');
    expect(detached).toBe(a);
    expect(a.destroyed).toBe(false);
    expect(a.parent).toBeNull();

    stage.clear();
    expect(b.destroyed).toBe(false);
    expect(b.parent).toBeNull();
    expect(stage.list()).toEqual([]);
  });

  it('relayout 逐个回调；某一个抛了不打断其余（屏幕尺寸变化每帧都可能来）', () => {
    const stage = new CanvasStage();
    const seen: string[] = [];
    stage.attach('entity', '炸的', new Container(), 0, () => { throw new Error('boom'); });
    stage.attach('entity', '好的', new Container(), 1, (w, h) => { seen.push(`${w}x${h}`); });

    expect(() => stage.relayout(1920, 1080)).not.toThrow();
    expect(seen).toEqual(['1920x1080']);
  });

  it('namesOf 只列该 kind 的作者名（换场景按类扫的路径靠它）', () => {
    const stage = new CanvasStage();
    stage.attach('entity', '甲', new Container());
    stage.attach('entity', '乙', new Container());
    stage.attach('vfx', '烟', new Container());

    expect(stage.namesOf('entity').sort()).toEqual(['乙', '甲']);
    expect(stage.namesOf('vfx')).toEqual(['烟']);
    expect(stage.namesOf('document')).toEqual([]);
  });
});
