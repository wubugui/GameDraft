/**
 * 一个被世界脑接管的街面角色：把"Jev 挑的那件事"落成逐帧的走位 / 动作 / 朝向。
 *
 * 只经 {@link BrainNpc} 这层薄适配碰 NPC（位移、播动画、朝向、会话级显隐），
 * 全是**内存态**操作——不写存档、不写 flag、不改场景数据。
 *
 * 时间一律是世界脑时钟（秒）。位移的完成靠 `moveTo` 的 Promise + 序号（旧序号的兑现不算数：
 * 被新位移顶掉的旧 Promise 也会 resolve，不能把它当"到了"）。
 */
import type { AnimationPlaybackParams } from '../../data/types';
import type { ActOption } from './jevProtocol';
import type { StreetGraph } from './streetGraph';
import type { WorldBrainAnimRole, WorldBrainTuning } from './types';
import type { ResolvedPerson } from './worldBrainConfig';

/** NPC 的最小操作面（Game 用真 Npc 适配，测试用假件） */
export interface BrainNpc {
  readonly x: number;
  readonly y: number;
  readonly destroyed: boolean;
  moveTo(x: number, y: number, speed: number, moveAnim?: string, faceToward?: boolean, arriveAnim?: string | null): Promise<void>;
  jumpTo(x: number, y: number, durationMs: number, arc: number, jumpAnim?: string, landAnim?: string | null): Promise<void>;
  cancelActiveMove(): void;
  playAnimation(name: string, playback?: AnimationPlaybackParams): void;
  setFacing(dx: number, dy: number): void;
  applyInitialFacing(): void;
  setVisible(v: boolean): void;
  hasAnim(name: string): boolean;
  frameIndex(): number;
  frameCount(): number;
  setPlaying(p: boolean): void;
}

export interface ActorWorld {
  graph: StreetGraph;
  tuning: WorldBrainTuning;
  random: () => number;
  player: () => { x: number; y: number };
  /** 最近带地点的事（看热闹 / 朝那边望 / 往反方向跑） */
  eventAt: () => { x: number; y: number } | null;
  /** 场上另一个人此刻的位置 */
  npcPos: (npcId: string) => { x: number; y: number } | null;
  /** 某地点现在有几个人把它当目的地（不含自己） */
  placeLoad: (placeId: string, self: string) => number;
}

type Phase = 'moving' | 'dwell' | 'pose' | 'track' | 'rising' | 'away' | 'returning' | 'done';

interface Plan {
  option: ActOption;
  phase: Phase;
  startedAt: number;
  until: number;
  /** 目的地（地点 id），占位用 */
  destPlace: string | null;
  /** 到了之后干啥 */
  onArrive: 'dwell' | 'pose_crouch' | 'hide' | 'face_event' | 'face_player' | 'face_target';
  /** 跟随 / 靠近类：下次重算路线的时间 */
  retargetAt: number;
  targetNpc?: string;
}

const RISE_SEC = 0.9;

export class StreetActor {
  readonly npcId: string;
  plan: Plan | null = null;
  needsDecision = true;
  /** 离开了街面（藏起来了） */
  away = false;
  awayUntil = 0;
  lastSpokeAt = -1e9;
  lastPick: { key: string; text: string; p: number; conf: number | null } | null = null;
  /** 最近冒出来的那句（真冒出了气泡才记）；`until` = 气泡挂到啥时候（世界脑时钟） */
  lastSay: { category: string; text: string; at: number; until: number; reply: boolean } | null = null;
  /** 上一次被搭话时 Jev 挑的回话意图（调试面板） */
  lastReply: { intent: string; p: number } | null = null;
  /** 上一次决策的原因（调试面板） */
  lastReason = '';

  private path: { x: number; y: number }[] = [];
  private pathSpeed = 60;
  private pathAnim = '';
  private moving = false;
  private moveSeq = 0;
  private pose: { clip: string; freezeAt: number; frozen: boolean } | null = null;
  private pendingAfterRise: (() => void) | null = null;
  private riseUntil = 0;
  private hiddenByMe = false;

