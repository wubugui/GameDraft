import { describe, expect, it } from 'vitest';
import { createElement, createState } from '../editorModel';
import type { NarrativeCompositionDef, NarrativeGraphDef, NarrativeGraphsFileDef } from '../types';
import { SUBGRAPH_CHILD_ORIGIN, computeSubgraphGroupBounds } from './subgraphGroupLayout';
import {
  ELEMENT_NODE_LAYOUT_HEIGHT,
  ELEMENT_NODE_LAYOUT_WIDTH,
  STATE_NODE_LAYOUT_HEIGHT,
  STATE_NODE_LAYOUT_WIDTH,
} from './transitionAnchorLayout';
import {
  centerNodeAt,
  nudgeAwayFromOccupied,
  placeElement,
  placeInlineSubgraphState,
  placeTopLevelState,
  viewportCenterInFlow,
} from './viewportPlacement';

function graphWith(states: Record<string, { x: number; y: number }>): NarrativeGraphDef {
  return {
    id: 'g',
    ownerType: 'flow',
    initialState: Object.keys(states)[0] ?? '',
    states: Object.fromEntries(
      Object.entries(states).map(([id, pos]) => [id, { id, meta: { editor: { ...pos } } }]),
    ),
    transitions: [],
  } as NarrativeGraphDef;
}

describe('viewportCenterInFlow', () => {
  it('未平移未缩放时中心就是容器一半', () => {
    expect(viewportCenterInFlow(800, 600, [0, 0, 1])).toEqual({ x: 400, y: 300 });
  });

  it('按 screen = flow*zoom + t 反解（平移 + 缩放）', () => {
    // 屏幕 (400,300) = flow*2 + (-100, 50) → flow = (250, 125)
    expect(viewportCenterInFlow(800, 600, [-100, 50, 2])).toEqual({ x: 250, y: 125 });
  });

  it('容器尚未测量或 zoom 非法 → null（调用方回退默认落点）', () => {
    expect(viewportCenterInFlow(0, 600, [0, 0, 1])).toBeNull();
    expect(viewportCenterInFlow(800, 0, [0, 0, 1])).toBeNull();
    expect(viewportCenterInFlow(800, 600, [0, 0, 0])).toBeNull();
  });
});

describe('centerNodeAt / nudgeAwayFromOccupied', () => {
  it('节点几何中心对准 center', () => {
    expect(centerNodeAt({ x: 100, y: 100 }, { width: 50, height: 20 })).toEqual({ x: 75, y: 90 });
  });

  it('与已占位置完全重合时阶梯错开，直到空位', () => {
    const occupied = [{ x: 10, y: 10 }, { x: 34, y: 34 }];
    expect(nudgeAwayFromOccupied({ x: 10, y: 10 }, occupied)).toEqual({ x: 58, y: 58 });
    expect(nudgeAwayFromOccupied({ x: 11, y: 10 }, occupied)).toEqual({ x: 11, y: 10 });
  });
});

describe('placeTopLevelState', () => {
  it('顶层状态：flow 坐标直接写 meta.editor，且以节点中心对准视口中心', () => {
    const graph = graphWith({});
    const center = { x: 1000, y: 500 };
    const placement = placeTopLevelState(center, graph);
    expect(placement).toEqual({
      x: 1000 - STATE_NODE_LAYOUT_WIDTH / 2,
      y: 500 - STATE_NODE_LAYOUT_HEIGHT / 2,
    });
    const id = createState(graph, undefined, placement);
    expect(graph.states[id].meta?.editor).toEqual(placement);
  });

  it('视口中心正好压在已有状态上 → 错开而不是盖住', () => {
    const base = { x: 1000 - STATE_NODE_LAYOUT_WIDTH / 2, y: 500 - STATE_NODE_LAYOUT_HEIGHT / 2 };
    const graph = graphWith({ a: base });
    expect(placeTopLevelState({ x: 1000, y: 500 }, graph)).toEqual({ x: base.x + 24, y: base.y + 24 });
  });
});

