import type { ITextDisplaySettingsProvider } from '../data/types';

/**
 * 文字呈现偏好的实现（目前只有「逐字显示」这一组）。
 *
 * **为什么是倍率不是「字/秒」**：对白框（30 字/秒）与遭遇框（35 字/秒）的基准速度是各自
 * 按版式调出来的，设置页要调的是"整体快慢"这一件事。做成绝对字/秒就得把两处基准抹平成
 * 同一个数，等于拿一条设置项改掉两处已定稿的手感。
 *
 * **落盘在 localStorage**：这是玩家偏好，与存档同一个存放面（见 `SaveManager`），
 * prod 构建里也必须能记住。注意它与 [debug-ui-persistence] 卡说的那类**调试/编辑器**
 * 偏好不是一回事——那类走 `resources/editor_projects/editor_data/*.json` + vite 中间件，
 * 而中间件在 prod 根本不存在、运行时也永不加载那些 sidecar。
 * 读写全程 try/catch：沙箱/隐私模式禁 localStorage 时退化为"本局有效、记不住"，
 * 绝不因为一条偏好把开场炸掉。
 */

const STORAGE_KEY = 'gamedraft_text_display';

/**
 * 速度倍率区间。`MIN × MAX = 1`，于是 1×（默认）**正好落在滑条正中**——
 * 见 {@link typewriterScaleToSlider} 的几何映射；改这两个数要保住这条关系，
 * 否则默认值会歪在轨道的某个四分位上，看着像"没归位"。
 */
export const TYPEWRITER_SCALE_MIN = 0.4;
export const TYPEWRITER_SCALE_MAX = 2.5;
export const TYPEWRITER_SCALE_DEFAULT = 1;
/** 滑条吸附粒度：轨道像素分辨率远高于眼睛能分辨的速度差，不吸附就会出现 103% 这种值 */
const SCALE_SNAP = 0.05;

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return TYPEWRITER_SCALE_DEFAULT;
  return Math.max(TYPEWRITER_SCALE_MIN, Math.min(TYPEWRITER_SCALE_MAX, scale));
}

/** 倍率 → 滑条位置(0..1)。几何映射：0.4× 与 2.5× 到中点 1× 的"档数"相等。 */
export function typewriterScaleToSlider(scale: number): number {
  return Math.log(clampScale(scale) / TYPEWRITER_SCALE_MIN)
    / Math.log(TYPEWRITER_SCALE_MAX / TYPEWRITER_SCALE_MIN);
}

/** 滑条位置(0..1) → 倍率（吸附到 5% 一档）。 */
export function sliderToTypewriterScale(v: number): number {
  const t = Math.max(0, Math.min(1, v));
  const raw = TYPEWRITER_SCALE_MIN * (TYPEWRITER_SCALE_MAX / TYPEWRITER_SCALE_MIN) ** t;
  // 收两位小数：`x/0.05*0.05` 会留下 1.7000000000000002 这种尾巴，直接落进偏好文件很脏
  return clampScale(Number((Math.round(raw / SCALE_SNAP) * SCALE_SNAP).toFixed(2)));
}

interface StoredPrefs {
  typewriterEnabled?: unknown;
  speedScale?: unknown;
}

export class TextDisplaySettings implements ITextDisplaySettingsProvider {
  private typewriterEnabled = true;
  private speedScale: number = TYPEWRITER_SCALE_DEFAULT;

  constructor() {
    this.restore();
  }

  isTypewriterEnabled(): boolean {
    return this.typewriterEnabled;
  }

  setTypewriterEnabled(on: boolean): void {
    this.typewriterEnabled = on;
    this.persist();
  }

  getTypewriterSpeedScale(): number {
    return this.speedScale;
  }

  setTypewriterSpeedScale(scale: number): void {
    this.speedScale = clampScale(scale);
    this.persist();
  }

  /** 坏值一律按缺省处理（只认类型对得上的字段），不让一条脏偏好把设置页读成 NaN。 */
  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredPrefs | null;
      if (typeof parsed?.typewriterEnabled === 'boolean') {
        this.typewriterEnabled = parsed.typewriterEnabled;
      }
      if (typeof parsed?.speedScale === 'number') {
        this.speedScale = clampScale(parsed.speedScale);
      }
    } catch {
      /* 沙箱禁读 / JSON 坏了：留在缺省值上 */
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        typewriterEnabled: this.typewriterEnabled,
        speedScale: this.speedScale,
      }));
    } catch {
      /* 配额满 / 隐私模式：本局仍然生效，只是下次进来记不住 */
    }
  }
}