  constructor(
    readonly person: ResolvedPerson,
    private readonly npc: () => BrainNpc | null,
    /** 作者摆的原位（关掉世界脑时走回这里） */
    readonly homeX: number,
    readonly homeY: number,
    readonly hadPatrol: boolean,
  ) {
    this.npcId = person.npcId;
  }

  anim(role: WorldBrainAnimRole): string | null {
    const name = this.person.anims[role];
    if (!name) return null;
    const n = this.npc();
    return n && n.hasAnim(name) ? name : null;
  }

  private idle(): string {
    return this.anim('idle') ?? 'idle';
  }

  /** 当前在做的事的说法（给 Jev 的 state 与调试面板） */
  describeDoing(): string {
    if (this.away) return '不在街上（走开了）';
    if (!this.plan) return this.person.activity;
    // "接着做"就是他自己那摊事：说法不带"接着"——带着它，state 读起来是"他特意决定接着干"，
    // 下一拍模型只会让他接着干（09-22 实测洋行伙计雷劈下来一直"接着点货"）
    if (this.plan.option.kind === 'carry_on') return this.person.activity;
    return this.plan.option.text;
  }

  doingSince(now: number): number {
    return this.plan ? now - this.plan.startedAt : 0;
  }

  get destPlace(): string | null {
    return this.plan?.destPlace ?? null;
  }

  /**
   * 手上正做着自己那摊事（`takenOver` = 已被世界脑接管；没接管的人按作者摆的默认逻辑，
   * 就是在做自己的事）。被搭话时"说自己忙"只在这时说得通。
   */
  atOwnActivity(takenOver: boolean): boolean {
    if (!takenOver || this.away) return !this.away;
    const kind = this.plan?.option.kind;
    return !this.plan || kind === 'carry_on' || kind === 'peck' || kind === 'stretch';
  }

  /** 正在赶路去的地方（地点 id）；站着 / 跟人 / 蹲着时为 null */
  headingTo(): string | null {
    return this.plan?.phase === 'moving' ? this.plan.destPlace : null;
  }

  /** 被搭话：站着的就转过来对着说话的人（在走 / 在跟人 / 蹲着趴着的不扭） */
  faceToward(x: number, y: number): void {
    const n = this.npc();
    if (!n || n.destroyed || this.away || this.moving || this.pose) return;
    const phase = this.plan?.phase;
    if (phase === 'moving' || phase === 'track' || phase === 'rising') return;
    n.setFacing(x - n.x, y - n.y);
  }

  // ───────────────────────── 执行一件事 ─────────────────────────

  start(option: ActOption, now: number, w: ActorWorld): void {
    const n = this.npc();
    if (!n || n.destroyed) return;
    this.needsDecision = false;
    const run = () => this.begin(option, now, w);
    // 蹲着 / 趴着时先起身再做下一件（否则走路动画一顶，人是"弹"起来的）
    if (this.pose) {
      this.releasePose(false);
      this.pendingAfterRise = run;
      this.riseUntil = now + RISE_SEC;
      this.plan = {
        option, phase: 'rising', startedAt: now, until: now + RISE_SEC,
        destPlace: null, onArrive: 'dwell', retargetAt: 0,
      };
      return;
    }
    run();
  }

