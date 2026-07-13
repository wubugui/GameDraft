import { Container, Graphics, Text, Texture } from 'pixi.js';
import type { NpcDef, AnimationSetDef, ICutsceneActor } from '../data/types';
import { portraitSlugFromAnimFile } from '../data/characterRegistry';
import type { TexelsPerWorld } from '../rendering/EntityPixelDensityMatch';
import { SpriteEntity } from '../rendering/SpriteEntity';

const MARKER_SIZE = 20;

export class Npc implements ICutsceneActor {
  public readonly def: NpcDef;
  public container: Container;
  private sprite: SpriteEntity | null = null;
  private marker: Graphics | null = null;
  private nameLabel: Text;
  private promptIcon: Text | null = null;
  private showingPrompt: boolean = false;

  private _x: number;
  private _y: number;
  private moveTarget: {
    x: number;
    y: number;
    speed: number;
    resolve: () => void;
    /** false：仅在段起点 setFacing 一次（巡逻/旧演出）；true：段内每帧随运动方向更新左右镜像 */
    faceTowardMovement: boolean;
  } | null = null;
  /** loadSprite 时解析的静止状态，用于巡逻/演出移动结束后恢复，不硬编码 idle */
  private restAnimState: string | null = null;
  /** 对话期间暂停巡逻循环中的下一次 moveTo */
  private patrolPaused = false;
  /** 打断当前 moveTo 后本段不递增路点索引 */
  private patrolSkipWaypointAdvance = false;
  /** 与玩家开对话前记录的 `container.scale.x`（含左右镜像），结束时还原 */
  private facingScaleXBeforeDialogue: number | null = null;

  /**
   * 显隐三通道，最终 visible = 派生基底 ∧ 条件 ∧ override≠false，只在 applyEffectiveVisible
   * 一处合成。与 Hotspot 同构：InteractionSystem 每帧只回写「派生/条件」通道，
   * 外部 setVisible（setEntityEnabled 等会话级动作）落在覆盖通道，不被每帧派生冲掉。
   */
  private derivedBaseVisible = true;
  private conditionVisible = true;
  /** 会话级显隐覆盖（不入档）；null=无覆盖，true 等价 null */
  private sessionEnabledOverride: boolean | null = null;

  constructor(def: NpcDef) {
    this.def = def;
    this._x = def.x;
    this._y = def.y;
    this.container = new Container();
    this._syncContainerPosition();

    this.marker = new Graphics();
    this.marker.circle(0, -MARKER_SIZE, MARKER_SIZE);
    this.marker.fill({ color: 0x55aa55, alpha: 0.8 });
    this.marker.rect(-3, -2, 6, 4);
    this.marker.fill({ color: 0x55aa55, alpha: 0.8 });
    this.container.addChild(this.marker);

    this.nameLabel = new Text({
      text: def.name,
      style: { fontSize: 11, fill: 0xaaddaa, fontFamily: 'sans-serif' },
    });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.y = 6;
    this.container.addChild(this.nameLabel);
    this.applyInitialFacing();
  }

  /** 按 def.initialFacing 设置左右镜像（无精灵时同步占位与标签）。 */
  applyInitialFacing(): void {
    const f = this.def.initialFacing;
    if (f === 'left') {
      this.setFacing(-1, 0);
    } else if (f === 'right') {
      this.setFacing(1, 0);
    }
  }

  loadSprite(texture: Texture, animDef: AnimationSetDef, initialState?: string): void {
    if (this.sprite) {
      this.container.removeChild(this.sprite.container);
      this.sprite.destroy();
      this.sprite = null;
    }
    if (this.marker) {
      this.container.removeChild(this.marker);
      this.marker.destroy();
      this.marker = null;
    }

    this.sprite = new SpriteEntity();
    this.sprite.loadFromDef(texture, animDef);
    const want = initialState?.trim();
    const keys = Object.keys(animDef.states);
    const resolved =
      (want && animDef.states[want] ? want : undefined) ??
      (animDef.states.idle ? 'idle' : keys[0]);
    this.restAnimState = resolved ?? null;
    if (resolved) {
      this.sprite.playAnimation(resolved);
    }
    this.container.addChildAt(this.sprite.container, 0);
    this.sprite.container.x = 0;
    this.sprite.container.y = 0;
    this.applyInitialFacing();
  }

  private _syncContainerPosition(): void {
    this.container.x = this._x;
    this.container.y = this._y;
  }

  get entityId(): string { return this.def.id; }

  get x(): number { return this._x; }
  set x(v: number) {
    this._x = v;
    this._syncContainerPosition();
  }

  get y(): number { return this._y; }
  set y(v: number) {
    this._y = v;
    this._syncContainerPosition();
  }

  get interactionRange(): number { return this.def.interactionRange; }
  get id(): string { return this.def.id; }

