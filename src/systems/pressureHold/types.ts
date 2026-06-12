import type { ActionDef } from '../../data/types';

/**
 * 临场长按（Pressure Hold）配置。
 *
 * 一次长按交互 = 玩家按住（空格 / 指针）把进度从 0 充到 1：
 * - 松手时进度按 `decayPerSecond` 回落（制造「使不上劲 / 憋不住」的张力）；
 * - 进度首次到达某个 interrupt 的 `atRatio` 时暂停输入，顺序执行其 `actions`
 *   （演出 / 台词 / 音效等），然后：
 *   - `abort` 为 true：整次交互以「被打断」收场（即剧本里的脚软、吓退）；
 *   - 否则进度重置到 `resetToRatio` 继续；
 * - 配置了 `abortOnReleaseFromRatio` 时，进度 ≥ 该值后一旦松手，整次交互
 *   立即以 aborted 收场并执行 `onAborted`（即剧本里「不容松手」的关口，如夜路应声）；
 * - 进度到 1 且无未触发的 abort interrupt 时执行 `onComplete`。
 *
 * 数据文件：`public/assets/data/pressure_holds.json`（数组）。
 */
export interface PressureHoldInterruptDef {
  /** 触发进度（0-1，开区间内），同一配置内须严格递增 */
  atRatio: number;
  /** 触发时顺序执行的 Action（与对话/遭遇同一套类型） */
  actions: ActionDef[];
  /** true 时本次长按到此为止（剧本式失败/打断），不再继续充能 */
  abort?: boolean;
  /** abort 为否时，actions 执行完后进度重置到的值；缺省 0 */
  resetToRatio?: number;
}

export interface PressureHoldDef {
  id: string;
  /** 进度条上方的引导文案（支持 [tag:…]） */
  prompt: string;
  /** 按住时进度从 0 充满所需秒数 */
  fillSeconds: number;
  /** 松手时每秒回落的进度比例；缺省 0.6 */
  decayPerSecond?: number;
  /** 松手瞬间闪现的提示文案（如「差点应了声」），可选 */
  releaseHint?: string;
  /** 按住期间播放的氛围音效 id（一次性播放，文件本身可较长），可选 */
  holdSfx?: string;
  /** 进度条主题色（十六进制字符串，如 "#7a1f1f"），缺省用 UITheme 默认 */
  barColor?: string;
  interrupts?: PressureHoldInterruptDef[];
  /** 进度满且未被 abort 打断时执行 */
  onComplete?: ActionDef[];
  /**
   * 进度 ≥ 此值（0-1 开区间）后一旦松手，整次长按立即以 aborted 收场。
   * 此前的松手仍按 decay 回落（即「前段容错、末段不容松」）。缺省不启用。
   */
  abortOnReleaseFromRatio?: number;
  /** 因 abortOnReleaseFromRatio 松手失败时执行（如夜路「应了声」分支） */
  onAborted?: ActionDef[];
}

export type PressureHoldOutcome = 'completed' | 'aborted';
