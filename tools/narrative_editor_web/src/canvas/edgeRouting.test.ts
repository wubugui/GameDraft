import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import {
  PARALLEL_EDGE_SPACING,
  applyEdgeRouting,
  chooseRouteSides,
  computeEdgeRoutes,
  computeParallelOffsets,
  nodeTypeHasFourWayPorts,
  routedEdgePath,
  routedLabelPoint,
  sidePoint,
  type RoutingNodeRect,
} from './edgeRouting';

function rect(x: number, y: number, fourWay = true): RoutingNodeRect {
  return { x, y, width: 150, height: 58, fourWay };
}

/** 渲染期实际位移：把 label 点减去「零错开时的 label 点」，得到垂直方向的偏移向量。 */
function labelShift(source: RoutingNodeRect, target: RoutingNodeRect, offset: number) {
  const base = routedLabelPoint(source, target, {
    ...chooseRouteSides(source, target, false),
    offset: 0,
    selfLoop: false,
  });
  const moved = routedLabelPoint(source, target, {
    ...chooseRouteSides(source, target, false),
    offset,
    selfLoop: false,
  });
  return { x: moved.x - base.x, y: moved.y - base.y };
}

describe('chooseRouteSides', () => {
  it('回连边从左侧出、右侧进，不再绕过节点本体', () => {
    const right = rect(600, 200);
    const left = rect(100, 200);
    expect(chooseRouteSides(left, right, false)).toEqual({ sourceSide: 'r', targetSide: 'l' });
    // B→A（A 在左）：改造前只能从 B 的右口甩出去绕回 A 的左口
    expect(chooseRouteSides(right, left, false)).toEqual({ sourceSide: 'l', targetSide: 'r' });
  });

  it('纵向明显时改走上下口', () => {
    expect(chooseRouteSides(rect(100, 100), rect(120, 600), false)).toEqual({ sourceSide: 'b', targetSide: 't' });
    expect(chooseRouteSides(rect(120, 600), rect(100, 100), false)).toEqual({ sourceSide: 't', targetSide: 'b' });
  });

  it('横向为主时保持左右口（既有横排图观感不变）', () => {
    // |dy|=80 未超过 |dx|=300 的 1.5 倍 → 仍走左右
    expect(chooseRouteSides(rect(0, 0), rect(300, 80), false)).toEqual({ sourceSide: 'r', targetSide: 'l' });
  });

  it('非四向端口的节点强制回落到右出左进', () => {
    // 出边节点非四向：本该按几何走左口，回落成右口
    expect(chooseRouteSides(rect(600, 200, false), rect(100, 200), false)).toEqual({ sourceSide: 'r', targetSide: 'r' });
    // 入边节点非四向：本该按几何走右口，回落成左口
    expect(chooseRouteSides(rect(600, 200), rect(100, 200, false), false)).toEqual({ sourceSide: 'l', targetSide: 'l' });
  });

  it('自环上出右进，不跨过节点本体', () => {
    expect(chooseRouteSides(rect(0, 0), rect(0, 0), true)).toEqual({ sourceSide: 't', targetSide: 'r' });
  });
});

describe('computeParallelOffsets', () => {
  it('单条边零错开（走原生贝塞尔，逐点与改造前一致）', () => {
    const offsets = computeParallelOffsets([{ id: 'e1', source: 'a', target: 'b' }]);
    expect(offsets.get('e1')).toBe(0);
  });

  it('双向对的实际位移落在轴线两侧（本模块最容易写反的一处）', () => {
    const offsets = computeParallelOffsets([
      { id: 'e_ab', source: 'a', target: 'b' },
      { id: 'e_ba', source: 'b', target: 'a' },
    ]);
    const a = rect(100, 200);
    const b = rect(600, 200);
    const shiftAB = labelShift(a, b, offsets.get('e_ab') ?? 0);
    const shiftBA = labelShift(b, a, offsets.get('e_ba') ?? 0);
    // 两条边都偏离轴线
    expect(Math.abs(shiftAB.y)).toBeGreaterThan(1);
    expect(Math.abs(shiftBA.y)).toBeGreaterThan(1);
    // 且方向相反 —— 若 offset 忘了按规范方向取反，这里会同号（叠回同一侧）
    expect(Math.sign(shiftAB.y)).toBe(-Math.sign(shiftBA.y));
  });

  it('同向多条边对称分开', () => {
    const offsets = computeParallelOffsets([
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e1', source: 'a', target: 'b' },
    ]);
    expect(offsets.get('e1')).toBe(-PARALLEL_EDGE_SPACING / 2);
    expect(offsets.get('e2')).toBe(PARALLEL_EDGE_SPACING / 2);
  });

  it('分组只看端点对，与边的种类无关（迁移边与状态命令边同样分开）', () => {
    const offsets = computeParallelOffsets([
      { id: 'cmd', source: 'a', target: 'b' },
      { id: 'trans', source: 'a', target: 'b' },
      { id: 'other', source: 'a', target: 'c' },
    ]);
    expect(offsets.get('cmd')).not.toBe(offsets.get('trans'));
    expect(offsets.get('other')).toBe(0);
  });

  it('排序只认边 id，与输入顺序无关（同一张图每次重建结果稳定）', () => {
    const one = computeParallelOffsets([
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'a', target: 'b' },
    ]);
    const two = computeParallelOffsets([
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e1', source: 'a', target: 'b' },
    ]);
    expect(one.get('e1')).toBe(two.get('e1'));
    expect(one.get('e2')).toBe(two.get('e2'));
  });
});

