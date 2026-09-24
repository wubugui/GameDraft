import { describe, expect, it, vi } from 'vitest';
import type { JevCallResult, JevTransport } from './jevTransport';
import type { JevChoiceQuestion } from './jevProtocol';
import { PlayerActivity } from '../PlayerActivity';
import { WorldBrainSystem, type BrainNpc, type WorldBrainDeps } from './WorldBrainSystem';

/** 假道具表 */
const ITEMS: Record<string, string> = { leifu: '雷符', bug_jar: '虫罐', juzi: '橘子' };

const CONFIG = {
  sceneId: 's',
  setting: '一条街',
  player: { label: '关二狗', identity: '二流子' },
  places: [
    { id: 'home', name: '面摊', x: 0, y: 0, shelter: true },
    { id: 'b', name: '十字口', x: 300, y: 0 },
    { id: 'c', name: '洗衣台', x: 600, y: 0 },
  ],
  links: [['home', 'b'], ['b', 'c']],
  lineCategories: { hawk: '吆喝' },
  genericReplies: {
    greet: ['二狗，来了索。'],
    about_event: ['刚才{where}那{event}，你看到没得？'],
    blame: ['刚才那{event}，是不是你搞的？'],
  },
  people: [
    {
      npcId: 'n1', label: '面摊老板', identity: '卖面的', temper: '胆小', activity: '煮面',
      home: 'home', haunts: ['b', 'c'], says: ['hawk'], lines: { hawk: ['牛肉面！'] },
      replies: { busy: ['锅要糊了，等哈！'] },
    },
  ],
  tuning: {},
};

class FakeNpc implements BrainNpc {
  x: number;
  y: number;
  destroyed = false;
  visible = true;
  moves: { x: number; y: number; anim?: string }[] = [];
  anims: string[] = [];
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  moveTo(x: number, y: number, _s: number, anim?: string): Promise<void> {
    this.moves.push({ x, y, anim });
    this.x = x;
    this.y = y;
    return Promise.resolve();
  }
  jumpTo(): Promise<void> { return Promise.resolve(); }
  cancelActiveMove(): void {}
  playAnimation(name: string): void { this.anims.push(name); }
  setFacing(): void {}
  applyInitialFacing(): void {}
  setVisible(v: boolean): void { this.visible = v; }
  hasAnim(): boolean { return true; }
  frameIndex(): number { return 0; }
  frameCount(): number { return 16; }
  setPlaying(): void {}
}

type Picker = (key: string, q: JevChoiceQuestion) => string;

function makeTransport(pick: Picker | 'no_key') {
  const calls: { state: unknown; questions: Record<string, JevChoiceQuestion> }[] = [];
  const t: JevTransport = {
    decide: vi.fn(async (body) => {
      calls.push(body);
      if (pick === 'no_key') {
        return { ok: false, kind: 'no_key', message: 'x', status: 503, latencyMs: 5 } satisfies JevCallResult;
      }
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(body.questions)) {
        if ((q as { type?: string }).type === 'noul') {
          // 显著度题（街上的人看到会不会害怕）：这个替身见雷、白光、天黑、地震就判"会怕"，其余平常
          const scary = /雷|白光|黑|震/.test(JSON.stringify(body.state));
          answers[k] = { type: 'noul', noul: scary ? 0.95 : 0.3, confidence: 0.95, action: { act_probability: 1 } };
          continue;
        }
        const choice = pick(k, q as JevChoiceQuestion);
        answers[k] = { type: 'choice', choice, confidence: 0.8, probabilities: { [choice]: 0.9 } };
      }
      return { ok: true, body: { answers, usage: { input_tokens: 100 } }, latencyMs: 42 } satisfies JevCallResult;
    }),
    status: async () => ({ reachable: true, configured: pick !== 'no_key' }),
  };
  return { t, calls };
}

/** 走位题发出去的键是短代号：按选项说法找键 */
function keyOf(q: JevChoiceQuestion, text: string): string | undefined {
  return Object.entries(q.criteria).find(([, v]) => v.includes(text))?.[0];
}

/** 缺省替身：闲话挑吆喝，回话挑"摆刚才那件事"（有的话）否则挑第一个，走位挑去十字口（没有就挑第一个＝接着做） */
const DEFAULT_PICK: Picker = (k, q) => {
  if (k.startsWith('say')) return 'hawk';
  if (k.startsWith('reply')) return 'about_event' in q.criteria ? 'about_event' : Object.keys(q.criteria)[0];
  return keyOf(q, '走到十字口去') ?? Object.keys(q.criteria)[0];
};

/** 两个人的街（测"一人一发"、排队） */
const CONFIG2 = {
  ...CONFIG,
  people: [
    ...CONFIG.people,
    { npcId: 'n2', label: '洗衣婆', identity: '洗衣裳的', temper: '凶', activity: '搓衣裳', home: 'c', haunts: ['b'] },
  ],
};

/** 一个近处的人 + 四个很远的过路人（测背景巡检） */
const CONFIG_MANY = {
  ...CONFIG,
  people: [
    ...CONFIG.people,
    ...[1, 2, 3, 4].map((i) => ({
      npcId: `f${i}`, label: `过路人${i}`, identity: '过路的', temper: '闷', activity: '赶路', home: 'c', haunts: [],
    })),
  ],
};

/** 替身：一律"接着做手上的事"、不开腔（测频率时不让人走动换档） */
const STAY_PICK: Picker = (k, q) => (k.startsWith('say') ? 'silent' : Object.keys(q.criteria)[0]);

/** 发给某个人的那几发（一发只问一个人：有 act 题） */
function personCalls(calls: { state: unknown; questions: Record<string, JevChoiceQuestion> }[], label?: string) {
  return calls.filter((c) => 'act' in c.questions && (!label || JSON.stringify(c.state).includes(`"${label}":{`)));
}

