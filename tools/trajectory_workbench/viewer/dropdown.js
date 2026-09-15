'use strict';
/* 页内下拉列表：接管页面里所有 `<select>` 的弹出层，**不走系统原生弹窗**。
 *
 * 为什么必须自绘（2026-09-12 制作人实拍，粒子工作台）：
 * QtWebEngine 在 150% 缩放的屏幕上，原生 `<select>` 弹窗的**框**按设备像素算、里面的内容按 CSS 像素画，
 * 于是弹窗比控件大一圈、右下角一大块空白；而且**每开一次再乘一次**，白边越开越大。
 * 它还不吃页面 CSS（页面是暗色，弹窗是系统色），作者面上三个下拉框能出三种样子。
 * 这条路在 Qt 侧没有开关可关 —— 唯一稳的做法是不让它开：`mousedown` 里 `preventDefault()`，
 * 自己在 DOM 里画一个列表。
 *
 * 硬契约：
 * - **DOM 里那个 `<select>` 原样留着**：`.value` / `.options` / `change` 事件、页面里所有读写它的代码
 *   （包括自检脚本）一个字都不用改。这里只换"点开之后长什么样"。
 * - 选中才发 `change`（与原生一致：选同一项不发）；`input` 不发（页面没人听）。
 * - 键盘原样归浏览器：列表开着时按任意键（除 Esc 外）先关列表，再让原生行为走 —— 上下键仍然直接改值。
 *   **例外是会弹原生弹窗的那几个键**（2026-09-14 审查：Tab 到下拉框上按 Enter「确认」，弹出来的正是被禁的那个 Qt 弹窗）：
 *   焦点停在收起的下拉框上按 Enter / F4 / Alt+↑↓ = 打开页内列表（吃掉，页面收不到）；Space 只拦默认动作、**照样传给页面**
 *   （粒子工作台靠它在下拉框上放焦点 + 空格播放）。键盘打开的列表里 ↑↓ / Home / End 移高亮、Enter 选定、Esc 关；
 *   列表开着时 Enter / F4 / Alt+↑↓ / Space 也不许漏成原生弹窗（Enter 选定高亮项，其余关列表）。
 *   Esc 挂在 `window` 捕获阶段（本文件是页面第一个脚本，排在所有页面监听之前）：页面对话框自己的 Esc 不会先把整个对话框关掉、留个列表飘着。
 * - 列表是 `position: fixed` + 视口内钳位；控件被卷走 / 窗口变化 / 点别处 / 滚动 一律关。
 *   **点别处关列表的那一下整个被吃掉**（与原生弹窗一致）：页面收不到它的按下 / 抬起 / click，下拉框也失焦。
 * - 列表真关掉时在 `document` 上发 `ddclose`；列表开着期间 `<select>` 被页面拆出了 DOM、这时再选 = 什么都不写、
 *   关列表、发 `ddstale`。两个事件没人听的页面行为不变（粒子工作台用它们推迟 / 补上检视器重建）。
 *
 * 挂上去只要一行 `<script src=".../dropdown.js"></script>`（在页面脚本之前之后都行，它自己挂 document）。
 * 样式跟着页面变量走（`--panel2` / `--line` / `--fg` / `--accent`），没有这些变量时有一套暗色兜底。 */
