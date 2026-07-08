import type { ActionExecutor } from '../../core/ActionExecutor';
import type { AssetManager } from '../../core/AssetManager';
import type { GameContext, IGameSystem } from '../../data/types';
import { TEXT_URLS } from '../../core/projectPaths';
import { clamp01, validateInterruptChain } from './holdProgress';
import type { PressureHoldDef, PressureHoldInterruptDef, PressureHoldOutcome } from './types';

export interface PressureHoldRuntimeBinding {
  /**
   * 跑一段长按充能（表现 + 输入 + 游戏状态切换由组装层实现），
   * 进度到达 stopRatio 时 resolve 'reached'；配置了 abortOnReleaseFromRatio
   * 且玩家在进度 ≥ 该值时松手，则 resolve 'released'。
   * 旧绑定 resolve undefined 视同 'reached'。文案须已解析。
   */
  runSegment: (req: {
    prompt: string;
    releaseHint?: string;
    barColor?: number;
    startRatio: number;
    stopRatio: number;
    fillSeconds: number;
    decayPerSecond: number;
    abortOnReleaseFromRatio?: number;
  }) => Promise<'reached' | 'released' | void>;
  /** [tag:…] 文案解析 */
  resolveDisplayText: (raw: string) => string;
}

const DEFAULT_DECAY_PER_SECOND = 0.6;

/**
 * 临场长按（Pressure Hold）系统：数据驱动的「按住撑过去」交互。
 * 配置见 `public/assets/data/pressure_holds.json` 与 `types.ts`。
 * 由 Action `startPressureHold` 进入，complete/abort 之后由配置内的
 * Action 链继续推进剧情（系统本身不写剧情状态）。
 */
export class PressureHoldManager implements IGameSystem {
  private readonly actionExecutor: ActionExecutor;
  private assetManager!: AssetManager;
  private binding: PressureHoldRuntimeBinding | null = null;
  private defs: Map<string, PressureHoldDef> = new Map();
  private running = false;

  constructor(actionExecutor: ActionExecutor) {
    this.actionExecutor = actionExecutor;
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
  }

  update(_dt: number): void {}

  serialize(): object {
    return {};
  }

  deserialize(_data: object): void {}

  destroy(): void {
    this.defs.clear();
    this.binding = null;
    this.running = false;
  }

  bindRuntime(binding: PressureHoldRuntimeBinding): void {
    this.binding = binding;
  }

  async loadDefs(): Promise<void> {
    try {
      const defs = await this.assetManager.loadJson<PressureHoldDef[]>(TEXT_URLS.pressureHolds);
      for (const def of defs) {
        try {
          this.validateDef(def);
          this.defs.set(def.id, def);
        } catch (e) {
          console.warn(`PressureHoldManager: 配置 "${def?.id}" 非法，已跳过`, e);
        }
      }
    } catch {
      console.warn('PressureHoldManager: pressure_holds.json not found');
    }
  }

  /** 跑完一整次长按交互（含 interrupt / onComplete 的 Action 链）。 */
  async runUntilDone(id: string): Promise<PressureHoldOutcome> {
    const def = this.defs.get(id);
    if (!def) {
      console.warn(`PressureHoldManager: unknown pressure hold "${id}"`);
      return 'completed';
    }
    if (!this.binding) {
      console.warn('PressureHoldManager: runtime 未绑定（bindRuntime）');
      return 'completed';
    }
    if (this.running) {
      console.warn(`PressureHoldManager: 已有长按交互进行中，忽略 "${id}"`);
      return 'completed';
    }
    this.running = true;
    try {
      return await this.runFlow(def, this.binding);
    } finally {
      this.running = false;
    }
  }

  private async runFlow(
    def: PressureHoldDef,
    binding: PressureHoldRuntimeBinding,
  ): Promise<PressureHoldOutcome> {
    const interrupts = [...(def.interrupts ?? [])].sort((a, b) => a.atRatio - b.atRatio);
    const prompt = binding.resolveDisplayText(def.prompt);
    const releaseHint = def.releaseHint ? binding.resolveDisplayText(def.releaseHint) : undefined;
    const barColor = parseHexColor(def.barColor);
    const decay = def.decayPerSecond ?? DEFAULT_DECAY_PER_SECOND;

    if (def.holdSfx) {
      await this.actionExecutor.executeAwait({ type: 'playSfx', params: { id: def.holdSfx } });
    }

    let startRatio = 0;
    for (const interrupt of interrupts) {
      const seg = await binding.runSegment({
        prompt,
        releaseHint,
        barColor,
        startRatio,
        stopRatio: interrupt.atRatio,
        fillSeconds: def.fillSeconds,
        decayPerSecond: decay,
        abortOnReleaseFromRatio: def.abortOnReleaseFromRatio,
      });
      if (seg === 'released') {
        return this.finishAborted(def);
      }
      await this.actionExecutor.executeBatchAwait(interrupt.actions ?? []);
      if (interrupt.abort) {
        return 'aborted';
      }
      startRatio = clamp01(interrupt.resetToRatio ?? 0);
    }

    const lastSeg = await binding.runSegment({
      prompt,
      releaseHint,
      barColor,
      startRatio,
      stopRatio: 1,
      fillSeconds: def.fillSeconds,
      decayPerSecond: decay,
      abortOnReleaseFromRatio: def.abortOnReleaseFromRatio,
    });
    if (lastSeg === 'released') {
      return this.finishAborted(def);
    }
    if (def.onComplete) {
      await this.actionExecutor.executeBatchAwait(def.onComplete);
    }
    return 'completed';
  }

  /** abortOnReleaseFromRatio 触发的失败收场：执行 onAborted 后整次以 aborted 结束。 */
  private async finishAborted(def: PressureHoldDef): Promise<PressureHoldOutcome> {
    if (def.onAborted) {
      await this.actionExecutor.executeBatchAwait(def.onAborted);
    }
    return 'aborted';
  }

  private validateDef(def: PressureHoldDef): void {
    if (!def.id?.trim()) throw new Error('缺少 id');
    if (!(def.fillSeconds > 0)) throw new Error('fillSeconds 必须为正数');
    const releaseAbort = def.abortOnReleaseFromRatio;
    if (releaseAbort !== undefined && !(releaseAbort > 0 && releaseAbort < 1)) {
      throw new Error('abortOnReleaseFromRatio 须在 (0,1) 开区间内');
    }
    const interrupts: PressureHoldInterruptDef[] = def.interrupts ?? [];
    // B14：连同 resetToRatio 与下一停点的关系一起在加载期校验，
    // 防止 runFlow 中段以 startRatio ≥ stopRatio 构造 HoldProgress 运行期抛错
    validateInterruptChain(interrupts);
  }
}

/** "#rrggbb" → number；非法/缺省返回 undefined（用 UI 默认色） */
export function parseHexColor(raw: string | undefined): number | undefined {
  const s = (raw ?? '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return undefined;
  return parseInt(s.slice(1), 16);
}