function makeBrain(opts: {
  pick?: Picker | 'no_key';
  config?: unknown;
  patrol?: boolean;
  /** 摆人：npcId → 位置（缺省 n1 在 (10,0)、n2 在 (600,0)） */
  at?: Record<string, [number, number]>;
} = {}) {
  const listeners = new Map<string, Set<(p?: unknown) => void>>();
  const bus = {
    on: (e: string, cb: (p?: unknown) => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(cb);
    },
    off: (e: string, cb: (p?: unknown) => void) => listeners.get(e)?.delete(cb),
    emit: (e: string, p?: unknown) => listeners.get(e)?.forEach((cb) => cb(p)),
  };
  const at: Record<string, [number, number]> = opts.at ?? { n1: [10, 0], n2: [600, 0] };
  const npcs: Record<string, FakeNpc> = {};
  for (const [id, [x, y]] of Object.entries(at)) npcs[id] = new FakeNpc(x, y);
  const npc = npcs.n1;
  const { t, calls } = makeTransport(opts.pick ?? DEFAULT_PICK);
  const state = {
    exploring: true, paused: false, scene: 's', wall: 0, onScreen: true, bubbles: 0, player: { x: 200, y: 300 },
    posture: null as string | null,
    /** 背包：道具 id → 件数 */
    inv: {} as Record<string, number>,
    /** 世界此刻的样子：压暗倍率、风、开着的效果 */
    dim: 1,
    wind: null as { speed: number; base: number } | null,
    effects: [] as string[],
  };
  // 通用旁听：测试里手动"执行一条动作 / 冒一个效果"
  type Run = { id: number; initiator: { kind: string; id?: string } };
  const taps = {
    action: new Set<(type: string, params: Record<string, unknown>, ctx?: { run: Run }) => void>(),
    runEnd: new Set<(end: { run: Run; interrupted: boolean }) => void>(),
    vfx: new Set<(kind: 'start' | 'stop', id: string, at: { x: number; y: number } | null, runId?: number | null) => void>(),
  };
  const cfgPeople = ((opts.config ?? CONFIG) as { people?: { npcId: string; label: string }[] } | null)?.people ?? [];
  const entityName = (id: string) => cfgPeople.find((p) => p.npcId === id)?.label ?? null;
  // 真的玩家状态串（挂在同一条假总线上）：测试照引擎的样子发 item:use / player:posture / npc:interact
  const activity = new PlayerActivity({
    eventBus: bus,
    playerPos: () => ({ x: state.player.x, y: state.player.y }),
    itemInfo: (id) => (ITEMS[id] ? { name: ITEMS[id], useLabel: id === 'leifu' ? '掐诀，掷出去' : null } : null),
    entityName,
    held: () => null,
    posture: () => state.posture,
  });
  const deps: WorldBrainDeps = {
    eventBus: bus,
    loadConfig: vi.fn(async (sid: string) => (sid === 's' ? (opts.config === undefined ? CONFIG : opts.config) : null)),
    currentSceneId: () => state.scene,
    isExploring: () => state.exploring,
    isWorldPaused: () => state.paused,
    getNpc: (id) => npcs[id] ?? null,
    npcAuthored: (id) => (at[id] ? { x: at[id][0], y: at[id][1], hasPatrol: opts.patrol === true } : null),
    stopNpcPatrol: vi.fn(),
    startNpcPatrol: vi.fn(),
    playerPos: () => ({ x: state.player.x, y: state.player.y }),
    isRunHeld: () => false,
    playerActivity: activity,
    timeOfDay: () => '午',
    addActionListener: vi.fn((fn) => { taps.action.add(fn); return () => taps.action.delete(fn); }),
    addRunEndListener: vi.fn((fn) => { taps.runEnd.add(fn); return () => taps.runEnd.delete(fn); }),
    addVfxListener: vi.fn((fn) => { taps.vfx.add(fn); return () => taps.vfx.delete(fn); }),
    vfxLabel: (id) => (id.startsWith('lightning_bolt') ? '天雷 01：介质击穿模型离线烘成贴图' : null),
    worldLook: () => ({ dim: state.dim, wind: state.wind, effects: state.effects }),
    itemName: (id) => ITEMS[id] ?? null,
    itemCount: (id) => state.inv[id] ?? 0,
    giveItem: vi.fn((id: string, count: number) => {
      state.inv[id] = (state.inv[id] ?? 0) + count;
      return true;
    }),
    entityName,
    entityPos: () => null,
    speak: vi.fn(() => true),
    onScreen: () => state.onScreen,
    bubbleCount: () => state.bubbles,
    clearBubbles: vi.fn(),
    transport: t,
    random: () => 0.5,
    wallMs: () => state.wall,
  };
  const brain = new WorldBrainSystem(deps);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** 推一帧并把异步（读配置 / 回包）落地 */
  const step = async (dt = 0.1) => {
    state.wall += dt * 1000;
    brain.update(dt);
    await flush();
  };
  const fireAction = (type: string, params: Record<string, unknown>, run?: Run) =>
    taps.action.forEach((fn) => fn(type, params, run ? { run } : undefined));
  const fireVfx = (kind: 'start' | 'stop', id: string, at: { x: number; y: number } | null, runId?: number) =>
    taps.vfx.forEach((fn) => fn(kind, id, at, runId ?? null));
  const endRun = (run: Run, interrupted = false) => taps.runEnd.forEach((fn) => fn({ run, interrupted }));
  return { brain, deps, npc, npcs, calls, state, bus, step, fireAction, fireVfx, endRun, taps };
}

