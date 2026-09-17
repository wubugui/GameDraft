import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';

describe('死亡/读档作废旧动作批', () => {
  it('嵌套动作扣血死亡后，内外层的后续奖励都不再执行', async () => {
    const events = new EventBus();
    const flags = new FlagStore(events);
    const actions = new ActionExecutor(events, flags);
    actions.register('die', () => { actions.cancelPending(); });
    actions.register('nested', () => actions.executeBatchAwait([
      { type: 'die', params: {} }, { type: 'setFlag', params: { key: 'innerReward', value: true } },
    ]));
    await actions.executeBatchAwait([
      { type: 'nested', params: {} }, { type: 'setFlag', params: { key: 'outerReward', value: true } },
    ]);
    expect(flags.get('innerReward')).toBeUndefined();
    expect(flags.get('outerReward')).toBeUndefined();
    await actions.executeBatchAwait([{ type: 'setFlag', params: { key: 'newTimeline', value: true } }]);
    expect(flags.get('newTimeline')).toBe(true);
  });
});
