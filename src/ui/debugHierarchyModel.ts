/**
 * F2「层级」页的纯逻辑(不碰 DOM,node 环境可测):
 * 树的展平 / 过滤、显示名、虚拟滚动的可见区间、检视器读数与写入、角度换算、
 * 舞台坐标 ↔ 画布 CSS 像素、画面拾取。DOM 那一半在 `debugHierarchySection.ts`。
 *
 * 节点即 engine2d 的 `Container`(GameObject + Transform,见 `engine2d/scene/Container.ts` 的「层级」一节)。
 * 这里的一切**只读 / 只改内存里的活对象**,不落任何文件。
 */
import { Point, type Container } from '../engine2d';

/** 游戏侧给无名节点起的显示别名(渲染层、玩家、NPC / 热点的容器);只用于显示与搜索,不写回 label */
export type NodeAliases = ReadonlyMap<Container, string>;

const NO_ALIASES: NodeAliases = new Map();

// ───────────────────────── 显示名

/** 节点的类名(dev 构建保留类名;取不到时退回 Container) */
export function nodeClassName(node: Container): string {
  const n = (node as { constructor?: { name?: string } }).constructor?.name;
  return n && n.length > 0 ? n : 'Container';
}

export interface NodeDisplayName {
  text: string;
  /** label = 节点自己的名字;alias = 游戏侧给的别名;anon = 没名字,用「类名#uid」 */
  kind: 'label' | 'alias' | 'anon';
}

export function nodeDisplayName(node: Container, aliases: NodeAliases = NO_ALIASES): NodeDisplayName {
  const label = node.label;
  if (label) return { text: label, kind: 'label' };
  const alias = aliases.get(node);
  if (alias) return { text: alias, kind: 'alias' };
  return { text: `${nodeClassName(node)}#${node.uid}`, kind: 'anon' };
}

/**
 * 名字过滤:忽略大小写的子串,比对 label / 别名 / 类名;以 `#` 开头则按 uid 精确匹配。
 * `q` 须已 trim + 小写(见 {@link normalizeQuery})。
 */
export function nodeMatchesQuery(node: Container, q: string, aliases: NodeAliases = NO_ALIASES): boolean {
  if (!q) return true;
  if (q.startsWith('#')) return q === `#${node.uid}`;
  if (node.label && node.label.toLowerCase().includes(q)) return true;
  const alias = aliases.get(node);
  if (alias && alias.toLowerCase().includes(q)) return true;
  return nodeClassName(node).toLowerCase().includes(q);
}

export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

// ───────────────────────── 树的展平

export interface TreeRow {
  node: Container;
  depth: number;
  hasChildren: boolean;
  /** 下一行是不是它的子节点(展开态 / 过滤时作为命中行的祖先) */
  expanded: boolean;
  /** 过滤模式下本行自己命中;非过滤模式恒 true */
  match: boolean;
}

export interface FlattenResult {
  rows: TreeRow[];
  /** 行数超过上限被截断 */
  truncated: boolean;
  /** 过滤模式:命中的节点数(截断前数到的);非过滤模式为 -1 */
  matches: number;
}

/**
 * 按展开集合(uid)展平:只下探展开了的节点,几千个节点的树也只产出看得见的行。
 * 根节点本身作为第 0 层的一行。
 */
export function flattenTree(root: Container, expanded: ReadonlySet<number>, maxRows = 20000): FlattenResult {
  const rows: TreeRow[] = [];
  let truncated = false;
  const visit = (node: Container, depth: number): void => {
    if (rows.length >= maxRows) {
      truncated = true;
      return;
    }
    const hasChildren = node.children.length > 0;
    const open = hasChildren && expanded.has(node.uid);
    rows.push({ node, depth, hasChildren, expanded: open, match: true });
    if (!open) return;
    for (const child of node.children) {
      visit(child, depth + 1);
      if (truncated) return;
    }
  };
  visit(root, 0);
  return { rows, truncated, matches: -1 };
}

/**
 * 过滤:搜整棵树(不管展开与否),产出「命中节点 + 它们的祖先」构成的剪枝树(前序,祖先全展开)。
 * 命中节点的子孙只有自己也命中才出现。
 */