describe('WorldBrainSystem', () => {
  it('关着：街上出什么事都不碰 NPC、不问 Jev，连动作执行器 / 粒子系统的旁听都没挂', async () => {
    const { deps, npc, calls, bus, step } = makeBrain();
    for (let i = 0; i < 20; i++) await step();
    bus.emit('item:use', { itemId: 'leifu' });
    for (let i = 0; i < 20; i++) await step();
    expect(calls.length).toBe(0);
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(deps.addActionListener).not.toHaveBeenCalled();
    expect(deps.addVfxListener).not.toHaveBeenCalled();
    expect(deps.stopNpcPatrol).not.toHaveBeenCalled();
    expect(npc.moves).toEqual([]);
    expect(deps.speak).not.toHaveBeenCalled();
  });

  it('开着但本场景没有配置：什么都不做，状态说实话', async () => {
    const { brain, deps, calls, step } = makeBrain({ config: null });
    brain.setEnabled(true);
    for (let i = 0; i < 10; i++) await step();
    expect(calls.length).toBe(0);
    expect(deps.stopNpcPatrol).not.toHaveBeenCalled();
    expect(brain.getDebugState().status).toBe('no_config');
  });

  it('开着：问决策服务 → 拿到决定才接管（停巡逻）→ 沿路网走过去、开腔', async () => {
    const { brain, deps, npc, calls, step } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    // 决策一发（他走动、开腔之后，那两件事的显著度各一发——街上别人看得见他干的事）
    expect(personCalls(calls).length).toBe(1);
    const q = calls[0].questions;
    expect(Object.keys(q).sort()).toEqual(['act', 'say']);
    expect(JSON.stringify(calls[0].state)).toContain('面摊老板');
    for (let i = 0; i < 3; i++) await step();
    expect(deps.stopNpcPatrol).toHaveBeenCalledWith('n1');
    expect(npc.moves[npc.moves.length - 1]).toMatchObject({ x: 300, y: 0 });
    expect(deps.speak).toHaveBeenCalledWith('n1', '牛肉面！', expect.any(Number), { reply: false, scale: 2.2 });
    const row = brain.getDebugState().people[0];
    expect(row.takenOver).toBe(true);
    expect(row.pick).toBe('go:b');
    // 牌子上的那句 = 头上挂着的那句
    expect(row.say).toBe('牛肉面！');
  });

  it('决策服务用不了（没填 key）：不接管，街上照旧是默认逻辑', async () => {
    const { brain, deps, npc, step } = makeBrain({ pick: 'no_key' });
    brain.setEnabled(true);
    for (let i = 0; i < 10; i++) await step();
    expect(deps.stopNpcPatrol).not.toHaveBeenCalled();
    expect(npc.moves).toEqual([]);
    expect(brain.getDebugState().status).toBe('error');
    expect(brain.getDebugState().lastError).toContain('key');
  });

  it('关掉：被接管的人走回原位，原本巡逻的重启巡逻；之后再不碰', async () => {
    const { brain, deps, npc, step } = makeBrain({ patrol: true });
    brain.setEnabled(true);
    for (let i = 0; i < 8; i++) await step();
    expect(npc.x).toBe(300);
    brain.setEnabled(false);
    await step();
    expect(npc.x).toBe(10); // 走回作者摆的原位
    expect(deps.startNpcPatrol).toHaveBeenCalledWith('n1');
    expect(deps.clearBubbles).toHaveBeenCalled();
    const moves = npc.moves.length;
    for (let i = 0; i < 20; i++) await step();
    expect(npc.moves.length).toBe(moves);
  });

  it('关掉之后迟到的回包作废', async () => {
    let release: (v: JevCallResult) => void = () => {};
    const { brain, deps, npc, step } = makeBrain();
    (deps.transport.decide as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<JevCallResult>((r) => { release = r; }),
    );
    brain.setEnabled(true);
    for (let i = 0; i < 4; i++) await step();
    brain.setEnabled(false);
    release({ ok: true, body: { answers: { act: { choice: 'go:c', probabilities: { 'go:c': 1 } } } }, latencyMs: 1 });
    for (let i = 0; i < 5; i++) await step();
    expect(deps.stopNpcPatrol).not.toHaveBeenCalled();
    expect(npc.moves).toEqual([]);
  });

  it('世界里冒出任何效果（这里是代码直接放的一道雷）：用效果自带的 label 描述，看得见的人立刻重问；这件事的显著度单独一发', async () => {
    const { brain, calls, step, fireVfx } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    const before = calls.length;
    fireVfx('start', 'lightning_bolt_03', { x: 300, y: 0 });
    for (let i = 0; i < 3; i++) await step(0.05);
    const after = calls.slice(before);
    const ask = personCalls(after)[0];
    expect(JSON.stringify(ask.state)).toContain('十字口那边出现了天雷');
    // 有了出事地点，"凑过去看 / 往反方向跑"进菜单（键是短代号，按说法认）
    for (const t of ['看热闹', '撒腿就跑', '就地蹲下']) expect(keyOf(ask.questions.act, t), t).toBeDefined();
    // 显著度：一件事一发，是非题，state 里只有这件事
    const sal = after.find((c) => 'sal' in c.questions)!;
    expect((sal.questions.sal as unknown as { type: string }).type).toBe('noul');
    expect((sal.state as Record<string, unknown>)['刚才街上发生的事']).toEqual(['十字口那边出现了天雷']);
  });

  it('任何通用动作（这里是压暗天色，不管是哪个技能放的）：全街立刻重问', async () => {
    const { brain, calls, step, fireAction } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    const before = calls.length;
    fireAction('setSceneDim', { scale: 0.3 });
    fireAction('setFlag', { key: 'x', value: 1 }); // 街上看不见的动作：不报
    for (let i = 0; i < 3; i++) await step(0.05);
    const ask = personCalls(calls.slice(before))[0];
    const json = JSON.stringify(ask.state);
    expect(json).toContain('天一下黑得像锅底');
    expect(json).not.toContain('setFlag');
  });

  it('用了任何道具：用道具表里的名字与说明描述，不逐个道具配', async () => {
    const { brain, bus, calls, step } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    const before = calls.length;
    bus.emit('item:use', { itemId: 'leifu' });
    bus.emit('item:use', { itemId: 'some_new_item' });
    for (let i = 0; i < 3; i++) await step(0.05);
    const json = JSON.stringify(personCalls(calls.slice(before))[0].state);
    // 玩家状态串：道具表里的名字 + "用"的说法（use.label）；道具表里没有的也照报
    expect(json).toContain('拿出「雷符」掐诀，掷出去');
    expect(json).toContain('拿出「some_new_item」用了');
  });

  it('一人一发：两个人各发各的，state 里只有他自己（别人只在"旁边有"里）', async () => {
    const { brain, calls, step } = makeBrain({ config: CONFIG2 });
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    const a = personCalls(calls, '面摊老板')[0];
    const b = personCalls(calls, '洗衣婆')[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(JSON.stringify(a.state)).not.toContain('"洗衣婆":{');
    expect(JSON.stringify(b.state)).not.toContain('"面摊老板":{');
    expect(a.questions.act.instructions).toContain('面摊老板');
    expect(b.questions.act.instructions).toContain('洗衣婆');
  });

  it('并发：在途上限以内一起发（Laya 在 GPU 上合批），两个人同一帧都问出去', async () => {
    const { brain, deps, calls, step } = makeBrain({ config: CONFIG2 });
    (deps.transport.decide as ReturnType<typeof vi.fn>).mockImplementation((body: { state: unknown; questions: Record<string, unknown> }) => {
      calls.push(body as never);
      return new Promise<JevCallResult>(() => {}); // 都卡在途中
    });
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    expect(personCalls(calls).length).toBe(2);
    expect(brain.getDebugState().inFlight).toBe(2);
    expect(brain.getDebugState().queueLength).toBe(0);
  });

  it('分层·停：太远的人日常决策、大事都不问，照旧走默认逻辑', async () => {
    const { brain, calls, state, step, fireAction, deps } = makeBrain({
      pick: STAY_PICK, config: CONFIG2, at: { n1: [10, 0], n2: [5000, 0] },
    });
    state.onScreen = false;
    brain.setEnabled(true);
    for (let i = 0; i < 10; i++) await step();
    fireAction('setSceneDim', { scale: 0.3 }); // 大事
    for (let i = 0; i < 10; i++) await step();
    expect(personCalls(calls, '洗衣婆').length).toBe(0);
    expect(personCalls(calls, '面摊老板').length).toBe(2); // 开场一次 + 大事一次
    expect(deps.stopNpcPatrol).not.toHaveBeenCalledWith('n2');
    const row = brain.getDebugState().people.find((p) => p.npcId === 'n2')!;
    expect(row.tier).toBe('停');
    expect(row.takenOver).toBe(false);
  });

  it('分层·拉近补问：从停走到近处时，远处出过大事就立刻补问一次，state 里带着那件事', async () => {
    const { brain, calls, state, step, fireAction } = makeBrain({
      pick: STAY_PICK, config: CONFIG2, at: { n1: [10, 0], n2: [5000, 0] },
    });
    state.onScreen = false;
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    fireAction('setSceneDim', { scale: 0.3 });
    for (let i = 0; i < 6; i++) await step();
    expect(personCalls(calls, '洗衣婆').length).toBe(0);
    state.player = { x: 4900, y: 0 }; // 玩家走过去
    for (let i = 0; i < 3; i++) await step();
    const ask = personCalls(calls, '洗衣婆');
    expect(ask.length).toBe(1);
    expect(JSON.stringify(ask[0].state)).toContain('天一下黑得像锅底');
    expect(brain.getDebugState().callsPerMinute.catchup).toBe(1);
  });

  it('分层·远：大事最多隔 farEventGapSec 问一次（没到间隔就先记着）', async () => {
    const { brain, calls, state, step, fireAction } = makeBrain({
      pick: STAY_PICK, config: CONFIG2, at: { n1: [10, 0], n2: [1900, 300] }, // 离玩家 1700：远
    });
    state.onScreen = false;
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step(); // 开场：远一档从没问过，日常间隔早到了 → 问一次
    const first = personCalls(calls, '洗衣婆').length;
    expect(first).toBe(1);
    fireAction('setSceneDim', { scale: 0.3 });
    for (let i = 0; i < 50; i++) await step(); // 5 秒：还没到 10 秒
    expect(personCalls(calls, '洗衣婆').length).toBe(first);
    for (let i = 0; i < 60; i++) await step(); // 过了 10 秒
    expect(personCalls(calls, '洗衣婆').length).toBe(first + 1);
  });

  it('分层·近：刚做完决定的 commitSec 内，小事不打断他；过了再问', async () => {
    const { brain, calls, bus, step } = makeBrain({ pick: STAY_PICK });
    brain.setEnabled(true);
    for (let i = 0; i < 3; i++) await step(); // 开场那发问完、落地
    const n0 = personCalls(calls).length;
    expect(n0).toBe(1);
    bus.emit('player:posture', { to: 'crouch' }); // 小事
    for (let i = 0; i < 15; i++) await step(); // 1.5 秒：还在刚做决定的 3 秒里
    expect(personCalls(calls).length).toBe(n0);
    for (let i = 0; i < 25; i++) await step(); // 过了 3 秒
    expect(personCalls(calls).length).toBe(n0 + 1);
  });

  it('背景巡检：固定频率挑远处等得最久的人问，总量跟远处有多少人无关', async () => {
    const { brain, state, step } = makeBrain({
      pick: STAY_PICK, config: CONFIG_MANY,
      at: { n1: [10, 0], f1: [6000, 0], f2: [6100, 0], f3: [6200, 0], f4: [6300, 0] },
    });
    state.onScreen = false;
    brain.setEnabled(true);
    for (let i = 0; i < 120; i++) await step(0.5); // 60 秒
    const s = brain.getDebugState();
    expect(s.tierCounts['停']).toBe(4);
    // 15 秒一次：60 秒里 3~4 次，不是 4 个人各问好几次
    expect(s.callsPerMinute.background).toBeGreaterThanOrEqual(3);
    expect(s.callsPerMinute.background).toBeLessThanOrEqual(4);
    expect(s.callsPerMinute.routine + s.callsPerMinute.event).toBeLessThanOrEqual(8); // 只有近处那一个人在问
  }, 20000);

  it('排队：超过在途上限的在本地排着，前一发回来了才发下一发', async () => {
    const releases: ((v: JevCallResult) => void)[] = [];
    const { brain, deps, calls, step } = makeBrain({
      config: { ...CONFIG2, tuning: { ...CONFIG2.tuning, maxConcurrentRequests: 1 } },
    });
    (deps.transport.decide as ReturnType<typeof vi.fn>).mockImplementation((body: { state: unknown; questions: Record<string, unknown> }) => {
      calls.push(body as never);
      return new Promise<JevCallResult>((r) => releases.push(r));
    });
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    expect(calls.length).toBe(1);
    expect(brain.getDebugState().queueLength).toBe(1);
    releases[0]({ ok: true, body: { answers: { act: { choice: 'carry_on', probabilities: { carry_on: 1 } } } }, latencyMs: 1 });
    for (let i = 0; i < 2; i++) await step();
    expect(calls.length).toBe(2);
  });

  it('请求在途时街上又出了事：旧答案落地后，被重新标记的人马上再问一遍（不被旧答案吞掉）', async () => {
    let release: (v: JevCallResult) => void = () => {};
    const { brain, deps, calls, step, fireAction } = makeBrain();
    const decide = deps.transport.decide as ReturnType<typeof vi.fn>;
    const real = decide.getMockImplementation()!;
    decide.mockImplementationOnce((body: { state: unknown; questions: Record<string, unknown> }) => {
      calls.push(body as never);
      return new Promise<JevCallResult>((r) => { release = r; });
    });
    brain.setEnabled(true);
    for (let i = 0; i < 4; i++) await step(); // 第一发发出去、卡在途中
    const sent = calls.length;
    fireAction('screenFlash', {}); // 在途期间街上出事
    release({ ok: true, body: { answers: { act: { choice: 'carry_on', probabilities: { carry_on: 1 } } } }, latencyMs: 1 });
    decide.mockImplementation(real);
    for (let i = 0; i < 3; i++) await step(0.05);
    const again = personCalls(calls.slice(sent));
    expect(again.length).toBe(1);
    expect(JSON.stringify(again[0].state)).toContain('白光闪过');
  });

  it('显著度由决策服务判："会不会害怕"的概率写回事件，调试面板看得到', async () => {
    const { brain, step, fireVfx } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    fireVfx('start', 'lightning_bolt_01', { x: 300, y: 0 });
    for (let i = 0; i < 4; i++) await step(0.05);
    const s = brain.getDebugState();
    expect(s.events.some((e) => e.includes('天雷') && e.includes('判会怕 0.95，算事'))).toBe(true);
    expect(s.tension).toBeGreaterThan(0.9);
  });

  it('服务端截断了 state（Laya 只在 warnings 里说）：状态牌上看得到，不当成失败', async () => {
    const { brain, deps, step } = makeBrain();
    (deps.transport.decide as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true,
      body: {
        model: 'laya-multilingual',
        answers: { act: { type: 'choice', choice: 'carry_on', probabilities: { carry_on: 0.6 }, confidence: 0.3 } },
        usage: { input_tokens: 2048, cost: 0, state_tokens: 1937 },
        latency_ms: 1985.9,
        warnings: ['state truncated: 1937 tokens, laya-multilingual only reads the first 967'],
      },
      latencyMs: 2000,
    } satisfies JevCallResult));
    brain.setEnabled(true);
    for (let i = 0; i < 4; i++) await step();
    const s = brain.getDebugState();
    expect(s.warningCount).toBe(1);
    expect(s.warnings[0]).toContain('state truncated');
    expect(s.servedModel).toBe('laya-multilingual');
    expect(s.stateTokens).toBe(1937);
    expect(s.cost).toBe(0);
    expect(s.costEstimated).toBe(false);
    expect(s.people[0].pick).toBe('carry_on');
  });

  it('决策服务连不上（Laya 被关了）：状态说连不上、隔一阵再试，不接管、不报崩', async () => {
    const { brain, deps, npc, step } = makeBrain();
    (deps.transport.decide as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: false, kind: 'unreachable', message: '连不上 http://a:1：ECONNREFUSED', status: 502, latencyMs: 3,
    } satisfies JevCallResult));
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    const s = brain.getDebugState();
    expect(s.status).toBe('error');
    expect(s.lastError).toContain('服务连不上');
    expect(deps.stopNpcPatrol).not.toHaveBeenCalled();
    expect(npc.moves).toEqual([]);
    // 退避期间不再发
    const n = (deps.transport.decide as ReturnType<typeof vi.fn>).mock.calls.length;
    for (let i = 0; i < 20; i++) await step();
    expect((deps.transport.decide as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n);
  });

  it('对街坊按 E：走回话通道立刻问（不含"不开腔"），回的话冒正式气泡、牌子上标成回你的话', async () => {
    const { brain, bus, calls, deps, step } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    const before = calls.length;
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    await step(0.05);
    // 同一帧发出去：回话那发（并发以内，"搭话"这件事的显著度也一起发了）
    const last = calls.slice(before).find((c) => 'reply' in c.questions)!;
    expect(last).toBeDefined();
    expect(Object.keys(last.questions).sort()).toEqual(['act', 'reply']);
    expect(last.questions.reply.instructions).toContain('搭话');
    expect(last.questions.reply.criteria.silent).toBeUndefined();
    expect(JSON.stringify(last.state)).toContain('关二狗在十字口找面摊老板说话');
    // 平常时：没出过事就没有"摆刚才那件事"
    expect(last.questions.reply.criteria.about_event).toBeUndefined();
    await step(0.05);
    const replyCall = (deps.speak as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[3]?.reply === true);
    expect(replyCall).toBeDefined();
    const row = brain.getDebugState().people[0];
    expect(row.say).toBe(replyCall![1]);
    expect(row.sayIsReply).toBe(true);
  });

  it('按 E 时刚出过事：回话能摆那件事，句子里填的是那件事的短名与地点（不写死任何一种事）', async () => {
    const { brain, bus, calls, deps, step, fireVfx } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    fireVfx('start', 'lightning_bolt_03', { x: 300, y: 0 });
    for (let i = 0; i < 4; i++) await step(0.05);
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    for (let i = 0; i < 3; i++) await step(0.05);
    const q = calls.find((c) => 'reply' in c.questions)!.questions.reply;
    expect(q.criteria.about_event).toContain('十字口那边出现了天雷');
    expect(q.criteria.blame).toBeDefined();
    expect(deps.speak).toHaveBeenCalledWith('n1', '刚才十字口那边那天雷，你看到没得？', expect.any(Number), { reply: true, scale: 2.2 });
  });

  it('回话不排在常规决策后头：常规那发卡在途中（排队上限已占满），按 E 照样马上问', async () => {
    const { brain, bus, deps, calls, step } = makeBrain({ config: { ...CONFIG, tuning: { ...CONFIG.tuning, maxConcurrentRequests: 1 } } });
    const decide = deps.transport.decide as ReturnType<typeof vi.fn>;
    const real = decide.getMockImplementation()!;
    decide.mockImplementationOnce((body: { state: unknown; questions: Record<string, unknown> }) => {
      calls.push(body as never);
      return new Promise<JevCallResult>(() => {}); // 永不回
    });
    brain.setEnabled(true);
    for (let i = 0; i < 4; i++) await step();
    decide.mockImplementation(real);
    const sent = calls.length;
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    await step(0.05);
    expect(calls.length).toBe(sent + 1);
    expect('reply' in calls[calls.length - 1].questions).toBe(true);
  });

  it('闲话：人不在屏幕上就不说，牌子上也没有（说了就一定冒气泡）', async () => {
    const { brain, deps, state, step } = makeBrain();
    state.onScreen = false;
    brain.setEnabled(true);
    for (let i = 0; i < 8; i++) await step();
    expect(deps.speak).not.toHaveBeenCalled();
    expect(brain.getDebugState().people[0].say).toBeNull();
  });

  it('闲话被挤住（同屏气泡太多）先排队，挪开了就冒；气泡收了牌子上也跟着收', async () => {
    const { brain, deps, state, step } = makeBrain();
    state.bubbles = 99;
    brain.setEnabled(true);
    for (let i = 0; i < 8; i++) await step();
    expect(deps.speak).not.toHaveBeenCalled();
    state.bubbles = 0;
    await step();
    expect(deps.speak).toHaveBeenCalledWith('n1', '牛肉面！', expect.any(Number), { reply: false, scale: 2.2 });
    expect(brain.getDebugState().people[0].say).toBe('牛肉面！');
    for (let i = 0; i < 60; i++) await step(); // 6 秒后气泡早收了
    expect(brain.getDebugState().people[0].say).toBeNull();
  });

  it('花费：累计 + 照最近的节奏估一小时（直连官方没有花费字段，按 token × 官方价估）', async () => {
    const { brain, step } = makeBrain();
    brain.setEnabled(true);
    expect(brain.getDebugState().costPerHourUsd).toBeNull(); // 刚打开，数据不够
    for (let i = 0; i < 300; i++) await step(); // 30 秒
    const s = brain.getDebugState();
    expect(s.requests).toBeGreaterThan(0);
    expect(s.costEstimated).toBe(true);
    expect(s.cost).toBeCloseTo((s.inputTokens / 1e6) * 0.042, 10);
    expect(s.costPerHourUsd).toBeGreaterThan(0);
    expect(s.costPerHourUsd!).toBeCloseTo(s.cost * (3600 / s.rateWindowSec), 6);
  }, 20000);

  it('暂停 / 非探索态：钟不走、不发请求', async () => {
    const { brain, calls, state, step } = makeBrain();
    state.paused = true;
    brain.setEnabled(true);
    for (let i = 0; i < 10; i++) await step();
    expect(calls.length).toBe(0);
    expect(brain.getDebugState().clock).toBe(0);
  });

  it('选择题先分"应付不应付"：受惊反应的概率加起来大过"接着做"，就在受惊反应里挑（选票不被拆散）', async () => {
    const { brain, step } = makeBrain();
    brain.setEnabled(true);
    await step();
    const b = brain as unknown as {
      actors: Map<string, unknown>;
      world(): unknown;
      arbitrate(e: unknown, menu: { key: string; kind: string; text: string }[], ans: unknown, w: unknown): { key: string } | null;
    };
    const e = b.actors.get('n1');
    const menu = [
      { key: 'carry_on', kind: 'carry_on', text: '接着点货' },
      { key: 'flee', kind: 'flee', text: '撒腿就跑' },
      { key: 'cower', kind: 'cower', text: '蹲下抱头' },
      { key: 'startle', kind: 'startle', text: '吓一跳' },
    ];
    const pick = (probabilities: Record<string, number>) =>
      b.arbitrate(e, menu, { choice: 'carry_on', probabilities, confidence: 0.5 }, b.world())?.key;
    // 接着做 0.45，受惊的 0.28 + 0.16 + 0.11 = 0.55：他会被吓到，挑受惊里最高的
    expect(pick({ carry_on: 0.45, flee: 0.28, cower: 0.16, startle: 0.11 })).toBe('flee');
    // 接着做 0.7，受惊的加起来 0.3：照做
    expect(pick({ carry_on: 0.7, flee: 0.15, cower: 0.1, startle: 0.05 })).toBe('carry_on');
  });

  it('全量快照：天气（天色 / 风 / 看得到的效果）、关二狗先前干的事、跟他说过的话都进', async () => {
    const { brain, state, bus, step } = makeBrain();
    brain.setEnabled(true);
    await step();
    state.dim = 0.3;
    state.wind = { speed: 50, base: 20 };
    state.effects = ['lightning_bolt_01'];
    bus.emit('item:use', { itemId: 'leifu', consume: true, actions: [] });
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    await step();
    const snaps = brain.captureSnapshots();
    const me = snaps.find((s) => s.person?.label === '面摊老板')!;
    expect(me.weather).toBe('天色黑得跟半夜一样，刮起了大风，看得到：天雷');
    // "接着做"就是他自己那摊事：说法不带"接着"，也不写成"响动以后才换成这样"
    expect(me.person?.doing).not.toMatch(/^接着/);
    expect(me.person?.doing).not.toContain('才换成这样');
    expect(me.player?.recent?.some((r) => r.includes('雷符'))).toBe(true);
    expect(me.person?.dialogue?.[0]).toMatch(/^关二狗：（走到跟前找他说话/);
  });

  it('引擎的动作串：同一串的动作与效果是一簇、按发起方认是不是关二狗起的头；串结束 = 事平息', async () => {
    const { brain, step, fireAction, fireVfx, endRun } = makeBrain();
    brain.setEnabled(true);
    await step();
    const run = { id: 41, initiator: { kind: 'item', id: 'leifu' } };
    fireAction('setSceneDim', { scale: 0.3 }, run);
    fireVfx('start', 'lightning_bolt_03', { x: 300, y: 0 }, 41);
    await step();
    const inRun = () => brain.getDebugState().events.filter((e) => e.includes('串 41'));
    expect(inRun().length).toBeGreaterThanOrEqual(1);
    expect(inRun().every((e) => e.includes('item:leifu') && !e.includes('已平息'))).toBe(true);
    endRun(run);
    await step();
    expect(inRun().every((e) => e.includes('已平息'))).toBe(true);
    // 叙事图起的头：不算关二狗搞的
    const world = { id: 42, initiator: { kind: 'narrative', id: 'g' } };
    fireVfx('start', 'lightning_bolt_01', { x: 300, y: 0 }, 42);
    fireAction('setSceneDim', { scale: 0.5 }, world);
    await step();
    expect(brain.getDebugState().events.some((e) => e.includes('串 42'))).toBe(true);
  });

  it('destroy 摘掉全部监听（含动作执行器 / 串结束 / 粒子系统的旁听）', async () => {
    const { brain, bus, deps, taps, step } = makeBrain();
    brain.setEnabled(true);
    await step();
    expect(taps.action.size).toBe(1);
    expect(taps.runEnd.size).toBe(1);
    expect(taps.vfx.size).toBe(1);
    brain.destroy();
    expect(taps.action.size).toBe(0);
    expect(taps.runEnd.size).toBe(0);
    expect(taps.vfx.size).toBe(0);
    bus.emit('item:use', { itemId: 'leifu' });
    expect(deps.stopNpcPatrol).not.toHaveBeenCalled();
  });
});