  private begin(option: ActOption, now: number, w: ActorWorld): void {
    const n = this.npc();
    if (!n || n.destroyed) return;
    // 起身途中又来了新决定：直接开做新的，旧的"起身后再做"作废
    this.pendingAfterRise = null;
    this.stopMotion();
    const rnd = (r: [number, number]) => r[0] + (r[1] - r[0]) * w.random();
    const dwell = rnd(w.tuning.dwellSec);
    // "接着做"不是换了一件事：开始的时刻沿用原来那摊事的——之前就在做自己的事（没接管 / 上一件也是接着做）
    // 就还是那时候起的；不这样的话，state 里写成"响动以后才换成这样"，像他听到响动特意决定接着干
    const prev = this.plan;
    const startedAt = option.kind === 'carry_on'
      ? (!prev ? -Infinity : prev.option.kind === 'carry_on' ? prev.startedAt : now)
      : now;
    const plan: Plan = {
      option, phase: 'dwell', startedAt, until: now + dwell,
      destPlace: null, onArrive: 'dwell', retargetAt: now,
    };
    this.plan = plan;
    const walk = this.anim('walk') ?? this.idle();
    const runA = this.anim('run') ?? walk;
    const g = w.graph;
    const goPlace = (placeId: string, fast: boolean, onArrive: Plan['onArrive'], end?: { x: number; y: number }) => {
      const pts = g.route(n.x, n.y, placeId, end);
      if (!pts) {
        plan.phase = 'dwell';
        return;
      }
      plan.destPlace = placeId;
      plan.onArrive = onArrive;
      plan.phase = 'moving';
      plan.until = now + 90; // 走不到的兜底：一分半还没到就当做完了
      this.setPath(pts, fast ? this.person.runSpeed : this.person.walkSpeed, fast ? runA : walk);
    };

    switch (option.kind) {
      case 'carry_on':
        n.playAnimation(this.idle());
        plan.until = now + rnd(w.tuning.carryOnSec);
        break;
      case 'go':
        if (option.arg) goPlace(option.arg, false, 'dwell');
        break;
      case 'go_home':
        // 回到作者摆的那个位置（摊子 / 墙根），不是停在最近的街心点上
        goPlace(this.person.home, false, 'dwell', { x: this.homeX, y: this.homeY });
        break;
      case 'run_shelter':
        if (option.arg) goPlace(option.arg, true, this.anim('crouch') ? 'pose_crouch' : 'dwell');
        break;
      case 'flee': {
        const from = w.eventAt() ?? w.player();
        const far = this.farthestPlace(from, w);
        if (far) goPlace(far, true, 'dwell');
        break;
      }
      case 'avoid_player': {
        const far = this.farthestPlace(w.player(), w, this.person.haunts.concat(this.person.home));
        if (far) goPlace(far, false, 'dwell');
        break;
      }
      case 'leave':
        if (option.arg) goPlace(option.arg, false, 'hide');
        break;
      case 'gawk_event': {
        const ev = w.eventAt();
        if (!ev) break;
        const near = g.nearest(ev.x, ev.y);
        if (!near) break;
        // 停在离出事点一段距离的地方，朝它看
        const dx = n.x - ev.x;
        const dy = n.y - ev.y;
        const d = Math.hypot(dx, dy) || 1;
        const stand = { x: ev.x + (dx / d) * 130, y: ev.y + (dy / d) * 130 };
        goPlace(near.id, false, 'face_event', stand);
        break;
      }
      case 'approach_person': {
        const target = option.arg ? w.npcPos(option.arg) : null;
        if (!target || !option.arg) break;
        plan.targetNpc = option.arg;
        plan.onArrive = 'face_target';
        plan.phase = 'track';
        plan.until = now + 20;
        break;
      }
      case 'approach_player':
      case 'follow_player':
      case 'charge_player':
        plan.phase = 'track';
        plan.until = now + (option.kind === 'follow_player' ? 12 + 6 * w.random() : option.kind === 'charge_player' ? 6 : 15);
        plan.onArrive = 'face_player';
        break;
      case 'face_player':
      case 'watch_event': {
        n.playAnimation(this.idle());
        plan.phase = 'dwell';
        plan.onArrive = option.kind === 'face_player' ? 'face_player' : 'face_event';
        plan.until = now + 4 + 4 * w.random();
        this.faceFor(plan, w);
        break;
      }
      case 'cower':
      case 'drop_flat': {
        const clip = this.anim(option.kind === 'cower' ? 'crouch' : 'lie');
        if (clip) this.enterPose(clip);
        else n.playAnimation(this.idle());
        plan.phase = 'pose';
        plan.until = now + 6 + 4 * w.random();
        break;
      }
      case 'startle': {
        const jump = this.anim('jump');
        void n.jumpTo(n.x, n.y, 520, 30, jump ?? undefined, this.idle());
        plan.until = now + 2.2;
        break;
      }
      default: {
        // 动物的专属动作：原地循环播几秒
        const role = ({ bark: 'bark', peck: 'peck', flap: 'flap', honk: 'honk', stretch: 'stretch', arch: 'arch' } as const)[
          option.kind as 'bark' | 'peck' | 'flap' | 'honk' | 'stretch' | 'arch'
        ];
        const clip = role ? this.anim(role) : null;
        n.playAnimation(clip ?? this.idle());
        if (option.kind === 'bark' || option.kind === 'honk' || option.kind === 'arch') {
          const p = w.player();
          n.setFacing(p.x - n.x, p.y - n.y);
        }
        plan.until = now + 3 + 3 * w.random();
      }
    }
  }

