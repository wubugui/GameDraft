/** Render-group history parity; Pixi's real transform system is the reference (no GPU). */
import * as PIXI from 'pixi.js';
import { afterEach, describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Matrix } from '../math/Matrix';
import { Rectangle } from '../math/Rectangle';
import { Container, renderedWorldTransform } from '../scene/Container';
import { WebGPURenderer } from '../gpu/WebGPURenderer';
import { prepareDetached } from '../gpu/collect';
import { Culler } from './Culler';

type Pair = [PIXI.Container, Container];
const view = new Rectangle(40, -20, 30, 50);
const renderers: WebGPURenderer[] = [];
afterEach(() => { for (const renderer of renderers.splice(0)) renderer.destroy(); });

function pair(x = 0, group = false): Pair {
  return [new PIXI.Container({ x, isRenderGroup: group }), new Container({ x, isRenderGroup: group })];
}
function add(parent: Pair, child: Pair): Pair {
  parent[0].addChild(child[0]);
  parent[1].addChild(child[1]);
  return child;
}
function mark(node: Pair, area: boolean): Pair {
  for (const c of node) c.cullable = true;
  if (area) {
    node[0].cullArea = new PIXI.Rectangle(0, 0, 10, 10);
    node[1].cullArea = new Rectangle(0, 0, 10, 10);
  } else {
    node[0].boundsArea = new PIXI.Rectangle(0, 0, 10, 10);
    node[1].boundsArea = new Rectangle(0, 0, 10, 10);
  }
  return node;
}
function setup() {
  const renderer = new WebGPURenderer({
    rhi: new NullRhiDevice(),
    canvas: { width: 64, height: 64, style: {} } as HTMLCanvasElement,
    width: 64, height: 64,
  });
  renderers.push(renderer);
  return (node: Pair, transform?: Matrix) => {
    const p = node[0];
    // AbstractRenderer enables the root group. RenderGroupSystem temporarily detaches it,
    // substitutes options.transform, updates all groups, then restores parent/local state.
    p.updateLocalTransform();
    p.enableRenderGroup();
    const parent = p.parent;
    const groupParent = p.renderGroup!.renderGroupParent;
    const local = p.localTransform.clone();
    p.parent = null;
    p.renderGroup!.renderGroupParent = null!;
    if (transform) p.localTransform.copyFrom(transform);
    PIXI.updateRenderGroupTransforms(p.renderGroup!, true);
    p.localTransform.copyFrom(local);
    p.parent = parent;
    p.renderGroup!.renderGroupParent = groupParent;
    renderer.render({ container: node[1], transform });
  };
}
function check(node: Pair, x: number, culled: boolean): void {
  expect(node[0].worldTransform.tx).toBe(x);
  expect(renderedWorldTransform(node[1], new Matrix()).tx).toBe(x);
  PIXI.Culler.shared.cull(node[0], view);
  Culler.shared.cull(node[1], view);
  expect([node[0].culled, node[1].culled]).toEqual([culled, culled]);
}