// ───────────────────────── 逐项是非（Laya） ─────────────────────────

const PO_CONFIG = {
  ...CONFIG,
  lineCategories: { hawk: '吆喝', scream: '惊叫' },
  ambientCategories: ['hawk'],
  people: [{ ...CONFIG.people[0], says: ['hawk', 'scream'], lines: { hawk: ['牛肉面！'], scream: ['哎呀妈呀！'] } }],
  tuning: { decisionMode: 'perOption' },
};

type Call = { state: unknown; questions: Record<string, { type: string; instructions: string }> };

const isBaseline = (c: Call) => Object.keys(c.questions).every((k) => /^b\d+$/.test(k));
/** 对照"去掉他是谁"：身份、脾气换成 N/A */
const isAnon = (c: Call) => JSON.stringify(c.state).includes('"是啥子":"N/A"');
/** 对照"去掉刚才的事" */
const isNoEvents = (c: Call) => JSON.stringify(c.state).includes('"刚才街上发生的事":["没得啥子特别的事"]');
const isSalience = (c: Call) => 'sal' in c.questions;
const decisionCalls = (calls: Call[]) => calls.filter((c) => !isBaseline(c) && !isSalience(c));

/**
 * 替身 Laya 的是非题：按 state（去掉他是谁 / 平常 / 出了雷 / 有人找他说话）和陈述里说的是啥给概率。
 * "去掉刚才的事"的对照里没有雷、没有说话，按平常给。
 * 选的数让"原始概率最高"和"比对照涨得最多"挑出来的不一样——测的是后者。
 */