  /** 每帧推进；返回 true 表示这件事做完了（该重新问 Jev） */
  update(now: number, w: ActorWorld): boolean {
    const n = this.npc();
    if (!n || n.destroyed) return false;
    // 蹲 / 趴：播到最低那一帧定住
    if (this.pose && !this.pose.frozen && n.frameIndex() >= this.pose.freezeAt) {
      n.setPlaying(false);
      this.pose.frozen = true;
    }
    if (this.away) {
      if (now >= this.awayUntil) this.comeBack(now, w);
      return false;
    }
    const plan = this.plan;
    if (!plan) return this.needsDecision;
    if (plan.phase === 'rising') {
      if (now >= this.riseUntil) {
        const next = this.pendingAfterRise;
        this.pendingAfterRise = null;
        next?.();
      }
      return false;
    }
    if (plan.phase === 'moving') {
      this.pumpPath();
      if (!this.moving && this.path.length === 0) this.arrive(plan, now, w);
      else if (now >= plan.until) {
        this.stopMotion();
        plan.phase = 'done';
      }
    } else if (plan.phase === 'track') {
      this.track(plan, now, w);
    } else if (plan.phase === 'dwell' || plan.phase === 'pose') {
      if (plan.onArrive === 'face_player' || plan.onArrive === 'face_event' || plan.onArrive === 'face_target') {
        if (now >= plan.retargetAt) {
          this.faceFor(plan, w);
          plan.retargetAt = now + 0.6;
        }
      }
    }
    if (plan.phase !== 'moving' && plan.phase !== 'track' && now >= plan.until) plan.phase = 'done';
    if (plan.phase === 'done') {
      this.needsDecision = true;
      return true;
    }
    return false;
  }

  private arrive(plan: Plan, now: number, w: ActorWorld): void {
    const n = this.npc();
    if (!n) return;
    const rnd = (r: [number, number]) => r[0] + (r[1] - r[0]) * w.random();
    switch (plan.onArrive) {
      case 'hide':
        this.hide(now, w);
        return;
      case 'pose_crouch': {
        const clip = this.anim('crouch');
        if (clip) this.enterPose(clip);
        plan.phase = 'pose';
        plan.until = now + 6 + 5 * w.random();
        return;
      }
      default:
        n.playAnimation(this.idle());
        plan.phase = 'dwell';
        plan.until = now + rnd(w.tuning.dwellSec);
        plan.retargetAt = now;
    }
  }