(() => {
  const ID = 'ddlist';
  let listEl = null;
  let owner = null;
  /** 列表是键盘打开的（↑↓ 移高亮归列表；鼠标打开的照旧"按键先关列表、原生改值"） */
  let viaKey = false;
  /** 高亮项下标（Enter 选它）；打开时 = 当前选中项 */
  let hi = -1;

  function styleOnce() {
    if (document.getElementById('ddlist-style')) return;
    const st = document.createElement('style');
    st.id = 'ddlist-style';
    st.textContent = `
#${ID} { position: fixed; z-index: 80; box-sizing: border-box;
  background: var(--panel2, #22262c); color: var(--fg, #e6e6e6);
  border: 1px solid var(--line, #3a4048); border-radius: 4px; padding: 3px;
  max-height: 60vh; overflow-y: auto; overflow-x: hidden;
  box-shadow: 0 8px 26px rgba(0,0,0,.55); font: var(--font, 13px/1.45 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif); }
#${ID} .dditem { padding: 4px 9px; border-radius: 3px; white-space: nowrap; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; }
#${ID} .dditem:hover { background: #2c4f7a; }
#${ID} .dditem.on { background: #2c4f7a; color: #fff; }
#${ID} .dditem.hi { background: #3b6aa3; color: #fff; box-shadow: inset 0 0 0 1px var(--accent, #6aa9ff); }
#${ID} .dditem.off { opacity: .45; cursor: default; }`;
    document.head.appendChild(st);
  }

  function close() {
    const was = listEl;
    if (listEl && listEl.parentNode) listEl.parentNode.removeChild(listEl);
    listEl = null;
    owner = null;
    viaKey = false;
    hi = -1;
    // 真关掉了一个列表才发（open 里先 close 一次不算）：页面可以把"列表开着时推迟的重建"补上。
    // 同步派发——pick 里 close 在 change 之前，页面要补重建得推到下一拍（粒子工作台就是这么接的）；没人听的页面行为不变
    if (was) document.dispatchEvent(new Event('ddclose'));
  }

  function pick(sel, i) {
    // 列表开着期间控件已经被页面重建掉（拆出了 DOM）：往孤儿节点上写值 / 发 change 谁也收不到，
    // 页面的写入闭包还拿着旧的引用（改名前的 id）静默什么都不做——列表关掉、告诉页面这一下没选上
    if (!sel.isConnected) { close(); document.dispatchEvent(new Event('ddstale')); return; }
    const opt = sel.options[i];
    if (!opt || opt.disabled) return;
    const changed = sel.selectedIndex !== i;
    sel.selectedIndex = i;
    close();
    if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function open(sel, fromKey) {
    close();
    styleOnce();
    owner = sel;
    viaKey = !!fromKey;
    hi = sel.selectedIndex;
    const list = document.createElement('div');
    list.id = ID;
    list.setAttribute('role', 'listbox');
    for (let i = 0; i < sel.options.length; i++) {
      const o = sel.options[i];
      const it = document.createElement('div');
      it.className = 'dditem' + (i === sel.selectedIndex ? ' on' : '') + (o.disabled ? ' off' : '');
      it.textContent = o.text;
      it.title = o.title || o.text;
      it.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); pick(sel, i); });
      list.appendChild(it);
    }
    document.body.appendChild(list);
    listEl = list;
    place(sel, list);
    const on = list.querySelector('.dditem.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
    if (viaKey) setHi(hi);
  }

  /** 键盘高亮：标出第 i 项并卷进视野 */
  function setHi(i) {
    if (!listEl) return;
    hi = i;
    for (let k = 0; k < listEl.children.length; k++) listEl.children[k].classList.toggle('hi', k === i);
    const it = listEl.children[i];
    if (it) it.scrollIntoView({ block: 'nearest' });
  }

  /** 从 from 往 step 方向找下一个可选项（跳过 disabled）；找不到 = 原地不动 */
  function nextEnabled(sel, from, step) {
    for (let i = from + step; i >= 0 && i < sel.options.length; i += step) if (!sel.options[i].disabled) return i;
    return from;
  }

  const isAltArrow = (e) => e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp');
  const isSpace = (e) => e.key === ' ' || e.key === 'Spacebar';

  /** 贴着控件左下；右边 / 下边超出视口就往回收（不够高就翻到控件上方） */
  function place(sel, list) {
    const r = sel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    list.style.minWidth = `${Math.round(r.width)}px`;
    list.style.maxWidth = `${Math.max(160, Math.round(vw * 0.6))}px`;
    list.style.left = '0px';
    list.style.top = '0px';
    const w = list.offsetWidth;
    const h = list.offsetHeight;
    const below = vh - r.bottom - 4;
    const above = r.top - 4;
    let top = r.bottom + 2;
    if (h > below && above > below) top = Math.max(2, r.top - 2 - h);
    else top = Math.min(top, Math.max(2, vh - h - 2));
    list.style.left = `${Math.max(2, Math.min(r.left, vw - w - 2))}px`;
    list.style.top = `${Math.round(top)}px`;
  }

  // 点别处关列表：这一下**整个吃掉**，与原生弹窗一致（2026-09-14 第七轮复核：植被台点画面关场景列表，
  // 画布的 pointerdown 早于 document 上的 mousedown，列表关了、画面上却多了一笔；锚点工具还 preventDefault 掉了兼容 mousedown，
  // 列表干脆关不掉）。挂 window 捕获（本文件是页面第一个脚本 → 排在画布 / 舞台 / 页面自己的捕获监听前面）：
  // 关列表、焦点离开下拉框（不然单键快捷键还被它拿着）、preventDefault + stopImmediatePropagation，
  // 同一手势剩下的抬起 / click / 右键菜单 / 双击也吞掉。点列表里的项照常选；点开着的那个下拉框本身 = 只关（不闪一下又开）。
  /** 正在吞一次被吃掉的手势：下一次按下 / 这一下的 click / 任何按键 都结束它，后面的东西一个不丢 */
  let eat = false;
  /** 被吃掉那下之后紧跟的一次按下可能和它连成双击：1 = 刚吃掉，2 = 紧跟的那次按下，它的 dblclick 也吞 */
  let eatDbl = 0;
  /** 吃掉的是 pointerdown：它的兼容 mousedown 还可能来一下（真浏览器里已被 preventDefault 掐掉，合成事件才会到），也吞 */
  let eatDown = false;
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  function onPress(e) {
    if (e.type === 'mousedown' && eat && eatDown) { eatDown = false; swallow(e); return; }
    eat = false; eatDown = false;                                  // 新的一次按下：上一下的吞没到此为止
    if (listEl && !listEl.contains(e.target)) {
      const sel = owner;
      const onOwner = !!(sel && e.target && e.target.closest && e.target.closest('select') === sel);
      close();
      if (!onOwner) {
        if (sel && document.activeElement === sel) sel.blur();
        else if (document.activeElement && document.activeElement.tagName === 'SELECT') document.activeElement.blur();
      }
      swallow(e);
      eat = true; eatDown = e.type === 'pointerdown'; eatDbl = 1;
      return;
    }
    if (e.type === 'pointerdown') { eatDbl = eatDbl === 1 ? 2 : 0; return; }
    if (eatDbl && e.detail < 2) eatDbl = 0;                        // 没和被吃掉那下连成双击：后面的 dblclick 照常
  }
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('mousedown', onPress, true);
  for (const t of ['pointerup', 'mouseup', 'contextmenu', 'auxclick']) {
    window.addEventListener(t, (e) => { if (eat) swallow(e); }, true);
  }
  window.addEventListener('click', (e) => { if (eat) { swallow(e); eat = false; } }, true);
  window.addEventListener('dblclick', (e) => { if (eat || eatDbl) swallow(e); eatDbl = 0; }, true);

  // 打开：左键按下（capture，早于页面自己的处理）；再按一下同一个控件 = 关
  document.addEventListener('mousedown', (e) => {
    const sel = e.target && e.target.closest ? e.target.closest('select') : null;
    if (!sel) { if (listEl && !listEl.contains(e.target)) close(); return; }
    if (sel.disabled || sel.multiple || sel.size > 1) return;   // 多选 / 列表框保持原生
    e.preventDefault();                                          // ← 原生弹窗从这里被掐死
    if (owner === sel) { close(); return; }
    try { sel.focus({ preventScroll: true }); } catch (err) { sel.focus(); }
    open(sel);
  }, true);

  // 键盘 · Esc 关列表：window 捕获阶段、而且 stopImmediatePropagation——页面对话框的 Esc 也挂在 window 捕获上
  // （轨迹台 modal 原来先把整个对话框关了、列表还飘着），本文件先注册，所以排在它们前面
  window.addEventListener('keydown', (e) => {
    eat = false; eatDbl = 0;                                       // 按键 = 那一下鼠标手势早结束了（键盘触发的 click 不许被吞）
    if (!listEl || e.key !== 'Escape') return;
    e.preventDefault(); e.stopImmediatePropagation(); close();
  }, true);

  // 键盘 · 其余（document 捕获，早于页面自己的快捷键表）
  document.addEventListener('keydown', (e) => {
    if (listEl) {
      const sel = owner;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }   // 兜底（正常已被上面那条吃掉）
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (e.repeat) return;                                    // 按住 Enter：打开那一下的自动重复不许紧接着就选定
        if (sel && hi >= 0 && sel.options[hi] && !sel.options[hi].disabled) pick(sel, hi); else close();
        return;
      }
      if (viaKey && sel && !e.altKey && !e.ctrlKey && !e.metaKey
        && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'ArrowDown') setHi(nextEnabled(sel, hi, 1));
        else if (e.key === 'ArrowUp') setHi(hi < 0 ? nextEnabled(sel, sel.options.length, -1) : nextEnabled(sel, hi, -1));
        else if (e.key === 'Home') setHi(nextEnabled(sel, -1, 1));
        else setHi(nextEnabled(sel, sel.options.length, -1));
        return;
      }
      // 这几个键原生会弹系统弹窗：关列表（与原生"再按一次收起"一致），不让默认动作走
      if (e.key === 'F4' || isAltArrow(e)) { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (isSpace(e)) { e.preventDefault(); close(); return; }  // 只拦默认动作：页面照样收到空格
      close();
      return;
    }
    // 列表收着：焦点停在一个归本文件管的下拉框上
    const t = e.target;
    if (!t || t.tagName !== 'SELECT' || t.disabled || t.multiple || t.size > 1) return;
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter' || e.key === 'F4' || isAltArrow(e)) {
      e.preventDefault(); e.stopPropagation();
      open(t, true);
      return;
    }
    if (isSpace(e)) e.preventDefault();                          // ← 原生弹窗从这里被掐死；不拦传播（空格播放要看见它）
  }, true);

  // 控件被卷走 / 窗口变了 / 页面滚了：关掉，别留一个飘在错位置的列表
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  document.addEventListener('scroll', (e) => { if (!listEl || !listEl.contains(e.target)) close(); }, true);
  document.addEventListener('wheel', (e) => { if (listEl && !listEl.contains(e.target)) close(); }, true);

  window.Dropdown = { close, isOpen: () => !!listEl, ownerOf: () => owner };
})();