function poJudge(state: unknown, statement: string): number {
  const s = JSON.stringify(state);
  const has = (t: string) => statement.includes(t);
  if (s.includes('"是啥子":"N/A"')) {
    if (has('走到十字口去')) return 0.3;
    if (has('接着煮面')) return 0.6;
    if (has('走到洗衣台去')) return 0.5;
    return 0.3;
  }
  const scary = s.includes('雷');
  const talk = s.includes('说话');
  if (has('会害怕')) return scary ? 0.95 : 0.3;
  if (has('放下手上的事')) return scary ? 0.85 : 0.3;
  if (has('撒腿就跑')) return scary ? 0.9 : 0.2;
  if (has('朝出事的那边望')) return scary ? 0.95 : 0.7; // 原始概率最高，但只涨 0.25
  if (has('开腔惊叫')) return scary ? 0.7 : 0.1;
  if (has('开腔吆喝')) return scary ? 0.45 : 0.5;
  if (has('正忙着煮面')) return talk ? 0.8 : 0.3;
  if (has('招呼')) return talk ? 0.9 : 0.8; // 原始概率最高，但只涨 0.1
  if (has('走到十字口去')) return 0.7;
  if (has('接着煮面')) return 0.75;
  if (has('走到洗衣台去')) return 0.6;
  return 0.3;
}

