import { Container, Graphics, Text } from 'pixi.js';
import type { EmoteBubbleOffsetOpts, IEmoteBubbleAnchor, IGameSystem, GameContext } from '../data/types';
import { Hotspot } from '../entities/Hotspot';

interface ActiveBubble {
  bubble: Container;
  parent: Container;
  remainingMs: number;
  /** true：仅能通过返回的 dismiss 或 cleanup 移除（不参与 update 倒计时） */
  noAutoExpire?: boolean;
  /** 归属方标记（如过场）：cleanupByOwner 只清对应来源的气泡，不误伤世界气泡 */
  owner?: string;
  /** 挂 entityLayer 的移动实体气泡：每帧按锚点实体当前位置重摆（热点静止，挂载时定位一次即可） */
  follow?: {
    anchor: IEmoteBubbleAnchor;
    displayObj: Container;
    bw: number;
    bh: number;
    ox: number;
    oy: number;
  };
}

/**
 * 气泡一律单挂 entityLayer（entityAttachLayer 就绪时），不进实体自身容器：
 * - 热点容器可能 `spriteSort: back` 排到最底；quad 直接来自 Hotspot 的世界数据（展示图底中锚点，
 *   x/y/worldWidth/worldHeight 已定义完整世界四边形），静止故挂载时定位一次。
 * - 玩家/NPC/过场演员容器带光照/遮挡滤镜（气泡混入会撑大滤镜 bounds、AO 重标定）且可能 scale.x=-1
 *   镜像文字；这类锚点会移动，由 update 每帧按实体位置重摆（follow）。
 * 不走 getBounds / toGlobal / toLocal，避免屏幕空间与 entityLayer 世界空间混用。
 */
/** 气泡底边落在 quad 顶边之上（世界单位近似，与 NPC headGap 同量级） */
const QUAD_ABOVE_GAP = 8;

export class EmoteBubbleManager implements IGameSystem {
  private activeBubbles: ActiveBubble[] = [];
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 与 SceneManager 放入 NPC/热点的层一致；不设则热点气泡仍挂在热点容器下 */
  private entityAttachLayer: Container | null = null;
  /** F2 调试面板 */
  private debugPanelLog: ((message: string) => void) | null = null;

  /**
   * 由 Game 在 renderer.init() 之后设置；供热点气泡挂靠世界实体层。
   */
  setEntityAttachLayer(layer: Container | null): void {
    this.entityAttachLayer = layer;
  }

  /** F2 调试面板「日志」路由（与 ActionRegistry 同源）。 */
  setDebugPanelLog(fn: ((message: string) => void) | null): void {
    this.debugPanelLog = fn;
  }

  private dbg(message: string): void {
    this.debugPanelLog?.(`[EmoteBubble] ${message}`);
  }

  init(_ctx: GameContext): void {}
  serialize(): object { return {}; }
  deserialize(_data: object): void { this.cleanup(); }

