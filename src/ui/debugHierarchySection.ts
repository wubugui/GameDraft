/**
 * F2「层级」页:活场景树(Hierarchy)+ 检视器(Inspector),照 Unity 的那两个窗口。
 *
 * - **树**:`app.stage` 起的整棵渲染树,懒展开 + 虚拟滚动(几千个节点也只画看得见的几十行);
 *   每行:展开箭头、激活勾(`setActive`)、名字(无名用游戏侧给的别名,再没有就「类名#uid」)、角标
 *   (隐 = visible false、不渲 = renderable false、⚙n = 组件数、(n) = 子节点数;层级中未激活的整行变灰)。
 *   名字过滤搜整棵树,命中节点连同祖先链展开列出。方向键可在树里走。
 * - **检视器**:选中节点的名字 / 激活 / 显隐 / alpha / zIndex、本地变换(位置 / 旋转° / 缩放 / pivot / 切变°)、
 *   世界位置 / 世界旋转°(可改,走引擎的 worldPosition / worldRotation)/ lossyScale、兄弟序号、父链(点了选中)、
 *   组件列表(逐个 enabled)。数值框回车 / 失焦生效;没在编辑的框按活对象刷新;拖字段名左右刮值(Shift ×10、Alt ×0.1)。
 * - **高亮**:选中节点的包围盒(`getBounds()`,舞台坐标)换算到画布 CSS 像素,DOM 框叠在画面上;
 *   树里悬停的行另画一个虚线框。
 * - **拾取**:点「拾取」后在画面上点,选中那一点最上面**看得见的**节点(同一处再点依次往下);Shift 连续拾取,Esc / 右键退出。
 *
 * 只在「F2 打开且停在本页」时轮询(4 Hz)、画高亮(每帧)、能拾取;切走 / 收起即全停。
 * **所有改动只落在内存里的活对象上,不写任何文件**;游戏逻辑每帧写的属性(实体位置、显隐、实体层 zIndex)
 * 会被下一帧改回去,这是预期。纯逻辑(展平 / 过滤 / 换算 / 拾取)在 `debugHierarchyModel.ts`,有单测。
 */
import type { Component, Container } from '../engine2d';
import {
  ancestorChain,
  applyNumericField,
  clientToStage,
  countNodes,
  filterTree,
  flattenTree,
  formatNum,
  intersectBox,
  nextPick,
  nodeClassName,
  nodeDisplayName,
  parseNum,
  pickAll,
  readTransform,
  scrollTopToReveal,
  stageRectToHost,
  visibleRange,
  type Box,
  type NodeAliases,
  type NumericField,
  type StageRect,
  type TreeRow,
} from './debugHierarchyModel';

export interface DebugHierarchyDeps {
  /** 渲染根(Application 的 stage);渲染器没起来 / 已拆时返回 null */
  getRoot: () => Container | null;
  /** 游戏画布;高亮框与拾取按它的 CSS 盒换算(框挂在它的父元素 #game-mount 上) */
  getCanvas: () => HTMLCanvasElement | null;
  /** 逻辑视口尺寸(= app.screen,舞台坐标的范围) */
  getScreenSize: () => { width: number; height: number };
  /** 无名节点的显示别名(渲染层 / 玩家 / NPC / 热点);每次轮询取一次,只用于显示与搜索 */
  getNodeAliases?: () => NodeAliases;
  log: (message: string) => void;
}

export interface DebugHierarchySectionHandle {
  root: HTMLElement;
  /** 本页是否正被看着(F2 打开且停在本页):只有看着时才轮询、画高亮、能拾取 */
  setActive(active: boolean): void;
  /** 立刻刷一次(没在看就什么也不做) */
  refresh(): void;
  destroy(): void;
}

const POLL_MS = 250;
const ROW_H = 20;
const INDENT_PX = 12;
/** 算一次包围盒超过这么多毫秒,就不再每帧算(整棵舞台这种大子树),退回按轮询频率 */
const SLOW_BOUNDS_MS = 1;
const EMPTY_ALIASES: NodeAliases = new Map();

interface Slot {
  el: HTMLDivElement;
  tog: HTMLSpanElement;
  act: HTMLInputElement;
  name: HTMLSpanElement;
  cls: HTMLSpanElement;
  badges: HTMLSpanElement;
  sig: string;
  rowIndex: number;
}

interface NumInput {
  field: NumericField;
  input: HTMLInputElement;
  digits: number;
  step: number;
}