describe('placeInlineSubgraphState', () => {
  it('展开子图内：去掉 element 原点与 SUBGRAPH_CHILD_ORIGIN（与拖拽写回互逆）', () => {
    const element = { x: 300, y: 200 };
    const graph = graphWith({});
    const center = { x: 900, y: 700 };
    const placement = placeInlineSubgraphState(center, element, graph);
    expect(placement).toEqual({
      x: 900 - STATE_NODE_LAYOUT_WIDTH / 2 - 300 - SUBGRAPH_CHILD_ORIGIN.x,
      y: 700 - STATE_NODE_LAYOUT_HEIGHT / 2 - 200 - SUBGRAPH_CHILD_ORIGIN.y,
    });
    // 反向：父相对 node.position = ORIGIN + meta.editor，加上 element 原点回到 flow 左上角
    expect(placement.x + SUBGRAPH_CHILD_ORIGIN.x + element.x).toBe(900 - STATE_NODE_LAYOUT_WIDTH / 2);
    expect(placement.y + SUBGRAPH_CHILD_ORIGIN.y + element.y).toBe(700 - STATE_NODE_LAYOUT_HEIGHT / 2);
  });

  it('视口中心落在分组框左上外侧 → 钳到框内原点，不产生负的父相对坐标', () => {
    const placement = placeInlineSubgraphState({ x: 0, y: 0 }, { x: 2000, y: 2000 }, graphWith({}));
    expect(placement).toEqual({ x: 0, y: 0 });
  });
});

describe('placeElement + createElement', () => {
  it('黑盒元素（折叠节点）按折叠尺寸居中', () => {
    const comp: NarrativeCompositionDef = {
      id: 'c',
      mainGraph: graphWith({ initial: { x: 120, y: 160 } }),
      elements: [],
    } as NarrativeCompositionDef;
    const data = { compositions: [comp] } as NarrativeGraphsFileDef;
    const el = createElement(comp, 'dialogueBlackbox', data);
    const placement = placeElement({ x: 640, y: 360 }, el, [], false);
    expect(placement).toEqual({
      x: 640 - ELEMENT_NODE_LAYOUT_WIDTH / 2,
      y: 360 - ELEMENT_NODE_LAYOUT_HEIGHT / 2,
    });
  });

  it('创建即展开的 wrapper 按展开后的分组框尺寸居中，子图内部状态坐标不受影响', () => {
    const comp: NarrativeCompositionDef = {
      id: 'c',
      mainGraph: graphWith({ initial: { x: 120, y: 160 } }),
      elements: [],
    } as NarrativeCompositionDef;
    const data = { compositions: [comp] } as NarrativeGraphsFileDef;
    const el = createElement(comp, 'wrapperGraph', data);
    const bounds = computeSubgraphGroupBounds(el.graph!);
    expect(bounds.width).toBeGreaterThan(ELEMENT_NODE_LAYOUT_WIDTH);
    const placement = placeElement({ x: 640, y: 360 }, el, [], true);
    expect(placement).toEqual({
      x: Math.round(640 - bounds.width / 2),
      y: Math.round(360 - bounds.height / 2),
    });
    expect(el.graph?.states.initial.meta?.editor).toEqual({ x: 120, y: 160 });
  });

  it('错开只看其余元素，不把自己算成"已占"', () => {
    const comp: NarrativeCompositionDef = {
      id: 'c',
      mainGraph: graphWith({}),
      elements: [],
    } as NarrativeCompositionDef;
    const a = createElement(comp, 'zoneBlackbox');
    a.x = 640 - ELEMENT_NODE_LAYOUT_WIDTH / 2;
    a.y = 360 - ELEMENT_NODE_LAYOUT_HEIGHT / 2;
    const b = createElement(comp, 'zoneBlackbox');
    const others = comp.elements!.filter((e) => e.id !== b.id);
    expect(placeElement({ x: 640, y: 360 }, b, others, false)).toEqual({ x: a.x + 24, y: a.y + 24 });
  });

  it('不传落点时保持原默认坐标（无画布上下文的调用不受影响）', () => {
    const comp: NarrativeCompositionDef = {
      id: 'c',
      mainGraph: graphWith({ initial: { x: 120, y: 160 } }),
      elements: [],
    } as NarrativeCompositionDef;
    const el = createElement(comp, 'wrapperGraph');
    expect({ x: el.x, y: el.y }).toEqual({ x: 320, y: 380 });
    const sid = createState(comp.mainGraph);
    expect(comp.mainGraph.states[sid].meta?.editor).toEqual({ x: 120, y: 260 });
  });
});
