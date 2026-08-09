import { describe, expect, it } from 'vitest';
import { aggregateIsomorphicIssues, aggregatedIssueTitle } from './issueAggregation';
import type { NarrativeGraphsFileDef, NarrativeGraphDef, ValidationIssueDef } from '../types';

function boxGraph(id: string, signal = 'box_open'): NarrativeGraphDef {
  return {
    id: `wrap_${id}`,
    ownerType: 'hotspot',
    ownerId: id,
    initialState: `${id}_closed`,
    states: {
      [`${id}_closed`]: { id: `${id}_closed` },
      [`${id}_opened`]: { id: `${id}_opened` },
    },
    transitions: [{ id: 't_1', from: `${id}_closed`, to: `${id}_opened`, signal }],
  };
}

function fileWith(graphs: NarrativeGraphDef[]): NarrativeGraphsFileDef {
  return {
    schemaVersion: 3,
    signals: [{ id: 'box_open', scope: 'private' }],
    compositions: [{
      id: 'comp',
      mainGraph: {
        id: 'flow', ownerType: 'flow', initialState: 'a',
        states: { a: { id: 'a' }, b: { id: 'b' } },
        transitions: [{ id: 't_1', from: 'a', to: 'b', signal: 'box_open' }],
      },
      elements: graphs.map((g) => ({
        id: `el_${g.id}`, kind: 'wrapperGraph' as const, ownerType: 'hotspot', ownerId: g.ownerId, graph: g,
      })),
    }],
  } as unknown as NarrativeGraphsFileDef;
}

/** 与 validatePrivateSignalListeners 同款文案：每张图各报一遍、只有图 id 不同。 */
function unboundIssue(graphId: string): ValidationIssueDef {
  return {
    severity: 'error',
    code: 'signal.private.listener.unbound',
    message: `${graphId}: 只有实体 owner（npc/hotspot/zone）绑定的 wrapper 图能监听私有信号 "box_open"`,
    path: `${graphId}.transitions.t_1`,
    target: { kind: 'transition', compositionId: 'comp', graphId, transitionId: 't_1' },
  };
}

