import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';

function makeExecutor(): { executor: ActionExecutor; flags: FlagStore } {
  const bus = new EventBus();
  const flags = new FlagStore(bus);
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
});