  /** 靠近 / 跟随 / 冲过去：每秒重算一次落点（人在动） */
  private track(plan: Plan, now: number, w: ActorWorld): void {
    const n = this.npc();
    if (!n) return;
    const kind = plan.option.kind;
    const target = kind === 'approach_person'
      ? (plan.targetNpc ? w.npcPos(plan.targetNpc) : null)
      : w.player();
    if (!target) {
      plan.phase = 'done';
      return;
    }
    const d = Math.hypot(target.x - n.x, target.y - n.y);
    const stopAt = kind === 'follow_player' ? 150 : kind === 'charge_player' ? 55 : 95;
    if (d <= stopAt) {
      if (this.moving) this.stopMotion();
      n.setFacing(target.x - n.x, target.y - n.y);
      if (kind === 'follow_player') {
        n.playAnimation(this.idle());
        if (now >= plan.until) plan.phase = 'done';
        return;
      }
      // 到跟前了：朝着对方站一会儿再算完
      const clip = kind === 'charge_player' ? (this.anim('honk') ?? this.idle()) : this.idle();
      n.playAnimation(clip);
      plan.phase = 'dwell';
      plan.onArrive = kind === 'approach_person' ? 'face_target' : 'face_player';
      plan.until = now + 3 + 3 * w.random();
      plan.retargetAt = now;
      return;
    }
    if (now >= plan.until) {
      this.stopMotion();
      plan.phase = 'done';
      return;
    }
    if (now < plan.retargetAt) {
      this.pumpPath();
      return;
    }
    plan.retargetAt = now + 1;
    const fast = kind === 'charge_player' || (kind === 'follow_player' && d > 420) || d > 700;
    const speed = fast ? this.person.runSpeed : this.person.walkSpeed;
    const moveAnim = kind === 'charge_player'
      ? (this.anim('charge') ?? this.anim('run') ?? this.idle())
      : fast ? (this.anim('run') ?? this.idle()) : (this.anim('walk') ?? this.idle());
    // 落点：对方身边、靠自己这一侧
    const ux = (n.x - target.x) / (d || 1);
    const uy = (n.y - target.y) / (d || 1);
    const goal = { x: target.x + ux * (stopAt - 15), y: target.y + uy * (stopAt - 15) };
    let pts: { x: number; y: number }[] | null;
    if (d < 380) {
      pts = [goal]; // 近处直接走过去
    } else {
      const near = w.graph.nearest(target.x, target.y);
      pts = near ? w.graph.route(n.x, n.y, near.id, goal) : [goal];
    }
    if (pts && pts.length) this.setPath(pts, speed, moveAnim);
  }

  private faceFor(plan: Plan, w: ActorWorld): void {
    const n = this.npc();
    if (!n) return;
    let t: { x: number; y: number } | null = null;
    if (plan.onArrive === 'face_player') t = w.player();
    else if (plan.onArrive === 'face_event') t = w.eventAt();
    else if (plan.onArrive === 'face_target' && plan.targetNpc) t = w.npcPos(plan.targetNpc);
    if (t) n.setFacing(t.x - n.x, t.y - n.y);
  }

