/**
 * 地图上点火的表演（2026-09-16 制作人定，A3.8）：
 *
 * 玩家手上燃着能点火的东西、在可燃物交互范围内按 E ⇒ **切游戏状态（ActionSequence）** ⇒ 走到解出来的站位
 * （小步挪过去，不瞬移）⇒ 播点火动作（动作本身不变，只挪脚）⇒ 接触帧那一刻火头在**画面上（2D）**对准着火点 ⇒
 * 点着 ⇒ 播完回自由探索。
 *
 * ## 站位怎么解（闭式反解，不是 IK）
 * 接触帧时火头相对脚底的偏移 `o(朝向, 透视系数)` 是确定的（挂点标注 + 挂件支点 / 自转 / 缩放 + 起火点，
 * `SpriteEntity.predictAttachmentPointOffset`）。脚底 = 着火点 − o。脚往画面上方走会变小（透视系数随脚点变），
 * 所以做不动点迭代：f₀ 按当前脚点、之后按上一轮解出的脚点，3–5 轮收敛（测试钉着残差）。
 *
 * ## 朝向
 * 人在着火点左边就朝右点、右边就朝左点。解出来的站位进了碰撞区 ⇒ 换另一个朝向；两个都站不了 ⇒ 原地朝着它点
 * （火头对不齐，dev 告警——燃烧工作台里站位会画成红的，作者调着火点或交互范围）。
 *
 * ## 两个方向（2026-09-16 火把与燃烧系统交互）
 * - `ignite`：手上燃着的火点可燃物（上面说的）；
 * - `relight`：手上的火把灭着，伸到**正在烧**的可燃物离火头最近的明火上，接触帧那一刻火把点着（不耗火种、不动那个可燃物）。
 * 同一套走位 / 动作 / 接触帧，只是瞄哪、接触时做什么不同。
 *
 * ## 拒绝路径都要恢复（运行时规范不变量 6）
 * 表演中手上的火灭了 / 切场景 / 读档 / 被别的东西抢了状态 ⇒ 不点、收掉、状态还回来。世代号作废在途的等待。
 */
import { GameState } from '../../data/types';
import { solveIgniteStance, type IgniteStanceQuery } from './igniteStance';

export { solveIgniteStance, type IgniteStanceQuery } from './igniteStance';

export interface IgnitePerformerDeps {
  getState(): GameState;
  setState(s: GameState): void;
  /** 场景正在切换（切换中不开演） */
  switching(): boolean;
  player: {
    pos(): { x: number; y: number };
    facing(): 1 | -1;
    setFacing(dir: 1 | -1): void;
    moveTo(x: number, y: number, speed: number): Promise<void>;
    cancelMotion(): void;
    walkSpeed(): number;
    hasLogicalState(logical: string): boolean;
    playOnce(logical: string, thenLogical: string): void;
    currentFrame(): { state: string; frame: number; frameCount: number; clipSeconds: number };
    resolveClip(logical: string): string;
    igniteContactFrame(logical: string): { frame: number; marked: boolean; frameCount: number } | null;
    predictTip(socket: string, u: number, v: number, logical: string, frame: number, facing: 1 | -1, depthScale: number): { x: number; y: number } | null;
  };
  perspectiveAt(x: number, y: number): number;
  isWalkable(x: number, y: number): boolean;
  /** 玩家手上燃着能点火的那件（没有 ⇒ null） */
  igniter(): { socket: string; u: number; v: number } | null;
  /** 玩家手上灭着、能被引火的那件（没有 ⇒ null）；不给 = 没有引火这回事 */
  relightTip?(): { socket: string; u: number; v: number } | null;
  /** 引火点着玩家手上的火（接触帧） */
  relight?(): boolean;
  burn: {
    canPlayerIgnite(hotspotId: string): boolean;
    playerIgniteTarget(hotspotId: string, tip: { x: number; y: number }): { scene: { x: number; y: number }; target: { u: number; v: number } | 'all' } | null;
    igniteAt(hotspotId: string, target: { u: number; v: number } | 'all'): boolean;
    canRelightFrom?(hotspotId: string): boolean;
    relightTarget?(hotspotId: string, tip: { x: number; y: number }): { x: number; y: number } | null;
  };
  /** 点火片段（逻辑状态名）与走过去的速度（缺省走路速度） */
  config(): { animation: string; walkSpeed?: number };
  log(msg: string): void;
}

