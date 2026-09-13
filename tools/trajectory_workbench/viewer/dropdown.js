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
 * - 列表是 `position: fixed` + 视口内钳位；控件被卷走 / 窗口变化 / 点别处 / 滚动 一律关。
 *
 * 挂上去只要一行 `<script src=".../dropdown.js"></script>`（在页面脚本之前之后都行，它自己挂 document）。
 * 样式跟着页面变量走（`--panel2` / `--line` / `--fg` / `--accent`），没有这些变量时有一套暗色兜底。 */
(() => {
  const ID = 'ddlist';
  let listEl = null;
  let owner = null;

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
#${ID} .dditem.off { opacity: .45; cursor: default; }`;
    document.head.appendChild(st);
  }

  function close() {
    if (listEl && listEl.parentNode) listEl.parentNode.removeChild(listEl);
    listEl = null;
    owner = null;
  }

  function pick(sel, i) {
    const opt = sel.options[i];
    if (!opt || opt.disabled) return;
    const changed = sel.selectedIndex !== i;
    sel.selectedIndex = i;
    close();
    if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function open(sel) {
    close();
    styleOnce();
    owner = sel;
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
  }

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

  // 键盘：Esc 关（不让页面的快捷键表再吃一次）；其它键先关列表，原生行为照走
  document.addEventListener('keydown', (e) => {
    if (!listEl) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    close();
  }, true);

  // 控件被卷走 / 窗口变了 / 页面滚了：关掉，别留一个飘在错位置的列表
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  document.addEventListener('scroll', (e) => { if (!listEl || !listEl.contains(e.target)) close(); }, true);
  document.addEventListener('wheel', (e) => { if (listEl && !listEl.contains(e.target)) close(); }, true);

  window.Dropdown = { close, isOpen: () => !!listEl, ownerOf: () => owner };
})();
