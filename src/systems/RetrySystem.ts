import type { GameContext, IGameSystem } from '../data/types';
import type { HealthDepletion, RetryConfig } from '../data/survival';

interface Checkpoint { id: string; label: string; payload: string }
export interface RetryDeps {
  canCapture(): boolean;
  capture(): string | null;
  load(payload: string): Promise<boolean>;
  isDepleted(): boolean;
  enterDeath(): void;
  closeChoice(): void;
  showNote(id: string): Promise<void>;
  choose(title: string, options: { text: string }[]): Promise<number | null>;
  returnToMenu(): void;
  /** 保留当前已经读过的说明卡；其真相仍只在 FlagStore，不自建第二份已读表。 */
  shownNoteFlags(): Record<string, boolean>;
}

/** 普通死亡与回退。checkpoint 载荷不包含自身，避免存档体积递归增长。 */
export class RetrySystem implements IGameSystem {
  private checkpoint: Checkpoint | null = null;
  private pending: { id: string; label: string } | null = null;
  private generation = 0;
  private presenting = false;
  private config: RetryConfig = {};
  private deps: RetryDeps | null = null;

  configure(config: RetryConfig | undefined): void { this.config = { ...config }; }
  connect(deps: RetryDeps): void { this.deps = deps; }
  init(_ctx: GameContext): void { this.generation++; this.checkpoint = null; this.pending = null; this.presenting = false; }

  /** 不 await 安全窗口：action 持有探索锁，等待会与自身锁死。 */
  requestCheckpoint(id: string, label = ''): void {
    if (id.trim()) this.pending = { id: id.trim(), label };
  }

  update(_dt: number): void {
    const d = this.deps;
    if (!d || this.presenting || d.isDepleted() || (!this.pending && this.checkpoint) || !d.canCapture()) return;
    const raw = d.capture();
    if (!raw) return;
    try {
      const payload = JSON.parse(raw);
      if (!payload.systems || typeof payload.systems !== 'object') return;
      delete payload.systems.retrySystem;
      this.checkpoint = { id: this.pending?.id ?? 'session_start', label: this.pending?.label ?? '', payload: JSON.stringify(payload) };
      this.pending = null;
    } catch (e) { console.warn('RetrySystem: checkpoint capture failed', e); }
  }

  deplete(cause: HealthDepletion, failedRetry = false): void {
    if (!this.deps || this.presenting) return;
    this.presenting = true;
    this.pending = null;
    const gen = ++this.generation;
    this.deps.enterDeath();
    void this.present(cause, gen, failedRetry).catch((e) => {
      console.error('RetrySystem: death presentation failed', e);
      if (gen === this.generation) { this.presenting = false; this.deps?.returnToMenu(); }
    });
  }

  private async present(cause: HealthDepletion, gen: number, failedRetry: boolean): Promise<void> {
    const d = this.deps!;
    const note = cause.deathNoteId || this.config.firstDeathNoteId;
    if (note) await d.showNote(note);
    if (gen !== this.generation) return;
    const options = this.checkpoint
      ? [{ text: (this.config.retryText || '从上一个安全点重试') + (this.checkpoint.label ? ` · ${this.checkpoint.label}` : '') }, { text: this.config.menuText || '返回主菜单' }]
      : [{ text: this.config.menuText || '返回主菜单' }];
    const title = failedRetry ? (this.config.failedText || '重试未成功，请再试一次，或返回主菜单。') : (this.config.title || '三把火熄了。');
    const picked = await d.choose(title, options);
    if (gen !== this.generation || picked === null) return;
    if (picked !== 0 || !this.checkpoint) { d.returnToMenu(); return; }
    const payload = JSON.parse(this.checkpoint.payload);
    // 将当前检查点自身与已读卡带入新时间线，其他背包、钱、健康、叙事均完整回退。
    payload.systems.retrySystem = this.serialize();
    payload.systems.flagStore = { ...payload.systems.flagStore, ...d.shownNoteFlags() };
    const ok = await d.load(JSON.stringify(payload));
    // load 的 distribute 会调用 deserialize 作废当前 UI 协程。失败时 SaveManager 已回滚；
    // 只有回滚后仍为死亡，才重新给出可操作入口，不把玩家锁死在黑画面。
    if (!ok && d.isDepleted() && this.deps === d) {
      this.presenting = false;
      this.deplete(cause, true);
    }
  }

  serialize(): object { return { checkpoint: this.checkpoint ? { ...this.checkpoint } : null }; }
  deserialize(raw: object): void {
    this.generation++;
    this.presenting = false;
    this.pending = null;
    this.deps?.closeChoice();
    const candidate = (raw as { checkpoint?: Checkpoint } | null)?.checkpoint;
    this.checkpoint = null;
    if (!candidate || typeof candidate.id !== 'string' || typeof candidate.payload !== 'string') return;
    try {
      const payload = JSON.parse(candidate.payload);
      if (!payload.systems || typeof payload.systems !== 'object') return;
      delete payload.systems.retrySystem;
      this.checkpoint = { id: candidate.id, label: String(candidate.label ?? ''), payload: JSON.stringify(payload) };
    } catch { /* 坏快照不影响普通读档，下一次安全探索会建立初始快照。 */ }
  }
  snapshot(): object { return { checkpoint: this.checkpoint ? { id: this.checkpoint.id, label: this.checkpoint.label } : null, pending: this.pending, presenting: this.presenting }; }
  destroy(): void { this.generation++; this.deps?.closeChoice(); this.deps = null; this.pending = null; this.checkpoint = null; }
}
