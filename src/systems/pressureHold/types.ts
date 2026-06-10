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
}

export type PressureHoldOutcome = 'completed' | 'aborted';
