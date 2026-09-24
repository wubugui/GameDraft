import { Container } from 'pixi.js';

/**
 * **画布**(制作人 2026-09-21 定名):场景之外的那一张**屏幕空间的面**。
 *
 * 一句话:背景一张图,前面按作者定的顺序画别的东西 —— 叠图、文档揭示、实体、特效
 * 全是这张面上的 item,共用**同一个顺序空间**(`order`,越大越靠前),随时可改。
 *
 * ## 为什么必须有这一张表(不是"再加一个容器")
 *
 * 在它之前,屏幕空间的东西散在 `CutsceneRenderer` 的几张私有表里(`images` / `documentLayers`),
 * 各自 `addChild` 到同一个 `cutsceneOverlay` 上,**顺序由 addChild 先后决定**;而实体与粒子的
 * 唯一宿主是 `worldContainer.entityLayer`。两者是**兄弟容器**,父子关系压着 ——
 * 于是"实体 / 特效能不能画到文档揭示前面"这个问题在架构上**无解**:那一层填什么 zIndex 都没用,
 * 因为比的根本不是同一个父节点下的次序(2026-09-21 制作人提的正是这一条)。
 *
 * 这张表把那个面收成一处:**唯一宿主 + 唯一顺序空间 + 唯一销毁纪律**。
 *
 * ## 句柄命名空间(硬契约,别合并)
 *
 * item 的键 = `kind` 前缀 + 作者名。这不是为了好看 —— `hideOverlayImage` **必须收不到**
 * 文档揭示(见 `overlay-image-handle-semantics` 与 `document-reveal-three-states` 两张卡:
 * 作者的叠图句柄与 documentId 是两个命名空间,2026-09-12 制作人定调解耦)。
 * 前缀就是那条解耦在这张新表里的落地形式:两种 kind 的同名 item 天然是两个键,
 * 谁也寻址不到谁,**不需要再靠两张 Map 才做得到**。
 *
 * ## 顺序语义
 *
 * `order` 越大越靠前,直接写进 `node.zIndex`,由 Pixi 的 `sortableChildren` 每帧排。
 * **同 `order` 的 item 保持登记先后**(Array.prototype.sort 稳定),所以全部不填 order 时
 * 行为与迁移前的"按 addChild 先后"一致 —— 这是迁移不改画面的前提。
 *
 * ## 谁负责销毁 node
 *
 * `attach` 进来的显示对象**所有权仍归调用方**:这张表只管"在不在画布上、排第几",
 * `detach` / `clear` 只摘父子关系与登记,**不 destroy**。理由是既有几路(叠图的
 * `CutsceneLayerEntry.disposeGpu`、实体的挂件与 lit mesh、粒子的网格池)各有自己的释放
 * 纪律,收归这里只会变成第二份真相。
 */

/** 画布上 item 的四种来路。前缀即命名空间,见类注释。 */
export type CanvasItemKind = 'image' | 'document' | 'entity' | 'vfx';

/** 没填 order 时的缺省:0。全部缺省 = 按登记先后,与迁移前一致。 */
export const CANVAS_ORDER_DEFAULT = 0;

/** 对外快照(调试面板 / 画布工作台 / 测试读它),按 order 升序。 */
export interface CanvasItemInfo {
  /** 带 kind 前缀的全局键 */
  key: string;
  kind: CanvasItemKind;
  /** 作者面的名字(不带前缀):叠图句柄 / documentId / 实体名 / 特效句柄 */
  name: string;
  order: number;
  visible: boolean;
}

interface CanvasItem {
  kind: CanvasItemKind;
  name: string;
  node: Container;
  order: number;
  /** 登记序号:仅用于 list() 的稳定次序,不参与 zIndex */
  seq: number;
  /** 屏幕尺寸变了要重摆的 item 自己登记(不登记 = 不需要重摆) */
  relayout?: (screenW: number, screenH: number) => void;
}

export class CanvasStage {
  /**
   * 画布的唯一宿主容器。由 `Renderer` 建好并挂在 **worldContainer 之上、cutsceneOverlay 之下**:
   * 画布是"画面"的一部分(所以过场的字幕 / 电影黑边 / 对白框在它之上),但不是世界
   * (所以不吃相机变换、不吃世界滤镜)。
   */
  readonly layer: Container;

  private readonly items = new Map<string, CanvasItem>();
  private seqCounter = 0;