  private buildAndMountBubble(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    opts?: EmoteBubbleOffsetOpts,
  ): { bubble: Container; parent: Container; bw: number; bh: number; follow?: ActiveBubble['follow'] } {
    const displayObj = anchor.getDisplayObject() as Container;

    this.dbg(
      `mount 开始 anchor=${anchor.constructor?.name ?? '?'} emoteLen=${emote.length} ` +
        `entityAttachLayer=${this.entityAttachLayer ? 'ok' : '(null)'}`,
    );
    this.dbg(
      `  displayObj parent=${displayObj.parent ? 'yes' : 'no'} visible=${displayObj.visible} ` +
        `renderable=${(displayObj as { renderable?: boolean }).renderable ?? '?'} alpha=${displayObj.alpha} ` +
        `y=${Number.isFinite(displayObj.y) ? displayObj.y.toFixed(1) : String(displayObj.y)}`,
    );

    const bubble = new Container();

    const txt = new Text({
      text: emote,
      style: { fontSize: 20, fill: 0x222222, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });

    const padX = 8;
    const padY = 4;
    const bw = txt.width + padX * 2;
    const bh = txt.height + padY * 2;

    const bg = new Graphics();
    bg.roundRect(0, 0, bw, bh, 6);
    bg.fill({ color: 0xffffff, alpha: 0.95 });
    bg.stroke({ color: 0x888888, width: 1 });
    bubble.addChild(bg);

    txt.x = padX;
    txt.y = padY;
    bubble.addChild(txt);

    const ox = opts?.anchorOffsetX ?? 0;
    const oy = opts?.anchorOffsetY ?? 0;

    let attachParent: Container = displayObj;
    let bx = -bw / 2 + ox;
    let by = anchor.getEmoteBubbleAnchorLocalY() + oy - bh;
    let follow: ActiveBubble['follow'];

    if (this.entityAttachLayer !== null && anchor instanceof Hotspot) {
      attachParent = this.entityAttachLayer;
      (bubble as Container & { entitySortBand?: 'front' }).entitySortBand = 'front';
      const quad = anchor.getEmoteWorldQuad();
      bx = quad.left + quad.width / 2 - bw / 2 + ox;
      by = quad.top - QUAD_ABOVE_GAP - bh + oy;
      this.dbg(
        `  热点 worldQuad→entityLayer ` +
          `quad xywh=(${quad.left.toFixed(1)},${quad.top.toFixed(1)}) ${quad.width.toFixed(1)}×${quad.height.toFixed(1)} ` +
          `bubble=(${bx.toFixed(1)},${by.toFixed(1)}) band=front`,
      );
    } else if (this.entityAttachLayer !== null && displayObj.parent === this.entityAttachLayer) {
      // 玩家/NPC/过场演员：实体容器带光照/遮挡滤镜，气泡挂进去会撑大滤镜 bounds、触发 AO 重标定，
      // 还会被实体 scale.x=-1 镜像。与热点气泡同样单挂 entityLayer（实体容器本就是该层直接子节点，
      // 坐标同空间），实体会移动，故记 follow 由 update 每帧按脚点重摆。
      attachParent = this.entityAttachLayer;
      (bubble as Container & { entitySortBand?: 'front' }).entitySortBand = 'front';
      bx = displayObj.x - bw / 2 + ox;
      by = displayObj.y + anchor.getEmoteBubbleAnchorLocalY() + oy - bh;
      follow = { anchor, displayObj, bw, bh, ox, oy };
      this.dbg(`  实体气泡→entityLayer 跟随 bubble=(${bx.toFixed(1)},${by.toFixed(1)}) band=front`);
    } else if (anchor instanceof Hotspot && this.entityAttachLayer === null) {
      this.dbg('  警告: Hotspot 但 entityAttachLayer 未设置，气泡仅在热点容器内（易被遮挡）');
    }

    bubble.x = bx;
    bubble.y = by;
    attachParent.addChild(bubble);
    if (attachParent.sortableChildren) {
      attachParent.sortChildren();
    }
    this.dbg(
      `  已 addChild: 父=${attachParent === this.entityAttachLayer ? 'entityLayer' : 'anchor本地'} ` +
        `bubble.xy=(${bx.toFixed(1)},${by.toFixed(1)}) bw×bh=${bw.toFixed(0)}×${bh.toFixed(0)} ` +
        `bubble.visible=${bubble.visible} bubble.renderable=${(bubble as { renderable?: boolean }).renderable ?? '?'}`,
    );
    return { bubble, parent: attachParent, bw, bh, follow };
  }

  show(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    durationMs: number = 1500,
    opts?: EmoteBubbleOffsetOpts,
    owner?: string,
  ): void {
    const { bubble, parent, follow } = this.buildAndMountBubble(anchor, emote, opts);
    this.dbg(`show 定时消失 durMs=${durationMs}${owner ? ` owner=${owner}` : ''}`);
    this.activeBubbles.push({
      bubble,
      parent,
      remainingMs: durationMs,
      noAutoExpire: false,
      owner,
      follow,
    });
  }

  /**
   * 不参与每帧倒计时；须调用返回的 dismiss() 或 cleanup() 移除。
   * 供 showSubtitle.subtitleEmote；Action showEmoteAndWait 仍用 showAndWait(duration)。
   */
  showSticky(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    opts?: EmoteBubbleOffsetOpts,
    owner?: string,
  ): () => void {
    const { bubble, parent, follow } = this.buildAndMountBubble(anchor, emote, opts);
    this.dbg('showSticky 无自动消失，须与字幕等同生命周期 dismiss');
    const entry: ActiveBubble = {
      bubble,
      parent,
      remainingMs: 0,
      noAutoExpire: true,
      owner,
      follow,
    };
    this.activeBubbles.push(entry);
    return () => {
      const i = this.activeBubbles.indexOf(entry);
      if (i < 0) return;
      this.removeBubble(entry);
      this.activeBubbles.splice(i, 1);
    };
  }

  showAndWait(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    durationMs: number = 1500,
    opts?: EmoteBubbleOffsetOpts,
    owner?: string,
  ): Promise<void> {
    this.show(anchor, emote, durationMs, opts, owner);
    return new Promise(resolve => {
      const id = setTimeout(() => {
        this.pendingTimers.delete(id);
        resolve();
      }, durationMs);
      this.pendingTimers.add(id);
    });
  }

  update(dt: number): void {
    for (let i = this.activeBubbles.length - 1; i >= 0; i--) {
      const entry = this.activeBubbles[i];
      if (entry.follow) {
        const { anchor, displayObj, bw, bh, ox, oy } = entry.follow;
        // 锚定实体已被拆除（切场/过场收尾）：气泡没有可跟随的目标，立即移除，别悬浮在旧位置
        if (displayObj.destroyed || !displayObj.parent) {
          this.removeBubble(entry);
          this.activeBubbles.splice(i, 1);
          continue;
        }
        entry.bubble.x = displayObj.x - bw / 2 + ox;
        entry.bubble.y = displayObj.y + anchor.getEmoteBubbleAnchorLocalY() + oy - bh;
      }
      if (entry.noAutoExpire) continue;
      entry.remainingMs -= dt * 1000;
      if (entry.remainingMs <= 0) {
        this.removeBubble(entry);
        this.activeBubbles.splice(i, 1);
      }
    }
  }

  private removeBubble(entry: ActiveBubble): void {
    if (entry.bubble.parent) {
      entry.bubble.parent.removeChild(entry.bubble);
    }
    entry.bubble.destroy({ children: true });
  }

  /**
   * 只清指定归属方的气泡（show/showSticky 传入的 owner 标记），其余不动——
   * 供过场收尾只清过场自己发的气泡，不误杀世界侧仍在倒计时的气泡。
   */
  cleanupByOwner(owner: string): void {
    for (let i = this.activeBubbles.length - 1; i >= 0; i--) {
      const entry = this.activeBubbles[i];
      if (entry.owner !== owner) continue;
      this.removeBubble(entry);
      this.activeBubbles.splice(i, 1);
    }
  }

  cleanup(): void {
    for (const id of this.pendingTimers) clearTimeout(id);
    this.pendingTimers.clear();
    for (const entry of this.activeBubbles) {
      this.removeBubble(entry);
    }
    this.activeBubbles.length = 0;
  }

  destroy(): void {
    this.cleanup();
    // 外部注入引用一并放掉；重 init 时由 Game 重新 set
    this.entityAttachLayer = null;
    this.debugPanelLog = null;
  }
}
