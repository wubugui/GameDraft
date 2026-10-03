import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => {
  const instances: TestGame[] = [];
  class TestGame {
    resolve!: () => void;
    reject!: (reason: unknown) => void;
    readonly pending = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    readonly start = vi.fn((_options: Record<string, unknown>) => this.pending);
    readonly destroy = vi.fn();
    constructor() { instances.push(this); }
  }
  return { instances, TestGame, guard: vi.fn(async (_isDev: boolean) => true) };
});
vi.mock('./core/Game', () => ({ Game: startup.TestGame }));
vi.mock('./core/entryGuard', () => ({ runEntryGuard: startup.guard }));

interface FatalElement { id: string; style: { cssText: string }; textContent: string; remove(): void }
let errors: FatalElement[];
let listeners: Map<string, Set<() => void>>;
let host: { location: { search: string }; __gameDestroy?: () => void };
async function flush(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }
async function boot(): Promise<void> { await import('./main'); await flush(); }

beforeEach(() => {
  vi.resetModules(); startup.instances.length = 0; startup.guard.mockReset().mockResolvedValue(true);
  vi.stubEnv('DEV', true); errors = []; listeners = new Map();
  host = { location: { search: '?mode=dev&devScene=dev_room&screen_title=1&load_slot=2' } };
  vi.stubGlobal('window', Object.assign(host, {
    setTimeout, clearTimeout,
    addEventListener: (name: string, callback: () => void) => {
      const registered = listeners.get(name) ?? new Set(); registered.add(callback); listeners.set(name, registered);
    },
    removeEventListener: (name: string, callback: () => void) => { listeners.get(name)?.delete(callback); },
  }));
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { createElement: () => ({ id: '', style: { cssText: '' }, textContent: '', remove() {} }),
    body: { appendChild: (element: FatalElement) => { errors.push(element); } }, head: { appendChild: vi.fn() } });
  vi.stubGlobal('__GAMEDRAFT_BOOT_QUERY__', undefined);
  vi.stubGlobal('__gamedraftWebgpuCaptureInitialized', undefined);
  vi.stubGlobal('webgpuInspector', undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const game of startup.instances) game.destroy.mockImplementation(() => {});
  host.__gameDestroy?.();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('main actual startup and stale-rejection ownership', () => {
  it('preserves normal startup options, entry guard ordering and idempotent page teardown', async () => {
    await boot(); expect(startup.guard).toHaveBeenCalledExactlyOnceWith(true);
    expect(startup.instances).toHaveLength(1); const game = startup.instances[0];
    expect(game.start).toHaveBeenCalledExactlyOnceWith({ devMode: true, playCutscene: undefined, playCutsceneFrom: undefined,
      devScene: 'dev_room', narrativeWarp: undefined, waterPreview: undefined, sugarWheelPreview: undefined,
      paperCraftPreview: undefined, visualCapture: false, startAtTitle: true, loadSlot: 2 });
    expect(startup.guard.mock.invocationCallOrder[0]).toBeLessThan(game.start.mock.invocationCallOrder[0]);
    game.resolve(); await flush(); expect(errors).toEqual([]); expect(game.destroy).not.toHaveBeenCalled();
    for (const callback of [...listeners.get('pagehide') ?? []]) callback(); host.__gameDestroy?.();
    expect(game.destroy).toHaveBeenCalledOnce(); expect(listeners.get('beforeunload')?.size).toBe(0); expect(listeners.get('pagehide')?.size).toBe(0);
  });

  it('release startup keeps title/save parameters but ignores developer shortcuts', async () => {
    vi.stubEnv('DEV', false); await boot();
    expect(startup.guard).toHaveBeenCalledExactlyOnceWith(false);
    expect(startup.instances[0].start.mock.calls[0][0]).toMatchObject({ devMode: false, devScene: undefined, startAtTitle: true, loadSlot: 2 });
    startup.instances[0].resolve(); await flush(); expect(errors).toEqual([]);
  });

  it('does not construct a game when the actual entry chain is refused', async () => {
    startup.guard.mockResolvedValue(false); await boot();
    expect(startup.instances).toHaveLength(0); expect(errors).toEqual([]);
  });

  it('an entry guard exception retains the master fallback and starts normally', async () => {
    const failure = new Error('entry probe unavailable'); startup.guard.mockRejectedValue(failure); await boot();
    expect(startup.instances).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith('main: 入口检查失败，按正常流程启动', failure);
    startup.instances[0].resolve(); await flush(); expect(errors).toEqual([]);
  });

  it('Inspector initialization failure stays nonfatal and still reaches the entry guard', async () => {
    vi.stubGlobal('navigator', { gpu: {} }); const failure = new Error('Inspector unavailable');
    const initialize = vi.fn(() => { throw failure; }); vi.stubGlobal('webgpuInspector', { initialize });
    await boot(); expect(initialize).toHaveBeenCalledOnce(); expect(startup.guard).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith('main: WebGPU 抓帧探针不可用，游戏继续启动', failure);
    expect(startup.instances).toHaveLength(1); startup.instances[0].resolve(); await flush(); expect(errors).toEqual([]);
  });

  it('current startup failure destroys its half-initialized game and preserves the master fatal DOM diagnostic', async () => {
    await boot(); const game = startup.instances[0]; const failure = new Error('required scene missing');
    game.reject(failure); await flush(); expect(game.destroy).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(failure);
    expect(errors.map(element => ({ id: element.id, text: element.textContent })))
      .toEqual([{ id: 'game-fatal-error', text: '游戏启动失败，请刷新页面重试。\nrequired scene missing' }]);
    expect(listeners.get('beforeunload')?.size).toBe(0);
  });

  it('a cleanup exception does not hide the current startup failure diagnostic', async () => {
    await boot(); const game = startup.instances[0]; const cleanupFailure = new Error('cleanup failed');
    game.destroy.mockImplementation(() => { throw cleanupFailure; }); game.reject('startup failed'); await flush();
    expect(console.warn).toHaveBeenCalledWith('main: 启动失败后的清理也失败', cleanupFailure);
    expect(errors.map(element => element.textContent)).toEqual(['游戏启动失败，请刷新页面重试。\nstartup failed']);
  });

  it('a disposed old module startup rejection cannot destroy or paint an error over its live replacement', async () => {
    await boot(); const old = startup.instances[0]; host.__gameDestroy?.(); expect(old.destroy).toHaveBeenCalledOnce();
    vi.resetModules(); await boot(); expect(startup.instances).toHaveLength(2); const replacement = startup.instances[1];
    replacement.resolve(); await flush(); old.reject(new Error('late old startup')); await flush();
    expect(old.destroy).toHaveBeenCalledOnce(); expect(replacement.destroy).not.toHaveBeenCalled();
    expect(errors).toEqual([]); expect(console.error).not.toHaveBeenCalled();
    expect(listeners.get('beforeunload')?.size).toBe(1); expect(listeners.get('pagehide')?.size).toBe(1);
    host.__gameDestroy?.(); expect(replacement.destroy).toHaveBeenCalledOnce();
  });
});
