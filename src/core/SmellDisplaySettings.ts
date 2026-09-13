import type { ISmellDisplaySettingsProvider } from '../data/types';
import { resolvePersistentStore, type PersistentStore } from './storage/persistentStore';

/**
 * 气味指示器的呈现偏好（目前只有「气缕指向」这一项）。
 *
 * 落盘范式同 {@link TextDisplaySettings}：`settings/smellDisplay.json`，编辑器内嵌
 * WebEngine / 外部浏览器 / 打包 exe 三种壳共用同一份；读写全程不抛，写失败只记日志
 * （偏好不像存档那样必须把成败回报给玩家）。
 *
 * **为什么翻转做在显示侧**：气味源在哪是玩法真值，由 SmellSystem 每帧算出来广播，
 * flag `current_smell_dir` 恒为规范值（正 = 源在右）。这条偏好只决定 HUD 把那条真值
 * 画成"烟指着东西"还是"烟背着东西"——放进 SmellSystem 会让一条显示偏好改写玩法状态，
 * 将来任何读 `current_smell_dir` 的条件都会跟着玩家的设置走。
 */

const SETTINGS_NAMESPACE = 'settings';
const SETTINGS_KEY = 'smellDisplay';

interface StoredPrefs {
  invertDirection?: unknown;
}

export class SmellDisplaySettings implements ISmellDisplaySettingsProvider {
  private invertDirection = false;
  private store: PersistentStore | null = null;
  /** 记在飞的 hydrate 而不是布尔：布尔版并发进来会拿到空值（同 TextDisplaySettings / SaveManager）。 */
  private hydrating: Promise<void> | null = null;

  /**
   * 启动时调一次。构造期先按缺省值跑（`isDirectionInverted()` 被逐帧路径同步调用），
   * hydrate 完成后 HUD 下一帧就会按读回来的值重画。
   */
  hydrate(): Promise<void> {
    if (!this.hydrating) this.hydrating = this.doHydrate();
    return this.hydrating;
  }

  private async doHydrate(): Promise<void> {
    try {
      this.store = await resolvePersistentStore();
      const raw = (await this.store.readAll(SETTINGS_NAMESPACE))[SETTINGS_KEY];
      if (raw) this.applyStored(raw);
    } catch (e) {
      console.warn('SmellDisplaySettings: 偏好读取失败，使用缺省值', e);
    }
  }

  isDirectionInverted(): boolean {
    return this.invertDirection;
  }

  setDirectionInverted(on: boolean): void {
    this.invertDirection = on;
    this.persist();
  }

  /** 坏值一律留在缺省值上，不让一条脏偏好把设置页读成 undefined。 */
  private applyStored(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as StoredPrefs | null;
      if (typeof parsed?.invertDirection === 'boolean') this.invertDirection = parsed.invertDirection;
    } catch {
      /* JSON 坏了：留在缺省值上 */
    }
  }

  private async persistNow(): Promise<void> {
    // 没后端也要抛：静默 return 会让下面那条警告永远打不出来，于是"改了设置但下次进来没记住"
    // 变成一个毫无线索的现象。
    if (!this.store) throw new Error('没有可用的持久化后端（未 hydrate 或后端不可用）');
    await this.store.write(SETTINGS_NAMESPACE, SETTINGS_KEY, JSON.stringify({
      invertDirection: this.invertDirection,
    }));
  }

  private persist(): void {
    void this.persistNow().catch((e) => {
      console.warn('SmellDisplaySettings: 偏好写入失败，本局仍然生效', e);
    });
  }
}
