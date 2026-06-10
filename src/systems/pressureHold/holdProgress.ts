/**
 * 临场长按的纯进度逻辑（不含 UI / Action 副作用），便于单测。
 *
 * 一个 HoldProgress 表示「从当前进度充到下一个停点」的一段：
 * 停点 = 下一个未触发的 interrupt.atRatio，或 1（完成）。
 */

export interface HoldSegmentConfig {
  /** 起始进度（0-1） */
  startRatio: number;
  /** 本段的停点（0-1]，到达即结束本段 */
  stopRatio: number;
  /** 按住时进度从 0 充满（到 1）所需秒数 */
  fillSeconds: number;
  /** 松手时每秒回落的进度比例 */
  decayPerSecond: number;
}

export class HoldProgress {
  private ratio: number;
  private readonly cfg: HoldSegmentConfig;

  constructor(cfg: HoldSegmentConfig) {
    if (!(cfg.fillSeconds > 0)) {
      throw new Error('HoldProgress: fillSeconds 必须为正数');
    }
    if (!(cfg.stopRatio > cfg.startRatio)) {
      throw new Error('HoldProgress: stopRatio 必须大于 startRatio');
    }
    this.cfg = cfg;
    this.ratio = clamp01(cfg.startRatio);
  }

  get current(): number {
    return this.ratio;
  }

  /** 是否已到达本段停点 */
  get reachedStop(): boolean {
    return this.ratio >= this.cfg.stopRatio;
  }

  /**
   * 推进一帧。
   * @param dtSeconds 帧时长（秒）
   * @param holding 当前是否按住
   * @returns 当前进度（0-1）
   */
  tick(dtSeconds: number, holding: boolean): number {
    if (dtSeconds < 0 || !Number.isFinite(dtSeconds)) return this.ratio;
    if (this.reachedStop) return this.ratio;
    if (holding) {
      this.ratio = Math.min(this.cfg.stopRatio, this.ratio + dtSeconds / this.cfg.fillSeconds);
    } else {
      this.ratio = Math.max(0, this.ratio - dtSeconds * this.cfg.decayPerSecond);
    }
    return this.ratio;
  }
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * 校验并排序 interrupt 停点：须在 (startRatio, 1) 内严格递增。
 * 返回排序后的 atRatio 列表；非法配置抛错（数据问题应在加载期暴露）。
 */
export function validateInterruptRatios(ratios: number[]): number[] {
  const sorted = [...ratios].sort((a, b) => a - b);
  for (const r of sorted) {
    if (!(r > 0 && r < 1)) {
      throw new Error(`pressure hold interrupt atRatio 须在 (0,1) 内: ${r}`);
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      throw new Error(`pressure hold interrupt atRatio 重复: ${sorted[i]}`);
    }
  }
  return sorted;
}
