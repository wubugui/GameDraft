import { describe, expect, it } from 'vitest';

import {
  UNCATEGORIZED_LABEL,
  distinctCompositionCategories,
  distinctSubgraphCategories,
  getCompositionCategory,
  getSubgraphCategory,
  groupCompositions,
  groupSubgraphElements,
  normalizeCategoriesFile,
  pruneOrphans,
  setCompositionCategory,
  setSubgraphCategory,
} from './categories';
import type {
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeGraphsFileDef,
} from '../types';

function comp(id: string): NarrativeCompositionDef {
  return { id, mainGraph: { id: `${id}_main`, ownerType: 'main', initialState: 's', states: {}, transitions: [] } };
}
function subgraph(id: string): CompositionElementDef {
  return { id, kind: 'wrapperGraph', graph: { id: `${id}_g`, ownerType: 'npc', initialState: 's', states: {}, transitions: [] } };
}

describe('normalizeCategoriesFile', () => {
  it('coerces shape, strips values, drops empties and empty inner dicts', () => {
    const out = normalizeCategoriesFile({
      compositions: { a: '  主线 ', b: '', c: 42 },
      subgraphs: { comp1: { e1: ' NPC ', e2: '' }, comp2: {}, '': { e: 'x' } },
    });
    expect(out).toEqual({
      schemaVersion: 1,
      compositions: { a: '主线' },
      subgraphs: { comp1: { e1: 'NPC' } },
    });
  });

  it('returns empty registry for garbage input', () => {
    expect(normalizeCategoriesFile(null)).toEqual({ schemaVersion: 1, compositions: {}, subgraphs: {} });
    expect(normalizeCategoriesFile('nope')).toEqual({ schemaVersion: 1, compositions: {}, subgraphs: {} });
  });
});

describe('get/set (immutable)', () => {
  it('sets and clears composition category without mutating input', () => {
    const base = normalizeCategoriesFile(null);
    const withCat = setCompositionCategory(base, 'a', '主线');
    expect(getCompositionCategory(withCat, 'a')).toBe('主线');
    expect(getCompositionCategory(base, 'a')).toBe(''); // 原对象不变
    const cleared = setCompositionCategory(withCat, 'a', '   ');
    expect(getCompositionCategory(cleared, 'a')).toBe('');
    expect(cleared.compositions).toEqual({});
  });

  it('sets and clears subgraph category, dropping empty inner dict', () => {
    let file = normalizeCategoriesFile(null);
    file = setSubgraphCategory(file, 'c1', 'e1', 'NPC');
    file = setSubgraphCategory(file, 'c1', 'e2', '场景');
    expect(getSubgraphCategory(file, 'c1', 'e1')).toBe('NPC');
    file = setSubgraphCategory(file, 'c1', 'e1', '');
    file = setSubgraphCategory(file, 'c1', 'e2', '');
    expect(file.subgraphs).toEqual({}); // 内层清空后整条移除
  });
});

describe('distinct suggestions (sorted, unique)', () => {
  // 用无歧义的 ASCII 名断言顺序：Web 侧排序仅用于侧栏展示（磁盘键序由 Python 按码点确定性排），
  // 不同 ICU 的中文拼音排序差异不影响数据正确性，也不该让测试跨机漂移。
  it('lists distinct composition category names', () => {
    const file = normalizeCategoriesFile({ compositions: { a: 'beta', b: 'alpha', c: 'alpha' } });
    expect(distinctCompositionCategories(file)).toEqual(['alpha', 'beta']);
  });
  it('scopes subgraph suggestions to the composition', () => {
    const file = normalizeCategoriesFile({
      subgraphs: { c1: { e1: 'npc', e2: 'trap' }, c2: { e1: 'scene' } },
    });
    expect(distinctSubgraphCategories(file, 'c1')).toEqual(['npc', 'trap']);
    expect(distinctSubgraphCategories(file, 'c2')).toEqual(['scene']);
    expect(distinctSubgraphCategories(file, 'nope')).toEqual([]);
  });
});

describe('grouping', () => {
  it('groups compositions with named categories first and uncategorized last', () => {
    const comps = [comp('a'), comp('b'), comp('c')];
    const file = setCompositionCategory(setCompositionCategory(normalizeCategoriesFile(null), 'a', 'Main'), 'c', 'Side');
    const groups = groupCompositions(comps, file);
    expect(groups.map((g) => g.label)).toEqual(['Main', 'Side', UNCATEGORIZED_LABEL]);
    expect(groups[0].items.map((c) => c.id)).toEqual(['a']);
    expect(groups[2].isUncategorized).toBe(true);
    expect(groups[2].items.map((c) => c.id)).toEqual(['b']);
  });

  it('returns a single uncategorized group when nothing is tagged', () => {
    const groups = groupCompositions([comp('a'), comp('b')], normalizeCategoriesFile(null));
    expect(groups).toHaveLength(1);
    expect(groups[0].isUncategorized).toBe(true);
    expect(groups[0].key).toBe('');
  });

  it('groups subgraph elements per composition scope', () => {
    const els = [subgraph('e1'), subgraph('e2')];
    const file = setSubgraphCategory(normalizeCategoriesFile(null), 'c1', 'e1', 'NPC');
    const groups = groupSubgraphElements(els, file, 'c1');
    expect(groups.map((g) => g.label)).toEqual(['NPC', UNCATEGORIZED_LABEL]);
    expect(groups[0].items.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('pruneOrphans', () => {
  it('drops assignments for compositions/elements no longer present', () => {
    const data: NarrativeGraphsFileDef = {
      compositions: [{ ...comp('c1'), elements: [subgraph('e1')] }],
    };
    const file = normalizeCategoriesFile({
      compositions: { c1: '主线', gone: '支线' },
      subgraphs: { c1: { e1: 'NPC', deadEl: '场景' }, deadComp: { e: 'x' } },
    });
    expect(pruneOrphans(file, data)).toEqual({
      schemaVersion: 1,
      compositions: { c1: '主线' },
      subgraphs: { c1: { e1: 'NPC' } },
    });
  });
});
