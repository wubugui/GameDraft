import { useMemo } from 'react';
import { SignalChipsField } from './SignalChipsField';
import {
  coerceLocalVarValue,
  defaultValueForLocalVarType,
  duplicateLocalVarKeys,
  localVarsOf,
  LOCAL_VAR_TYPES,
  nextLocalVarKey,
  setLocalSignalList,
  setLocalVars,
  type LocalVarType,
} from '../localMachine';
import type { NarrativeGraphDef, NarrativeLocalVarDef } from '../types';

/**
 * 局部机原型面板：实例变量表 + 对外信号声明。
 *
 * 放在「元素属性」与「图属性」两处共用同一个组件——策划从主画布点元素、或进子图点空白，
 * 都该看到同一张表；两处各写一份迟早漂。
 */
export function LocalMachineSection({
  graph,
  updateGraph,
  knownSignals,
}: {
  graph: NarrativeGraphDef;
  updateGraph: (updater: (g: NarrativeGraphDef) => void) => void;
  /** 信号候选（作者信号；派生 state:… 不作候选——局部机本就禁广播）。 */
  knownSignals: string[];
}) {
  const vars = localVarsOf(graph);
  const dupKeys = useMemo(() => duplicateLocalVarKeys(vars), [vars]);
  const signalOptions = useMemo(
    () => knownSignals.filter((sig) => !sig.startsWith('state:')),
    [knownSignals],
  );

  const mutateVars = (mutate: (list: NarrativeLocalVarDef[]) => NarrativeLocalVarDef[]) => {
    updateGraph((g) => { setLocalVars(g, mutate(localVarsOf(g).map((v) => ({ ...v })))); });
  };

  return (
    <div className="local-machine-section">
      <div className="property-line note">
        这是一张<b>图纸</b>：它自己一份实例都没有，绑定它的每个实体各得一台私有机器。
        实例的当前态与变量<b>对外不可见</b>——外面既问不到"那个箱子什么状态"，也不能用
        narrative 条件读它；要对外说话只有一条路：<b>导出信号</b>。
      </div>

      <div className="field">
        <label>
          实例变量表
          {dupKeys.size > 0 && <span className="local-var-error"> ⚠ 变量名重复：{[...dupKeys].join('、')}</span>}
        </label>
        <div className="local-var-rows">
          {vars.length === 0 ? (
            <span className="muted">（没有变量。要记"踢了几脚""偷看过没有"这类实例私有数据，在这里加。）</span>
          ) : vars.map((v, index) => {
            const key = String(v?.key ?? '').trim();
            const type = (LOCAL_VAR_TYPES as readonly string[]).includes(v?.type)
              ? (v.type as LocalVarType)
              : 'bool';
            const keyBad = !key || dupKeys.has(key);
            return (
              <div className="local-var-row" key={`var-${index}`}>
                <input
                  className={keyBad ? 'invalid' : ''}
                  value={String(v?.key ?? '')}
                  placeholder="变量名"
                  title={!key ? '变量名不能为空' : dupKeys.has(key) ? '变量名与其它行重复' : '实例变量名（转移条件里用 localVar 读它）'}
                  onChange={(e) => mutateVars((list) => {
                    list[index] = { ...list[index], key: e.target.value };
                    return list;
                  })}
                />
                <select
                  value={type}
                  onChange={(e) => mutateVars((list) => {
                    const nextType = e.target.value as LocalVarType;
                    // 改类型必须一起换默认值，否则留下 type/default 对不上的行（校验 error）。
                    list[index] = { ...list[index], type: nextType, default: defaultValueForLocalVarType(nextType) };
                    return list;
                  })}
                >
                  {LOCAL_VAR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                {type === 'bool' ? (
                  <select
                    value={v.default === true ? 'true' : 'false'}
                    onChange={(e) => mutateVars((list) => {
                      list[index] = { ...list[index], default: e.target.value === 'true' };
                      return list;
                    })}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    type={type === 'float' ? 'number' : 'text'}
                    value={String(v.default ?? (type === 'float' ? 0 : ''))}
                    placeholder="默认值"
                    onChange={(e) => mutateVars((list) => {
                      list[index] = { ...list[index], default: coerceLocalVarValue(e.target.value, type) };
                      return list;
                    })}
                  />
                )}
                <button
                  type="button"
                  title="删除这个变量（读它的转移条件会立刻报未声明，改条件即可）"
                  onClick={() => mutateVars((list) => list.filter((_, i) => i !== index))}
                >
                  删
                </button>
              </div>
            );
          })}
        </div>
        <div className="inspector-actions">
          <button
            type="button"
            onClick={() => mutateVars((list) => [
              ...list,
              { key: nextLocalVarKey(list), type: 'bool', default: false },
            ])}
          >
            添加变量
          </button>
        </div>
        <div className="property-line note">
          实例只存<b>偏离默认</b>的值——1000 个没被碰过的箱子在存档里是 0 条目。
        </div>
      </div>

      <SignalChipsField
        label="监听的全局信号（声明）"
        value={graph.local?.listens ?? []}
        options={signalOptions}
        onChange={(value) => updateGraph((g) => { setLocalSignalList(g, 'listens', value); })}
        note="信号索引按这份声明建：一条信号只会投给声明监听它的原型，其余实例零成本。漏声明 = 转移永不触发。"
        emptyText="（不监听任何全局信号）"
      />
      <SignalChipsField
        label="导出的全局信号（声明）"
        value={graph.local?.emits ?? []}
        options={signalOptions}
        onChange={(value) => updateGraph((g) => { setLocalSignalList(g, 'emits', value); })}
        note="这台机器会往全局总线上发哪些信号。真正的发射写在状态的「进入/离开时动作」里；这里声明是给接线与校验看的。"
        emptyText="（不导出任何信号）"
      />
    </div>
  );
}