  /**
   * 当前生效装扮配置的对话头像立绘集：显式 portraitSlug（NpcDef 就地 / 角色注册表继承）优先，
   * 缺省按 animFile 动画包目录名推导（多数「包名==头像名」的角色因此无需配 portraitSlug）。
   * 装扮配置解耦：NPC 换装走 `setEntityField(npc, portraitSlug/animFile)`——运行时字段直接改写本
   * 实体 def 并经 sceneMemory 进存档；改 animFile 时头像也随包名推导自动跟着换。
   */
  get currentPortraitSlug(): string | null {
    return this.def.portraitSlug?.trim() || portraitSlugFromAnimFile(this.def.animFile);
  }

  /** 投影阴影用：当前显示帧纹理；无精灵时 null */
  getDisplayTexture(): Texture | null {
    return this.sprite?.getDisplayTexture() ?? null;
  }

  /** 投影阴影用：世界尺寸（宽高） */
  getWorldSize(): { width: number; height: number } {
    return this.sprite?.getWorldSize() ?? { width: 0, height: 0 };
  }

  /** 投影阴影用：左右朝向（来自 container.scale.x 符号） */
  getFacing(): 1 | -1 {
    return this.container.scale.x < 0 ? -1 : 1;
  }

  getDisplayObject(): unknown {
    return this.container;
  }