function usePoJudge(
  deps: WorldBrainDeps,
  calls: Call[],
  failBaseline: () => boolean = () => false,
  judge: (state: unknown, statement: string) => number = poJudge,
): void {
  (deps.transport.decide as ReturnType<typeof vi.fn>).mockImplementation(async (body: Call) => {
    calls.push(body);
    if (isBaseline(body) && failBaseline()) {
      return { ok: false, kind: 'http', message: '500', status: 500, latencyMs: 1 } satisfies JevCallResult;
    }
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries(body.questions)) {
      answers[k] = { type: 'noul', noul: judge(body.state, q.instructions), confidence: 0.9 };
    }
    return { ok: true, body: { answers, usage: { input_tokens: 50 } }, latencyMs: 30 } satisfies JevCallResult;
  });
}

describe('WorldBrainSystem · 逐项是非', () => {
  it('平常时：只问日常的下一件（不问打断），跟"去掉他是谁"比涨得最多的胜出——不是原始概率最高的', async () => {
    const { brain, deps, calls, step } = makeBrain({ config: PO_CONFIG });
    usePoJudge(deps, calls as never);
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    const d = decisionCalls(calls as never);
    expect(d.length).toBe(1);
    const qs = Object.entries(d[0].questions);
    expect(qs.every(([, q]) => q.type === 'noul')).toBe(true);
    expect(qs.some(([k]) => k === 'g')).toBe(false);
    expect(qs.some(([k]) => k.startsWith('s'))).toBe(false); // 平常时不问开不开腔
    // 对照"去掉他是谁"一发，跟决策同时发、照同一个街面（只有身份、脾气换成 N/A）
    const anon = (calls as never as Call[]).filter((c) => isBaseline(c) && isAnon(c));
    expect(anon.length).toBe(1);
    const live = JSON.stringify(d[0].state).replace('"是啥子":"卖面的","脾气":"胆小"', '"是啥子":"N/A","脾气":"N/A"');
    expect(JSON.stringify(anon[0].state)).toBe(live);
    const s = brain.getDebugState();
    expect(s.decisionMode).toBe('perOption');
    // 接着煮面原始 0.75 最高，但只比对照涨 0.15（+ 接着做加分 0.1）；去十字口涨 0.4
    expect(s.people[0].pick).toBe('go:b');
    expect(s.people[0].p).toBeCloseTo(0.4, 5);
  });

  it('对照每一发现问、用完即删（不缓存、不越积越多）；街上啥都没出时不问打断', async () => {
    const { brain, deps, calls, step } = makeBrain({ config: PO_CONFIG });
    usePoJudge(deps, calls as never);
    brain.setEnabled(true);
    for (let i = 0; i < 80; i++) await step(0.5); // 40 秒：走到十字口、歇够、再想好几回
    const d = decisionCalls(calls as never);
    expect(d.length).toBeGreaterThan(1);
    // 每一发日常决策都配一发"去掉他是谁"
    expect((calls as never as Call[]).filter((c) => isBaseline(c) && isAnon(c)).length).toBe(d.length);
    for (const c of d) expect('g' in c.questions).toBe(false);
    // 留着的对照只属于还没落地的那一发（落了就删）
    const b = brain as unknown as {
      baseValues: Map<string, number>; baselinePending: Set<string>;
      pending: { job: { seq: number } }[]; inFlightJobs: Map<number, unknown>;
    };
    const live = new Set([...b.pending.map((p) => p.job.seq), ...b.inFlightJobs.keys()]);
    for (const k of [...b.baseValues.keys(), ...b.baselinePending]) expect(live.has(Number(k.split('|')[0])), k).toBe(true);
    // 再推几帧让那一发落地：对照跟着删光
    for (let i = 0; i < 3; i++) await step(0.01);
    expect(b.pending.length).toBe(0);
    expect(b.baseValues.size).toBe(0);
  }, 20000);

  it('雷符：先问要不要放下手上的事（比"去掉刚才的事"涨够了才打断），打断了在反应里挑涨得最多的，并按涨幅开腔', async () => {
    const { brain, bus, deps, calls, step } = makeBrain({ config: PO_CONFIG });
    usePoJudge(deps, calls as never);
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    bus.emit('item:use', { itemId: 'leifu' });
    for (let i = 0; i < 4; i++) await step(0.05);
    const last = decisionCalls(calls as never).pop()!;
    expect(last.questions.g.instructions).toBe('「面摊老板」会放下手上的事，去应付刚才街上的事。');
    // 平常话（吆喝，ambientCategories 里的）判不了，不出题；惊叫出题
    const statements = Object.values(last.questions).map((q) => q.instructions);
    expect(statements.some((s) => s.includes('开腔吆喝'))).toBe(false);
    expect(statements.some((s) => s.includes('开腔惊叫'))).toBe(true);
    // 对照"去掉刚才的事"：同一个街面、同一个他，只是没有那道雷
    const cf = (calls as never as Call[]).filter((c) => isBaseline(c) && !isAnon(c) && isNoEvents(c));
    expect(cf.length).toBe(1);
    expect(JSON.stringify(cf[0].state)).toContain('"是啥子":"卖面的"');
    expect(JSON.stringify(cf[0].state)).not.toContain('雷');
    // 对照 = 同一个街面去掉刚才的事：栏目一样，只有"刚才的事"和跟它对时间的那几句（"雷符之前就这样……"）变成平常说法
    const strip = (s: unknown) => JSON.stringify(s).replace(/（[^（）]*(之前就这样|以后的事|那会儿正在做这个|的时候正在做这个)[^（）]*）/g, '');
    const liveNoEvents = strip({ ...(last.state as Record<string, unknown>), 刚才街上发生的事: ['没得啥子特别的事'] });
    expect(strip(cf[0].state)).toBe(liveNoEvents);
    const row = brain.getDebugState().people[0];
    // 朝那边望原始 0.95 最高，但只涨 0.25；撒腿就跑涨 0.7
    expect(row.pick).toBe('flee');
    expect(row.gate).toBeCloseTo(0.55, 5);
    expect(deps.speak).toHaveBeenCalledWith('n1', '哎呀妈呀！', expect.any(Number), { reply: false, scale: 2.2 });
  });

  it('小事、没涨够：接着做手上的事，不换（不问日常的下一件）', async () => {
    const { brain, bus, deps, npc, calls, step } = makeBrain({ config: PO_CONFIG });
    usePoJudge(deps, calls as never);
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    expect(brain.getDebugState().people[0].pick).toBe('go:b');
    const moves = npc.moves.length;
    const before = decisionCalls(calls as never).length;
    bus.emit('player:posture', { to: 'crouch' });
    for (let i = 0; i < 40; i++) await step(); // 过了 commitSec
    const d = decisionCalls(calls as never).slice(before);
    expect(d.length).toBe(1);
    expect('g' in d[0].questions).toBe(true);
    expect(Object.keys(d[0].questions).some((k) => k.startsWith('o'))).toBe(false);
    const row = brain.getDebugState().people[0];
    expect(row.gate).toBeCloseTo(0, 5);
    expect(row.pick).toBe('go:b');
    expect(npc.moves.length).toBe(moves);
  });

  it('按 E：回话按比平静时涨得最多的意图（说忙），不是原始概率最高的（招呼）', async () => {
    const cfg = { ...PO_CONFIG, people: [{ ...PO_CONFIG.people[0], haunts: [] }] };
    const { brain, bus, deps, calls, step } = makeBrain({ config: cfg });
    usePoJudge(deps, calls as never);
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    expect(brain.getDebugState().people[0].pick).toBe('carry_on');
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    for (let i = 0; i < 3; i++) await step(0.05);
    expect(deps.speak).toHaveBeenCalledWith('n1', '锅要糊了，等哈！', expect.any(Number), { reply: true, scale: 2.2 });
    expect(brain.getDebugState().people[0].sayIsReply).toBe(true);
  });

  it('平常话交给编排：开始一件日常的事时按 ambientSayChance 说一句（只从 ambientCategories 里挑）', async () => {
    const cfg = { ...PO_CONFIG, people: [{ ...PO_CONFIG.people[0], haunts: [] }], tuning: { decisionMode: 'perOption', ambientSayChance: 1 } };
    const { brain, deps, calls, step } = makeBrain({ config: cfg });
    usePoJudge(deps, calls as never);
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    expect(deps.speak).toHaveBeenCalledWith('n1', '牛肉面！', expect.any(Number), { reply: false, scale: 2.2 });
    expect(deps.speak).not.toHaveBeenCalledWith('n1', '哎呀妈呀！', expect.anything(), expect.anything());
  });

  it('全量上下文：问要不要应付刚才的事时也带"看得见的人"（09-22 起不再为 Laya 拿掉），旁人的样子跟那件事对时间', async () => {
    const { brain, bus, deps, calls, step } = makeBrain({ config: { ...PO_CONFIG, people: [...PO_CONFIG.people, CONFIG2.people[1]] } });
    usePoJudge(deps, calls as never);
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    const routine = decisionCalls(calls as never).find((c) => JSON.stringify(c.state).includes('"面摊老板":{'))!;
    expect(JSON.stringify(routine.state)).toContain('看得见的人');
    bus.emit('item:use', { itemId: 'leifu' });
    for (let i = 0; i < 4; i++) await step(0.05);
    const gated = decisionCalls(calls as never).filter((c) => 'g' in c.questions);
    expect(gated.length).toBeGreaterThan(0);
    for (const c of gated) {
      const json = JSON.stringify(c.state);
      expect(json).toContain('看得见的人');
      // 旁人的样子写明是出事前就这样还是出事后才换的（不写的话"全街没一个人动"）
      expect(json).toMatch(/之前就这样，到这会儿还没动|才换成这样，是[^"]*以后的事/);
    }
  });

  it('没被惊动到放下手上的事：就算惊叫那类话涨了也不开腔（街上没事不喊"妈哟"）', async () => {
    // 替身：蹲一下让"惊叫"涨 0.5，但"放下手上的事"不涨
    const judge = (state: unknown, statement: string) => {
      const events = JSON.stringify((state as Record<string, unknown>)['刚才街上发生的事'] ?? []);
      const crouched = events.includes('蹲下去了');
      if (statement.includes('开腔惊叫')) return crouched ? 0.6 : 0.1;
      return poJudge(state, statement);
    };
    const { brain, bus, deps, calls, state, step } = makeBrain({ config: PO_CONFIG });
    usePoJudge(deps, calls as never, () => false, judge);
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    state.posture = 'crouch';
    bus.emit('player:posture', { from: null, to: 'crouch' });
    for (let i = 0; i < 40; i++) await step();
    const d = brain.inspect('n1')!.history.pop()!;
    expect(d.gate).toBeCloseTo(0, 5);
    expect(d.rows.find((r) => r.group === '开腔')?.score).toBeCloseTo(0.5, 5);
    expect(deps.speak).not.toHaveBeenCalledWith('n1', '哎呀妈呀！', expect.anything(), expect.anything());
  });

  it('对照没拿到：不拿原始概率乱挑，不接管；下回再问（对照跟着再问一次）', async () => {
    let fail = true;
    const { brain, deps, calls, step } = makeBrain({ config: PO_CONFIG });
    usePoJudge(deps, calls as never, () => fail);
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    expect(deps.stopNpcPatrol).not.toHaveBeenCalled();
    expect(brain.getDebugState().people[0].pick).toBeNull();
    fail = false;
    for (let i = 0; i < 60; i++) await step(); // 近处日常间隔 4 秒
    expect((calls as never as Call[]).filter((c) => isBaseline(c) && isAnon(c)).length).toBeGreaterThanOrEqual(2);
    expect(brain.getDebugState().people[0].pick).toBe('go:b');
  });

  it('auto：连的是 Laya 用逐项是非，其余用选择题', async () => {
    const a = makeBrain({ config: { ...PO_CONFIG, tuning: {} } });
    a.deps.transport.status = async () => ({ reachable: true, configured: true, provider: 'laya' });
    usePoJudge(a.deps, a.calls as never);
    a.brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await a.step();
    expect(a.brain.getDebugState().decisionMode).toBe('perOption');
    expect(Object.values(decisionCalls(a.calls as never)[0].questions).every((q) => q.type === 'noul')).toBe(true);

    const b = makeBrain({ config: { ...PO_CONFIG, tuning: {} } });
    b.deps.transport.status = async () => ({ reachable: true, configured: true, provider: 'vercel' });
    b.brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await b.step();
    expect(b.brain.getDebugState().decisionMode).toBe('choice');
    expect('act' in b.calls[0].questions).toBe(true);
  });
});

// ───────────────────────── 发道具 / 怕的门槛 / 人与人 / 切换 / 详情 ─────────────────────────

const HANDOUT_CONFIG = {
  ...CONFIG,
  people: [{
    ...CONFIG.people[0],
    replies: { ...CONFIG.people[0].replies, give: ['拿到，莫说是我给的。'] },
    handOut: [{ item: 'leifu' }, { item: 'bug_jar', count: 2, upTo: 2 }, { item: 'nope_item' }],
  }],
};

describe('WorldBrainSystem · 发道具的职责', () => {
  it('找他说话：回话只有"把东西塞给你"一种，照玩家缺的给（走背包的正式入口），说"给你"那句；都有了就不再给', async () => {
    const { brain, bus, deps, calls, state, step } = makeBrain({ config: HANDOUT_CONFIG });
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    for (let i = 0; i < 3; i++) await step(0.05);
    const reply = calls.find((c) => 'reply' in c.questions)!;
    expect(Object.keys(reply.questions.reply.criteria)).toEqual(['give']);
    expect(reply.questions.reply.criteria.give).toContain('「雷符」「虫罐」');
    expect(state.inv).toEqual({ leifu: 1, bug_jar: 2 }); // 道具表里没有的那样跳过
    expect(deps.speak).toHaveBeenCalledWith('n1', '拿到，莫说是我给的。', expect.any(Number), { reply: true, scale: 2.2 });
    for (let i = 0; i < 40; i++) await step();
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    for (let i = 0; i < 3; i++) await step(0.05);
    const second = calls.filter((c) => 'reply' in c.questions)[1];
    expect(second.questions.reply.criteria.give).toBeUndefined();
    expect(deps.giveItem).toHaveBeenCalledTimes(2);
  });

  it('决策服务出错也照给（职责不看它挑不挑）', async () => {
    const { brain, bus, deps, state, step } = makeBrain({ config: HANDOUT_CONFIG, pick: 'no_key' });
    brain.setEnabled(true);
    for (let i = 0; i < 4; i++) await step();
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    for (let i = 0; i < 130; i++) await step(); // 出错后退避 10 秒
    expect(state.inv.leifu).toBe(1);
    expect(deps.speak).toHaveBeenCalledWith('n1', '拿到，莫说是我给的。', expect.any(Number), { reply: true, scale: 2.2 });
    expect(brain.inspect('n1')!.history.some((h) => h.outcome.includes('发道具：雷符'))).toBe(true);
  }, 20000);
});

describe('WorldBrainSystem · "怕"的门槛', () => {
  it('没有吓人的事：菜单里没有蹲下抱头 / 扑地 / 吓一跳；出了决策服务判成吓人的事才有', async () => {
    const { brain, calls, step, fireVfx } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    const calm = Object.values(personCalls(calls)[0].questions.act.criteria);
    for (const t of ['扑倒在地上趴起', '就地蹲下，抱到脑壳', '吓得一跳']) expect(calm).not.toContain(t);
    const before = calls.length;
    fireVfx('start', 'lightning_bolt_01', { x: 300, y: 0 });
    for (let i = 0; i < 4; i++) await step(0.05);
    const scared = Object.values(personCalls(calls.slice(before))[0].questions.act.criteria);
    for (const t of ['扑倒在地上趴起', '就地蹲下，抱到脑壳', '吓得一跳']) expect(scared).toContain(t);
  });

  it('新事的显著度还没判：常规决策先让一让（判完了再问，菜单才对）', async () => {
    let release: (v: JevCallResult) => void = () => {};
    const { brain, deps, calls, step, fireVfx } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    const decide = deps.transport.decide as ReturnType<typeof vi.fn>;
    const real = decide.getMockImplementation()! as (b: unknown) => Promise<JevCallResult>;
    decide.mockImplementation((body: { state: unknown; questions: Record<string, unknown> }) => {
      if ('sal' in body.questions) {
        calls.push(body as never);
        return new Promise<JevCallResult>((r) => { release = r; });
      }
      return real(body);
    });
    const before = personCalls(calls).length;
    fireVfx('start', 'lightning_bolt_01', { x: 300, y: 0 });
    for (let i = 0; i < 5; i++) await step(0.05);
    expect(personCalls(calls).length).toBe(before); // 在等显著度
    release({ ok: true, body: { answers: { sal: { noul: 0.95 } } }, latencyMs: 1 });
    decide.mockImplementation(real);
    for (let i = 0; i < 3; i++) await step(0.05);
    expect(personCalls(calls).length).toBe(before + 1);
  });
});

describe('WorldBrainSystem · 人与人相互影响', () => {
  it('每个人的 state 里有他看得见的人此刻在做啥', async () => {
    const { brain, calls, step } = makeBrain({ config: CONFIG2 });
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    const st = JSON.stringify(personCalls(calls, '洗衣婆')[0].state);
    expect(st).toContain('"看得见的人":["面摊老板（');
    expect(st).toContain('煮面');
  });

  it('某人说了吓人的话：看得见的人被惊动、再想一遍，state 里带着那句；他自己的 state 里不当成"街上的事"', async () => {
    const cfg = { ...CONFIG2, people: [{ ...CONFIG2.people[0], lines: { hawk: ['天黑了！快跑！'] } }, CONFIG2.people[1]] };
    const { brain, calls, step } = makeBrain({ config: cfg });
    brain.setEnabled(true);
    for (let i = 0; i < 10; i++) await step();
    const washer = personCalls(calls, '洗衣婆');
    expect(washer.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(washer[washer.length - 1].state)).toContain('面摊老板在十字口说：「天黑了！快跑！」');
    for (const c of personCalls(calls, '面摊老板')) {
      expect((c.state as Record<string, unknown>)['刚才街上发生的事']).not.toEqual(expect.arrayContaining([expect.stringContaining('面摊老板在')]));
    }
  });

  it('平常话（配置的 ambientCategories）不问显著度、不惊动别人（Laya 会把"生意淡"判成吓人，成假警报）', async () => {
    const cfg = {
      ...CONFIG2, ambientCategories: ['hawk'],
      people: [{ ...CONFIG2.people[0], lines: { hawk: ['天黑了！快跑！'] } }, CONFIG2.people[1]],
    };
    const { brain, calls, step } = makeBrain({ config: cfg });
    brain.setEnabled(true);
    for (let i = 0; i < 10; i++) await step();
    expect(personCalls(calls, '洗衣婆').length).toBe(1);
    expect(calls.some((c) => 'sal' in c.questions && JSON.stringify(c.state).includes('天黑了！快跑！'))).toBe(false);
  });

  it('平常走动不进别人的"刚才街上的事"（只在"看得见的人"里）', async () => {
    const { brain, calls, step } = makeBrain({ config: CONFIG2 });
    brain.setEnabled(true);
    for (let i = 0; i < 60; i++) await step();
    for (const c of personCalls(calls, '洗衣婆')) {
      const evs = (c.state as Record<string, unknown>)['刚才街上发生的事'] as string[];
      expect(evs.some((e) => e.includes('面摊老板在'))).toBe(false);
    }
  });

  it('玩家干的事：先只惊动跟前的人；决策服务判成吓人的，再惊动看得见的所有人', async () => {
    const { brain, bus, calls, step } = makeBrain({ config: CONFIG2, pick: STAY_PICK });
    brain.setEnabled(true);
    for (let i = 0; i < 5; i++) await step();
    const w0 = personCalls(calls, '洗衣婆').length;
    bus.emit('player:posture', { from: null, to: 'crouch' }); // 平常：洗衣婆离得远（500），不惊动
    for (let i = 0; i < 40; i++) await step();
    expect(personCalls(calls, '洗衣婆').length).toBe(w0);
    bus.emit('item:use', { itemId: 'leifu' }); // 替身判"雷"吓人 → 惊动看得见的人
    for (let i = 0; i < 4; i++) await step(0.05);
    const w = personCalls(calls, '洗衣婆');
    expect(w.length).toBe(w0 + 1);
    expect(JSON.stringify(w[w.length - 1].state)).toContain('拿出「雷符」掐诀，掷出去');
  });
});

describe('WorldBrainSystem · 游戏里切换与详情面板', () => {
  it('切决策服务：通道跟着切、在途作废、全街马上重想；切问法同样', async () => {
    const { brain, deps, calls, step } = makeBrain();
    const setBackend = vi.fn();
    deps.transport.setBackend = setBackend;
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    const n = personCalls(calls).length;
    brain.setBackend('jev');
    expect(setBackend).toHaveBeenCalledWith('jev');
    expect(brain.getDebugState().backend).toBe('jev');
    for (let i = 0; i < 3; i++) await step();
    expect(personCalls(calls).length).toBe(n + 1);
    brain.setDecisionMode('perOption');
    for (let i = 0; i < 3; i++) await step();
    expect(brain.getDebugState().decisionModeSetting).toBe('perOption');
    const last = calls.filter((c) => !('sal' in c.questions)).pop()!;
    expect(Object.values(last.questions).every((q) => (q as { type: string }).type === 'noul')).toBe(true);
  });

  it('详情：按 E 缺省不弹详情；开了「按 E 开详情」才切过去', async () => {
    const { brain, bus, step } = makeBrain();
    brain.setEnabled(true);
    for (let i = 0; i < 6; i++) await step();
    expect(brain.getDebugState().inspectOnInteract).toBe(false);
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    expect(brain.getDebugState().inspectTarget).toBeNull();
    brain.setInspectOnInteract(true);
    expect(brain.getDebugState().inspectOnInteract).toBe(true);
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    expect(brain.getDebugState().inspectTarget).toBe('n1');
    // 关掉开关不收起已经开着的面板
    brain.setInspectOnInteract(false);
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    expect(brain.getDebugState().inspectTarget).toBe('n1');
  });

  it('详情：开了「按 E 开详情」按 E 跟他说话就切过去；有身份、此刻在做啥、最近怎么想的（候选与挑中的）、最近一发问了啥回了啥', async () => {
    const { brain, bus, step } = makeBrain();
    brain.setEnabled(true);
    brain.setInspectOnInteract(true);
    for (let i = 0; i < 6; i++) await step();
    bus.emit('npc:interact', { npc: { def: { id: 'n1' } } });
    expect(brain.getDebugState().inspectTarget).toBe('n1');
    for (let i = 0; i < 3; i++) await step(0.05);
    const d = brain.inspect('n1')!;
    expect(d.identity).toBe('卖面的');
    expect(d.now.takenOver).toBe(true);
    const first = d.history[0];
    expect(first.outcome).toBe('挑了：走到十字口去');
    expect(first.rows.find((r) => r.picked && r.group === '走位')?.text).toBe('走到十字口去');
    expect(d.history[d.history.length - 1].layer).toBe('回话');
    expect(d.lastAsk!.questions.some((q) => q.key === 'reply' && q.answer.startsWith('挑 '))).toBe(true);
    expect(d.lastAsk!.state).toContain('找面摊老板说话');
  });
});