/** 走这么近就不挪了（wu） */
const STANCE_EPS = 0.75;
/** 接触帧 / 播完的兜底超时 = 片段时长 + 这么多秒（片段在当前装扮里播不出来时不许卡死） */
const CLIP_TIMEOUT_PAD_S = 1;
/** 走位兜底超时 = 按走路速度该走的时间 × 这么多倍 + CLIP_TIMEOUT_PAD_S（透视会把步长压小，留足余量） */
const WALK_TIMEOUT_FACTOR = 4;

type Phase = 'idle' | 'walking' | 'toContact' | 'toEnd';

/** `ignite` 手上的火点它 / `relight` 从它身上引火点着手上的火把 */
export type IgniteMode = 'ignite' | 'relight';

export class IgnitePerformer {
  private phase: Phase = 'idle';
  private gen = 0;
  private hotspotId = '';
  private mode: IgniteMode = 'ignite';
  private logical = '';
  private contactFrame = 0;
  private target: { u: number; v: number } | 'all' = 'all';
  private elapsed = 0;
  private timeout = 0;
  private enteredState = false;
  private walkFacing: 1 | -1 = 1;
  private warnedUnmarked = new Set<string>();

  constructor(private readonly deps: IgnitePerformerDeps) {}

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  get debugState(): { phase: Phase; hotspotId: string; contactFrame: number; mode: IgniteMode } {
    return { phase: this.phase, hotspotId: this.hotspotId, contactFrame: this.contactFrame, mode: this.mode };
  }

  /** 这个热点此刻按 E 走哪个方向：手上燃着能点它 ⇒ ignite；手上灭着、它正在烧 ⇒ relight；都不行 ⇒ null */
  modeFor(hotspotId: string): IgniteMode | null {
    const d = this.deps;
    if (d.igniter() && d.burn.canPlayerIgnite(hotspotId)) return 'ignite';
    if (d.relightTip?.() && d.burn.canRelightFrom?.(hotspotId)) return 'relight';
    return null;
  }

  /** 开演。条件不满足（不在探索、手上没火、这个点不了）⇒ false，什么都没动 */
  start(hotspotId: string): boolean {
    const d = this.deps;
    if (this.phase !== 'idle') return false;
    if (d.getState() !== GameState.Exploring || d.switching()) return false;
    const mode = this.modeFor(hotspotId);
    if (!mode) return false;
    const ig = mode === 'ignite' ? d.igniter() : d.relightTip!();
    if (!ig) return false;
    const cfg = d.config();
    let logical = cfg.animation;
    if (!d.player.hasLogicalState(logical)) {
      if (!this.warnedUnmarked.has(`missing:${logical}`)) {
        this.warnedUnmarked.add(`missing:${logical}`);
        d.log(`点火表演：逻辑状态「${logical}」在当前装扮里播不出来（playerAvatar.stateMap 没映射 / 图集里没有），改用 idle`);
      }
      logical = 'idle';
    }
    const contact = d.player.igniteContactFrame(logical);
    if (!contact) return false;
    if (!contact.marked && !this.warnedUnmarked.has(logical)) {
      this.warnedUnmarked.add(logical);
      d.log(`点火表演：片段「${d.player.resolveClip(logical)}」没标点火接触帧（挂点面板勾「点火接触帧」），先按第 0 帧`);
    }
    const pos = d.player.pos();
    const nowFacing = d.player.facing();
    const tipNow = d.player.predictTip(ig.socket, ig.u, ig.v, logical, contact.frame, nowFacing, d.perspectiveAt(pos.x, pos.y));
    const tip = tipNow ? { x: pos.x + tipNow.x, y: pos.y + tipNow.y } : pos;
    const aim = mode === 'ignite'
      ? d.burn.playerIgniteTarget(hotspotId, tip)
      : (() => {
        const at = d.burn.relightTarget?.(hotspotId, tip) ?? null;
        return at ? { scene: at, target: 'all' as const } : null;
      })();
    if (!aim) return false;
    const preferred: 1 | -1 = aim.scene.x > pos.x ? 1 : aim.scene.x < pos.x ? -1 : nowFacing;
    const query: IgniteStanceQuery = {
      tipOffset: (f, depth) => d.player.predictTip(ig.socket, ig.u, ig.v, logical, contact.frame, f, depth),
      depthScaleAt: (x, y) => d.perspectiveAt(x, y),
    };
    let stance: { x: number; y: number; facing: 1 | -1 } | null = null;
    for (const facing of [preferred, (preferred === 1 ? -1 : 1) as 1 | -1]) {
      const s = solveIgniteStance(aim.scene, pos, facing, query);
      if (s && d.isWalkable(s.x, s.y)) { stance = { x: s.x, y: s.y, facing }; break; }
    }
    if (!stance) {
      d.log(`点火表演：${hotspotId} 左右两个站位都站不了（碰撞区 / 这一帧没标挂点），原地朝它点——到燃烧工作台里看站位`);
      stance = { x: pos.x, y: pos.y, facing: preferred };
    }
    // ---- 开演：状态机先切（同步），之后的一切都靠世代号作废
    const gen = ++this.gen;
    this.hotspotId = hotspotId;
    this.mode = mode;
    this.logical = logical;
    this.contactFrame = contact.frame;
    this.target = aim.target;
    d.setState(GameState.ActionSequence);
    this.enteredState = true;
    const speed = cfg.walkSpeed && cfg.walkSpeed > 0 ? cfg.walkSpeed : d.player.walkSpeed();
    const facing = stance.facing;
    const walkDist = Math.hypot(stance.x - pos.x, stance.y - pos.y);
    if (walkDist > STANCE_EPS) {
      this.phase = 'walking';
      this.walkFacing = facing;
      this.elapsed = 0;
      // 走位兜底：远处透视把步长压到很小 / 位移被别的调用抢走不再 resolve 时不许卡在演出里
      this.timeout = walkDist / Math.max(1e-3, speed) * WALK_TIMEOUT_FACTOR + CLIP_TIMEOUT_PAD_S;
      void d.player.moveTo(stance.x, stance.y, speed).then(() => {
        if (gen !== this.gen || this.phase !== 'walking') return;
        this.beginClip(facing);
      });
    } else {
      this.beginClip(facing);
    }
    return true;
  }

