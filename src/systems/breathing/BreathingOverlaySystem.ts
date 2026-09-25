import type { Container, Texture } from '../../engine2d';
import { type BreathingOverlayDef, isBreathingOverlayError, resolveBreathingOverlay } from '../../data/breathingOverlays';
import { createBreathingFieldTextures, createBreathingOverlayMesh } from '../../rendering/breathingOverlayMesh';
import { breathingUniforms } from '../../rendering/breathingUniforms';
import type { ProceduralBreathHandle } from '../AudioManager';
import { BreathingPerformance } from './BreathingPerformance';

/**
 * 呼吸图实例的持有者:显示 / 表演 / 改参数 / 每帧推进 / 收尾。
 *
 * - 显示走过场覆盖图层(与 showOverlayImage 同一张 images 表、同一套 id 句柄):`hideOverlayImage`、同 id 换层、
 *   过场结束的 cleanup 都能收掉它;收掉时这里的实例跟着停(声音停、等它的剧情步骤放行)。
 * - 推进用游戏时钟的 dt,由 Game 在世界没暂停时调 `update(dt)`;暂停时不推进,声音靠看门狗自己落下去。
 * - 参数:资产预设 → `setBreathingParams` 实时改(可带渐变);DEV 下呼吸工作台推来的工作态顶替盘上那份,
 *   并立刻换到正在显示的同一张图上。
 */

export type BreathingAct = 'breathe' | 'fadeOut' | 'gasp' | 'stopNow' | 'restart';
export const BREATHING_ACTS: readonly BreathingAct[] = ['breathe', 'fadeOut', 'gasp', 'stopNow', 'restart'];

export interface BreathingOverlayDeps {
  loadDefJson: (breathingId: string) => Promise<unknown>;
  loadTexture: (path: string) => Promise<Texture>;
  fetchBytes: (path: string) => Promise<ArrayBuffer>;
  showLayer: (
    id: string, texW: number, texH: number, xPercent: number, yPercent: number, widthPercent: number, order: number | undefined,
    prepare: () => Promise<(cx: number, cy: number, dispW: number, dispH: number) => { node: Container; disposeGpu: () => void }>,
  ) => Promise<boolean>;
  hideLayer: (id: string) => void;
  startBreathSound: () => ProceduralBreathHandle | null;
}

interface Instance {
  handle: string;
  assetId: string;
  def: BreathingOverlayDef;
  perf: BreathingPerformance;
  apply: ((u: Record<string, number>) => void) | null;
  sound: ProceduralBreathHandle | null;
  alive: boolean;
}

export interface BreathingInstanceSnapshot {
  handle: string;
  asset: string;
  mode: string;
  phase: string;
  chest: number;
  paperMm: number;
  t: number;
}

export class BreathingOverlaySystem {
  private readonly instances = new Map<string, Instance>();
  /** DEV:呼吸工作台推来的工作态(id → 原始文档);null = 用盘上那份 */
  private preview: Map<string, unknown> | null = null;

  constructor(private readonly deps: BreathingOverlayDeps) {}

  private async loadDef(assetId: string): Promise<BreathingOverlayDef> {
    const raw = this.preview?.has(assetId) ? this.preview.get(assetId) : await this.deps.loadDefJson(assetId);
    const def = resolveBreathingOverlay(raw, assetId);
    if (isBreathingOverlayError(def)) throw new Error(`呼吸图「${assetId}」不能用:${def.error}`);
    return def;
  }

  /** 显示一张呼吸图(同 handle 已有的换掉);Promise 在显示出来(或被别的操作顶掉)时兑现 */
  async show(handle: string, assetId: string, xPercent: number, yPercent: number, widthPercent: number, order?: number): Promise<void> {
    const def = await this.loadDef(assetId);
    let inst: Instance | null = null;
    const shown = await this.deps.showLayer(handle, def.size[0], def.size[1], xPercent, yPercent, widthPercent, order, async () => {
      const L = def.layers;
      const [base, body, sheet, flap, bytes] = await Promise.all([
        this.deps.loadTexture(L.base),
        L.body ? this.deps.loadTexture(L.body) : Promise.resolve(null),
        L.sheet ? this.deps.loadTexture(L.sheet) : Promise.resolve(null),
        L.flap ? this.deps.loadTexture(L.flap) : Promise.resolve(null),
        this.deps.fetchBytes(def.fields.file),
      ]);
      const fields = createBreathingFieldTextures(bytes, def.fields.width, def.fields.height);
      return (cx, cy, dispW, dispH) => {
        const m = createBreathingOverlayMesh({ base, body, sheet, flap, ...fields }, def.rig, def.size, cx, cy, dispW, dispH);
        const perf = new BreathingPerformance(def.params, def.rig.limits);
        const created: Instance = { handle, assetId, def, perf, apply: m.apply, sound: null, alive: true };
        inst = created;
        m.apply(this.uniformsOf(created));
        return {
          node: m.mesh,
          disposeGpu: () => {
            m.disposeGpu();
            fields.field1.destroy(true);
            fields.field2.destroy(true);
            this.retire(created);
          },
        };
      };
    });
    if (!shown || !inst) return;
    const ready = inst as Instance;
    const prev = this.instances.get(handle);
    if (prev && prev !== ready) this.retire(prev);
    ready.sound = this.deps.startBreathSound();
    this.instances.set(handle, ready);
  }