describe('routedEdgePath', () => {
  const base = {
    sourceX: 250,
    sourceY: 229,
    targetX: 600,
    targetY: 229,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  };

  it('零错开直接委托原生贝塞尔（观感零回归）', () => {
    const [path, labelX, labelY] = routedEdgePath(base);
    expect(path.startsWith('M250,229')).toBe(true);
    expect(labelX).toBeCloseTo(425, 0);
    expect(labelY).toBeCloseTo(229, 0);
  });

  it('错开量把曲线整体推到一侧，端点仍精确落在端口上', () => {
    const [path, , labelY] = routedEdgePath({ ...base, offset: 28 });
    expect(path.startsWith('M250,229')).toBe(true);
    expect(path.endsWith('600,229')).toBe(true);
    expect(labelY).toBeCloseTo(229 + 28, 0);
  });

  it('同一状态上的多条自环半径不同，不叠成一条', () => {
    const loop = (offset: number) => routedEdgePath({
      sourceX: 175, sourceY: 200, sourcePosition: Position.Top,
      targetX: 250, targetY: 229, targetPosition: Position.Right,
      offset, selfLoop: true,
    })[0];
    // 自环的垂线退化，错开量必须吃进半径；否则 ±offset 取绝对值后两条环完全重合
    expect(loop(-PARALLEL_EDGE_SPACING / 2)).not.toBe(loop(PARALLEL_EDGE_SPACING / 2));
  });

  it('自环给出两端不同的可见环路', () => {
    const [path, labelX, labelY] = routedEdgePath({
      sourceX: 175,
      sourceY: 200,
      sourcePosition: Position.Top,
      targetX: 250,
      targetY: 229,
      targetPosition: Position.Right,
      selfLoop: true,
    });
    expect(path.startsWith('M175,200')).toBe(true);
    // 环路必须甩到节点右上方之外，否则会缩成一团盖在节点上
    expect(labelY).toBeLessThan(200);
    expect(labelX).toBeGreaterThan(250);
  });
});

describe('applyEdgeRouting', () => {
  const rects = new Map<string, RoutingNodeRect>([
    ['a', rect(100, 200)],
    ['b', rect(600, 200)],
    ['frame', rect(1200, 200, false)],
  ]);
  const rectOf = (id: string) => rects.get(id) ?? null;

  it('四向端点写 handle id，非四向端点留空走兜底端口', () => {
    const [toFrame] = applyEdgeRouting([{ id: 'e', source: 'a', target: 'frame' }], rectOf);
    expect(toFrame.sourceHandle).toBe('r');
    // frame 上没有 'l' 这个 id 的端口，写了会 error008 整条边不渲染
    expect(toFrame.targetHandle).toBeUndefined();
  });

  it('端点节点缺失时原样返回，不写任何 handle', () => {
    const [orphan] = applyEdgeRouting([{ id: 'e', source: 'a', target: 'ghost' }], rectOf);
    expect(orphan.sourceHandle).toBeUndefined();
    expect(orphan.targetHandle).toBeUndefined();
  });

  it('保留既有 data 字段并挂上路由', () => {
    const [edge] = applyEdgeRouting(
      [{ id: 'e', source: 'b', target: 'a', data: { edgeKind: 'transition', label: 'sig' } }],
      rectOf,
    );
    expect(edge.sourceHandle).toBe('l');
    expect(edge.targetHandle).toBe('r');
    expect((edge.data as { label?: string }).label).toBe('sig');
    expect((edge.data as { route?: { offset: number } }).route?.offset).toBe(0);
  });
});

describe('computeEdgeRoutes / sidePoint', () => {
  it('端口锚点取各边中点', () => {
    const r = rect(100, 200);
    expect(sidePoint(r, 'r')).toEqual({ x: 250, y: 229 });
    expect(sidePoint(r, 'l')).toEqual({ x: 100, y: 229 });
    expect(sidePoint(r, 't')).toEqual({ x: 175, y: 200 });
    expect(sidePoint(r, 'b')).toEqual({ x: 175, y: 258 });
  });

  it('自环被标记出来，交给渲染画环路', () => {
    const routes = computeEdgeRoutes([{ id: 'loop', source: 'a', target: 'a' }], () => rect(0, 0));
    expect(routes.get('loop')?.selfLoop).toBe(true);
  });
});

describe('nodeTypeHasFourWayPorts', () => {
  it('只有渲染了四向端口的节点类型才允许写 handle id', () => {
    expect(nodeTypeHasFourWayPorts('state')).toBe(true);
    expect(nodeTypeHasFourWayPorts('wrapperGraph')).toBe(true);
    // 这三类的端口被 CSS 钉死在 top:50%（分组框/子图框）或本体只有 24px（触发点）
    expect(nodeTypeHasFourWayPorts('subgraphGroup')).toBe(false);
    expect(nodeTypeHasFourWayPorts('editorGroupFrame')).toBe(false);
    expect(nodeTypeHasFourWayPorts('transitionAnchor')).toBe(false);
    expect(nodeTypeHasFourWayPorts(undefined)).toBe(false);
  });
});
