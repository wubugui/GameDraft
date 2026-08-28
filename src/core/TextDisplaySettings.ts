import type { ITextDisplaySettingsProvider } from '../data/types';
import { resolvePersistentStore, type PersistentStore } from './storage/persistentStore';

/**
 * 文字呈现偏好的实现（目前只有「逐字显示」这一组）。
 *
 * **为什么是倍率不是「字/秒」**：对白框（30 字/秒）与遭遇框（35 字/秒）的基准速度是各自
 * 按版式调出来的，设置页要调的是"整体快慢"这一件事。做成绝对字/秒就得把两处基准抹平成
 * 同一个数，等于拿一条设置项改掉两处已定稿的手感。
 *
 * **落盘在文件，不在 localStorage**：这是玩家偏好，与存档同一个存放面（见 `SaveManager`）。
 * `localStorage` 按 origin 隔离，而游戏会在编辑器内嵌 WebEngine、外部浏览器、打包 exe
 * 三种壳里跑，各存各的——设置在一处调了、换个壳进来又变回默认。改走
 * `storage/persistentStore` 后三边同一份 `settings/textDisplay.json`。
 *
 * 读写全程不抛：后端不可用时退化为"本局有效、记不住"，绝不因为一条偏好把开场炸掉。
 * 与存档的区别在于**偏好写失败只记日志**，不像存档那样必须把成败回报给玩家。
 */

/** 旧偏好在 localStorage 里的键。只用于一次性迁移，不再是写入目标。 */
const LEGACY_STORAGE_KEY = 'gamedraft_text_display';
const SETTINGS_NAMESPACE = 'settings';
const SETTINGS_KEY = 'textDisplay';

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
  private store: PersistentStore | null = null;
  /** 记在飞的 hydrate 而不是布尔——理由同 SaveManager：布尔版并发进来会拿到空值。 */
  private hydrating: Promise<void> | null = null;

  /**
   * 启动时调一次：挑后端、读回偏好、把 localStorage 里的旧偏好搬上来。
   *
   * 构造函数里不做这件事——读盘是异步的，而 `isTypewriterEnabled()` 被逐帧的
   * 打字机路径同步调用。构造后先按缺省值跑，hydrate 完成后即时生效。
   */
  hydrate(): Promise<void> {
    if (!this.hydrating) this.hydrating = this.doHydrate();
    return this.hydrating;
  }

  private async doHydrate(): Promise<void> {
    try {
      this.store = await resolvePersistentStore();
      const all = await this.store.readAll(SETTINGS_NAMESPACE);
      const raw = all[SETTINGS_KEY];
      if (raw) {
        this.applyStored(raw);
        return;
      }
      // 文件侧没有 → 试着把浏览器里的旧偏好搬过来（原件保留，搬运是复制）
      let legacy: string | null = null;
      try {
        legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      } catch { /* 沙箱禁 localStorage：没有可搬的 */ }
      if (legacy && this.applyStored(legacy)) {
        await this.persistNow();
      }
    } catch (e) {
      console.warn('TextDisplaySettings: 偏好读取失败，使用缺省值', e);
    }
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

  /**
   * 坏值一律按缺省处理（只认类型对得上的字段），不让一条脏偏好把设置页读成 NaN。
   * 返回是否真的读到了可用字段——迁移路径据此决定要不要回写。
   */
  private applyStored(raw: string): boolean {
    try {
      const parsed = JSON.parse(raw) as StoredPrefs | null;
      let got = false;
      if (typeof parsed?.typewriterEnabled === 'boolean') {
        this.typewriterEnabled = parsed.typewriterEnabled;
        got = true;
      }
      if (typeof parsed?.speedScale === 'number') {
        this.speedScale = clampScale(parsed.speedScale);
        got = true;
      }
      return got;
    } catch {
      return false; // JSON 坏了：留在缺省值上
    }
  }

  private async persistNow(): Promise<void> {
    // 没后端也要抛：静默 return 会让下面那条 catch 里的警告永远打不出来，
    // 于是"改了设置但下次进来没记住"变成一个毫无线索的现象。
    if (!this.store) throw new Error('没有可用的持久化后端（未 hydrate 或后端不可用）');
    await this.store.write(SETTINGS_NAMESPACE, SETTINGS_KEY, JSON.stringify({
      typewriterEnabled: this.typewriterEnabled,
      speedScale: this.speedScale,
    }));
  }

  /**
   * 即发即走。偏好与存档不同：写失败只记日志，不打断玩家手上的动作——
   * 拖个速度滑条不该弹错误框。
   */
  private persist(): void {
    void this.persistNow().catch((e) => {
      console.warn('TextDisplaySettings: 偏好写入失败，本局仍然生效', e);
    });
  }
}