describe.each([true, false])('Culler render-group history (cullArea=%s)', (area) => {
  it('retains the group created by rendering an attached subtree', () => {
    const render = setup();
    const stage = pair(1000);
    const child = add(stage, mark(pair(50), area));
    render(stage);
    check(child, 1050, true);
    render(child);
    expect(child[1].parent).toBe(stage[1]);
    check(child, 50, false);
    // Current worldTransform and skip=false keep following the actual parent chain.
    expect(child[1].worldTransform.tx).toBe(1050);
    Culler.shared.cull(child[1], view, false);
    expect(child[1].culled).toBe(true);
    render(child, new Matrix(1, 0, 0, 1, 1000, 0));
    check(child, 1000, true);
    stage[0].x = stage[1].x = 0;
    render(stage);
    check(child, 50, false);
  });

  it('new nodes use identity relative to their nearest nested group', () => {
    const render = setup();
    const stage = pair(1000);
    const group = add(stage, pair(-950, true));
    const layer = add(group, pair(600));
    render(stage);
    const child = add(layer, mark(pair(300), area));
    check(child, 50, false);
    render(stage);
    check(child, 950, true);
  });

  it('records the explicit render transform, then restores ordinary rendering', () => {
    const render = setup();
    const root = mark(pair(50), area);
    const child = add(root, mark(pair(5), area));
    const transform = new Matrix(1, 0, 0, 1, 1000, 0);
    render(root, transform);
    transform.tx = 0;
    check(root, 1000, true);
    check(child, 1005, true);
    expect(root[1].worldTransform.tx).toBe(50);
    render(root);
    check(root, 50, false);
    check(child, 55, false);
  });

  it('updates hidden subtrees and nested groups before they are shown again', () => {
    const render = setup();
    const stage = pair(1000);
    const hidden = add(stage, pair(200));
    const group = add(hidden, pair(-1150, true));
    const child = add(group, mark(pair(), area));
    render(stage);
    hidden[0].visible = false;
    hidden[1].setActive(false);
    group[0].x = group[1].x = -250;
    render(stage);
    hidden[0].visible = true;
    hidden[1].setActive(true);
    group[0].x = group[1].x = -1150;
    check(child, 950, true);
    render(stage);
    check(child, 50, false);
  });

  it('prepareDetached does not overwrite history for external masks or their children', () => {
    const render = setup();
    const stage = pair(1000);
    const subtree = add(stage, pair(400));
    const mask = add(stage, mark(pair(-950), area));
    const maskChild = add(mask, mark(pair(), area));
    render(stage);
    check(mask, 50, false);
    check(maskChild, 50, false);
    render(subtree);
    prepareDetached(mask[1], subtree[1], Container._nextRenderTick());
    check(mask, 50, false);
    check(maskChild, 50, false);
  });

  it('reparenting keeps relative history until the new group renders', () => {
    const render = setup();
    const stage = pair(1000);
    const a = add(stage, pair(-950, true));
    const b = add(stage, pair(0, true));
    const branch = add(a, pair(0));
    const child = add(branch, mark(pair(5), area));
    render(stage);
    check(child, 55, false);
    add(b, branch);
    check(child, 1005, true);
    branch[0].x = branch[1].x = -950;
    render(stage);
    check(child, 55, false);
    // A detached ordinary node retains its last queried world value, just like Pixi.
    branch[0].removeFromParent();
    branch[1].removeFromParent();
    check(child, 55, false);
    add(a, branch);
    check(child, -895, true);
  });

  it('enabling/disabling nested groups changes the history boundary', () => {
    const render = setup();
    const stage = pair(1000);
    const group = add(stage, pair(-950));
    const child = add(group, mark(pair(), area));
    render(stage);
    check(child, 50, false);
    for (const c of group) c.enableRenderGroup();
    render(stage);
    check(child, 50, false);
    for (const c of group) c.disableRenderGroup();
    check(child, 1000, true);
    render(stage);
    check(child, 50, false);
  });

  it('composes rotated/scaled group history without changing drawing transforms', () => {
    const render = setup();
    const stage = pair(1000);
    const group = add(stage, pair(-950, true));
    const child = add(group, mark(pair(5), area));
    for (const c of stage) { c.rotation = 0.3; c.scale.set(1.2, 0.8); }
    for (const c of group) { c.rotation = -0.7; c.scale.set(0.6, 1.4); }
    const transform = new Matrix(0.8, 0.3, -0.2, 1.1, 50, 0);
    const values = (m: Matrix | PIXI.Matrix) => [m.a, m.b, m.c, m.d, m.tx, m.ty];
    for (const root of [stage, group, stage]) {
      render(root, root === group ? transform : undefined);
      expect(values(renderedWorldTransform(child[1], new Matrix()))).toEqual(values(child[0].worldTransform));
      // The collector still uses transforms relative to this render's root, flattening groups.
      const expectedDrawing = root === group
        ? child[1].localTransform
        : new Matrix().appendFrom(child[1].localTransform, group[1].localTransform);
      expect(values(child[1].groupTransform)).toEqual(values(expectedDrawing));
      PIXI.Culler.shared.cull(child[0], view);
      Culler.shared.cull(child[1], view);
      expect(child[1].culled).toBe(child[0].culled);
    }
  });

  it('destroying a group releases its history and leaves detached children usable', () => {
    const render = setup();
    const stage = pair(1000);
    const group = add(stage, pair(-950, true));
    const child = add(group, mark(pair(5), area));
    render(stage);
    check(child, 55, false);
    group[0].destroy();
    group[1].destroy();
    expect(group[1]._renderedGroupWorldTransform).toBeNull();
    expect(group[1]._renderedRelativeTransform).toBeNull();
    expect(group[1]._renderedWorldTransform).toBeNull();
    expect(child[1].parent).toBeNull();
    check(child, 55, false);
    add(stage, child);
    check(child, 1005, true);
  });
});