  private beginClip(facing: 1 | -1): void {
    const d = this.deps;
    d.player.setFacing(facing);
    d.player.playOnce(this.logical, 'idle');
    const cf = d.player.currentFrame();
    this.phase = 'toContact';
    this.elapsed = 0;
    this.timeout = cf.clipSeconds + CLIP_TIMEOUT_PAD_S;
  }

  /** 每帧（ActionSequence 分支里、玩家更新之后）：盯接触帧与播完 */
  update(dt: number): void {
    if (this.phase === 'idle') return;
    const d = this.deps;
    // 被别的东西抢了状态（对话 / 过场 / 读档）⇒ 收掉，不点
    if (d.getState() !== GameState.ActionSequence) { this.abort(false); return; }
    this.elapsed += dt;
    if (this.phase === 'walking') {
      if (this.elapsed >= this.timeout) {
        d.log(`点火表演：走到站位超时（${this.timeout.toFixed(1)} s），原地开始点火动作`);
        this.phase = 'toContact';
        d.player.cancelMotion();
        this.beginClip(this.walkFacing);
      }
      return;
    }
    const cf = d.player.currentFrame();
    const clip = d.player.resolveClip(this.logical);
    const onClip = cf.state === clip;
    if (this.phase === 'toContact') {
      const reached = onClip ? cf.frame >= this.contactFrame : true;
      if (reached || this.elapsed >= this.timeout) {
        if (this.mode === 'ignite') {
          // 火在接触那一刻还燃着才点（表演途中被风吹灭了就不点）
          if (d.igniter() && d.burn.canPlayerIgnite(this.hotspotId)) d.burn.igniteAt(this.hotspotId, this.target);
        } else if (d.relightTip?.() && d.burn.canRelightFrom?.(this.hotspotId)) {
          // 引火：那团火接触那一刻还在烧、手上的火把还灭着才点着
          d.relight?.();
        }
        this.phase = 'toEnd';
      }
      return;
    }
    // toEnd：片段播完（切到了 thenState / 停在最后一帧）或超时
    const done = !onClip || cf.frame >= cf.frameCount - 1;
    if (done || this.elapsed >= this.timeout) this.finish();
  }

  private finish(): void {
    const d = this.deps;
    this.phase = 'idle';
    this.gen++;
    if (this.enteredState && d.getState() === GameState.ActionSequence) d.setState(GameState.Exploring);
    this.enteredState = false;
  }

  /**
   * 收掉（切场景 / 读档 / 状态被抢）。`restoreState`：我们切进来的 ActionSequence 还在就还回探索
   * （被别的状态抢走时不动那个状态）。
   */
  abort(restoreState = true): void {
    if (this.phase === 'idle') return;
    const d = this.deps;
    const walking = this.phase === 'walking';
    this.phase = 'idle';
    this.gen++;
    if (walking) d.player.cancelMotion();
    if (restoreState && this.enteredState && d.getState() === GameState.ActionSequence) d.setState(GameState.Exploring);
    this.enteredState = false;
  }
}