  /** 表演一下;wait=true 时 fadeOut 等到「停住 + 真停后多久出字」、gasp 等到猛吸结束才兑现 */
  perform(handle: string, act: BreathingAct, wait: boolean): Promise<void> {
    const inst = this.instances.get(handle);
    if (!inst) {
      console.warn(`[呼吸图] breathingPerform:没有显示着的呼吸图「${handle}」`);
      return Promise.resolve();
    }
    let done: Promise<void> = Promise.resolve();
    switch (act) {
      case 'breathe': inst.perf.breathe(); break;
      case 'fadeOut': done = inst.perf.fadeOut(); break;
      case 'gasp': done = inst.perf.gasp(); break;
      case 'stopNow': inst.perf.stopNow(); break;
      case 'restart': inst.perf.restart(); break;
      default: console.warn(`[呼吸图] 不认识的表演「${String(act)}」`);
    }
    return wait ? done : Promise.resolve();
  }

  /** 实时改参数(可带渐变);返回被拒的键 */
  setParams(handle: string, params: Record<string, unknown>, durationMs = 0): string[] {
    const inst = this.instances.get(handle);
    if (!inst) {
      console.warn(`[呼吸图] setBreathingParams:没有显示着的呼吸图「${handle}」`);
      return [];
    }
    const rejected = inst.perf.setParams(params, Math.max(0, durationMs) / 1000);
    if (rejected.length) console.warn(`[呼吸图] setBreathingParams:不认识的参数 ${rejected.join('、')}`);
    return rejected;
  }

  has(handle: string): boolean {
    return this.instances.has(handle);
  }

  /** 每帧推进(游戏时钟 dt 秒;世界暂停时不调) */
  update(dt: number): void {
    for (const inst of this.instances.values()) {
      if (!inst.alive) continue;
      inst.perf.step(dt);
      inst.apply?.(this.uniformsOf(inst));
      const f = inst.perf.frame();
      inst.sound?.setFlow(f.flow, inst.perf.p('volume'));
    }
  }

  private uniformsOf(inst: Instance): Record<string, number> {
    const p = inst.perf;
    return breathingUniforms({ frame: p.frame(), vent: p.p('vent'), cran: p.p('cran'), inflate: p.p('inflate'), sink: p.p('sink') }, inst.def.rig);
  }

  private retire(inst: Instance): void {
    if (!inst.alive) return;
    inst.alive = false;
    inst.apply = null;
    inst.sound?.stop();
    inst.sound = null;
    inst.perf.dispose();
    if (this.instances.get(inst.handle) === inst) this.instances.delete(inst.handle);
  }

  // ---------------- DEV:呼吸工作台联动 ----------------

  /** 套工作态:之后新显示的用它;正在显示的同一张图立刻换上新参数 */
  applyPreview(docs: Record<string, unknown> | null): void {
    this.preview = docs ? new Map(Object.entries(docs)) : null;
    if (!docs) return;
    for (const inst of this.instances.values()) {
      const raw = docs[inst.assetId];
      if (raw === undefined) continue;
      const def = resolveBreathingOverlay(raw, inst.assetId);
      if (isBreathingOverlayError(def)) { console.warn(`[呼吸图] 工作台推来的「${inst.assetId}」不能用:${def.error}`); continue; }
      inst.perf.setParams(def.params);
    }
  }

  /** 探针:对显示着这张图的每个实例做一次;show 在游戏里显示一张预览;返回有没有做到 */
  probe(action: 'show' | 'hide' | BreathingAct, assetId: string): boolean {
    const previewHandle = `__breathing_preview__${assetId}`;
    if (action === 'show') {
      void this.show(previewHandle, assetId, 50, 50, 90, 1000).catch((e) => console.warn('[呼吸图] 预览显示失败', e));
      return true;
    }
    const targets = [...this.instances.values()].filter((i) => i.assetId === assetId);
    if (action === 'hide') {
      if (!targets.length) return false;
      for (const t of targets) this.deps.hideLayer(t.handle);
      return true;
    }
    if (!targets.length) return false;
    for (const t of targets) void this.perform(t.handle, action, false);
    return true;
  }

  debugSnapshot(): BreathingInstanceSnapshot[] {
    return [...this.instances.values()].map((i) => {
      const f = i.perf.frame();
      return { handle: i.handle, asset: i.assetId, mode: f.mode, phase: f.phase, chest: +f.chest.toFixed(2), paperMm: +f.paperMm.toFixed(1), t: +i.perf.time().toFixed(1) };
    });
  }

  destroy(): void {
    for (const inst of [...this.instances.values()]) {
      // 游戏拆的时候渲染层可能已经先拆了:收层失败不影响实例退役(声音照样停)
      try { this.deps.hideLayer(inst.handle); } catch { /* 层已随渲染器销毁 */ }
    }
    for (const inst of [...this.instances.values()]) this.retire(inst);
    this.instances.clear();
  }
}