export function filterTree(
  root: Container,
  query: string,
  aliases: NodeAliases = NO_ALIASES,
  maxMatches = 500,
): FlattenResult {
  const q = normalizeQuery(query);
  const rows: TreeRow[] = [];
  const path: Container[] = [];
  /** path 里前多少个已经作为行输出过 */
  let emitted = 0;
  let matches = 0;
  let truncated = false;
  const visit = (node: Container, depth: number): void => {
    path[depth] = node;
    path.length = depth + 1;
    if (emitted > depth) emitted = depth;
    if (nodeMatchesQuery(node, q, aliases)) {
      if (matches >= maxMatches) {
        truncated = true;
        return;
      }
      for (let i = emitted; i < depth; i++) {
        const a = path[i];
        rows.push({ node: a, depth: i, hasChildren: a.children.length > 0, expanded: false, match: false });
      }
      rows.push({ node, depth, hasChildren: node.children.length > 0, expanded: false, match: true });
      emitted = depth + 1;
      matches++;
    }
    for (const child of node.children) {
      visit(child, depth + 1);
      if (truncated) return;
    }
  };
  visit(root, 0);
  for (let i = 0; i < rows.length; i++) rows[i].expanded = i + 1 < rows.length && rows[i + 1].depth > rows[i].depth;
  return { rows, truncated, matches };
}

/** 从 root 到 node 的父链(不含 node 本身;node 不在 root 下时返回 null) */
export function ancestorChain(node: Container, root: Container): Container[] | null {
  const chain: Container[] = [];
  for (let c = node.parent; c; c = c.parent) {
    chain.push(c);
    if (c === root) return chain.reverse();
  }
  return node === root ? [] : null;
}

/** 整棵树的节点数(状态行用;几千个节点也只是一次遍历) */
export function countNodes(root: Container): number {
  let n = 1;
  for (const c of root.children) n += countNodes(c);
  return n;
}

// ───────────────────────── 虚拟滚动

/** 固定行高的列表里,滚动位置对应要画的行区间 [first, last)(含上下各 overscan 行) */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 6,
): { first: number; last: number } {
  if (total <= 0 || rowHeight <= 0) return { first: 0, last: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + Math.max(0, viewportHeight)) / rowHeight) + overscan);
  return { first, last: Math.max(first, last) };
}

/** 让第 index 行完整露出来所需的 scrollTop(已经看得见就原样返回) */
export function scrollTopToReveal(index: number, scrollTop: number, viewportHeight: number, rowHeight: number): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}

// ───────────────────────── 数值

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 显示用:最多 digits 位小数、去掉尾零、不出现 -0 */
export function formatNum(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return String(v);
  const f = 10 ** digits;
  let r = Math.round(v * f) / f;
  if (Object.is(r, -0) || r === 0) r = 0;
  return String(r);
}