  /** 跨运行壳视觉门禁用的稳定只读状态。 */
  getDebugVisualState(): Record<string, unknown> {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      visible: this.container.visible,
      scaleX: this.container.scale.x,
      scaleY: this.container.scale.y,
      animation: this.sprite?.getDebugVisualState() ?? null,
    };
  }


  resetAnimationClock(): void {
    this.sprite?.resetAnimationClock();
  }

  /** 气泡底边在头顶附近；无精灵时用占位圆顶部估算 */
  getEmoteBubbleAnchorLocalY(): number {
    const headGap = 8;
    if (this.sprite) {
      const h = Math.max(this.sprite.getWorldSize().height, 1);
      return -h - headGap;
    }
    return -MARKER_SIZE * 2 - headGap;
  }

  /**
   * 按世界空间向量 (dx,dy) 调整朝向：从 NPC 指向目标（如玩家）的向量。
   * 仅改世界实体 `container.scale` 与必要的子节点抵消，精灵保持自然帧缩放（不镜像动画数据）。
   */
  setFacing(dx: number, dy: number): void {
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-8) return;

    let sx: number;
    if (Math.abs(dx) >= 1e-6) {
      sx = dx > 0 ? 1 : -1;
    } else {
      sx = dy >= 0 ? 1 : -1;
    }

    const baseX = Math.abs(this.container.scale.x) || 1;
    const baseY = Math.abs(this.container.scale.y) || 1;
    this.container.scale.x = sx * baseX;
    this.container.scale.y = baseY;

    this.nameLabel.scale.x = sx;
    if (this.promptIcon) this.promptIcon.scale.x = sx;
    if (this.marker) this.marker.scale.x = sx;

    this.sprite?.setDirection(1, 0);
  }

  /**
   * 外部（Action / 过场 / 持久化立即生效路径）显隐入口：写会话覆盖通道，
   * 不会被 InteractionSystem 的每帧派生回写冲掉；true 即清除覆盖（回到派生基底决定）。
   */
  setVisible(visible: boolean): void {
    this.setSessionEnabledOverride(visible ? null : false);
  }

  /** 会话级覆盖通道（SceneManager.setEntitySessionEnabled / setVisible 落点）。 */
  setSessionEnabledOverride(v: boolean | null): void {
    this.sessionEnabledOverride = v;
    this.applyEffectiveVisible();
  }

  /** 派生基底通道：过场绑定 / sceneMemory enabled 推导值，由 InteractionSystem / SceneManager 每帧刷新。 */
  setDerivedBaseVisible(base: boolean): void {
    this.derivedBaseVisible = base;
    this.applyEffectiveVisible();
  }

  /** 条件通道：conditionHidesEntity 时的条件求值结果（其余情况传 true）。 */
  setConditionVisible(ok: boolean): void {
    this.conditionVisible = ok;
    this.applyEffectiveVisible();
  }

  /** 三通道合成的唯一出口。 */
  private applyEffectiveVisible(): void {
    this.container.visible =
      this.derivedBaseVisible && this.conditionVisible && this.sessionEnabledOverride !== false;
  }

  playAnimation(name: string): void {
    this.sprite?.playAnimation(name);
  }

  /** 纯渲染：与背景像素密度对齐（内层精灵，不碰深度与碰撞） */
  applyEntityPixelDensityMatch(enabled: boolean, dBg: TexelsPerWorld | null, strengthScale = 1): void {
    if (!this.sprite) return;
    this.sprite.setPixelDensityMatchActive(enabled);
    this.sprite.applyPixelDensityMatch(dBg, strengthScale);
  }

  /** 打断当前 moveTo（与 onDialogueStart 内取消位移一致），供停止巡逻等逻辑调用 */
  cancelActiveMove(): void {
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
  }

  /**
   * 进入对话：暂停巡逻（取消当前位移并阻塞巡逻循环）、朝向玩家。
   * 对话中要播的站立/表情动画由图对话 `runActions` 的 playNpcAnimation 等驱动。
   */
  pausePatrolAndFaceForDialogue(playerX: number, playerY: number): void {
    if (this.def.patrol) {
      this.cancelActiveMove();
      this.patrolSkipWaypointAdvance = true;
      this.patrolPaused = true;
    }
    this.facingScaleXBeforeDialogue = this.container.scale.x;
    this.setFacing(playerX - this._x, playerY - this._y);
  }

  /** @deprecated 请改用 `pausePatrolAndFaceForDialogue` */
  onDialogueStart(playerX: number, playerY: number): void {
    this.pausePatrolAndFaceForDialogue(playerX, playerY);
  }

  /** 进入场景时解析的静止状态；未在对话里另行 `playNpcAnimation` 时角色可保持当前已播状态 */
  getRestAnimState(): string | null {
    return this.restAnimState;
  }

  onDialogueEnd(): void {
    if (this.def.patrol) this.patrolPaused = false;
    if (this.facingScaleXBeforeDialogue === null) return;
    const saved = this.facingScaleXBeforeDialogue;
    this.facingScaleXBeforeDialogue = null;
    this.container.scale.x = saved;
    const sx = Math.sign(saved) || 1;
    this.nameLabel.scale.x = sx;
    if (this.promptIcon) this.promptIcon.scale.x = sx;
    if (this.marker) this.marker.scale.x = sx;
    this.sprite?.setDirection(1, 0);
  }

  get isPatrolPausedForDialogue(): boolean {
    return this.patrolPaused;
  }

  /** @returns true 表示本次应跳过路点递增（已消费标志） */
  consumePatrolSkipWaypointAdvance(): boolean {
    if (!this.patrolSkipWaypointAdvance) return false;
    this.patrolSkipWaypointAdvance = false;
    return true;
  }

  moveTo(
    targetX: number,
    targetY: number,
    speed: number,
    moveAnimState?: string,
    faceTowardMovement?: boolean,
  ): Promise<void> {
    // 过场 skip 后被放弃的动作链可能继续对已销毁的 `_cut_*` 演员发 moveTo：
    // 此时 cutsceneUpdate 不再被调用，建出的 moveTarget 永不推进也永不 resolve，直接空履约。
    if (this.container.destroyed) return Promise.resolve();
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
    // 零距离目标幂等早退：不重播移动动画、不建 moveTarget（巡逻 ping-pong 端点重合 /
    // 单路点 route 会以自身坐标为目标反复 moveTo，走完整流程会每帧抖动画帧并空转）。
    {
      const dx0 = targetX - this._x;
      const dy0 = targetY - this._y;
      if (dx0 * dx0 + dy0 * dy0 < 1e-6) {
        return Promise.resolve();
      }
    }
    return new Promise<void>(resolve => {
      const toward = faceTowardMovement === true;
      this.moveTarget = { x: targetX, y: targetY, speed, resolve, faceTowardMovement: toward };
      this.setFacing(targetX - this._x, targetY - this._y);
      const anim = moveAnimState?.trim();
      if (anim) {
        this.playAnimation(anim);
      }
    });
  }

  cutsceneUpdate(dt: number): void {
    if (this.moveTarget) {
      const t = this.moveTarget;
      const dx = t.x - this._x;
      const dy = t.y - this._y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = t.speed * dt;

      if (dist <= step) {
        this.x = t.x;
        this.y = t.y;
        if (this.restAnimState) {
          this.playAnimation(this.restAnimState);
        }
        const resolve = t.resolve;
        this.moveTarget = null;
        resolve();
      } else {
        const nx = dx / dist;
        const ny = dy / dist;
        if (t.faceTowardMovement) {
          this.setFacing(dx, dy);
        }
        this.x += nx * step;
        this.y += ny * step;
      }
    }
    this.sprite?.update(dt);
  }

  showPrompt(): void {
    if (this.showingPrompt) return;
    this.showingPrompt = true;

    this.promptIcon = new Text({
      text: 'E',
      style: {
        fontSize: 14,
        fill: 0xffee88,
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
      },
    });
    this.promptIcon.anchor.set(0.5, 0.5);
    this.promptIcon.y = -(MARKER_SIZE * 2 + 12);
    const sx = Math.sign(this.container.scale.x) || 1;
    this.promptIcon.scale.x = sx;
    this.container.addChild(this.promptIcon);
  }

  hidePrompt(): void {
    if (!this.showingPrompt) return;
    this.showingPrompt = false;
    if (this.promptIcon) {
      this.container.removeChild(this.promptIcon);
      this.promptIcon.destroy();
      this.promptIcon = null;
    }
  }

  destroy(): void {
    this.hidePrompt();
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
    if (this.sprite) {
      this.sprite.destroy();
      this.sprite = null;
    }
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