interface BoundsCache {
  node: Container | null;
  rect: StageRect | null;
  /** 包围盒为空(未激活 / 不可见 / 没内容)时退回画世界位置的十字 */
  marker: boolean;
  at: number;
  slow: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

function btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'debug-dock__btn debug-dock__btn--sm', label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export function createDebugHierarchySection(deps: DebugHierarchyDeps): DebugHierarchySectionHandle {
  let active = false;
  let destroyed = false;
  let pollTimer: number | null = null;
  let overlayRaf: number | null = null;
  let pickRaf: number | null = null;

  let selected: Container | null = null;
  /** 树里指针悬停的行 */
  let rowHover: Container | null = null;
  /** 拾取模式下指针底下的节点 */
  let pickHover: Container | null = null;
  const expanded = new Set<number>();
  let rootSeen: Container | null = null;
  let rows: TreeRow[] = [];
  let filterQuery = '';
  let filterMatches = -1;
  let rowsTruncated = false;
  let aliases: NodeAliases = EMPTY_ALIASES;
  /** 状态行尾的一次性提示(选中的节点没了之类) */
  let note = '';

  // ───────────────────────── 外壳

  const sec = el('section', 'debug-hier');

  const hint = el('div', 'debug-hier__hint',
    '只改内存里的活对象，不落盘（刷新 / 重进场景即还原）。游戏逻辑每帧写的属性（实体位置、显隐、实体层 zIndex）会被下一帧改回。');
  sec.appendChild(hint);

  const bar = el('div', 'debug-hier__bar');
  const search = el('input', 'debug-flag__search debug-hier__search');
  search.type = 'search';
  search.placeholder = '按名字 / 类名过滤（#uid 精确）…';
  search.autocomplete = 'off';
  const pickBtn = btn('拾取', '在画面上点一下选中那里最上面看得见的节点（同一处再点依次往下；Shift 连续拾取，Esc / 右键退出）',
    () => setPicking(!picking));
  const revealBtn = btn('定位', '在树里展开并滚到选中的节点', () => revealSelected());
  const collapseBtn = btn('全部折叠', '只留根节点展开', () => {
    expanded.clear();
    if (rootSeen) expanded.add(rootSeen.uid);
    refreshNow();
  });
  bar.append(search, pickBtn, revealBtn, collapseBtn);
  sec.appendChild(bar);

  const status = el('div', 'debug-hier__status');
  sec.appendChild(status);

  const treeView = el('div', 'debug-hier__tree');
  treeView.tabIndex = 0;
  const spacer = el('div', 'debug-hier__spacer');
  treeView.appendChild(spacer);
  sec.appendChild(treeView);

  const insp = el('div', 'debug-hier__insp');
  sec.appendChild(insp);

  // ───────────────────────── 树

  const slots: Slot[] = [];

  function makeSlot(index: number): Slot {
    const row = el('div', 'debug-hier__row');
    row.dataset.slot = String(index);
    const tog = el('span', 'debug-hier__tog');
    const act = el('input', 'debug-hier__act');
    act.type = 'checkbox';
    act.title = 'activeSelf（setActive）';
    const name = el('span', 'debug-hier__name');
    const cls = el('span', 'debug-hier__cls');
    const badges = el('span', 'debug-hier__badges');
    row.append(tog, act, name, cls, badges);
    spacer.appendChild(row);
    return { el: row, tog, act, name, cls, badges, sig: '', rowIndex: -1 };
  }

  function slotOf(target: EventTarget | null): Slot | null {
    const row = (target as HTMLElement | null)?.closest?.('.debug-hier__row') as HTMLElement | null;
    if (!row || row.parentElement !== spacer) return null;
    const s = slots[Number(row.dataset.slot)];
    return s && s.rowIndex >= 0 && s.rowIndex < rows.length ? s : null;
  }

  function rebuildRows(root: Container): void {
    const r = filterQuery ? filterTree(root, filterQuery, aliases) : flattenTree(root, expanded);
    rows = r.rows;
    filterMatches = r.matches;
    rowsTruncated = r.truncated;
  }

  /** 撑开滚动区到当前行数(改 scrollTop 之前必须先做,否则浏览器按旧高度把它夹回去) */
  function syncSpacerHeight(): void {
    const h = `${rows.length * ROW_H}px`;
    if (spacer.style.height !== h) spacer.style.height = h;
  }

  function renderSlice(): void {
    const total = rows.length;
    syncSpacerHeight();
    const { first, last } = visibleRange(treeView.scrollTop, treeView.clientHeight, ROW_H, total);
    const need = last - first;
    while (slots.length < need) slots.push(makeSlot(slots.length));
    const filtering = filterQuery !== '';
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k];
      const i = first + k;
      if (k >= need) {
        if (s.rowIndex !== -1) {
          s.rowIndex = -1;
          s.sig = '';
          s.el.hidden = true;
        }
        continue;
      }
      s.rowIndex = i;
      const r = rows[i];
      const n = r.node;
      const dn = nodeDisplayName(n, aliases);
      const cls = nodeClassName(n);
      const aih = n.activeInHierarchy;
      const comps = n.components.length;
      const kids = n.children.length;
      const sig = [
        i, n.uid, r.depth, r.hasChildren ? 1 : 0, r.expanded ? 1 : 0, dn.text, dn.kind, cls,
        n.activeSelf ? 1 : 0, aih ? 1 : 0, n.visible ? 1 : 0, n.renderable ? 1 : 0, comps, kids,
        n === selected ? 1 : 0, r.match ? 1 : 0, filtering ? 1 : 0,
      ].join('|');
      if (sig === s.sig) continue;
      s.sig = sig;
      s.el.hidden = false;
      s.el.style.top = `${i * ROW_H}px`;
      s.el.style.paddingLeft = `${4 + r.depth * INDENT_PX}px`;
      s.tog.textContent = r.hasChildren ? (r.expanded ? '▾' : '▸') : '';
      s.tog.classList.toggle('is-static', filtering);
      s.act.checked = n.activeSelf;
      s.name.textContent = dn.text;
      s.name.className = `debug-hier__name is-${dn.kind}`;
      s.cls.textContent = cls !== 'Container' && cls !== dn.text ? cls : '';
      const b: string[] = [];
      if (!n.visible) b.push('隐');
      if (!n.renderable) b.push('不渲');
      if (comps > 0) b.push(`⚙${comps}`);
      if (kids > 0) b.push(`(${kids})`);
      s.badges.textContent = b.join(' ');
      s.el.classList.toggle('is-selected', n === selected);
      s.el.classList.toggle('is-inactive', !aih);
      s.el.classList.toggle('is-context', filtering && !r.match);
      s.el.title = `${n.hierarchyPath}\n${cls} #${n.uid}${aih ? '' : '（层级中未激活）'}`;
    }
  }

  function toggleExpand(n: Container): void {
    if (filterQuery || n.children.length === 0) return;
    if (expanded.has(n.uid)) expanded.delete(n.uid);
    else expanded.add(n.uid);
    refreshNow();
  }

  spacer.addEventListener('click', (e) => {
    const s = slotOf(e.target);
    if (!s || e.target === s.act) return;
    const n = rows[s.rowIndex].node;
    if (e.target === s.tog) toggleExpand(n);
    else select(n, false);
  });
  spacer.addEventListener('dblclick', (e) => {
    const s = slotOf(e.target);
    if (!s || e.target === s.act || e.target === s.tog) return;
    toggleExpand(rows[s.rowIndex].node);
  });
  spacer.addEventListener('change', (e) => {
    const s = slotOf(e.target);
    if (!s || e.target !== s.act) return;
    const n = rows[s.rowIndex].node;
    n.setActive(s.act.checked);
    deps.log(`[层级] ${n.hierarchyPath}.setActive(${s.act.checked})`);
    refreshNow();
  });
  spacer.addEventListener('pointerover', (e) => {
    const s = slotOf(e.target);
    rowHover = s ? rows[s.rowIndex].node : null;
  });
  treeView.addEventListener('pointerleave', () => {
    rowHover = null;
  });
  treeView.addEventListener('scroll', () => renderSlice());
  treeView.addEventListener('keydown', (e) => {
    if (rows.length === 0) return;
    const i = selected ? rows.findIndex((r) => r.node === selected) : -1;
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i < 0 ? 0 : i - 1);
    else if (e.key === 'ArrowRight' && i >= 0) {
      const r = rows[i];
      if (r.hasChildren && !r.expanded) toggleExpand(r.node);
      else if (r.expanded) next = i + 1;
    } else if (e.key === 'ArrowLeft' && i >= 0) {
      const r = rows[i];
      if (r.expanded && !filterQuery) toggleExpand(r.node);
      else {
        for (let j = i - 1; j >= 0; j--) {
          if (rows[j].depth < r.depth) {
            next = j;
            break;
          }
        }
      }
    } else return;
    e.preventDefault();
    if (next >= 0 && next < rows.length) {
      select(rows[next].node, false);
      treeView.scrollTop = scrollTopToReveal(next, treeView.scrollTop, treeView.clientHeight, ROW_H);
      renderSlice();
    }
  });

  search.addEventListener('input', () => {
    filterQuery = search.value.trim();
    note = '';
    treeView.scrollTop = 0;
    refreshNow();
  });

  function revealSelected(): void {
    const root = deps.getRoot();
    if (!selected || !root) return;
    const chain = ancestorChain(selected, root);
    if (!chain) return;
    if (filterQuery && !rows.some((r) => r.node === selected)) {
      search.value = '';
      filterQuery = '';
    }
    for (const a of chain) expanded.add(a.uid);
    rebuildRows(root);
    syncSpacerHeight();
    const idx = rows.findIndex((r) => r.node === selected);
    if (idx >= 0) {
      const vh = treeView.clientHeight;
      // 滚到正中(Unity 的 Frame 行为);已经看得见就不动
      const want = scrollTopToReveal(idx, treeView.scrollTop, vh, ROW_H);
      if (want !== treeView.scrollTop) treeView.scrollTop = Math.max(0, idx * ROW_H - vh / 2 + ROW_H / 2);
    }
    renderSlice();
  }

  // ───────────────────────── 检视器

  const empty = el('div', 'debug-hier__empty', '（未选中。点树里的一行，或用「拾取」在画面上点）');
  const body = el('div', 'debug-hier__insp-body');
  insp.append(empty, body);

  const numInputs: NumInput[] = [];
  /** 刮值进行中:这期间的读数刷新不跳过刮的那个框 */
  let scrubbing = false;

  function group(title: string): HTMLDivElement {
    const g = el('div', 'debug-hier__group');
    g.appendChild(el('div', 'debug-hier__group-title', title));
    body.appendChild(g);
    return g;
  }

  function commitNum(ni: NumInput): void {
    const node = selected;
    if (!node) return;
    const v = parseNum(ni.input.value);
    if (v === null) {
      ni.input.value = formatNum(readTransform(node)[ni.field], ni.digits);
      return;
    }
    applyNumericField(node, ni.field, v);
    deps.log(`[层级] ${node.hierarchyPath} ${ni.field} = ${formatNum(v, ni.digits)}`);
    ni.input.value = formatNum(readTransform(node)[ni.field], ni.digits);
    refreshNow();
  }

  function mkNumInput(field: NumericField, step: number, digits: number): HTMLInputElement {
    const input = el('input', 'debug-hier__num');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.spellcheck = false;
    const ni: NumInput = { field, input, digits, step };
    numInputs.push(ni);
    input.addEventListener('change', () => commitNum(ni));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (selected) input.value = formatNum(readTransform(selected)[field], digits);
        input.blur();
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!selected) return;
        const cur = parseNum(input.value) ?? readTransform(selected)[field];
        const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        input.value = formatNum(cur + (e.key === 'ArrowUp' ? 1 : -1) * step * mul, digits);
        commitNum(ni);
        e.preventDefault();
      }
    });
    return input;
  }

  /** 字段名左右拖动刮值(Unity 的做法);监听只挂在这个标签上,松手即摘 */
  function scrubbable(label: HTMLElement, field: NumericField, step: number, digits: number): void {
    label.classList.add('is-scrub');
    label.title = `左右拖动改值（Shift ×10，Alt ×0.1）；步长 ${step}`;
    label.addEventListener('pointerdown', (e) => {
      const node = selected;
      if (e.button !== 0 || !node) return;
      e.preventDefault();
      label.setPointerCapture(e.pointerId);
      let lastX = e.clientX;
      let value = readTransform(node)[field];
      const start = value;
      scrubbing = true;
      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        if (!dx || node.destroyed || selected !== node) return;
        value += dx * step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
        applyNumericField(node, field, value);
        refreshInspector(true);
      };
      const up = (): void => {
        label.removeEventListener('pointermove', move);
        label.removeEventListener('pointerup', up);
        label.removeEventListener('pointercancel', up);
        scrubbing = false;
        if (value !== start && !node.destroyed) {
          deps.log(`[层级] ${node.hierarchyPath} ${field} = ${formatNum(readTransform(node)[field], digits)}（拖动）`);
        }
        refreshNow();
      };
      label.addEventListener('pointermove', move);
      label.addEventListener('pointerup', up);
      label.addEventListener('pointercancel', up);
    });
  }

  function numRow(
    parent: HTMLElement,
    title: string,
    fields: readonly { field: NumericField; axis?: string }[],
    step: number,
    digits: number,
  ): void {
    const row = el('div', 'debug-hier__field');
    const lab = el('span', 'debug-hier__label', title);
    row.appendChild(lab);
    if (fields.length === 1) scrubbable(lab, fields[0].field, step, digits);
    for (const f of fields) {
      if (f.axis) {
        const ax = el('span', 'debug-hier__axis', f.axis);
        scrubbable(ax, f.field, step, digits);
        row.appendChild(ax);
      }
      row.appendChild(mkNumInput(f.field, step, digits));
    }
    parent.appendChild(row);
  }

  function readRow(parent: HTMLElement, title: string): HTMLSpanElement {
    const row = el('div', 'debug-hier__field');
    row.appendChild(el('span', 'debug-hier__label', title));
    const v = el('span', 'debug-hier__read');
    row.appendChild(v);
    parent.appendChild(row);
    return v;
  }

  function checkRow(parent: HTMLElement, title: string, tip: string, onChange: (node: Container, on: boolean) => void): HTMLInputElement {
    const lab = el('label', 'debug-hier__check');
    const c = el('input');
    c.type = 'checkbox';
    lab.title = tip;
    lab.append(c, document.createTextNode(title));
    c.addEventListener('change', () => {
      if (!selected) return;
      onChange(selected, c.checked);
      deps.log(`[层级] ${selected.hierarchyPath} ${title} = ${c.checked}`);
      refreshNow();
    });
    parent.appendChild(lab);
    return c;
  }

  // —— GameObject
  const gHead = group('GameObject');
  const headRow = el('div', 'debug-hier__head');
  const activeChk = el('input');
  activeChk.type = 'checkbox';
  activeChk.title = 'activeSelf（setActive）';
  activeChk.addEventListener('change', () => {
    if (!selected) return;
    selected.setActive(activeChk.checked);
    deps.log(`[层级] ${selected.hierarchyPath}.setActive(${activeChk.checked})`);
    refreshNow();
  });
  const nameInput = el('input', 'debug-hier__name-input');
  nameInput.type = 'text';
  nameInput.spellcheck = false;
  nameInput.placeholder = '（无名）';
  nameInput.title = 'name（= label）';
  nameInput.addEventListener('change', () => {
    if (!selected) return;
    selected.name = nameInput.value;
    deps.log(`[层级] 改名 → ${selected.hierarchyPath}`);
    refreshNow();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (selected) nameInput.value = selected.name;
    nameInput.blur();
    e.preventDefault();
    e.stopPropagation();
  });
  headRow.append(activeChk, nameInput);
  gHead.appendChild(headRow);
  const identity = el('div', 'debug-hier__sub');
  gHead.appendChild(identity);
  const crumbs = el('div', 'debug-hier__crumbs');
  gHead.appendChild(crumbs);
  let crumbsKey = '';
  const activeRead = el('div', 'debug-hier__sub');
  gHead.appendChild(activeRead);
  const checks = el('div', 'debug-hier__checks');
  const visibleChk = checkRow(checks, 'visible', 'Pixi 语义：只管画不画（不影响组件与命中剪枝以外的逻辑）',
    (n, on) => { n.visible = on; });
  const renderableChk = checkRow(checks, 'renderable', '为 false 时自己与子树都不画',
    (n, on) => { n.renderable = on; });
  const flagsRead = el('span', 'debug-hier__sub debug-hier__inline');
  checks.appendChild(flagsRead);
  gHead.appendChild(checks);
  numRow(gHead, 'alpha', [{ field: 'alpha' }], 0.01, 3);
  numRow(gHead, 'zIndex', [{ field: 'zIndex' }], 1, 3);

  // —— Transform(本地)
  const gLocal = group('Transform（本地，父节点空间）');
  numRow(gLocal, 'Position', [{ field: 'posX', axis: 'X' }, { field: 'posY', axis: 'Y' }], 1, 2);
  numRow(gLocal, 'Rotation°', [{ field: 'rotDeg' }], 1, 2);
  numRow(gLocal, 'Scale', [{ field: 'scaleX', axis: 'X' }, { field: 'scaleY', axis: 'Y' }], 0.01, 3);
  numRow(gLocal, 'Pivot', [{ field: 'pivotX', axis: 'X' }, { field: 'pivotY', axis: 'Y' }], 1, 2);
  numRow(gLocal, 'Skew°', [{ field: 'skewXDeg', axis: 'X' }, { field: 'skewYDeg', axis: 'Y' }], 1, 2);

  // —— 世界
  const gWorld = group('世界（舞台坐标 = 逻辑视口像素）');
  numRow(gWorld, 'Position', [{ field: 'worldX', axis: 'X' }, { field: 'worldY', axis: 'Y' }], 1, 2);
  numRow(gWorld, 'Rotation°', [{ field: 'worldRotDeg' }], 1, 2);
  const lossyRead = readRow(gWorld, 'Lossy Scale');
  const boundsRead = readRow(gWorld, '包围盒');

  // —— 层级
  const gTree = group('层级');
  const sibRow = el('div', 'debug-hier__field');
  const sibLab = el('span', 'debug-hier__label', 'Sibling');
  sibRow.appendChild(sibLab);
  sibRow.appendChild(mkNumInput('siblingIndex', 1, 0));
  const moveSibling = (fn: (n: Container) => void, what: string): void => {
    if (!selected || !selected.parent) return;
    fn(selected);
    deps.log(`[层级] ${selected.hierarchyPath} ${what} → siblingIndex ${selected.siblingIndex}`);
    refreshNow();
  };
  sibRow.append(
    btn('⤒', 'setAsFirstSibling（最先画 = 最底下）', () => moveSibling((n) => n.setAsFirstSibling(), '移到最前')),
    btn('↑', 'siblingIndex − 1', () => moveSibling((n) => { n.siblingIndex = n.siblingIndex - 1; }, '上移')),
    btn('↓', 'siblingIndex + 1', () => moveSibling((n) => { n.siblingIndex = n.siblingIndex + 1; }, '下移')),
    btn('⤓', 'setAsLastSibling（最后画 = 最上面）', () => moveSibling((n) => n.setAsLastSibling(), '移到最后')),
  );
  gTree.appendChild(sibRow);
  const sortNote = el('div', 'debug-hier__sub');
  gTree.appendChild(sortNote);
  const treeBtns = el('div', 'debug-hier__checks');
  treeBtns.append(
    btn('选中父节点', '选中父节点并在树里定位', () => {
      if (selected?.parent) select(selected.parent, true);
    }),
    btn('在树里定位', '展开祖先并滚到这一行', () => revealSelected()),
  );
  gTree.appendChild(treeBtns);

  // —— 视图(可画内容的只读摘要)
  const gView = group('视图');
  const viewRead = el('div', 'debug-hier__sub');
  gView.appendChild(viewRead);

  // —— 组件
  const gComp = group('组件');
  const compTitle = gComp.firstChild as HTMLDivElement;
  const compList = el('div', 'debug-hier__comps');
  gComp.appendChild(compList);
  let compRows: { comp: Component; chk: HTMLInputElement; state: HTMLSpanElement }[] = [];

  function rebuildComponents(node: Container): void {
    compList.replaceChildren();
    compRows = [];
    for (const comp of node.components) {
      const row = el('label', 'debug-hier__check debug-hier__comp');
      const chk = el('input');
      chk.type = 'checkbox';
      chk.title = 'enabled';
      chk.addEventListener('change', () => {
        comp.enabled = chk.checked;
        deps.log(`[层级] ${node.hierarchyPath} 组件 ${comp.constructor.name}.enabled = ${chk.checked}`);
        refreshNow();
      });
      const state = el('span', 'debug-hier__sub debug-hier__inline');
      row.append(chk, document.createTextNode(comp.constructor.name || 'Component'), state);
      compList.appendChild(row);
      compRows.push({ comp, chk, state });
    }
    if (compRows.length === 0) compList.appendChild(el('div', 'debug-hier__sub', '（无）'));
  }

  function setInput(input: HTMLInputElement, text: string, force: boolean): void {
    if (!force && document.activeElement === input) return;
    if (input.value !== text) input.value = text;
  }

  /** force = 连正在编辑的框也覆盖(换了选中 / 刮值时) */
  function refreshInspector(force = false): void {
    const n = selected;
    empty.hidden = n !== null;
    body.hidden = n === null;
    if (!n) return;
    const t = readTransform(n);
    for (const ni of numInputs) setInput(ni.input, formatNum(t[ni.field], ni.digits), force || scrubbing);
    setInput(nameInput, n.name, force);
    if (activeChk.checked !== n.activeSelf) activeChk.checked = n.activeSelf;
    if (visibleChk.checked !== n.visible) visibleChk.checked = n.visible;
    if (renderableChk.checked !== n.renderable) renderableChk.checked = n.renderable;

    const cls = nodeClassName(n);
    const alias = aliases.get(n);
    setText(identity, `${cls}　#${n.uid}${alias ? `　别名 ${alias}` : ''}${n.isSceneRoot ? '　场景根' : ''}`);
    setText(activeRead,
      `层级中激活 ${n.activeInHierarchy ? '✓' : '✗'}　在场景 ${n.inScene ? '✓' : '✗'}　祖先全激活 ${n.activeInTree ? '✓' : '✗'}`);
    setText(flagsRead, `eventMode ${n.eventMode}${n.culled ? '　已剔除' : ''}${n.cullable ? '　可剔除' : ''}`);
    setText(lossyRead, `${formatNum(t.lossyX, 3)}　${formatNum(t.lossyY, 3)}`);

    const sb = selCache.node === n ? selCache : null;
    if (!sb || !sb.rect) setText(boundsRead, '—');
    else if (sb.marker) setText(boundsRead, '（空：未激活 / 不可见 / 没有可画内容；画面上画的是世界位置）');
    else {
      const r = sb.rect;
      setText(boundsRead, `x ${formatNum(r.x, 1)}  y ${formatNum(r.y, 1)}  ${formatNum(r.width, 1)}×${formatNum(r.height, 1)}${sb.slow ? '（大子树，4 Hz 刷新）' : ''}`);
    }

    const p = n.parent;
    setText(sortNote, p
      ? `共 ${p.children.length} 个兄弟${p.sortableChildren ? '；父节点按 zIndex 排序（sortableChildren），手动换序会被下次排序改回' : ''}　子节点 ${n.children.length}`
      : `根节点　子节点 ${n.children.length}`);

    // 父链面包屑:段变了才重建
    const chain: Container[] = [];
    for (let c = n.parent; c; c = c.parent) chain.push(c);
    chain.reverse();
    const key = chain.map((c) => `${c.uid}:${nodeDisplayName(c, aliases).text}`).join('/');
    if (key !== crumbsKey) {
      crumbsKey = key;
      crumbs.replaceChildren();
      crumbs.appendChild(el('span', 'debug-hier__sub', '父链：'));
      if (chain.length === 0) crumbs.appendChild(el('span', 'debug-hier__sub', '（无）'));
      chain.forEach((c, i) => {
        if (i > 0) crumbs.appendChild(el('span', 'debug-hier__sep', '/'));
        const a = el('button', 'debug-hier__crumb', nodeDisplayName(c, aliases).text);
        a.type = 'button';
        a.title = `选中 ${c.hierarchyPath}`;
        a.addEventListener('click', () => select(c, true));
        crumbs.appendChild(a);
      });
    }

    // 视图摘要
    const v = n as unknown as {
      texture?: { width?: number; height?: number; label?: string };
      anchor?: { x: number; y: number };
      text?: unknown;
    };
    const parts: string[] = [];
    parts.push(n.renderPipeId ? `renderPipe ${n.renderPipeId}` : '纯容器（自己不画东西）');
    if (v.texture && typeof v.texture.width === 'number') {
      parts.push(`纹理 ${formatNum(v.texture.width, 1)}×${formatNum(v.texture.height ?? 0, 1)}${v.texture.label ? `「${v.texture.label}」` : ''}`);
    }
    if (v.anchor && typeof v.anchor.x === 'number') parts.push(`anchor ${formatNum(v.anchor.x)}, ${formatNum(v.anchor.y)}`);
    if (typeof v.text === 'string') parts.push(`文字「${v.text.length > 40 ? `${v.text.slice(0, 40)}…` : v.text}」`);
    if (n.filters && n.filters.length) parts.push(`滤镜 ${n.filters.length}`);
    if (n.mask) parts.push('有遮罩');
    setText(viewRead, parts.join('　'));

    // 组件:集合变了才重建,否则就地改勾与状态
    const comps = n.components;
    if (comps.length !== compRows.length || comps.some((c, i) => compRows[i].comp !== c)) rebuildComponents(n);
    setText(compTitle, `组件（${comps.length}）`);
    for (const r of compRows) {
      if (r.chk.checked !== r.comp.enabled) r.chk.checked = r.comp.enabled;
      setText(r.state, r.comp.isActiveAndEnabled ? '　活' : '　停');
    }
  }

  function select(n: Container | null, reveal: boolean): void {
    if (n !== selected) {
      selected = n;
      note = '';
      selCache.node = null;
      compRows = [];
      compList.replaceChildren();
      crumbsKey = '\u0000';
    }
    refreshInspector(true);
    if (reveal) revealSelected();
    else renderSlice();
    updateStatus();
  }

  // ───────────────────────── 高亮框(挂在画布的父元素上,随等比信箱盒一起走、被它裁剪)

  function mkHighlight(kind: 'sel' | 'hover'): { box: HTMLDivElement; chip: HTMLDivElement; key: string } {
    const box = el('div', `debug-hier__hl is-${kind}`);
    const chip = el('div', 'debug-hier__hl-chip');
    box.appendChild(chip);
    return { box, chip, key: '' };
  }
  const hlSel = mkHighlight('sel');
  const hlHover = mkHighlight('hover');
  const selCache: BoundsCache = { node: null, rect: null, marker: false, at: 0, slow: false };
  const hoverCache: BoundsCache = { node: null, rect: null, marker: false, at: 0, slow: false };

  function measure(n: Container, cache: BoundsCache, now: number): void {
    if (cache.node === n && cache.slow && now - cache.at < POLL_MS) return;
    const t0 = performance.now();
    const b = n.getBounds();
    const cost = performance.now() - t0;
    let rect: StageRect = { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
    let marker = false;
    if (!(rect.width > 0 || rect.height > 0)) {
      const p = n.worldPosition;
      rect = { x: p.x, y: p.y, width: 0, height: 0 };
      marker = true;
    }
    cache.node = n;
    cache.rect = rect;
    cache.marker = marker;
    cache.at = now;
    cache.slow = cost > SLOW_BOUNDS_MS;
  }

  function hideHighlight(h: { box: HTMLDivElement; key: string }): void {
    if (h.box.parentElement) h.box.remove();
    h.key = '';
  }

  function placeHighlight(
    h: { box: HTMLDivElement; chip: HTMLDivElement; key: string },
    n: Container | null,
    cache: BoundsCache,
    host: HTMLElement,
    canvasInHost: Box,
    screen: { width: number; height: number },
    now: number,
  ): void {
    if (!n || n.destroyed) {
      hideHighlight(h);
      return;
    }
    measure(n, cache, now);
    const rect = cache.rect!;
    const mapped = stageRectToHost(rect, screen, canvasInHost);
    if (!mapped) {
      hideHighlight(h);
      return;
    }
    // 包围盒为空时画世界位置处的小圈;细长 / 零宽的也至少画 2px。都裁到画布(在画面外就不画)
    const r = 7;
    const box = intersectBox(
      cache.marker
        ? { left: mapped.left - r, top: mapped.top - r, width: 2 * r, height: 2 * r }
        : { left: mapped.left, top: mapped.top, width: Math.max(2, mapped.width), height: Math.max(2, mapped.height) },
      canvasInHost,
    );
    if (!box) {
      hideHighlight(h);
      return;
    }
    const name = nodeDisplayName(n, aliases).text;
    const size = (cache.marker ? '（无包围盒）' : `${formatNum(rect.width, 0)}×${formatNum(rect.height, 0)}`)
      + (n.activeInHierarchy ? '' : '　层级中未激活');
    const key = `${box.left.toFixed(1)}|${box.top.toFixed(1)}|${box.width.toFixed(1)}|${box.height.toFixed(1)}|${cache.marker}|${name}|${size}`;
    if (h.box.parentElement !== host) host.appendChild(h.box);
    if (key === h.key) return;
    h.key = key;
    const s = h.box.style;
    s.left = `${box.left}px`;
    s.top = `${box.top}px`;
    s.width = `${box.width}px`;
    s.height = `${box.height}px`;
    h.box.classList.toggle('is-marker', cache.marker);
    h.chip.textContent = `${name}  ${size}`;
    // 贴着画布上沿时标签放进框里
    h.chip.classList.toggle('is-inside', box.top - canvasInHost.top < 16);
  }

  function drawOverlay(): void {
    overlayRaf = null;
    if (!active || destroyed) return;
    try {
      const canvas = deps.getCanvas();
      const host = canvas?.parentElement ?? null;
      if (!canvas || !host) {
        hideHighlight(hlSel);
        hideHighlight(hlHover);
      } else {
        const cr = canvas.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        const canvasInHost: Box = {
          left: cr.left - hr.left - host.clientLeft,
          top: cr.top - hr.top - host.clientTop,
          width: cr.width,
          height: cr.height,
        };
        const screen = deps.getScreenSize();
        const now = performance.now();
        placeHighlight(hlSel, selected, selCache, host, canvasInHost, screen, now);
        const hov = picking ? pickHover : rowHover;
        placeHighlight(hlHover, hov && hov !== selected ? hov : null, hoverCache, host, canvasInHost, screen, now);
      }
    } catch (e) {
      hideHighlight(hlSel);
      hideHighlight(hlHover);
      setText(status, `高亮出错：${String(e)}`);
    }
    overlayRaf = requestAnimationFrame(drawOverlay);
  }

  // ───────────────────────── 拾取

  let picking = false;
  const catcher = el('div', 'debug-hier__catcher');
  catcher.title = '拾取：点一下选中；Shift 连续；Esc / 右键退出';
  let lastPickClient: { x: number; y: number } | null = null;
  let lastPickClick: { x: number; y: number } | null = null;

  function pickAtClient(clientX: number, clientY: number): Container[] {
    const root = deps.getRoot();
    const canvas = deps.getCanvas();
    if (!root || !canvas) return [];
    const r = canvas.getBoundingClientRect();
    const p = clientToStage(clientX, clientY, deps.getScreenSize(), { left: r.left, top: r.top, width: r.width, height: r.height });
    return p ? pickAll(root, p.x, p.y) : [];
  }

  function onPickKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setPicking(false);
  }

  function setPicking(on: boolean): void {
    if (on === picking) return;
    if (on) {
      const host = active ? deps.getCanvas()?.parentElement : null;
      if (!host) return;
      picking = true;
      host.appendChild(catcher);
      window.addEventListener('keydown', onPickKey, true);
    } else {
      picking = false;
      catcher.remove();
      window.removeEventListener('keydown', onPickKey, true);
      if (pickRaf !== null) cancelAnimationFrame(pickRaf);
      pickRaf = null;
      pickHover = null;
      lastPickClient = null;
    }
    pickBtn.classList.toggle('is-on', picking);
    setText(pickBtn, picking ? '拾取中…' : '拾取');
  }

  // 拾取板盖在画布上:游戏(InputManager 挂在 window 上的 pointerdown)与引擎事件系统都收不到这次点击
  catcher.addEventListener('pointermove', (e) => {
    e.stopPropagation();
    lastPickClient = { x: e.clientX, y: e.clientY };
    if (pickRaf !== null) return;
    pickRaf = requestAnimationFrame(() => {
      pickRaf = null;
      if (!picking || !lastPickClient) return;
      pickHover = pickAtClient(lastPickClient.x, lastPickClient.y)[0] ?? null;
    });
  });
  catcher.addEventListener('pointerleave', () => {
    pickHover = null;
  });
  catcher.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 2) {
      setPicking(false);
      return;
    }
    if (e.button !== 0) return;
    const hits = pickAtClient(e.clientX, e.clientY);
    const same = lastPickClick !== null && Math.hypot(lastPickClick.x - e.clientX, lastPickClick.y - e.clientY) <= 3;
    lastPickClick = { x: e.clientX, y: e.clientY };
    const n = nextPick(hits, same ? selected : null);
    if (n) {
      select(n, true);
      note = hits.length > 1 ? `此处叠了 ${hits.length} 个，同一处再点往下选` : '';
    } else note = '这一点没有看得见的节点';
    updateStatus();
    if (!e.shiftKey) setPicking(false);
  });
  for (const type of ['pointerup', 'click', 'contextmenu'] as const) {
    catcher.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // ───────────────────────── 轮询

  function updateStatus(root: Container | null = deps.getRoot()): void {
    if (!root) {
      setText(status, '渲染器还没起来');
      return;
    }
    let s = `舞台 ${countNodes(root)} 个节点　列出 ${rows.length} 行`;
    if (filterQuery) s += `　命中 ${filterMatches}${rowsTruncated ? '（只列前 500 个）' : ''}`;
    else if (rowsTruncated) s += '（太多，已截断）';
    if (note) s += `　· ${note}`;
    setText(status, s);
  }

  function refreshNow(): void {
    if (!active || destroyed) return;
    try {
      const root = deps.getRoot();
      if (!root) {
        rows = [];
        renderSlice();
        select(null, false);
        updateStatus(null);
        return;
      }
      if (root !== rootSeen) {
        rootSeen = root;
        expanded.add(root.uid);
      }
      try {
        aliases = deps.getNodeAliases?.() ?? EMPTY_ALIASES;
      } catch {
        aliases = EMPTY_ALIASES;
      }
      if (selected && (selected.destroyed || !selected.isChildOf(root))) {
        const what = `选中的「${nodeDisplayName(selected, aliases).text}」已${selected.destroyed ? '销毁' : '从舞台摘下'}`;
        select(null, false);
        note = what;
      }
      if (rowHover && (rowHover.destroyed || !rowHover.isChildOf(root))) rowHover = null;
      rebuildRows(root);
      renderSlice();
      refreshInspector();
      updateStatus(root);
    } catch (e) {
      setText(status, `刷新出错：${String(e)}`);
    }
  }

  function setActive(on: boolean): void {
    if (destroyed || on === active) return;
    active = on;
    if (on) {
      refreshNow();
      pollTimer = window.setInterval(refreshNow, POLL_MS);
      overlayRaf = requestAnimationFrame(drawOverlay);
    } else {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = null;
      if (overlayRaf !== null) cancelAnimationFrame(overlayRaf);
      overlayRaf = null;
      setPicking(false);
      rowHover = null;
      hideHighlight(hlSel);
      hideHighlight(hlHover);
    }
  }

  select(null, false);

  return {
    root: sec,
    setActive,
    refresh: refreshNow,
    destroy(): void {
      if (destroyed) return;
      setActive(false);
      destroyed = true;
      selected = null;
      rowHover = null;
      pickHover = null;
      selCache.node = null;
      hoverCache.node = null;
      rows = [];
      compRows = [];
      expanded.clear();
      rootSeen = null;
      aliases = EMPTY_ALIASES;
      sec.remove();
      sec.replaceChildren();
    },
  };
}