/** 输入框文字 → 有限数;空 / 非数 / 无穷返回 null(调用方据此拒收并把框恢复成活值) */
export function parseNum(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// ───────────────────────── 检视器:读数与写入

/** 检视器里可编辑的数值字段 */
export type NumericField =
  | 'posX' | 'posY' | 'rotDeg' | 'scaleX' | 'scaleY' | 'pivotX' | 'pivotY' | 'skewXDeg' | 'skewYDeg'
  | 'worldX' | 'worldY' | 'worldRotDeg' | 'alpha' | 'zIndex' | 'siblingIndex';

export type TransformReadout = Record<NumericField, number> & { lossyX: number; lossyY: number };

/**
 * 一次读齐检视器要的数(角度一律换成度)。
 * 注意:读 pivot / skew / scale 会让引擎懒建那几个 ObservablePoint(值为缺省),不改变任何变换。
 */
export function readTransform(node: Container): TransformReadout {
  const wp = node.worldPosition;
  const lossy = node.lossyScale;
  return {
    posX: node.position.x,
    posY: node.position.y,
    rotDeg: radToDeg(node.localRotation),
    scaleX: node.scale.x,
    scaleY: node.scale.y,
    pivotX: node.pivot.x,
    pivotY: node.pivot.y,
    skewXDeg: radToDeg(node.skew.x),
    skewYDeg: radToDeg(node.skew.y),
    worldX: wp.x,
    worldY: wp.y,
    worldRotDeg: radToDeg(node.worldRotation),
    alpha: node.alpha,
    zIndex: node.zIndex,
    siblingIndex: node.siblingIndex,
    lossyX: lossy.x,
    lossyY: lossy.y,
  };
}

/** 把一个数值字段写回活对象(度 → 弧度在这里换);世界量走引擎的 worldPosition / worldRotation setter */
export function applyNumericField(node: Container, field: NumericField, value: number): void {
  switch (field) {
    case 'posX': node.position.x = value; break;
    case 'posY': node.position.y = value; break;
    case 'rotDeg': node.localRotation = degToRad(value); break;
    case 'scaleX': node.scale.x = value; break;
    case 'scaleY': node.scale.y = value; break;
    case 'pivotX': node.pivot.x = value; break;
    case 'pivotY': node.pivot.y = value; break;
    case 'skewXDeg': node.skew.x = degToRad(value); break;
    case 'skewYDeg': node.skew.y = degToRad(value); break;
    case 'worldX': { const w = node.worldPosition; node.worldPosition = { x: value, y: w.y }; break; }
    case 'worldY': { const w = node.worldPosition; node.worldPosition = { x: w.x, y: value }; break; }
    case 'worldRotDeg': node.worldRotation = degToRad(value); break;
    case 'alpha': node.alpha = Math.max(0, Math.min(1, value)); break;
    case 'zIndex': node.zIndex = value; break;
    case 'siblingIndex': node.siblingIndex = value; break;
  }
}

// ───────────────────────── 舞台坐标 ↔ 画布 CSS 像素

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 舞台坐标(= 逻辑视口像素,`app.screen`;`getBounds()` / `worldPosition` 都在这个空间)→ 宿主元素里的 CSS 像素。
 *
 * `canvasInHost` 是画布在宿主元素里的 CSS 盒(`canvas.getBoundingClientRect()` 减宿主的)。
 * 固定视口时画布是 `Renderer.layoutMount` 摆出的等比盒、宽高各自向下取整,所以两轴分开算比例,不假设等比。
 */
export function stageRectToHost(rect: StageRect, screen: { width: number; height: number }, canvasInHost: Box): Box | null {
  if (!(screen.width > 0 && screen.height > 0)) return null;
  const sx = canvasInHost.width / screen.width;
  const sy = canvasInHost.height / screen.height;
  return {
    left: canvasInHost.left + rect.x * sx,
    top: canvasInHost.top + rect.y * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
}

/** 视口坐标(clientX/Y)→ 舞台坐标;画布盒用 `getBoundingClientRect()` 的值 */
export function clientToStage(
  clientX: number,
  clientY: number,
  screen: { width: number; height: number },
  canvasClient: Box,
): { x: number; y: number } | null {
  if (!(canvasClient.width > 0 && canvasClient.height > 0)) return null;
  return {
    x: ((clientX - canvasClient.left) * screen.width) / canvasClient.width,
    y: ((clientY - canvasClient.top) * screen.height) / canvasClient.height,
  };
}

/** 两个盒的交;不相交返回 null */
export function intersectBox(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

// ───────────────────────── 画面拾取

const tmpLocal = new Point();
const tmpGlobal = new Point();

function hitSelf(node: Container, p: Point): boolean {
  // 纯容器自己没东西可画(Container.containsPoint 恒 false),省掉一次逆变换
  if (!node.renderPipeId) return false;
  node.worldTransform.applyInverse(p, tmpLocal);
  return node.containsPoint(tmpLocal);
}

const hitForMask = (c: Container, p: Point): boolean => {
  c.worldTransform.applyInverse(p, tmpLocal);
  return c.containsPoint(tmpLocal);
};

/**
 * 舞台坐标 (x, y) 处**看得见的**节点,自顶向下(`[0]` 是最上面那个),最多 limit 个。
 *
 * 为什么不用事件边界的 `hitTest`:那条只认可交互节点(eventMode static / dynamic),
 * 游戏里的场景、实体、特效几乎全是 passive,点哪儿都拾不到。这里走同样的顺序与剪枝
 * (子节点倒序、未激活 / 不可见 / 不可渲染 / 不计包围盒的整棵剪掉、遮罩外剪掉),
 * 但不看 eventMode、也不看 hitArea(那是交互区,不是画面),另外剪掉累计 alpha≈0 的
 * (渐黑层之类透明全屏板会把整个画面盖住)。
 */
export function pickAll(root: Container, x: number, y: number, limit = 32): Container[] {
  const out: Container[] = [];
  const p = tmpGlobal;
  p.set(x, y);
  const visit = (node: Container, parentAlpha: number): void => {
    if (out.length >= limit) return;
    if (!node.activeSelf || !node.visible || !node.renderable || !node.measurable || !node.includeInBuild || node.culled) return;
    const a = parentAlpha * node.alpha;
    if (a <= 0.001) return;
    for (const e of node.effects) {
      if (e.containsPoint && !e.containsPoint(p, hitForMask)) return;
    }
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      visit(children[i], a);
      if (out.length >= limit) return;
    }
    if (hitSelf(node, p)) out.push(node);
  };
  visit(root, 1);
  return out;
}

/**
 * 同一处连点时依次往下选(照 Unity 场景视图):当前选中在命中列表里就取下一个,否则取最上面那个。
 */
export function nextPick(hits: readonly Container[], current: Container | null): Container | null {
  if (hits.length === 0) return null;
  const i = current ? hits.indexOf(current) : -1;
  return i < 0 ? hits[0] : hits[(i + 1) % hits.length];
}