describe('aggregateIsomorphicIssues', () => {
  it('100 张同构图各报一遍 → 收成一条 ×100（代表行原封不动）', () => {
    const graphs = Array.from({ length: 100 }, (_, i) => boxGraph(`box_${i}`));
    const data = fileWith(graphs);
    const issues = graphs.map((g) => unboundIssue(g.id));

    const rows = aggregateIsomorphicIssues(issues, data);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(100);
    expect(rows[0]!.issue).toBe(issues[0]); // 代表行是原对象：点它仍定位到那一个真实实例
    expect(rows[0]!.graphIds).toHaveLength(100);
    expect(aggregatedIssueTitle(rows[0]!, 'fallback')).toContain('100 张同构图');
  });

  it('形状不同就不合并（换了信号名 = 不是同一个问题）', () => {
    const same = boxGraph('box_1');
    const other = boxGraph('box_2', 'crate_open');
    const rows = aggregateIsomorphicIssues(
      [unboundIssue(same.id), unboundIssue(other.id)],
      fileWith([same, other]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it('code 不同不合并（同一张图上的两类毛病照样分开列）', () => {
    const g = boxGraph('box_1');
    const a = unboundIssue(g.id);
    const b: ValidationIssueDef = { ...a, code: 'transition.signal.draft', message: `${g.id}: 别的毛病` };
    expect(aggregateIsomorphicIssues([a, b], fileWith([g]))).toHaveLength(2);
  });

  it('消息里的状态 id 也换记号：只差实例名的两条能合上', () => {
    const g1 = boxGraph('box_1');
    const g2 = boxGraph('box_2');
    const mk = (g: NarrativeGraphDef, id: string): ValidationIssueDef => ({
      severity: 'warning',
      code: 'state.broadcast.missing',
      message: `${g.id}: 监听了未广播的状态 ${id}_opened`,
      path: `${g.id}.states.${id}_opened`,
      target: { kind: 'state', compositionId: 'comp', graphId: g.id, stateId: `${id}_opened` },
    });
    const rows = aggregateIsomorphicIssues([mk(g1, 'box_1'), mk(g2, 'box_2')], fileWith([g1, g2]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  it('同一张图上真正重复两次的告警也合并（同图同码同文案）', () => {
    const g = boxGraph('box_1');
    const issue = unboundIssue(g.id);
    const rows = aggregateIsomorphicIssues([issue, { ...issue }], fileWith([g]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
    expect(rows[0]!.graphIds).toEqual([g.id]);
  });

  it('不归属任何图的问题（信号级）逐条原样保留，永不合并', () => {
    const g = boxGraph('box_1');
    const sig = (id: string): ValidationIssueDef => ({
      severity: 'warning',
      code: 'signal.private.unlistened',
      message: `私有信号 "${id}" 没有任何 wrapper 图监听`,
      path: 'signals',
      target: { kind: 'signal', signalId: id },
    });
    const rows = aggregateIsomorphicIssues([sig('a'), sig('b'), sig('a')], fileWith([g]));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it('顺序稳定：代表行按原列表首次出现序排列', () => {
    const g1 = boxGraph('box_1');
    const g2 = boxGraph('box_2', 'crate_open');
    const first = unboundIssue(g2.id);
    const rows = aggregateIsomorphicIssues(
      [first, unboundIssue(g1.id), unboundIssue(g2.id)],
      fileWith([g1, g2]),
    );
    expect(rows[0]!.issue).toBe(first);
    expect(rows[0]!.count).toBe(2);
    expect(rows[1]!.count).toBe(1);
  });

  it('严重度不同不合并（error 与 warning 混成一行会把优先级说错）', () => {
    const g1 = boxGraph('box_1');
    const g2 = boxGraph('box_2');
    const a = unboundIssue(g1.id);
    const b: ValidationIssueDef = { ...unboundIssue(g2.id), severity: 'warning' };
    expect(aggregateIsomorphicIssues([a, b], fileWith([g1, g2]))).toHaveLength(2);
  });

  it('单字母状态 id 不许污染消息里的普通单词（`a` 不能把 states 切成 st␟S1tes）', () => {
    // 两张同构图，各带一个单字母状态。裸子串替换会把 path 里的 "states" 打碎，
    // 两条本该合并的告警从此永远合不上——而且不报错，只表现为"聚合好像没生效"。
    const mk = (gid: string, solo: string): NarrativeGraphDef => ({
      id: gid,
      ownerType: 'hotspot',
      ownerId: gid,
      initialState: solo,
      states: { [solo]: { id: solo }, [`${solo}_next`]: { id: `${solo}_next` } },
      transitions: [{ id: 't', from: solo, to: `${solo}_next`, signal: 'box_open' }],
    });
    const g1 = mk('wrap_1', 'a');
    const g2 = mk('wrap_2', 'b');
    const issue = (gid: string, solo: string): ValidationIssueDef => ({
      severity: 'warning',
      code: 'state.broadcast.missing',
      message: `${gid}: 状态 ${solo} 未广播`,
      path: `${gid}.states.${solo}`,
      target: { kind: 'state', compositionId: 'comp', graphId: gid, stateId: solo },
    });
    const rows = aggregateIsomorphicIssues([issue('wrap_1', 'a'), issue('wrap_2', 'b')], fileWith([g1, g2]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  it('记号替换必须长的先来：短 id 是长 id 的前缀时，短的先换会把长的切碎、聚合静默失效', () => {
    // 两张同构图，各自的状态 id 里短的那个是长的那个的前缀（`ab` / `a`、`cd` / `c`）。
    // 长的先替换：两条消息都归一成 “␟G: 状态 ␟S0 未广播”，合成一条。
    // 短的先替换：分别变成 “…␟S1b…” 与 “…␟S1d…”，永远合不上。
    const mk = (gid: string, long: string, short: string): NarrativeGraphDef => ({
      id: gid,
      ownerType: 'hotspot',
      ownerId: gid,
      initialState: long,
      states: { [long]: { id: long }, [short]: { id: short } },
      transitions: [{ id: 'tr', from: long, to: short, signal: 'box_open' }],
    });
    const g1 = mk('g1', 'ab', 'a');
    const g2 = mk('g2', 'cd', 'c');
    const issue = (gid: string, long: string): ValidationIssueDef => ({
      severity: 'warning',
      code: 'state.broadcast.missing',
      message: `${gid}: 状态 ${long} 未广播`,
      path: `${gid}.states.${long}`,
      target: { kind: 'state', compositionId: 'comp', graphId: gid, stateId: long },
    });
    const rows = aggregateIsomorphicIssues([issue('g1', 'ab'), issue('g2', 'cd')], fileWith([g1, g2]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  it('单条不带 ×N（aggregatedIssueTitle 退回原 tooltip）', () => {
    const g = boxGraph('box_1');
    const rows = aggregateIsomorphicIssues([unboundIssue(g.id)], fileWith([g]));
    expect(rows[0]!.count).toBe(1);
    expect(aggregatedIssueTitle(rows[0]!, 'fallback')).toBe('fallback');
  });
});