  private farthestPlace(from: { x: number; y: number }, w: ActorWorld, among?: string[]): string | null {
    const n = this.npc();
    if (!n) return null;
    const here = w.graph.nearest(n.x, n.y);
    let best: string | null = null;
    let bestScore = -Infinity;
    const ids = among ?? w.graph.places.filter((p) => !p.exit).map((p) => p.id);
    for (const id of ids) {
      const p = w.graph.place(id);
      if (!p || (here && p.id === here.id)) continue;
      // 离危险远、离自己近（跑也跑不了半条街），满了的地方扣分
      const score = Math.hypot(p.x - from.x, p.y - from.y)
        - 0.45 * Math.hypot(p.x - n.x, p.y - n.y)
        - 250 * Math.max(0, w.placeLoad(id, this.npcId) - (p.capacity ?? 3) + 1);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  // ───────────────────────── 位移 ─────────────────────────

  private setPath(pts: { x: number; y: number }[], speed: number, anim: string): void {
    this.cancelMove();
    this.path = pts.slice();
    this.pathSpeed = speed;
    this.pathAnim = anim;
    this.pumpPath();
  }

  private pumpPath(): void {
    if (this.moving || this.path.length === 0) return;
    const n = this.npc();
    if (!n || n.destroyed) return;
    const p = this.path.shift()!;
    const seq = ++this.moveSeq;
    this.moving = true;
    const last = this.path.length === 0;
    void n.moveTo(p.x, p.y, this.pathSpeed, this.pathAnim, true, last ? this.idle() : null).then(() => {
      if (seq === this.moveSeq) this.moving = false;
    });
  }

  private cancelMove(): void {
    this.moveSeq++;
    this.moving = false;
    this.path = [];
    const n = this.npc();
    if (n && !n.destroyed) n.cancelActiveMove();
  }

  private stopMotion(): void {
    this.cancelMove();
  }

  // ───────────────────────── 蹲 / 趴 ─────────────────────────

  private enterPose(clip: string): void {
    const n = this.npc();
    if (!n) return;
    n.playAnimation(clip, { loop: false });
    // 本仓库人物的蹲 / 趴片段是"下去再起来"一整个来回：定在中间那一帧（最低点）
    const count = Math.max(1, n.frameCount());
    this.pose = { clip, freezeAt: Math.max(0, Math.floor(count / 2) - 1), frozen: false };
  }

  /** 起身：从最低点接着播后半段，播完回站姿。`instant` = 直接站起（关掉世界脑时） */
  private releasePose(instant: boolean): void {
    const n = this.npc();
    const pose = this.pose;
    this.pose = null;
    if (!n || !pose) return;
    if (instant) {
      n.playAnimation(this.idle());
      return;
    }
    n.playAnimation(pose.clip, { loop: false, startFrame: pose.freezeAt + 1, thenState: this.idle() });
  }

  // ───────────────────────── 离开 / 回来 ─────────────────────────

  private hide(now: number, w: ActorWorld): void {
    const n = this.npc();
    if (!n) return;
    n.setVisible(false);
    this.hiddenByMe = true;
    this.away = true;
    const r = w.tuning.awaySec;
    this.awayUntil = now + r[0] + (r[1] - r[0]) * w.random();
    this.plan = null;
    this.needsDecision = false;
  }

  private comeBack(now: number, w: ActorWorld): void {
    const n = this.npc();
    if (!n) return;
    this.away = false;
    if (this.hiddenByMe) {
      n.setVisible(true);
      this.hiddenByMe = false;
    }
    // 回来先往自己的地方走，走到了再问 Jev
    const opt: ActOption = { key: 'go_home', kind: 'go_home', text: '回来了，往自己的地方走' };
    this.begin(opt, now, w);
  }

  // ───────────────────────── 交还 ─────────────────────────

  /**
   * 世界脑关掉：停下手上的事、站起来、现身，走回作者摆的原位。
   * 返回一个 Promise：走到了（或走不到 / NPC 没了）就兑现——调用方据此重启巡逻。
   */
  handBack(w: ActorWorld): Promise<void> {
    const n = this.npc();
    this.plan = null;
    this.needsDecision = false;
    this.pendingAfterRise = null;
    this.cancelMove();
    if (!n || n.destroyed) return Promise.resolve();
    if (this.pose) this.releasePose(true);
    if (this.hiddenByMe) {
      n.setVisible(true);
      this.hiddenByMe = false;
    }
    this.away = false;
    const near = w.graph.nearest(this.homeX, this.homeY);
    const pts = near ? w.graph.route(n.x, n.y, near.id, { x: this.homeX, y: this.homeY }) : null;
    const route = pts && pts.length ? pts : [{ x: this.homeX, y: this.homeY }];
    const walk = this.anim('walk') ?? this.idle();
    const idle = this.idle();
    const seq = ++this.moveSeq;
    const run = async () => {
      for (let i = 0; i < route.length; i++) {
        const cur = this.npc();
        if (!cur || cur.destroyed || seq !== this.moveSeq) return;
        const last = i === route.length - 1;
        await cur.moveTo(route[i].x, route[i].y, this.person.walkSpeed, walk, true, last ? idle : null);
      }
      const cur = this.npc();
      if (cur && !cur.destroyed && seq === this.moveSeq) cur.applyInitialFacing();
    };
    return run();
  }

  /** 场景拆了 / 读档：只丢状态，不碰 NPC（它们正被销毁） */
  forget(): void {
    this.moveSeq++;
    this.plan = null;
    this.path = [];
    this.moving = false;
    this.pose = null;
    this.pendingAfterRise = null;
    this.hiddenByMe = false;
    this.away = false;
  }
}
