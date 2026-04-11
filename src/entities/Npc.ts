import { Container, Graphics, Text, Texture } from 'pixi.js';
import type { NpcDef, AnimationSetDef, ICutsceneActor } from '../data/types';
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
  private moveTarget: { x: number; y: number; speed: number; resolve: () => void } | null = null;
  /** loadSprite 时解析的静止状态，用于巡逻/演出移动结束后恢复，不硬编码 idle */
  private restAnimState: string | null = null;
  /** 对话期间暂停巡逻循环中的下一次 moveTo */
  private patrolPaused = false;
  /** 打断当前 moveTo 后本段不递增路点索引 */
  private patrolSkipWaypointAdvance = false;

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
  }

  loadSprite(texture: Texture, animDef: AnimationSetDef, initialState?: string): void {
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

  getDisplayObject(): unknown {
    return this.container;
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

  setVisible(visible: boolean): void {
    this.container.visible = visible;
  }

  playAnimation(name: string): void {
    this.sprite?.playAnimation(name);
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
   * 对话中要播的站立/表情动画由 Ink 的 `# action:playNpcAnimation:...` 驱动。
   */
  pausePatrolAndFaceForDialogue(playerX: number, playerY: number): void {
    if (this.def.patrol) {
      this.cancelActiveMove();
      this.patrolSkipWaypointAdvance = true;
      this.patrolPaused = true;
    }
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

  moveTo(targetX: number, targetY: number, speed: number, moveAnimState?: string): Promise<void> {
    if (this.moveTarget) {
      this.moveTarget.resolve();
    }
    return new Promise<void>(resolve => {
      this.moveTarget = { x: targetX, y: targetY, speed, resolve };
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
