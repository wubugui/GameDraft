import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { ActionDef, GameContext, IGameSystem } from '../data/types';
import { TEXT_URLS } from '../core/projectPaths';

/**
 * 具名「信号 Cue」：一段可复用的表现 Action 序列（浮层辉光、音效、台词等）。
 *
 * 设计动机：剧本级的重复信号（如 Axiu 的「香粉味＋小调」）必须每次表现一致，
 * 散落在各处的内联 action 容易彼此跑偏；统一收口为数据文件中的具名序列，
 * 内容只引用 `playSignalCue { id }`。
 *
 * 数据文件：`public/assets/data/signal_cues.json`（数组）。
 */
export interface SignalCueDef {
  id: string;
  /** 策划备注，运行时不读 */
  description?: string;
  /** 顺序执行的 Action（与对话/演出同一套类型） */
  actions: ActionDef[];
}

export class SignalCueManager implements IGameSystem {
  private readonly actionExecutor: ActionExecutor;
  private assetManager!: AssetManager;
  private defs: Map<string, SignalCueDef> = new Map();
  /** 进行中的 cue id；同名 cue 不可重入（防数据写出自引用死循环） */
  private inFlight: Set<string> = new Set();

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
    this.inFlight.clear();
  }

  async loadDefs(): Promise<void> {
    try {
      const defs = await this.assetManager.loadJson<SignalCueDef[]>(TEXT_URLS.signalCues);
      for (const def of defs) {
        const id = def?.id?.trim();
        if (!id || !Array.isArray(def.actions)) {
          console.warn('SignalCueManager: 非法 cue 配置，已跳过', def);
          continue;
        }
        this.defs.set(id, def);
      }
    } catch {
      console.warn('SignalCueManager: signal_cues.json not found');
    }
  }

  /** 顺序执行 cue 的 Action 序列；同名 cue 重入时忽略并告警。 */
  async play(cueId: string): Promise<void> {
    const id = (cueId ?? '').trim();
    const def = this.defs.get(id);
    if (!def) {
      console.warn(`SignalCueManager: unknown signal cue "${id}"`);
      return;
    }
    if (this.inFlight.has(id)) {
      console.warn(`SignalCueManager: cue "${id}" 重入被忽略`);
      return;
    }
    this.inFlight.add(id);
    try {
      await this.actionExecutor.executeBatchAwait(def.actions);
    } finally {
      this.inFlight.delete(id);
    }
  }
}
