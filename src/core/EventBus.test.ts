import { describe, expect, it } from 'vitest';

import { EventBus } from './EventBus';

describe('EventBus debug event trace', () => {
  it('records canonical ordered payloads independently of listeners', () => {
    const bus = new EventBus();
    bus.enableDebugTrace(2);
    bus.emit('first', { z: 2, a: [1, undefined, Number.POSITIVE_INFINITY] });
    bus.emit('second');
    bus.emit('third', { ok: true });

    expect(bus.getDebugTrace()).toEqual([
      { seq: 2, event: 'second', payload: null },
      { seq: 3, event: 'third', payload: { ok: true } },
    ]);
    bus.clearDebugTrace();
    bus.emit('after-clear', { nested: { value: 'x' } });
    expect(bus.getDebugTrace()).toEqual([
      { seq: 1, event: 'after-clear', payload: { nested: { value: 'x' } } },
    ]);
  });
});