  constructor(layer?: Container) {
    this.layer = layer ?? new Container();
    // 顺序全靠 zIndex,开了就不再关 —— 迁移前 CutsceneRenderer 会在 cleanup 里把
    // sortableChildren 关掉(因为那是与别人共用的 cutsceneOverlay),这里是画布**自己的**
    // 容器,没有共用方,关掉只会让下一次 attach 的 order 静默失效。
    this.layer.sortableChildren = true;
  }

  /** 键构造:kind 前缀 + 作者名。两个 kind 的同名 item 永远是两个键。 */
  static keyOf(kind: CanvasItemKind, name: string): string {
    return `${kind}:${name}`;
  }

  /**
   * 放一个 item 上画布(同键已有则**先摘掉旧的**再放新的,旧 node 的销毁归调用方)。
   *
   * @param order 越大越靠前;不给走 {@link CANVAS_ORDER_DEFAULT}
   * @param relayout 屏幕尺寸变化时重摆自己(按屏幕百分比定位的 item 都要给)
   */
  attach(
    kind: CanvasItemKind,
    name: string,
    node: Container,
    order?: number,
    relayout?: (screenW: number, screenH: number) => void,
  ): string {
    const key = CanvasStage.keyOf(kind, name);
    const prev = this.items.get(key);
    if (prev && prev.node !== node) this.unparent(prev.node);

    const ord = Number.isFinite(order) ? Number(order) : CANVAS_ORDER_DEFAULT;
    node.zIndex = ord;
    this.layer.addChild(node);
    this.items.set(key, { kind, name, node, order: ord, seq: this.seqCounter++, relayout });
    return key;
  }

  /** 摘掉一个 item(只摘不销毁);返回它的 node 供调用方自己释放。 */
  detach(kind: CanvasItemKind, name: string): Container | null {
    const key = CanvasStage.keyOf(kind, name);
    const item = this.items.get(key);
    if (!item) return null;
    this.items.delete(key);
    this.unparent(item.node);
    return item.node;
  }

  /** 改某个 item 的绘制顺序。item 不在画布上返回 false(作者写错名字要能看见)。 */
  setOrder(kind: CanvasItemKind, name: string, order: number): boolean {
    const item = this.items.get(CanvasStage.keyOf(kind, name));
    if (!item) return false;
    const ord = Number.isFinite(order) ? Number(order) : CANVAS_ORDER_DEFAULT;
    item.order = ord;
    item.node.zIndex = ord;
    return true;
  }

  getOrder(kind: CanvasItemKind, name: string): number | undefined {
    return this.items.get(CanvasStage.keyOf(kind, name))?.order;
  }

  has(kind: CanvasItemKind, name: string): boolean {
    return this.items.has(CanvasStage.keyOf(kind, name));
  }

  getNode(kind: CanvasItemKind, name: string): Container | null {
    return this.items.get(CanvasStage.keyOf(kind, name))?.node ?? null;
  }

  /** 某一类的全部作者名(叠图收图、换场景清实体等按类扫的路径用)。 */
  namesOf(kind: CanvasItemKind): string[] {
    const out: string[] = [];
    for (const item of this.items.values()) if (item.kind === kind) out.push(item.name);
    return out;
  }

  /**
   * 画布上现在有什么、谁在谁前面。按 `order` 升序;同 order 按登记先后
   * —— 与 Pixi 实际排出来的次序同口径(见类注释的顺序语义)。
   */
  list(): CanvasItemInfo[] {
    const arr = [...this.items.entries()].map(([key, it]) => ({
      key,
      kind: it.kind,
      name: it.name,
      order: it.order,
      visible: it.node.visible,
      seq: it.seq,
    }));
    arr.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
    return arr.map(({ seq: _seq, ...info }) => info);
  }

  /** 屏幕尺寸变了:逐个让登记过 relayout 的 item 重摆。 */
  relayout(screenW: number, screenH: number): void {
    for (const item of this.items.values()) {
      if (!item.relayout) continue;
      try {
        item.relayout(screenW, screenH);
      } catch (e) {
        console.warn(`[canvas] item「${item.kind}:${item.name}」重摆失败`, e);
      }
    }
  }

  /** 清空画布(只摘不销毁,同 detach 的所有权约定)。 */
  clear(): void {
    for (const item of this.items.values()) this.unparent(item.node);
    this.items.clear();
  }

  private unparent(node: Container): void {
    // destroy 过的节点读 parent 就抛;画布只负责摘,摘不动也不能让它打断整批
    try {
      if (node.parent) node.parent.removeChild(node);
    } catch {
      /* 已销毁 / 已摘 */
    }
  }
}
