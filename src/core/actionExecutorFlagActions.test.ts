import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';

/** addFlagValue 现走 FlagStore.addNumericFlag：登记表 valueType=float 才允许累加 */
function makeExecutor(): { executor: ActionExecutor; flags: FlagStore } {
  const bus = new EventBus();
  const flags = new FlagStore(bus);
  flags.configureRegistry({
    static: [
      { key: 'n', valueType: 'float' },
      { key: 'note', valueType: 'string' },
      { key: 'toggle', valueType: 'bool' },
    ],
  });
  return { executor: new ActionExecutor(bus, flags), flags };
}

describe('addFlagValue', () => {
  it('未设置的键按 0 起加', async () => {
    const { executor, flags } = makeExecutor();
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'n', delta: 1 } });
    expect(flags.get('n')).toBe(1);
  });

  it('在现有数值上累加，支持负数与字符串 delta', async () => {
    const { executor, flags } = makeExecutor();
    flags.set('n', 3);
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'n', delta: '2' } });
    expect(flags.get('n')).toBe(5);
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'n', delta: -4 } });
    expect(flags.get('n')).toBe(1);
  });

  it('当前值非数字时按 0 处理', async () => {
    const { executor, flags } = makeExecutor();
    flags.set('n', 'abc');
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'n', delta: 2 } });
    expect(flags.get('n')).toBe(2);
  });

  it('非法 delta / 缺 key 时不写入', async () => {
    const { executor, flags } = makeExecutor();
    flags.set('n', 7);
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'n', delta: 'x' } });
    expect(flags.get('n')).toBe(7);
    await executor.executeAwait({ type: 'addFlagValue', params: { key: '', delta: 1 } });
    expect(flags.get('')).toBeUndefined();
  });

  it('登记表非 float 类型（string/bool/未登记）拒绝写入', async () => {
    const { executor, flags } = makeExecutor();
    flags.set('note', 'hi');
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'note', delta: 1 } });
    expect(flags.get('note')).toBe('hi');
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'toggle', delta: 1 } });
    expect(flags.get('toggle')).toBeUndefined();
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'unregistered', delta: 1 } });
    expect(flags.get('unregistered')).toBeUndefined();
  });

  it('未配置登记表时拒绝写入（与 appendFlag 校验口径一致）', async () => {
    const bus = new EventBus();
    const flags = new FlagStore(bus);
    const executor = new ActionExecutor(bus, flags);
    await executor.executeAwait({ type: 'addFlagValue', params: { key: 'n', delta: 1 } });
    expect(flags.get('n')).toBeUndefined();
  });
});
