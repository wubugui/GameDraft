/**
 * 通用小游戏「氛围脚本」运行时。
 *
 * 各小游戏只需：
 * 1. 定义自己的 step 类型（含 `op` 字段）；
 * 2. 调 `createMinigameScriptRunner` 传入 opcode handler 表与 vars；
 * 3. 在合适时机调 `runner.runPhase(steps)` 或 `runner.tick(dt)` 推进。
 *
 * 解释器自身只提供通用控制 op（pick / wait / chance）；
 * IO 类 op（say / when_near_sector 等）由宿主注册。
 */

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

/** 运行时上下文：由宿主在创建 runner 时注入。 */
export interface MinigameScriptContext {
  /** 伪随机 [0,1) */
  rng: () => number;
  /** 策划配置的命名文案池 */
  vars: Record<string, string[]>;
  /** 临时槽位（pick 写入、say 读取） */
  slots: Record<string, string>;
}

/** 一步指令的最小公共字段（宿主可扩展） */
export interface MinigameScriptStep {
  op: string;
}

/**
 * 单个 opcode 的处理函数。
 * 返回 `void`（同步完成）或 `number`（需等待的秒数，由 runner 计时）。
 */
export type OpcodeHandler<S extends MinigameScriptStep = MinigameScriptStep> = (
  step: S,
  ctx: MinigameScriptContext,
  runChildren: (steps: S[]) => Promise<void>,
) => void | number | Promise<void | number>;

/** opcode 注册表 */
export type OpcodeRegistry<S extends MinigameScriptStep = MinigameScriptStep> = Record<
  string,
  OpcodeHandler<S>
>;

// ---------------------------------------------------------------------------
// 通用 opcode
// ---------------------------------------------------------------------------

function pickFromPool(ctx: MinigameScriptContext, poolName: string): string {
  const arr = ctx.vars[poolName];
  if (!arr || arr.length === 0) return '';
  return arr[Math.floor(ctx.rng() * arr.length)];
}

/** 读取 step 上任意键（通用 opcode 不依赖具体 step 类型） */
function field(step: MinigameScriptStep, key: string): unknown {
  return (step as unknown as Record<string, unknown>)[key];
}

/** 内置通用 opcode；宿主注册的同名 op 会覆盖。 */
export function coreOpcodes<S extends MinigameScriptStep>(): OpcodeRegistry<S> {
  return {
    pick(step, ctx) {
      const pool = String(field(step, 'pool') ?? '');
      const slot = String(field(step, 'slot') ?? '_line');
      ctx.slots[slot] = pool ? pickFromPool(ctx, pool) : '';
    },

    wait(step) {
      const sec = Number(field(step, 'sec') ?? 0);
      return Math.max(0, sec);
    },

    chance(step, ctx, runChildren) {
      const p = Number(field(step, 'p') ?? 0);
      if (ctx.rng() < p) {
        const then = field(step, 'then');
        if (Array.isArray(then) && then.length > 0) {
          return runChildren(then as S[]);
        }
      }
    },
  } as OpcodeRegistry<S>;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface MinigameScriptRunner<S extends MinigameScriptStep = MinigameScriptStep> {
  /** 启动一个阶段的步骤列表（会 cancel 上一个正在跑的阶段） */
  runPhase(steps: S[]): void;
  /** 每帧调用，dt 秒 */
  tick(dt: number): void;
  /** 立即取消当前阶段 */
  cancel(): void;
  readonly running: boolean;
}

export function createMinigameScriptRunner<S extends MinigameScriptStep>(
  registry: OpcodeRegistry<S>,
  ctx: MinigameScriptContext,
): MinigameScriptRunner<S> {
  let gen: Generator<number, void, void> | null = null;
  let waitRemain = 0;

  function* execute(steps: S[]): Generator<number, void, void> {
    for (const step of steps) {
      const handler = registry[step.op];
      if (!handler) {
        console.warn(`[minigameScript] unknown op: ${step.op}`);
        continue;
      }
      const childRunner = (children: S[]) => {
        const childSteps = [...children];
        const childPromise = new Promise<void>((resolve) => {
          const saved = gen;
          const childGen = execute(childSteps);
          const pump = (): void => {
            const r = childGen.next();
            if (r.done) {
              resolve();
              return;
            }
            waitRemain = r.value;
          };
          pump();
          void saved;
          resolve();
        });
        return childPromise;
      };
      const result = handler(step, ctx, childRunner);
      if (typeof result === 'number' && result > 0) {
        yield result;
      }
    }
  }

  return {
    runPhase(steps: S[]) {
      gen = execute(steps);
      waitRemain = 0;
      const r = gen.next();
      if (r.done) {
        gen = null;
      } else {
        waitRemain = r.value;
      }
    },

    tick(dt: number) {
      if (!gen) return;
      waitRemain -= dt;
      while (gen && waitRemain <= 0) {
        const r = gen.next();
        if (r.done) {
          gen = null;
          break;
        }
        waitRemain += r.value;
      }
    },

    cancel() {
      gen = null;
      waitRemain = 0;
    },

    get running() {
      return gen !== null;
    },
  };
}
