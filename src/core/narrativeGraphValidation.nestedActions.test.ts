import { describe, expect, it } from 'vitest';
import { validateNarrativeGraphData } from './narrativeGraphValidation';

/**
 * 叙事图校验必须下钻到**每一个**容器动作的子动作列表——口径是运行时 ActionRegistry.ts 的
 * `actionListFromParam` 调用点（+ addDelayedEvent / enableRuleOffers.slots[].resultActions）。
 * 历史漏洞：`runActionsIf` 的 actions / elseActions 不在手写 if/elif 里，里面的未知动作、
 * 缺必填参数、伪造保留信号全都校验不到（运行时照样执行）。
 */

/** 放进任一子动作列表的三条坏动作：未知类型 / 缺必填参数 / 发射保留信号。 */
function badActions(): unknown[] {
  return [
    { type: 'noSuchAction', params: {} },
    { type: 'setFlag', params: { value: true } },
    { type: 'emitNarrativeSignal', params: { signal: 'state:flow:done' } },
  ];
}

function issuesForOnEnter(onEnterActions: unknown[]) {
  return validateNarrativeGraphData({
    schemaVersion: 3,
    signals: [],
    compositions: [{
      id: 'comp',
      mainGraph: {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'a',
        states: { a: { id: 'a' }, b: { id: 'b', onEnterActions } },
        transitions: [{ id: 't', from: 'a', to: 'b', signal: 'go' }],
      },
      elements: [],
    }],
  });
}

const BASE = 'compositions[0].mainGraph.states.b.onEnterActions';

function expectBadActionsReportedAt(issues: ReturnType<typeof issuesForOnEnter>, listPath: string): void {
  const at = (code: string, path: string) => issues.some((i) => i.code === code && i.path === path && i.severity === 'error');
  expect(at('action.type.unknown', `${listPath}[0].type`), `${listPath}: unknown type`).toBe(true);
  expect(at('action.param.missing', `${listPath}[1].params.key`), `${listPath}: missing param`).toBe(true);
  expect(at('action.signal.reserved', `${listPath}[2].params.signal`), `${listPath}: reserved signal`).toBe(true);
}

describe('narrative validation descends into every nested action list', () => {
  const cond = { flag: 'k' };

  it('runActionsIf.actions and runActionsIf.elseActions', () => {
    const issues = issuesForOnEnter([
      { type: 'runActionsIf', params: { condition: cond, actions: badActions(), elseActions: badActions() } },
    ]);
    expectBadActionsReportedAt(issues, `${BASE}[0].params.actions`);
    expectBadActionsReportedAt(issues, `${BASE}[0].params.elseActions`);
  });

  it('runActionsIf nested inside other containers (and inside itself)', () => {
    const issues = issuesForOnEnter([
      {
        type: 'randomBranch',
        params: {
          aboveActions: [{ type: 'runActionsIf', params: { condition: cond, elseActions: badActions() } }],
          belowActions: [],
        },
      },
      {
        type: 'runActionsIf',
        params: {
          condition: cond,
          actions: [{ type: 'runActionsIf', params: { condition: cond, actions: badActions() } }],
        },
      },
    ]);
    expectBadActionsReportedAt(issues, `${BASE}[0].params.aboveActions[0].params.elseActions`);
    expectBadActionsReportedAt(issues, `${BASE}[1].params.actions[0].params.actions`);
  });

  it('every other container slot keeps being checked', () => {
    const issues = issuesForOnEnter([
      { type: 'runActions', params: { actions: badActions() } },
      { type: 'addDelayedEvent', params: { targetDay: 1, actions: badActions() } },
      { type: 'randomBranch', params: { probability: 0.5, aboveActions: badActions(), belowActions: badActions() } },
      { type: 'chooseAction', params: { prompt: 'p', options: [{ text: 'x', actions: badActions() }] } },
      { type: 'enableRuleOffers', params: { slots: [{ ruleId: 'r', resultActions: badActions() }] } },
    ]);
    expectBadActionsReportedAt(issues, `${BASE}[0].params.actions`);
    expectBadActionsReportedAt(issues, `${BASE}[1].params.actions`);
    expectBadActionsReportedAt(issues, `${BASE}[2].params.aboveActions`);
    expectBadActionsReportedAt(issues, `${BASE}[2].params.belowActions`);
    expectBadActionsReportedAt(issues, `${BASE}[3].params.options[0].actions`);
    expectBadActionsReportedAt(issues, `${BASE}[4].params.slots[0].resultActions`);
  });

  it('container shape errors keep their codes', () => {
    const issues = issuesForOnEnter([
      { type: 'runActionsIf', params: { condition: cond, elseActions: 'nope' } },
      { type: 'chooseAction', params: { prompt: 'p', options: 'nope' } },
      { type: 'enableRuleOffers', params: { slots: 7 } },
    ]);
    const byPath = new Map(issues.map((i) => [i.path, i.code]));
    expect(byPath.get(`${BASE}[0].params.elseActions`)).toBe('actions.shape');
    expect(byPath.get(`${BASE}[1].params.options`)).toBe('action.container.shape');
    expect(byPath.get(`${BASE}[2].params.slots`)).toBe('action.container.shape');
  });

  it('a well-formed runActionsIf with valid children reports nothing under it', () => {
    const issues = issuesForOnEnter([
      {
        type: 'runActionsIf',
        params: {
          condition: cond,
          actions: [{ type: 'setFlag', params: { key: 'k', value: true } }],
          elseActions: [{ type: 'emitNarrativeSignal', params: { signal: 'legit_signal' } }],
        },
      },
    ]);
    expect(issues.filter((i) => String(i.path ?? '').startsWith(`${BASE}[0]`))).toEqual([]);
  });
});
