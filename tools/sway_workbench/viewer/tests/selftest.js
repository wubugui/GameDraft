/* 草木工作台 · 交互层端到端回归（在真页面里跑；由 `python -m tools.sway_workbench --selftest` 注入）。
 *
 * 每条 `ok()` 一行 PASS/FAIL；跑完把整份报告写进 window.__selftestResult。
 * 约定：
 *  - **绝不动真场景的盘上数据**：全程只在内存里涂；唯一一次保存走的是临时通道，跑完原样恢复；
 *  - 手势一律从画布合成真实指针事件进去（护栏从最外层进，见 editor-tools norms）；
 *  - 页面状态挂在 `window.__S`（app.js 是 ES module，其它标识符不在全局）。
 *
 * 这份回归钉的就是制作人踩过的那几条：橡皮只擦当前层、撤销要全回来、清空+保存+刷新不许复活、
 * 通道之间不许互相冲淡。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__S;
  const el = (id) => document.getElementById(id);
  const px = (ch) => {
    const d = S().buf[ch].getImageData(0, 0, S().native[0], S().native[1]).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
    return n;
  };
  const toClient = (nx, ny) => {
    const r = el('stage').getBoundingClientRect();
    return [r.left + S().view.x + nx * S().view.k, r.top + S().view.y + ny * S().view.k];
  };
  let pid = 1;
  const drag = (x0, y0, x1, y1, button) => {
    const stage = el('stage');
    const id = pid++;
    const a = toClient(x0, y0);
    const buttons = button === 2 ? 2 : 1;
    stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: a[0], clientY: a[1], pointerId: id, bubbles: true, button: button || 0, buttons }));
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const p = toClient(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      stage.dispatchEvent(new PointerEvent('pointermove', { clientX: p[0], clientY: p[1], pointerId: id, bubbles: true, buttons }));
    }
    stage.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0, pointerId: id, bubbles: true }));
  };
  const clearAll = () => { for (const c of ['veg', 'freeze', 'rigid', 'unrigid']) S().buf[c].clearRect(0, 0, S().native[0], S().native[1]); };

  try {
    // ---------------------------------------------------------------- S1 起得来
    for (let i = 0; i < 160 && !(S() && S().scene && S().buf && S().buf.veg); i++) await wait(250);
    ok('S1 页面起得来：装了场景、四层画布就位、原画拿到了',
      !!(S() && S().scene && S().buf.veg && S().imgs.bg), { scene: S() && S().scene });
    ok('S1 四层齐全（含减刚体）', ['veg', 'freeze', 'rigid', 'unrigid'].every((c) => !!S().buf[c]));
    // 🔴 装场景过程中抛了异常也会走到这里（状态已经设了一半），所以要单独看日志与画布：
    // 少了这两条,"openScene 最后一行引用了不存在的变量 → 画布全黑"这种会一路溜过去(2026-09-13 真发生过)
    const logTxt = el('log').textContent;
    ok('S1 🔴 装场景没报错', !/起不来|出错|失败|not defined/.test(logTxt), { tail: logTxt.slice(-120) });
    const bgCtx = el('bg').getContext('2d');
    let painted = 0;
    for (const [x, y] of [[200, 200], [1000, 600], [1600, 900]]) {
      const d = bgCtx.getImageData(x, y, 1, 1).data;
      if (d[3] > 0 && (d[0] + d[1] + d[2]) > 0) painted++;
    }
    ok('S1 🔴 原画真画到画布上了（不是黑屏）', painted >= 2, { painted });

    el('size').value = '40';
    el('size').dispatchEvent(new Event('input'));
    clearAll();

    // ---------------------------------------------------------------- S2 画与层隔离
    el('t-rigid').click();
    drag(300, 300, 600, 300);
    const r1 = px('rigid');
    ok('S2 画得上（刚体层有像素了）', r1 > 500, { rigid: r1 });

    el('t-veg').click();
    drag(300, 300, 600, 300);
    ok('S2 🔴 叠画另一层不冲淡先前那层（预乘坑）', px('rigid') === r1, { rigid: px('rigid'), was: r1 });
    const v1 = px('veg');

    // ---------------------------------------------------------------- S3 橡皮只擦当前层
    drag(380, 300, 520, 300, 2);                       // 右键拖 = 擦当前层（现在是植被）
    ok('S3 🔴 右键擦的是当前层', px('veg') < v1, { veg: px('veg'), was: v1 });
    ok('S3 🔴 别的层一根汗毛都不动', px('rigid') === r1, { rigid: px('rigid'), was: r1 });

    // ---------------------------------------------------------------- S4 撤销
    el('undo').click();
    ok('S4 🔴 撤销把整笔都还回来（不是只还第一段）', px('veg') === v1, { veg: px('veg'), want: v1 });

    // ---------------------------------------------------------------- S5 清空本层
    el('t-freeze').click();
    drag(300, 500, 600, 500);
    const f1 = px('freeze');
    el('clear-ch').click();
    ok('S5 清空本层清得干净', px('freeze') === 0, { freeze: px('freeze'), was: f1 });
    ok('S5 清空只清当前层', px('rigid') === r1 && px('veg') === v1);
    el('undo').click();
    ok('S5 清空也能撤销', px('freeze') === f1, { freeze: px('freeze'), want: f1 });

    // ---------------------------------------------------------------- S6 存盘往返（临时场景名，不碰真数据）
    const before = { veg: px('veg'), freeze: px('freeze'), rigid: px('rigid') };
    const chans = {};
    for (const c of ['veg', 'freeze', 'rigid', 'unrigid']) {
      const cv = document.createElement('canvas');
      cv.width = S().native[0];
      cv.height = S().native[1];
      const x = cv.getContext('2d');
      const s = S().buf[c].getImageData(0, 0, cv.width, cv.height).data;
      const d = x.createImageData(cv.width, cv.height);
      for (let i = 0; i < d.data.length; i += 4) { const a = s[i + 3]; d.data[i] = a; d.data[i + 1] = a; d.data[i + 2] = a; d.data[i + 3] = 255; }
      x.putImageData(d, 0, 0);
      chans[c] = cv.toDataURL('image/png');
    }
    ok('S6 四层都导得出不透明灰度（数据不放在 alpha 上）',
      Object.values(chans).every((u) => typeof u === 'string' && u.startsWith('data:image/png')));

    // 把导出的再装回去，值要对得上（这一步等价于"保存→刷新"，但不写盘）
    for (const c of ['veg', 'freeze', 'rigid']) {
      await new Promise((res) => { const im = new Image(); im.onload = () => { window.__loadChannelForTest ? window.__loadChannelForTest(c, im) : null; res(); }; im.onerror = res; im.src = chans[c]; });
    }
    const after = { veg: px('veg'), freeze: px('freeze'), rigid: px('rigid') };
    const near = (a, b) => Math.abs(a - b) <= Math.max(4, a * 0.002);
    ok('S6 🔴 导出再装回来，三层的量都对得上（保存不丢数据）',
      near(after.veg, before.veg) && near(after.freeze, before.freeze) && near(after.rigid, before.rigid),
      { before, after });

    // ---------------------------------------------------------------- S6b 悬停高亮
    if (S().idMap) {
      const stage = el('stage');
      const hp = toClient(1240, 1000);
      stage.dispatchEvent(new PointerEvent('pointermove', { clientX: hp[0], clientY: hp[1], pointerId: 990, bubbles: true, altKey: true }));
      await wait(300);
      ok('S6b Alt 悬停认得出这是哪一株', S().hover > 0, { id: S().hover, label: el('hover').textContent });
      stage.dispatchEvent(new PointerEvent('pointermove', { clientX: hp[0], clientY: hp[1], pointerId: 991, bubbles: true }));
      await wait(200);
      ok('S6b 松开 Alt 就不再高亮（画画时不闪）', S().hover === 0);
    }

    // ---------------------------------------------------------------- S7 视图
    const k0 = S().view.k;
    el('stage').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
    ok('S7 滚轮能缩放', S().view.k > k0, { k0, k: S().view.k });

    // ---- S7b Alt+点是"检视"，不许顺手画一笔 ----
    // 两个 handler 都挂在 pointerdown 上，靠捕获期的 stopPropagation 挡住涂画那个；
    // 谁把注册顺序或 capture 标志改了，作者每检视一次就会在图上多一个点，而且不声不响。
    {
      clearAll();
      S().chan = 'rigid';
      const st = el('stage');
      const c = toClient(1240, 1000);
      st.dispatchEvent(new PointerEvent('pointerdown', { clientX: c[0], clientY: c[1], pointerId: 900, bubbles: true, button: 0, buttons: 1, altKey: true }));
      st.dispatchEvent(new PointerEvent('pointerup', { clientX: c[0], clientY: c[1], pointerId: 900, bubbles: true }));
      await wait(60);
      ok('S7b 🔴 Alt+点只检视，不在图上留笔', px('rigid') === 0, { rigid: px('rigid') });
      S().painting = false;
      S().dirty = false;
    }

    // ---- S7c 装场景要把视图着色缓存清掉（键带 ?t=，跨装载永远命中不了）----
    {
      const tc = window.__tintCacheForTest;
      if (tc) {
        for (const id of ['v-veg', 'v-free', 'v-rigid']) {
          const b = el(id);
          if (b && !b.classList.contains('on')) b.click();
        }
        window.__draw();
        await wait(200);
        const grew = tc.size;
        S().dirty = false;               // 装场景前必须是干净的：脏着会弹 confirm，无头环境里就卡死了
        await window.__openSceneForTest(S().scene);
        await wait(600);
        // 两头都要卡住：`<= grew` 抓"没清"，`> 0` 抓"清完不再重填"（那是另一种坏：视图空了）
        ok('S7c 🔴 装场景清掉着色缓存、并且重新填上（不清就是每次装载 ~20 MB 只进不出）',
          grew > 0 && tc.size > 0 && tc.size <= grew, { 装载前: grew, 装载后: tc.size });
      } else {
        ok('S7c 着色缓存可测（__tintCacheForTest 没导出）', false);
      }
    }

    // ---- S7d 焦点在下拉框里时，单键快捷键不许生效 ----
    // 切完场景焦点就停在 #scene 上；那时按 X 会清掉整整一层、按 B 会开一次烘焙。
    {
      clearAll();
      S().chan = 'rigid';
      S().buf.rigid.fillStyle = '#fff';
      S().buf.rigid.fillRect(100, 100, 200, 200);
      const had = px('rigid');
      const sel = el('scene');
      sel.focus();
      sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
      await wait(60);
      ok('S7d 🔴 焦点在下拉框里按 X 不许清层（人只是想用首字母跳选项）',
        px('rigid') === had, { now: px('rigid'), was: had });
      sel.blur();
      clearAll();
      S().dirty = false;
    }

    // ---- S17 场景下拉框走页内列表（第六轮复核 #5）：QtWebEngine 150% 缩放下原生 <select> 弹窗越开越大、不吃暗色，
    //      制作人在粒子 / 轨迹两台实拍过。点开 = 页内画的列表；装不了的场景点了不选、键盘高亮跳过它；选中就切场景 ----
    // ⚠ 必须排在任何弹过对话框的步骤前面：后面的步骤拿 `.remove()` 收对话框，对话框挂在 window 捕获上的 keydown 没摘，
    //   ↑↓ 在 window 就被它 stopPropagation，到不了下拉列表（真页面里对话框只经 done() 关，没有这种孤儿）
    //   前面 S7c 重装场景时 8 秒草稿已经落过一份，会弹「发现没保存的草稿」（不挡装载）：这里经按钮答掉（删掉草稿——
    //   草稿在自检的临时目录里），不许 `.remove()`，否则它的 keydown 监听就成了上面说的孤儿
    {
      for (const mm of document.querySelectorAll('.modal')) {
        const b = mm.querySelector('[data-choice=drop]') || mm.querySelector('[data-choice=cancel]');
        if (b) b.click(); else mm.remove();
      }
      await wait(100);
      clearAll();
      S().dirty = false;
      const sel = el('scene');
      const home = S().scene;
      const DD = window.Dropdown;
      ok('S17 🔴 页内下拉列表挂上了（/vendor/dropdown.js 装得出来）', !!DD);
      const realFetch = window.fetch;
      const jsonRes = (j) => new Response(JSON.stringify(j), { headers: { 'Content-Type': 'application/json' } });
      const homeIdx = sel.selectedIndex;
      const n = sel.options.length;
      // 造一个"装不了"的：紧挨着当前场景的那一项（清单桩里标成没有背景图，服务端一个字节不动）
      const offIdx = homeIdx + 1 < n ? homeIdx + 1 : homeIdx - 1;
      const offId = offIdx >= 0 ? sel.options[offIdx].value : '';
      try {
        if (DD && offId) {
          window.fetch = async (url, opts) => {
            const r = await realFetch(url, opts);
            if (!String(url).startsWith('/api/scenes')) return r;
            const j = await r.json();
            for (const s of j.scenes) if (s.id === offId) s.hasBackground = false;
            return jsonRes(j);
          };
          await wait(1600);                                   // 让过清单刷新的节流
          sel.dispatchEvent(new Event('focus'));              // 页面在 focus 上刷清单
          for (let i = 0; i < 120 && !sel.options[offIdx].disabled; i++) await wait(25);
          ok('S17 前提：清单桩让紧挨着的场景装不了', sel.options[offIdx].disabled, { offId });

          // 鼠标点开：原生弹窗被掐（mousedown 默认动作取消）、页内列表一项对一项
          const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
          sel.dispatchEvent(md);
          const list = document.getElementById('ddlist');
          const items = list ? [...list.querySelectorAll('.dditem')] : [];
          ok('S17 🔴 点开场景下拉框是页内画的列表、原生弹窗被掐掉',
            !!list && md.defaultPrevented && DD.ownerOf() === sel && items.length === n,
            { list: !!list, prevented: md.defaultPrevented, items: items.length, options: n });
          if (items[offIdx]) {
            items[offIdx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            await wait(80);
            ok('S17 🔴 点装不了的场景：不选、不切场景', sel.value === home && S().scene === home && items[offIdx].classList.contains('off'),
              { value: sel.value, scene: S().scene });
          }
          DD.close();

          // 键盘：焦点在下拉框上按 Enter 开页内列表（不许漏成原生弹窗），↑↓ 跳过装不了的，Esc 只关列表
          sel.focus();
          const kd = (key) => { const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); sel.dispatchEvent(ev); return ev; };
          const enter = kd('Enter');
          const kList = document.getElementById('ddlist');
          ok('S17 焦点在下拉框上按 Enter：开的是页内列表', !!kList && enter.defaultPrevented && DD.isOpen());
          const dir = offIdx > homeIdx ? 1 : -1;
          kd(dir > 0 ? 'ArrowDown' : 'ArrowUp');
          // 该落在：往那个方向越过装不了的那一项之后第一个能装的；一个都没有 = 原地不动
          let wantHi = homeIdx;
          for (let i = homeIdx + dir; i >= 0 && i < n; i += dir) if (!sel.options[i].disabled) { wantHi = i; break; }
          const hiIdx = kList ? [...kList.children].findIndex((c) => c.classList.contains('hi')) : -1;
          ok('S17 🔴 键盘高亮跳过装不了的场景', hiIdx === wantHi && hiIdx !== offIdx, { hiIdx, wantHi, offIdx, homeIdx });
          const esc = kd('Escape');
          await wait(50);
          ok('S17 Esc 只关列表：不选、不切场景、页面没弹别的',
            !DD.isOpen() && esc.defaultPrevented && sel.value === home && S().scene === home && !document.querySelector('.modal'));
          // 空格：只拦原生弹窗，页面照样收得到（这一页焦点在下拉框上时单键快捷键本来就让开）
          const sp = kd(' ');
          ok('S17 焦点在下拉框上按空格：不弹原生弹窗、不开页内列表、不切场景',
            sp.defaultPrevented && !DD.isOpen() && S().scene === home);
          sel.blur();

          // 第七轮复核：点画面关场景列表 = 那一下整个被吃掉（原生弹窗就是这样）。原来画布的 pointerdown 早于列表的 mousedown：
          // 画笔工具里列表关了、画面上多了一笔 48px 刚体；锚点工具里放了个锚点、列表还关不掉、焦点还卡在下拉框上
          {
            const chans = ['veg', 'freeze', 'rigid', 'unrigid'];
            const ovc = el('ov');
            const P = (ty, c) => new PointerEvent(ty, { clientX: c[0], clientY: c[1], pointerId: 90, bubbles: true, cancelable: true, button: 0, buttons: ty === 'pointerdown' ? 1 : 0 });
            const M = (ty, c) => new MouseEvent(ty, { clientX: c[0], clientY: c[1], bubbles: true, cancelable: true, button: 0, buttons: ty === 'mousedown' ? 1 : 0, detail: 1 });
            for (const tool of ['paint', 'anchor']) {
              if (tool === 'paint') el('t-rigid').click(); else el('t-anchor').click();
              S().dirty = false;
              const pxBefore = chans.map(px), anBefore = JSON.stringify(S().ov);
              sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
              const opened = DD.isOpen() && document.activeElement === sel;
              const c = toClient(S().native[0] * 0.5, S().native[1] * 0.5);
              ovc.dispatchEvent(P('pointerdown', c)); ovc.dispatchEvent(M('mousedown', c));
              ovc.dispatchEvent(P('pointerup', c)); ovc.dispatchEvent(M('mouseup', c)); ovc.dispatchEvent(M('click', c));
              await wait(60);
              const pxAfter = chans.map(px);
              ok(`S17 🔴 ${tool === 'paint' ? '画笔' : '锚点'}工具里点画面关场景列表：一个像素不动、锚点不动、不脏、列表关、焦点离开下拉框`,
                opened && pxAfter.every((v, i) => v === pxBefore[i]) && JSON.stringify(S().ov) === anBefore && !S().dirty
                  && !DD.isOpen() && document.activeElement !== sel,
                { opened, pxBefore, pxAfter, anchors: S().ov.anchors.length, dirty: S().dirty, open: DD.isOpen(), active: document.activeElement && document.activeElement.id });
            }
            el('t-rigid').click();                               // 回到画笔 · 刚体层
            // 被吃掉的只有那一下：紧接着的下一笔照常画得上
            const r0 = px('rigid'), cd0 = S().chDirty.rigid;
            drag(S().native[0] * 0.5 - 40, S().native[1] * 0.5, S().native[0] * 0.5 + 40, S().native[1] * 0.5);
            ok('S17 关列表那一下之后的下一笔照常画得上（吞掉的手势不外溢）', px('rigid') > r0, { rigid: px('rigid'), was: r0 });
            clearAll();
            S().chDirty.rigid = cd0;
            S().dirty = false;
          }

          // 从页内列表选一个能装的场景：切过去、列表收起、焦点还回去（单键快捷键立刻好使）
          const target = [...sel.options].findIndex((o, i) => i !== homeIdx && !o.disabled);
          if (target >= 0) {
            const want = sel.options[target].value;
            sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            const li = document.getElementById('ddlist');
            if (li && li.children[target]) li.children[target].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            for (let i = 0; i < 300 && !(S().scene === want && S().imgs.bg && decodeURIComponent(S().imgs.bg.src).includes('scene=' + want)); i++) await wait(50);
            ok('S17 🔴 从页内列表选一个场景就切过去、列表收起、焦点离开下拉框',
              S().scene === want && sel.value === want && !DD.isOpen() && document.activeElement !== sel,
              { scene: S().scene, want, open: DD.isOpen(), active: document.activeElement && document.activeElement.id });
            await wait(200);
            for (const mm of document.querySelectorAll('.modal')) mm.remove();   // 装场景可能问过草稿（非阻塞）
            S().dirty = false;
            await window.__openScene(home);
            for (let i = 0; i < 300 && !(S().scene === home && S().buf && S().buf.veg); i++) await wait(50);
            ok('S17 切回原场景', S().scene === home && sel.value === home, { scene: S().scene });
          }
        }
      } finally {
        window.fetch = realFetch;
        if (DD) DD.close();
        for (const mm of document.querySelectorAll('.modal')) mm.remove();
      }
    }

    // ---- S11 切到装不上的场景：留在原场景、下拉框退回、日志说清楚（不许"没反应"） ----
    // 制作人 2026-09-13："切了场景没反应，画面都不变"——dev_room 没有背景图，装载 500，异常没人接，
    // 页面却已经把当前场景改成了 dev_room（再按 Ctrl+S 会把旧场景的涂层存进它名下）。
    {
      S().dirty = false;
      const home = S().scene;
      const bgBefore = S().imgs.bg && S().imgs.bg.src;
      const logBefore = el('log').textContent.length;
      await window.__openScene('__自检用的不存在的场景__');
      await wait(100);
      const tail = el('log').textContent.slice(logBefore);
      ok('S11 🔴 装不上时当前场景不变（否则保存会存进错的场景）', S().scene === home, { scene: S().scene });
      ok('S11 🔴 装不上时画面不变、下拉框退回原场景', S().imgs.bg && S().imgs.bg.src === bgBefore && el('scene').value === home);
      ok('S11 装不上要在日志里说出来（不许悄悄没反应）', tail.includes('装不上'), { tail: tail.slice(-80) });
      const opts = [...el('scene').options];
      const noBg = opts.find((o) => o.textContent.includes('没有背景图'));
      ok('S11 没有背景图的场景在下拉框里标出来且不能选', !noBg || noBg.disabled, { found: noBg && noBg.value });
    }

    // ---- S10 连续切场景：每次都装得上、画布数量不涨、切完图片照样加载得出来 ----
    // 画布与解码后的大图占 JS 堆外内存；原来每切一次场景新建一批、旧的不释放。
    // 内嵌浏览器面板里新开页面连切 5 次后第 6 次起图片全部加载不出来（桌面壳里没复现——
    // 制作人那边"切了没反应"的真根因是 S11 那条；这条是复用画布必须清空、不许涨的护栏）。
    {
      S().dirty = false;
      const scenes = [...el('scene').options].map((o) => o.value);
      const home = S().scene;
      const other = scenes.find((v) => v !== home);
      const scratch = window.__scratchForTest;
      const probe = () => Promise.race([
        new Promise((res) => { const im = new Image(); im.onload = () => res('ok'); im.onerror = () => res('err'); im.src = '/api/scenes?probe=' + Math.random(); }),
        new Promise((res) => setTimeout(() => res('超时'), 4000)),
      ]);
      let countAfterFirst = -1, allLoaded = true, stuckAt = '';
      if (other) {
        for (let i = 0; i < 10; i++) {
          const sid = i % 2 ? home : other;
          S().dirty = false;
          const r = await Promise.race([window.__openSceneForTest(sid).then(() => 'done'), wait(15000).then(() => 'timeout')]);
          const shown = S().imgs.bg && decodeURIComponent(S().imgs.bg.src).includes('scene=' + sid);
          if (r !== 'done' || !shown) { allLoaded = false; stuckAt = `第 ${i + 1} 次切到 ${sid}`; break; }
          if (i === 1 && scratch) countAfterFirst = scratch.size;
        }
      }
      ok('S10 🔴 连切 10 次场景每次都装上、画面换成新场景', !other || allLoaded, { stuckAt });
      ok('S10 🔴 连切之后图片照样加载得出来（原来第 6 次起全部悬住）',
        !other || (await probe()) !== '超时');
      ok('S10 复用画布的数量不随切场景次数增长', !scratch || !other || scratch.size <= countAfterFirst + 1,
        { 第二次后: countAfterFirst, 最后: scratch && scratch.size });
      if (other && S().scene !== home) { S().dirty = false; await window.__openScene(home); }
    }

    // ---- S9 植株工具：锚点 / 整体摆（不碰涂层、可撤销、按株切换）----
    {
      clearAll();
      S().dirty = false;
      const keepOv = JSON.parse(JSON.stringify(S().ov));
      S().ov = { anchors: [], coherent: [] };
      const st = el('stage');
      const click = (nx, ny, button) => {
        const c = toClient(nx, ny);
        st.dispatchEvent(new PointerEvent('pointerdown', { clientX: c[0], clientY: c[1], pointerId: 950 + (button || 0), bubbles: true, button: button || 0, buttons: button === 2 ? 2 : 1 }));
        st.dispatchEvent(new PointerEvent('pointerup', { clientX: c[0], clientY: c[1], pointerId: 950 + (button || 0), bubbles: true }));
      };
      const vegBefore = px('veg') + px('rigid');
      el('t-anchor').click();
      click(1240, 1000);
      ok('S9 锚点工具：左键放一个锚点', S().ov.anchors.length === 1, { anchors: S().ov.anchors });
      ok('S9 🔴 放锚点不许在涂层上留笔', px('veg') + px('rigid') === vegBefore);
      click(1243, 1002, 2);
      ok('S9 右键删掉最近的锚点', S().ov.anchors.length === 0);
      click(1240, 1000);
      el('undo').click();
      ok('S9 放锚点可以撤销', S().ov.anchors.length === 0, { anchors: S().ov.anchors });
      el('t-coherent').click();
      click(1240, 1000);
      ok('S9 整体摆：点一株标上', S().ov.coherent.length === 1);
      click(1236, 996);
      ok('S9 🔴 同一株再点一次是取消（按株切换，不是按点堆）', S().ov.coherent.length === 0);
      ok('S9 植株设置改过就算有未保存改动', S().dirty === true && S().ovDirty === true);
      el('t-coherent').click();
      ok('S9 再点一次工具按钮回到画笔', S().tool === 'paint');
      S().ov = keepOv;
      S().dirty = false;
      S().ovDirty = false;
    }

    // ---- S8 本地草稿：手感（别在画画中途卡）+ 语义（增量，只存动过的层）----
    const payload = window.__draftPayloadForTest;
    if (payload) {
      const keep = { dirty: S().dirty, chDirty: S().chDirty, painting: S().painting };
      try {
        S().dirty = true; S().chDirty = { rigid: true }; S().painting = false;
        const d = payload();
        ok('S8 草稿只编码动过的层（四层全编码要 ~180ms，正画着就是卡一下）',
          !!d && Object.keys(d.ch).join() === 'rigid', { ch: d && Object.keys(d.ch) });
        ok('S8 草稿带着盘上那份的时间戳（恢复时才判得出中间有没有被别人改过）',
          !!d && d.base === S().baseMtime, { base: d && d.base });

        S().painting = true;
        ok('S8 🔴 笔按下的时候绝不编码（这是手感的命门）', payload() === null);

        S().painting = false; S().chDirty = {};
        ok('S8 没有任何层动过就不白干一趟', payload() === null);

        // 编码推迟到 idle 才做，那就有"排着队的时候人切了场景"这一档:
        // 接管 idle 队列，手动决定那一趟什么时候跑、跑之前把场景换掉。
        const saveD = window.__saveDraftForTest;
        const store = window.__draftStoreForTest;
        const realRIC = window.requestIdleCallback;
        const realScene = S().scene;
        const other = '__自检用的假场景__';
        const realPut = store && store.put;
        try {
          ok('S8 草稿存服务端（local/sway_drafts/），不存 localStorage（桌面壳是纯内存 profile，关窗就没了）',
            !!store && typeof store.put === 'function' && localStorage.length === 0, { ls: localStorage.length });
          const puts = [];
          store.put = (sid, d) => { puts.push({ sid, d }); return Promise.resolve({ ok: true }); };
          let queued = null;
          window.requestIdleCallback = (fn) => { queued = fn; return 1; };

          S().dirty = true; S().chDirty = { rigid: true };
          saveD();
          queued && queued();
          ok('S8 场景没变时草稿确实落得下来（不然下面那条是白过的）',
            puts.length === 1 && puts[0].sid === realScene && !!puts[0].d.ch.rigid, { puts: puts.map((p) => p.sid) });

          queued = null;
          puts.length = 0;
          S().dirty = true; S().chDirty = { rigid: true };
          saveD();                       // 排上队，还没跑
          S().scene = other;             // 人切走了
          queued && queued();
          S().scene = realScene;
          ok('S8 🔴 排队期间切了场景就作废（不许把 A 的活写进 B 的键）', puts.length === 0, { puts: puts.map((p) => p.sid) });
        } finally {
          window.requestIdleCallback = realRIC;
          S().scene = realScene;
          if (store) store.put = realPut;
        }
      } finally {
        S().dirty = keep.dirty; S().chDirty = keep.chDirty; S().painting = keep.painting;
      }
    } else {
      ok('S8 草稿逻辑可测（__draftPayloadForTest 没导出）', false);
    }

    // ---- S12 日常流程（2026-09-14 审查）：画笔手感、脏态看得见、保存不叠不误清、关窗保护、下拉选完还焦点 ----
    // 保存全走桩（拦 /api/paint），盘上一个字节不动
    {
      clearAll();
      S().dirty = false;
      window.__draw();
      // 画笔只重画这一笔经过的矩形：与整张重画逐像素一致（显示层取整差 ≤ 1），且一次移动远小于整张重画
      S().chan = 'rigid';
      const stage = el('stage');
      const a = toClient(700, 500);
      const t0 = [];
      stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: a[0], clientY: a[1], pointerId: 1200, bubbles: true, button: 0, buttons: 1 }));
      for (let i = 1; i <= 20; i++) {
        const p = toClient(700 + i * 12, 500 + i * 4);
        const s0 = performance.now();
        stage.dispatchEvent(new PointerEvent('pointermove', { clientX: p[0], clientY: p[1], pointerId: 1200, bubbles: true, buttons: 1 }));
        t0.push(performance.now() - s0);
      }
      stage.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0, pointerId: 1200, bubbles: true }));
      const ov = el('ov'), oc = ov.getContext('2d');
      const part = oc.getImageData(0, 0, ov.width, ov.height).data;
      const f0 = performance.now(); window.__draw(); const fullMs = performance.now() - f0;
      const full = oc.getImageData(0, 0, ov.width, ov.height).data;
      let maxd = 0;
      for (let i = 0; i < part.length; i++) { const d = Math.abs(part[i] - full[i]); if (d > maxd) maxd = d; }
      const moveMs = t0.reduce((x, y) => x + y, 0) / t0.length;
      ok('S12 画笔只重画经过的那一块：与整张重画一致（差 ≤ 1/255），一次移动比整张重画快一个量级',
        maxd <= 1 && px('rigid') > 100 && moveMs * 5 < Math.max(fullMs, 5), { maxd, moveMs: +moveMs.toFixed(2), fullMs: +fullMs.toFixed(1) });
      // 脏态立刻看得见（不等 1.5 s 的轮询）
      ok('S12 画完一笔：保存按钮立刻变色、窗口标题带 ●、状态条立刻说有未保存',
        S().dirty && el('save').classList.contains('dirty') && document.title.startsWith('●') && /有未保存/.test(el('badges').textContent),
        { cls: el('save').className, title: document.title, badge: el('badges').textContent.slice(0, 30) });
      // 关窗保护的钩子
      ok('S12 关窗保护：有没存的改动时页面说得出是哪个场景', window.__unsavedSummary().includes(S().scene), { s: window.__unsavedSummary() });

      // 保存：单飞 + 保存期间又画的笔不许被当成已存
      const realFetch = window.fetch;
      const keepBase = S().baseMtime;
      let posts = 0, release = null;
      window.fetch = async (url, opts) => {
        if (String(url).startsWith('/api/paint')) {
          posts++;
          await new Promise((r) => { release = r; });
          return new Response(JSON.stringify({ ok: true, mtime: keepBase, path: '(自检桩)', coverage: { veg: 0, freeze: 0, rigid: 0, unrigid: 0 } }),
            { headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(url, opts);
      };
      try {
        el('save').click();                                                                                                // 按钮
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));   // 紧跟着 Ctrl+S
        for (let i = 0; i < 100 && !release; i++) await wait(10);
        const b = toClient(900, 700);
        stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: b[0], clientY: b[1], pointerId: 1201, bubbles: true, button: 0, buttons: 1 }));
        stage.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0, pointerId: 1201, bubbles: true }));
        release && release();
        for (let i = 0; i < 100 && el('save').disabled; i++) await wait(10);
        await wait(50);
        ok('S12 🔴 按钮 + Ctrl+S 连着按只发一次保存；保存期间又画的一笔不被当成已存（留着脏、日志说再按一次）',
          posts === 1 && S().dirty && /保存期间又画了几笔/.test(el('log').textContent), { posts, dirty: S().dirty });
        // 这回不动笔：存完就干净
        posts = 0; release = null;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
        for (let i = 0; i < 100 && !release; i++) await wait(10);
        release && release();
        for (let i = 0; i < 100 && S().dirty; i++) await wait(10);
        ok('S12 没再动笔的保存：存完就干净、按钮复原', posts === 1 && !S().dirty && !el('save').classList.contains('dirty') && !document.title.startsWith('●'),
          { posts, dirty: S().dirty });
        ok('S12 关窗保护：存干净之后页面说"没有没存的"（壳直接关）', window.__unsavedSummary() === '');
        posts = 0;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
        await wait(80);
        ok('S12 没有改动时 Ctrl+S 不发请求（不白白挤掉一份历史、也不把状态翻成"待导出"）', posts === 0, { posts });
      } finally {
        window.fetch = realFetch;
        S().baseMtime = keepBase;
      }

      // 场景下拉选完就还焦点（焦点停在下拉框上时 P / B / 1-4 全没反应，按 B 还会首字母跳到别的场景）
      clearAll();
      S().dirty = false;
      const sel = el('scene');
      sel.focus();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(50);
      ok('S12 选完场景焦点离开下拉框（单键快捷键立刻好使）', document.activeElement !== sel, { active: document.activeElement && document.activeElement.id });
      for (let i = 0; i < 200 && !(S().buf && S().buf.veg && S().scene === sel.value); i++) await wait(50);
    }

    // ---- S13 复核（2026-09-14 工作流）抓出来的几条 ----
    {
      clearAll();
      S().dirty = false;
      await wait(100);
      for (const m of document.querySelectorAll('.modal')) m.remove();   // 前面装场景可能弹过草稿（非阻塞），清掉
      // 锚点工具里按 2 / E：回到画笔（原来下一下左键放的还是锚点）
      el('t-anchor').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
      const t2 = S().tool;
      el('t-coherent').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
      const te = S().tool;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));   // 橡皮关回去
      ok('S13 在锚点 / 整体摆工具里按 1-4 或 E 回到画笔', t2 === 'paint' && te === 'paint' && S().chan === 'rigid', { t2, te });

      const modalChoices = () => [...document.querySelectorAll('.modal [data-choice]')].map((b) => b.dataset.choice);
      // 有未保存的涂层时切场景：三选一（取消 / 不保存 / 保存并切换），取消留在原地、改动还在
      const store = window.__draftStoreForTest;
      const realGet = store.get, realClear = store.clear;
      const cleared = [];
      store.clear = (sid) => { cleared.push(sid); return Promise.resolve({ ok: true }); };
      try {
        S().buf.rigid.fillStyle = '#fff'; S().buf.rigid.fillRect(50, 50, 20, 20);
        S().dirty = true; S().chDirty = { rigid: true };
        const home = S().scene;
        const pOpen = window.__openSceneForTest(home);
        for (let i = 0; i < 40 && !document.querySelector('.modal'); i++) await wait(25);
        const ch1 = modalChoices();
        const cancel = document.querySelector('.modal [data-choice=cancel]');
        if (cancel) cancel.click();
        await pOpen;
        ok('S13 有未保存改动时切 / 重装场景：给「取消 / 不保存 / 保存」三选一，取消就留在原地、改动还在',
          ch1.join() === 'cancel,discard,save' && S().scene === home && S().dirty === true, { choices: ch1, dirty: S().dirty });
        // 选「不保存」：连这个场景的草稿一起删（明说了不要）；装载那一两秒里定时草稿也不许把它写回来
        const realPut = store.put;
        const puts = [];
        store.put = (sid, d) => { puts.push(sid); return Promise.resolve({ ok: true }); };
        const realRIC = window.requestIdleCallback;
        window.requestIdleCallback = null;                 // 让 saveDraft 当场跑
        const pOpen2 = window.__openSceneForTest(home);
        for (let i = 0; i < 40 && !document.querySelector('.modal'); i++) await wait(25);
        const disc = document.querySelector('.modal [data-choice=discard]');
        if (disc) disc.click();
        await wait(0);
        const dirtyDuringLoad = S().dirty;
        window.__saveDraftForTest();                        // 装载期间定时草稿那一拍
        window.requestIdleCallback = realRIC;
        await pOpen2;
        store.put = realPut;
        ok('S13 选「不保存」后装载期间，定时草稿不把刚丢掉的活写回去', dirtyDuringLoad === true && puts.length === 0, { dirtyDuringLoad, puts });
        for (let i = 0; i < 200 && !(S().buf && S().buf.veg && !S().dirty); i++) await wait(25);
        ok('S13 选「不保存」：装回盘上那份、草稿一起删掉（下次打开不再问要不要恢复刚丢掉的活）',
          !S().dirty && cleared.includes(home), { dirty: S().dirty, cleared });
        await wait(100);
        for (const m of document.querySelectorAll('.modal')) m.remove();
        // 装场景发现草稿：不挡装载；三选一里「删掉草稿」真删
        store.get = async () => ({ at: Date.now() - 5000, base: S().baseMtime, ch: { rigid: 'data:image/png;base64,' } });
        cleared.length = 0;
        const pOpen3 = window.__openSceneForTest(home);
        const r3 = await Promise.race([pOpen3.then(() => 'done'), wait(15000).then(() => 'timeout')]);
        for (let i = 0; i < 80 && !document.querySelector('.modal'); i++) await wait(25);
        const ch3 = modalChoices();
        const drop = document.querySelector('.modal [data-choice=drop]');
        if (drop) drop.click();
        await wait(50);
        ok('S13 装场景时发现草稿：不挡装载（场景先装好），给「先不管 / 删掉草稿 / 恢复」，删掉就真删',
          r3 === 'done' && ch3.join() === 'later,drop,restore' && cleared.includes(home) && !S().dirty, { r3, choices: ch3, cleared });
        // 「先不管」= 收进「历史…」（自动草稿 / 存盘都不碰它），不是只在内存里记一笔
        const realStash = store.stash;
        const stashed = [];
        store.stash = (sid) => { stashed.push(sid); return Promise.resolve({ ok: true }); };
        const pOpen4 = window.__openSceneForTest(home);
        await Promise.race([pOpen4, wait(15000)]);
        for (let i = 0; i < 80 && !document.querySelector('.modal'); i++) await wait(25);
        const later = document.querySelector('.modal [data-choice=later]');
        if (later) later.click();
        for (let i = 0; i < 40 && !stashed.length; i++) await wait(25);
        store.stash = realStash;
        ok('S13「先不管」把草稿收进「历史…」（不会被 8 秒后的自动草稿覆盖、也不会一存盘就删）', stashed.includes(home) && !cleared.slice(1).length, { stashed });
        ok('S13 关窗选「不保存」的钩子会删这个场景的草稿', typeof window.__onDiscardUnsaved === 'function');
      } finally {
        store.get = realGet; store.clear = realClear;
        for (const m of document.querySelectorAll('.modal')) m.remove();
      }
    }

    // ---- S14 复核（2026-09-14 第三轮）抓出来的几条：满硬笔刷、撤销内存、恢复草稿、窗口缩放、同场景再开、画外点击、导出中关窗 ----
    {
      clearAll();
      S().dirty = false;
      await wait(100);
      for (const m of document.querySelectorAll('.modal')) m.remove();
      const stage = el('stage');
      const keepOv = JSON.parse(JSON.stringify(S().ov));
      const [nw, nh] = S().native;
      const click = (nx, ny, button) => {
        const c = toClient(nx, ny);
        const id = pid++;
        stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: c[0], clientY: c[1], pointerId: id, bubbles: true, button: button || 0, buttons: button === 2 ? 2 : 1 }));
        stage.dispatchEvent(new PointerEvent('pointerup', { clientX: c[0], clientY: c[1], pointerId: id, bubbles: true }));
      };
      const setRange = (id, v) => { el(id).value = String(v); el(id).dispatchEvent(new Event('input')); };
      const realFetch = window.fetch;
      const jsonRes = (j) => new Response(JSON.stringify(j), { headers: { 'Content-Type': 'application/json' } });

      // 橡皮按钮与 E 键一样回到画笔（原来锚点工具还开着，按钮写着「橡皮（开）」，下一下左键放的是锚点）
      el('t-anchor').click();
      el('t-erase').click();
      ok('S14 在锚点工具里点橡皮按钮：回到画笔、橡皮开着', S().tool === 'paint' && S().erase === true, { tool: S().tool, erase: S().erase });
      el('t-erase').click();

      // 软硬 100：内外圆一样大的径向渐变什么都不画——涂不上、擦不掉，却记脏
      setRange('hard', 100);
      el('t-rigid').click();
      drag(300, 700, 600, 700);
      const hardPainted = px('rigid');
      drag(300, 700, 600, 700, 2);
      const hardLeft = px('rigid');
      ok('S14 🔴 软硬 100 涂得上、也擦得掉（原来画 0 像素、橡皮擦不动）', hardPainted > 8000 && hardLeft < hardPainted * 0.05, { hardPainted, hardLeft });
      setRange('hard', 70);
      clearAll();

      // 撤销按块收：一笔来回刷同一块，每块只收一次；另有总字节上限
      S().undo = [];
      setRange('size', 240);
      {
        const id = pid++;
        const a = toClient(400, 400);
        stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: a[0], clientY: a[1], pointerId: id, bubbles: true, button: 0, buttons: 1 }));
        for (let i = 0; i < 60; i++) {
          const p = toClient(i % 2 ? 800 : 400, 400);
          stage.dispatchEvent(new PointerEvent('pointermove', { clientX: p[0], clientY: p[1], pointerId: id, bubbles: true, buttons: 1 }));
        }
        stage.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0, pointerId: id, bubbles: true }));
      }
      const g = S().undo[S().undo.length - 1];
      const pad = 122 + 2;                                  // 半径 120 + 2，外加 2 像素坐标换算的余量
      const tilesX = Math.floor((800 + pad - 1) / 128) - Math.floor((400 - pad) / 128) + 1;
      const tilesY = Math.floor((400 + pad - 1) / 128) - Math.floor((400 - pad) / 128) + 1;
      const keys = g ? new Set(g.patches.map((p) => p.x + ',' + p.y)) : new Set();
      const bytes = g ? g.patches.reduce((n, p) => n + p.data.data.length, 0) : -1;
      ok('S14 🔴 一笔来回刷 60 次，撤销补丁每块只收一次（原来每次移动收一块，笔刷 240 一秒 15 MB）',
        !!g && keys.size === g.patches.length && g.patches.length <= tilesX * tilesY && g.bytes === bytes,
        { patches: g && g.patches.length, 上限: tilesX * tilesY, bytes: g && g.bytes });
      el('undo').click();
      ok('S14 分块撤销照样整笔还回来', px('rigid') === 0, { rigid: px('rigid') });
      S().undo = [];
      S().undoByteCap = 1024 * 1024;
      try {
        for (const x of [200, 1000, 1800]) drag(x, 200, x, 200);   // 每下 3×3 块 ≈ 0.6 MB，两下就过 1 MB
        const total = S().undo.reduce((n, e) => n + (e.bytes || 0), 0);
        ok('S14 🔴 撤销栈有总字节上限：超了从最老的丢，最新一笔留着', S().undo.length === 1 && total <= S().undoByteCap,
          { entries: S().undo.length, total });
      } finally {
        S().undoByteCap = 320 * 1024 * 1024;
      }
      el('undo').click();
      S().undo = [];
      clearAll();
      setRange('size', 40);

      // 画外点击：锚点 / 整体摆钳进原画（原来存盘时按 0 ≤ y < 高 丢掉），画笔点在暗边上不记脏
      S().ov = { anchors: [], coherent: [] };
      S().dirty = false;
      el('t-anchor').click();
      click(nw / 2, nh + 3);
      const an = S().ov.anchors[0];
      ok('S14 🔴 原画底边外点的锚点钳进原画里（不会被存盘 / 推送丢掉）', !!an && an[1] < nh && an[1] >= nh - 1 && an[0] >= 0 && an[0] < nw, { an });
      const m = S().idMap;
      let edgeX = -1;
      if (m) {
        for (let ix = 0; ix < m.w && edgeX < 0; ix++) {
          const o = ((m.h - 1) * m.w + ix) * 4;
          if (m.data[o] + 256 * m.data[o + 1] > 0) edgeX = ((ix + 0.5) / m.w) * nw;
        }
      }
      if (edgeX >= 0) {
        el('t-coherent').click();
        click(edgeX, nh + 2);
        const cp = S().ov.coherent[0];
        ok('S14 🔴 原画底边外点整体摆：标上的点在原画里', !!cp && cp[1] < nh && cp[0] < nw, { cp });
      }
      el('t-veg').click();
      S().ov = { anchors: [], coherent: [] };
      S().dirty = false;
      S().undo = [];
      click(-300, nh / 2);
      ok('S14 🔴 画笔点在原画外的暗边上：不记脏、不进撤销栈（原来标"有未保存"，撤销里却什么都没有）',
        S().dirty === false && S().undo.length === 0 && px('veg') === 0, { dirty: S().dirty, undo: S().undo.length });
      click(-10, nh / 2);                                   // 笔刷半径 20，擦着左边进来
      ok('S14 画笔擦着原画边进来：照常画上、记脏', S().dirty === true && S().undo.length === 1 && px('veg') > 0, { veg: px('veg') });
      el('undo').click();
      S().dirty = false;
      S().undo = [];

      // 整体摆蒙版缓存：同一份 id 集合不重建；局部重画与整张重画逐像素一致（缓存画布拷过一次，没有方框接缝）
      if (m) {
        let pt = null;
        for (let iy = m.h >> 1; iy < m.h && !pt; iy += 4) {
          for (let ix = 0; ix < m.w; ix += 4) {
            const o = (iy * m.w + ix) * 4;
            if (m.data[o] + 256 * m.data[o + 1] > 0) { pt = [((ix + 0.5) / m.w) * nw, ((iy + 0.5) / m.h) * nh]; break; }
          }
        }
        if (pt) {
          S().ov = { anchors: [], coherent: [[Math.round(pt[0]), Math.round(pt[1])]] };
          window.__draw();
          const e1 = window.__idMaskForTest.get('coherent');
          S().chan = 'rigid';
          drag(pt[0] - 60, pt[1], pt[0] + 60, pt[1] + 20);
          const e2 = window.__idMaskForTest.get('coherent');
          const oc = el('ov').getContext('2d');
          const part = oc.getImageData(0, 0, nw, nh).data;
          window.__draw();
          const full = oc.getImageData(0, 0, nw, nh).data;
          let maxd = 0;
          for (let i = 0; i < part.length; i++) { const d = Math.abs(part[i] - full[i]); if (d > maxd) maxd = d; }
          ok('S14 🔴 标了整体摆之后画笔不再每次移动重建蒙版；局部重画与整张重画一致',
            !!e1 && e1 === e2 && window.__idMaskForTest.get('coherent') === e1 && maxd <= 1, { same: e1 === e2, maxd });
          el('undo').click();
        }
        S().ov = { anchors: [], coherent: [] };
        S().dirty = false;
        S().undo = [];
        window.__draw();
      }

      // 窗口尺寸变了：保住缩放与平移，中心不动；视图还是复位的样子时才跟着重新复位
      {
        const side = el('side');
        el('fit').click();
        stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 500, clientY: 300, bubbles: true, cancelable: true }));
        const v0 = { ...S().view };
        const w0 = stage.getBoundingClientRect().width;
        side.style.flex = '0 0 400px'; side.style.width = '400px';
        const w1 = stage.getBoundingClientRect().width;
        window.dispatchEvent(new Event('resize'));
        const v1 = { ...S().view };
        ok('S14 🔴 放大着改窗口尺寸：缩放不变、按尺寸变化的一半平移（原来一律跳回整张图）',
          w1 !== w0 && v1.k === v0.k && Math.abs(v1.x - (v0.x + (w1 - w0) / 2)) < 0.01 && Math.abs(v1.y - v0.y) < 0.01, { v0, v1, w0, w1 });
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
        side.style.flex = ''; side.style.width = '';
        window.dispatchEvent(new Event('resize'));
        const st = stage.getBoundingClientRect();
        const kFit = Math.min(st.width / nw, st.height / nh);
        ok('S14 没动过视图（刚复位）时改窗口尺寸：跟着重新复位', Math.abs(S().view.k - kFit) < 1e-9, { k: S().view.k, kFit });
      }

      // 主编辑器再点「在草木工作台中打开」同一个场景：什么都不做（不重装、不弹框、撤销栈与视图都在）
      {
        const tok = S().openToken, v = { ...S().view };
        S().undo.push({ kind: 'ov', prev: { anchors: [], coherent: [] } });
        S().dirty = true;
        const r = window.__openScene(S().scene);
        await wait(400);
        ok('S14 🔴 __openScene 打开已经开着的场景：不重装、不弹框、撤销栈与视图都在',
          r === undefined && S().openToken === tok && !document.querySelector('.modal') && S().undo.length === 1 && S().dirty && S().view.k === v.k,
          { tok: S().openToken, modal: !!document.querySelector('.modal'), undo: S().undo.length });
        for (const mm of document.querySelectorAll('.modal')) mm.remove();
        S().undo = [];
        S().dirty = false;
      }

      // 导出在跑时关窗：要拦；「保存并关闭」等导出跑完才回 ok（失败了说原因、不关）
      {
        let done = null;
        window.__setExportJobForTest(new Promise((r) => { done = r; }));
        const sum = window.__unsavedSummary();
        window.__saveUnsaved();
        await wait(150);
        const mid = window.__saveUnsavedResult;
        done('');
        await wait(50);
        const fin = window.__saveUnsavedResult;
        window.__setExportJobForTest(new Promise((r) => { done = r; }));
        window.__saveUnsaved();
        done('导出失败：自检');
        await wait(50);
        const failRes = window.__saveUnsavedResult;
        window.__setExportJobForTest(null);
        ok('S14 🔴 导出在跑时关窗要拦（原来涂层已存就直接关，资源只写一半）', /导出/.test(sum) && window.__unsavedSummary() === '', { sum });
        ok('S14 🔴「保存并关闭」等导出跑完才说 ok，导出失败就说原因不关', mid === 'pending' && fin === 'ok' && /导出失败/.test(failRes), { mid, fin, failRes });
      }

      // 重装 / 切场景收起「历史…」；「待导出」用服务端给的 needsExport
      {
        const box = el('history-box');
        if (box.style.display === 'block') el('history').click();
        el('history').click();
        for (let i = 0; i < 80 && /读取中/.test(box.textContent); i++) await wait(25);
        const opened = box.style.display === 'block' && box.textContent.length > 0;
        // 时刻故意与 needsExport 说反；paintMtime 是乐观并发的基准，改过的话跑完放回去
        const baseKeep = S().baseMtime;
        let flip = (j) => ({ ...j, needsExport: true, bakedMtime: (j.paintMtime || 0) + 1 });
        window.fetch = async (url, opts) => {
          const r = await realFetch(url, opts);
          if (!String(url).startsWith('/api/layers')) return r;
          return jsonRes(flip(await r.json()));
        };
        try {
          await window.__openSceneForTest(S().scene, { noDraft: true });
          ok('S14 🔴 重装 / 切场景收起「历史…」（原来列着上一个场景的，点恢复拿错场景的名字）', opened && box.style.display === 'none' && box.innerHTML === '', { opened });
          const a = S().needsExport;
          flip = (j) => ({ ...j, needsExport: false, paintMtime: j.paintMtime || 1, bakedMtime: (j.paintMtime || 1) - 1 });
          await window.__openSceneForTest(S().scene, { noDraft: true });
          const b = S().needsExport;
          flip = (j) => {                               // 老服务端：没有这个字段就退回比时刻
            const o = { ...j, paintMtime: j.paintMtime || 1, bakedMtime: (j.paintMtime || 1) - 1 };
            delete o.needsExport;
            return o;
          };
          await window.__openSceneForTest(S().scene, { noDraft: true });
          ok('S14 🔴「待导出」按服务端的 needsExport（烘焙读到的输入指纹）算，没有这个字段才比时刻', a === true && b === false && S().needsExport === true, { a, b, c: S().needsExport });
        } finally {
          window.fetch = realFetch;
          S().baseMtime = baseKeep;
        }
        for (const mm of document.querySelectorAll('.modal')) mm.remove();
      }

      // 「历史…」开着时保存：重列（原来关了再开才看得见新的那份）
      const store = window.__draftStoreForTest;
      const realStashes = store.stashes, realGetStash = store.getStash, realDeleteStash = store.deleteStash;
      {
        const box = el('history-box');
        let histCalls = 0;
        const keepBase = S().baseMtime;
        store.stashes = async () => [];
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (u.startsWith('/api/paint')) {
            return jsonRes({ ok: true, mtime: keepBase, path: '(自检桩)', coverage: { veg: 0, freeze: 0, rigid: 0, unrigid: 0 } });
          }
          if (u.startsWith('/api/history')) {
            histCalls++;
            return jsonRes({ ok: true, items: Array.from({ length: histCalls }, (_, i) => ({ name: `20260914-12000${i}-000.png`, bytes: 2048 })) });
          }
          return realFetch(url, opts);
        };
        try {
          el('history').click();
          for (let i = 0; i < 80 && !/份历史/.test(box.textContent); i++) await wait(25);
          S().buf.rigid.fillStyle = '#fff'; S().buf.rigid.fillRect(10, 10, 4, 4);
          S().dirty = true; S().chDirty = { rigid: true };
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
          for (let i = 0; i < 120 && !(box.style.display === 'block' && box.textContent.includes('2 份历史')); i++) await wait(25);
          ok('S14「历史…」开着时保存：列表跟着重列', !S().dirty && box.style.display === 'block' && box.textContent.includes('2 份历史'),
            { dirty: S().dirty, text: box.textContent.slice(0, 40) });
        } finally {
          window.fetch = realFetch;
          store.stashes = realStashes;
          S().baseMtime = keepBase;
          if (box.style.display === 'block') el('history').click();
        }
      }

      // 恢复收起来的草稿：手上有没存的改动时先问（点名要换掉的层），换上之后一下 Ctrl+Z 撤回，换上了才删那份草稿
      try {
        clearAll();
        const box = el('history-box');
        const cv = document.createElement('canvas');
        cv.width = nw; cv.height = nh;
        const cx = cv.getContext('2d');
        cx.fillStyle = '#000'; cx.fillRect(0, 0, nw, nh);
        cx.fillStyle = '#fff'; cx.fillRect(400, 400, 100, 100);
        let draft = { at: Date.now() - 60000, base: S().baseMtime, ch: { rigid: cv.toDataURL('image/png') } };
        const deleted = [];
        store.stashes = async () => [{ name: 'zz_selftest.stash-1.json', at: draft.at, channels: ['rigid'] }];
        store.getStash = async () => draft;
        store.deleteStash = (sid, name) => { deleted.push(name); return Promise.resolve({ ok: true }); };
        // 手上的活：刚体层另一处 200×200，没存
        S().buf.rigid.fillStyle = '#fff'; S().buf.rigid.fillRect(1000, 300, 200, 200);
        S().dirty = true; S().chDirty = { rigid: true };
        S().undo = [];
        const mine = px('rigid');
        const openRows = async () => {
          if (box.style.display === 'block') el('history').click();
          el('history').click();
          for (let i = 0; i < 80 && ![...box.querySelectorAll('button')].some((b) => b.textContent === '恢复'); i++) await wait(25);
          return [...box.querySelectorAll('button')].find((b) => b.textContent === '恢复');
        };
        let btn = await openRows();
        const label = box.textContent;
        btn && btn.click();
        for (let i = 0; i < 80 && !document.querySelector('.modal'); i++) await wait(25);
        const ch1 = [...document.querySelectorAll('.modal [data-choice]')].map((b) => b.dataset.choice);
        const msg1 = (document.querySelector('.modal p') || {}).textContent || '';
        const cancel = document.querySelector('.modal [data-choice=cancel]');
        cancel && cancel.click();
        await wait(100);
        ok('S14 🔴 手上有没存的改动时恢复收起的草稿：先问、点名换掉哪几层；取消就什么都不动',
          !!btn && /替换页面上的/.test(label) && ch1.join() === 'cancel,go' && msg1.includes('加刚体') && px('rigid') === mine && deleted.length === 0,
          { choices: ch1, rigid: px('rigid'), mine, deleted });
        btn = await openRows();
        btn && btn.click();
        for (let i = 0; i < 80 && !document.querySelector('.modal'); i++) await wait(25);
        const go = document.querySelector('.modal [data-choice=go]');
        go && go.click();
        for (let i = 0; i < 120 && !deleted.length; i++) await wait(25);
        const replaced = px('rigid');
        const top = S().undo[S().undo.length - 1];
        ok('S14 🔴 确认后：草稿里的层整层换上、进撤销栈（一组）、换上了才删那份草稿',
          replaced === 10000 && !!top && top.kind === 'group' && deleted.length === 1 && S().dirty, { replaced, kind: top && top.kind, deleted });
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
        ok('S14 🔴 恢复草稿之后一下 Ctrl+Z 把手上的活原样拿回来', px('rigid') === mine, { rigid: px('rigid'), mine });
        // 草稿里的图读不出来：一层都不动、草稿留着；干净且盘上没变时不问
        S().dirty = false;
        draft = { at: draft.at, base: S().baseMtime, ch: { rigid: 'data:image/png;base64,' } };
        btn = await openRows();
        btn && btn.click();
        for (let i = 0; i < 80 && !/一层都没动/.test(el('log').textContent); i++) await wait(25);
        ok('S14 草稿读不出来：一层都不动、草稿不删；页面干净时不弹确认',
          px('rigid') === mine && deleted.length === 1 && !document.querySelector('.modal') && /一层都没动/.test(el('log').textContent),
          { rigid: px('rigid'), deleted, modal: !!document.querySelector('.modal') });
      } finally {
        store.stashes = realStashes; store.getStash = realGetStash; store.deleteStash = realDeleteStash;
        for (const mm of document.querySelectorAll('.modal')) mm.remove();
        const box = el('history-box');
        box.style.display = 'none'; box.innerHTML = '';
        S().undo = [];
        clearAll();
        S().dirty = false;
      }

      // 场景清单：点开下拉框之前刷新，选中项不变（原来只在启动时读一次，烘完几何场回来照样灰着）
      {
        await wait(1600);                                   // 让过刷新的节流
        const sel = el('scene');
        const cur = S().scene, n0 = sel.options.length;
        window.fetch = async (url, opts) => {
          const r = await realFetch(url, opts);
          if (!String(url).startsWith('/api/scenes')) return r;
          const j = await r.json();
          for (const s of j.scenes) if (s.id === cur) s.sway = { version: 9, instances: 4242, paint: true };
          return jsonRes(j);
        };
        try {
          sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          const opt = () => [...sel.options].find((o) => o.value === cur);
          for (let i = 0; i < 80 && !(opt() && opt().textContent.includes('4242')); i++) await wait(25);
          ok('S14 点开场景下拉框之前刷新清单，选中项不变', !!opt() && opt().textContent.includes('4242 株') && sel.value === cur && sel.options.length === n0,
            { text: opt() && opt().textContent, value: sel.value });
        } finally {
          window.fetch = realFetch;
          if (window.Dropdown) window.Dropdown.close();     // 上面那下 mousedown 打开了页内列表：收起来，别飘到后面的步骤里
        }
      }
      S().ov = keepOv;
      S().ovDirty = false;
    }

    // ---- S15 第三轮复核之后（2026-09-14）：实例分区看得见、重做不再多撤一笔、笔刷浓淡不随手速、存了没变不亮待导出、
    //      推送 / 导出等游戏真换上才打勾（没配风直说）、导出作废推送的补发、控制台游戏都没开不排命令 ----
    // 联动全走桩（/api/push、/api/export、/api/paint、/api/link/* 一律拦下），资源 / 涂层 / 游戏一个字节不碰
    {
      clearAll();
      S().dirty = false;
      S().undo = []; S().redo = [];
      for (const mm of document.querySelectorAll('.modal')) mm.remove();
      const stage = el('stage');
      const [nw, nh] = S().native;
      const sid = S().scene;
      const realFetch = window.fetch;
      const jsonRes = (j) => new Response(JSON.stringify(j), { headers: { 'Content-Type': 'application/json' } });
      const setRange = (id, v) => { el(id).value = String(v); el(id).dispatchEvent(new Event('input')); };
      const keyDown = (key, mods = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
      const click = (nx, ny) => {
        const c = toClient(nx, ny);
        const id = pid++;
        stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: c[0], clientY: c[1], pointerId: id, bubbles: true, button: 0, buttons: 1 }));
        stage.dispatchEvent(new PointerEvent('pointerup', { clientX: c[0], clientY: c[1], pointerId: id, bubbles: true }));
      };
      const alphaSum = (ch, y0 = 0, y1 = nh) => {
        const d = S().buf[ch].getImageData(0, y0, nw, y1 - y0).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) n += d[i];
        return n;
      };
      const logFrom = () => { const at = el('log').textContent.length; return () => el('log').textContent.slice(at); };
      const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await wait(25); return !!cond(); };
      const keepOv = JSON.parse(JSON.stringify(S().ov));
      const keepShow = { ...S().show };
      const keepFlags = { needsExport: S().needsExport, previewNewer: S().previewNewer, hasWind: S().layers && S().layers.hasWind };
      const T = window.__linkTimingForTest;
      const keepT = T ? { ...T } : null;

      // 实例分区：按株号上色、id 0 透明、局部重画与整张一致、上色图缓存着
      const m = S().idMap;
      if (m) {
        try {
          for (const k of Object.keys(S().show)) S().show[k] = false;
          S().show.ids = true;
          S().ov = { anchors: [], coherent: [] };
          S().hover = 0;
          window.__draw();
          const idAtCell = (ix, iy) => { const o = (iy * m.w + ix) * 4; return m.data[o] + 256 * m.data[o + 1]; };
          const uniform = (ix, iy) => {
            const v = idAtCell(ix, iy);
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (idAtCell(ix + dx, iy + dy) !== v) return -1;
            return v;
          };
          let zero = null;
          const plants = new Map();
          for (let iy = 3; iy < m.h - 3; iy += 5) {
            for (let ix = 3; ix < m.w - 3; ix += 5) {
              const v = uniform(ix, iy);
              if (v === 0 && !zero) zero = [ix, iy];
              else if (v > 0 && !plants.has(v)) plants.set(v, [ix, iy]);
            }
          }
          const oc = el('ov').getContext('2d');
          const at = ([ix, iy]) => [...oc.getImageData(Math.floor(((ix + 0.5) / m.w) * nw), Math.floor(((iy + 0.5) / m.h) * nh), 1, 1).data];
          const z = zero ? at(zero) : null;
          let pair = null;
          for (const a of plants.keys()) if (plants.has(a + 1)) { pair = [a, a + 1]; break; }      // 挨着的株号最容易撞色
          if (!pair && plants.size >= 2) pair = [...plants.keys()].slice(0, 2);
          const c1 = pair ? at(plants.get(pair[0])) : null, c2 = pair ? at(plants.get(pair[1])) : null;
          const dist = c1 && c2 ? Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]) : -1;
          ok('S15 🔴 实例分区：不属于任何一株的地方全透明（原来整幅贴不透明的 ids 图，画面蒙一层近黑）', !!z && z[3] === 0, { z });
          ok('S15 🔴 实例分区：株号相邻的两株颜色分得开（原来红色只差 1/255）', !!pair && c1[3] > 60 && c2[3] > 60 && dist > 60,
            { pair, c1, c2, dist: Math.round(dist) });
          const e1 = window.__idMaskForTest.get('partition');
          window.__draw();
          ok('S15 实例分区的上色图缓存着（不随每次重画重建）', !!e1 && !!e1.c && window.__idMaskForTest.get('partition') === e1);
          S().show.paint = true;
          el('t-rigid').click();
          drag(600, 500, 900, 560);
          const part = oc.getImageData(0, 0, nw, nh).data;
          window.__draw();
          const full = oc.getImageData(0, 0, nw, nh).data;
          let maxd = 0;
          for (let i = 0; i < part.length; i++) { const d = Math.abs(part[i] - full[i]); if (d > maxd) maxd = d; }
          ok('S15 实例分区开着画笔：局部重画与整张重画一致（最近邻放大，没有接缝）', maxd <= 1, { maxd });
        } finally {
          Object.assign(S().show, keepShow);
          S().ov = keepOv;
          clearAll();
          S().undo = []; S().redo = [];
          S().dirty = false;
          window.__draw();
        }
      }

      // 重做：Ctrl+Shift+Z / Ctrl+Y 是重做，不是再撤一笔；撤回去之后又画了新笔，重做栈作废
      {
        setRange('size', 40); setRange('hard', 70);
        el('t-rigid').click();
        drag(300, 300, 700, 300);
        const sumA = alphaSum('rigid');
        drag(300, 600, 700, 600);
        const sumAB = alphaSum('rigid');
        keyDown('z', { ctrlKey: true });
        const afterUndo = alphaSum('rigid');
        keyDown('Z', { ctrlKey: true, shiftKey: true });
        const afterRedo = alphaSum('rigid');
        ok('S15 🔴 Ctrl+Z 多按了一下再按 Ctrl+Shift+Z：那一笔重做回来（原来又撤掉一笔，两笔都没了）',
          sumA > 0 && sumAB > sumA && afterUndo === sumA && afterRedo === sumAB, { sumA, sumAB, afterUndo, afterRedo });
        keyDown('z', { ctrlKey: true });
        keyDown('z', { ctrlKey: true });
        const gone = alphaSum('rigid');
        keyDown('y', { ctrlKey: true });
        ok('S15 Ctrl+Y 也是重做，一步一步回来', gone === 0 && alphaSum('rigid') === sumA, { gone, now: alphaSum('rigid'), sumA });
        drag(300, 900, 700, 900);
        const sumC = alphaSum('rigid');
        keyDown('Z', { ctrlKey: true, shiftKey: true });
        ok('S15 撤回去之后又画了一笔：重做栈作废，Ctrl+Shift+Z 什么都不动', S().redo.length === 0 && alphaSum('rigid') === sumC,
          { redo: S().redo.length, now: alphaSum('rigid'), sumC });
        S().ov = { anchors: [], coherent: [] };
        el('t-anchor').click();
        click(1240, 1000);
        keyDown('z', { ctrlKey: true });
        const a0 = S().ov.anchors.length;
        keyDown('Z', { ctrlKey: true, shiftKey: true });
        ok('S15 锚点也能撤销后重做', a0 === 0 && S().ov.anchors.length === 1, { a0, a1: S().ov.anchors.length });
        el('t-anchor').click();
        S().ov = keepOv;
        clearAll();
        S().undo = []; S().redo = [];
        S().dirty = false;
        S().ovDirty = false;
      }

      // 笔刷间距整笔连续：慢拖与快拖画出来的量一样；点一下只印一个印子
      {
        setRange('size', 48); setRange('hard', 70);
        el('t-veg').click();
        const strokeBy = (y, step, n) => {
          const id = pid++;
          const a = toClient(400, y);
          stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: a[0], clientY: a[1], pointerId: id, bubbles: true, button: 0, buttons: 1 }));
          for (let i = 1; i <= n; i++) {
            const p = toClient(400 + i * step, y);
            stage.dispatchEvent(new PointerEvent('pointermove', { clientX: p[0], clientY: p[1], pointerId: id, bubbles: true, buttons: 1 }));
          }
          stage.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0, pointerId: id, bubbles: true }));
        };
        strokeBy(300, 1, 300);                               // 慢：每次移动 1 px
        strokeBy(500, 30, 10);                               // 快：每次移动 30 px，同样长
        const slow = alphaSum('veg', 250, 350), fast = alphaSum('veg', 450, 550);
        ok('S15 🔴 笔刷浓淡不随拖动快慢变：每次 1 px 与每次 30 px 拖同样长，画上去的量一样（原来慢拖软边叠成实心）',
          fast > 0 && Math.abs(slow - fast) <= fast * 0.01, { slow, fast });
        clearAll();
        click(800, 800);
        const [lx, ly] = S().last;
        const one = alphaSum('veg', 760, 840);
        const ref = document.createElement('canvas');
        ref.width = nw; ref.height = nh;
        const rx = ref.getContext('2d', { willReadFrequently: true });
        const r = 24;
        const g = rx.createRadialGradient(lx, ly, Math.min(r * 0.7, r - 0.5), lx, ly, r);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        rx.fillStyle = g;
        rx.beginPath(); rx.arc(lx, ly, r, 0, Math.PI * 2); rx.fill();
        const rd = rx.getImageData(0, 760, nw, 80).data;
        let refSum = 0;
        for (let i = 3; i < rd.length; i += 4) refSum += rd[i];
        ok('S15 🔴 点一下只印一个印子（原来同一处印两遍，软边比「软硬」设定的硬）', refSum > 0 && Math.abs(one - refSum) <= refSum * 0.002, { one, refSum });
        clearAll();
        S().undo = []; S().redo = [];
        S().dirty = false;
        setRange('size', 40);
      }

      // 联动桩：推送 / 导出 / 保存 / 游戏心跳全在页面里答
      const net = { notify: 0, open: 0, job: null, heartbeat: null, statusDelay: 0, hasWind: false, openResp: { via: 'queue', console: '自检' }, paint: null };
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith('/api/push/notify')) { net.notify++; return jsonRes({ ok: true, pushed: true, rev: 99, game: net.heartbeat && { ...net.heartbeat } }); }
        if (u.startsWith('/api/push') || u.startsWith('/api/export') || u.startsWith('/api/warm')) return jsonRes({ ok: true, started: true });
        if (u.startsWith('/api/job/status')) return jsonRes({ ok: true, running: false, done: true, succeeded: true, log: [], elapsed: 0, push: net.job });
        if (u.startsWith('/api/link/status')) {
          if (net.statusDelay) await wait(net.statusDelay);
          const hb = net.heartbeat;
          return jsonRes({ ok: true, game: 'http://127.0.0.1:9', alive: true, page: hb && { ...hb }, pageAlive: !!hb });
        }
        if (u.startsWith('/api/link/open')) { net.open++; return jsonRes({ ok: true, ...net.openResp }); }
        if (u.startsWith('/api/paint')) {
          return jsonRes({ ok: true, mtime: S().baseMtime, path: '(自检桩)', coverage: { veg: 0, freeze: 0, rigid: 0, unrigid: 0 }, ...(net.paint || {}) });
        }
        if (u.startsWith('/api/layers')) {
          const j = await (await realFetch(url, opts)).json();
          return jsonRes({ ...j, hasWind: net.hasWind });
        }
        return realFetch(url, opts);
      };
      try {
        Object.assign(T, { waitMs: 1500, pollMs: 60, applyMs: 1200, applyPollMs: 60 });
        const idle = () => until(() => !el('push').disabled && !window.__exportJobForTest(), 6000);

        // 存了但与导出时一样：不亮「待导出」
        {
          S().previewNewer = false;
          S().needsExport = false;
          net.paint = { paintUnchanged: true, needsExport: false };
          S().dirty = true;
          keyDown('s', { ctrlKey: true });
          await until(() => !S().dirty);
          const a = S().needsExport, badgeA = el('badges').textContent;
          net.paint = { paintUnchanged: false, needsExport: true };
          S().dirty = true;
          keyDown('s', { ctrlKey: true });
          await until(() => !S().dirty && S().needsExport);
          ok('S15 🔴 存下的与资源里导出时一样（撤销回原样 / 锚点加了又删）：不亮「待导出」；真有差别才亮',
            a === false && !/待导出/.test(badgeA) && S().needsExport === true, { a, badgeA: badgeA.slice(0, 40), b: S().needsExport });
          net.paint = null;
        }

        // 没配风：徽章直说
        S().layers.hasWind = false;
        S().dirty = true; S().dirty = false;                  // 脏态翻一下 = 立刻重画徽章
        ok('S15 🔴 场景没配风：状态条直说"游戏里草木不会动"', /没配风/.test(el('badges').textContent), { badge: el('badges').textContent });

        // 推送：游戏收下了但没换上（没配风的场景）——不许打勾，等不到就直说
        const hb = (applied) => ({ sceneId: sid, bootId: 'selftest-boot', preview: 0, applied, ageMs: 5 });
        await idle();
        net.hasWind = false;
        net.heartbeat = hb(6);
        net.job = { pushed: true, rev: 7, inScene: true, pageAlive: true, game: hb(6) };
        let tail = logFrom();
        el('push').click();
        await until(() => /没换上|✔ 游戏里已换上/.test(tail()), 8000);
        ok('S15 🔴 推送：游戏收下了却没换上（applied 不涨）不许打「✔ 游戏里已换上」，超时直说、点名没配风',
          /没换上/.test(tail()) && /没配风/.test(tail()) && !/✔ 游戏里已换上/.test(tail()), { tail: tail().slice(-160) });

        // 推送：等心跳里的 applied 追上这次 rev 才打勾
        await idle();
        net.hasWind = true;
        net.heartbeat = hb(6);
        net.job = { pushed: true, rev: 8, inScene: true, pageAlive: true, game: hb(6) };
        tail = logFrom();
        el('push').click();
        await until(() => /等它换上/.test(tail()), 6000);
        await wait(200);
        const early = /✔ 游戏里已换上/.test(tail());
        net.heartbeat = hb(8);
        await until(() => /✔ 游戏里已换上（第 8 次）/.test(tail()), 3000);
        ok('S15 🔴 推送：心跳 applied ≥ 这次 rev 才打「✔ 游戏里已换上」', !early && /✔ 游戏里已换上（第 8 次）/.test(tail()) && !/没换上/.test(tail()),
          { early, tail: tail().slice(-160) });

        // 老 dev server（心跳没有 applied）：照旧按收下了算
        await idle();
        const legacyHb = { sceneId: sid, bootId: 'selftest-boot', preview: 0, ageMs: 5 };
        net.heartbeat = legacyHb;
        net.job = { pushed: true, rev: 11, inScene: true, pageAlive: true, game: { ...legacyHb } };
        tail = logFrom();
        el('push').click();
        await until(() => /✔ 游戏里已换上（第 11 次）/.test(tail()), 4000);
        ok('S15 老 dev server 的心跳没有 applied：照旧收下就打勾（不空等）', /✔ 游戏里已换上（第 11 次）/.test(tail()) && !/等它换上/.test(tail()), { tail: tail().slice(-120) });

        // 导出：资源写完就放掉导出的 promise（关窗保护不等游戏），游戏换没换上另说
        await idle();
        net.heartbeat = hb(8);
        net.job = { pushed: true, rev: 12, inScene: true, pageAlive: true, game: hb(8) };
        tail = logFrom();
        el('export').click();
        await until(() => /✔ 已写进资源/.test(tail()), 4000);
        const released = await until(() => !window.__exportJobForTest(), 800);
        const tooEarly = /没换上|换回资源里这份/.test(tail());
        await until(() => /没换上|换回资源里这份/.test(tail()), 4000);
        ok('S15 🔴 导出：游戏没换上不许说「游戏已换回资源里这份」；导出的 promise 不等游戏', released && !tooEarly && /没换上/.test(tail()) && !/换回资源里这份/.test(tail()),
          { released, tooEarly, tail: tail().slice(-160) });
        await idle();
        net.job = { pushed: true, rev: 13, inScene: true, pageAlive: true, game: hb(12) };
        tail = logFrom();
        el('export').click();
        await until(() => /等它换上/.test(tail()), 4000);
        net.heartbeat = hb(13);
        await until(() => /✔ 游戏已换回资源里这份（第 13 次）/.test(tail()), 3000);
        ok('S15 导出：applied 追上才说「✔ 游戏已换回资源里这份」', /✔ 游戏已换回资源里这份（第 13 次）/.test(tail()), { tail: tail().slice(-120) });

        // 控制台和游戏都没开：不排命令、不空等，日志带上控制台为什么没开
        await idle();
        net.heartbeat = null;
        net.job = { pushed: false, why: '没找到在跑的游戏' };
        net.openResp = { via: 'none', console: '控制台没开（自检）', detail: 'dev server 也没在跑' };
        net.notify = 0;
        tail = logFrom();
        el('push').click();
        await until(() => /控制台和游戏都没开/.test(tail()), 4000);
        await wait(300);
        ok('S15 🔴 控制台和游戏都没开：不排切场景命令、不空等，日志说清为什么（原来写"已请求（queue）"然后空等）',
          /控制台和游戏都没开（控制台没开（自检））/.test(tail()) && !/等游戏页进到/.test(tail()) && net.notify === 0 && window.__waitingForGameForTest() === null,
          { tail: tail().slice(-160) });

        // 等游戏页进场景按真实时间封顶（每次问状态要实探端口，按轮数数实际要等好几倍）
        await idle();
        net.openResp = { via: 'queue', console: '控制台没开（自检）' };
        net.statusDelay = 300;
        Object.assign(T, { waitMs: 900, pollMs: 50 });
        tail = logFrom();
        const t0 = Date.now();
        el('push').click();
        await until(() => /等了一分半/.test(tail()), 15000);
        const took = Date.now() - t0;
        net.statusDelay = 0;
        ok('S15 🔴 等游戏页进场景按真实流逝时间封顶，不按轮数', /等了一分半/.test(tail()) && took < 9000, { took });

        // 推送在等游戏起来时导出了同一个场景：作废补发；finally 只清自己那张凭证
        await idle();
        Object.assign(T, { waitMs: 8000, pollMs: 150 });
        net.heartbeat = null;
        net.notify = 0;
        tail = logFrom();
        el('push').click();
        await until(() => !!window.__waitingForGameForTest() && /等游戏页进到/.test(tail()), 4000);
        const tok1 = window.__waitingForGameForTest();
        net.job = { pushed: false, why: '没开着' };
        el('export').click();
        await until(() => /✔ 已写进资源/.test(tail()), 4000);
        net.heartbeat = hb(0);                                 // 游戏起来了、进了这个场景
        await wait(700);
        ok('S15 🔴 推送在等游戏起来时导出了同一个场景：游戏起来后不再补发预览（原来补发的 preview 盖掉导出）',
          !!tok1 && tok1.cancelled === true && /不再补发预览/.test(tail()) && net.notify === 0 && window.__waitingForGameForTest() === null,
          { cancelled: tok1 && tok1.cancelled, notify: net.notify, waiting: !!window.__waitingForGameForTest() });
        await idle();
        net.heartbeat = null;
        const SLEEP = 7000;
        Object.assign(T, { pollMs: SLEEP });
        el('push').click();
        await until(() => !!window.__waitingForGameForTest(), 4000);
        const tok2 = window.__waitingForGameForTest(), tok2At = Date.now();
        el('export').click();
        await idle();
        tail = logFrom();
        el('push').click();                                    // 上一张凭证作废了、它的等待还睡着：这次要自己再等
        await until(() => !!window.__waitingForGameForTest() && window.__waitingForGameForTest() !== tok2, 4000);
        const tok3 = window.__waitingForGameForTest(), tok3At = Date.now();
        await wait(Math.max(0, tok2At + SLEEP + 400 - Date.now()));   // 让 tok2 那一轮醒来退出（它的 finally 不许清掉 tok3）
        ok('S15 🔴 作废的等待退出时只清自己那张凭证：之后再按 P 的那次照样在等',
          !!tok2 && tok2.cancelled && !!tok3 && tok3 !== tok2 && !tok3.cancelled && tok3At - tok2At < SLEEP
            && window.__waitingForGameForTest() === tok3 && !/还在等游戏页进到/.test(tail()),
          { tok2: !!tok2, tok3: !!tok3, 先后: tok3At - tok2At, same: window.__waitingForGameForTest() === tok3 });
        if (tok3) tok3.cancelled = true;
        await until(() => window.__waitingForGameForTest() === null, SLEEP + 1000);

        // 游戏页正在装场景（心跳 loading、sceneId 还是空的）时按 P：不许去拉游戏（原来心跳断着就当没有游戏页，
        // 又开一个游戏窗口 / 排切场景命令把玩家送回入口）；等它装好进了这个场景、applied 追上再打勾
        await idle();
        Object.assign(T, { waitMs: 4000, pollMs: 60, applyMs: 1500, applyPollMs: 60 });
        const loadingHb = { sceneId: '', bootId: 'selftest-boot', preview: 0, applied: 0, ageMs: 5, loading: true };
        net.heartbeat = loadingHb;
        net.job = { pushed: true, rev: 21, inScene: false, pageAlive: true, pageBusy: true, game: { ...loadingHb } };
        net.open = 0; net.notify = 0;
        tail = logFrom();
        el('push').click();
        await until(() => /游戏页正在装场景/.test(tail()), 4000);
        await wait(300);
        const openedWhileLoading = net.open;
        net.heartbeat = { sceneId: sid, bootId: 'selftest-boot', preview: 21, applied: 21, ageMs: 5, loading: false };
        await until(() => /✔ 游戏里已换上（第 21 次）/.test(tail()), 4000);
        ok('S15 🔴 游戏页正在装场景时推送：不拉第二个游戏 / 不排切场景命令，等它装好进了这个场景才打勾',
          openedWhileLoading === 0 && net.open === 0 && /✔ 游戏里已换上（第 21 次）/.test(tail()) && window.__waitingForGameForTest() === null,
          { open: net.open, tail: tail().slice(-160) });
        // 装好落在别的场景：说一句进来就是这份，不打勾、不拉游戏
        await idle();
        net.heartbeat = loadingHb;
        net.job = { pushed: true, rev: 22, inScene: false, pageAlive: true, pageBusy: true, game: { ...loadingHb } };
        tail = logFrom();
        el('push').click();
        await until(() => /游戏页正在装场景/.test(tail()), 4000);
        net.heartbeat = { sceneId: 'selftest_其它场景', bootId: 'selftest-boot', preview: 0, applied: 0, ageMs: 5, loading: false };
        await until(() => /在「selftest_其它场景」/.test(tail()), 4000);
        ok('S15 游戏页装好落在别的场景：说进来就是这份，不打勾、不拉游戏',
          /在「selftest_其它场景」/.test(tail()) && !/✔ 游戏里已换上/.test(tail()) && net.open === 0, { tail: tail().slice(-120) });
        net.heartbeat = null;
      } finally {
        window.fetch = realFetch;
        if (T && keepT) Object.assign(T, keepT);
        S().needsExport = keepFlags.needsExport;
        S().previewNewer = keepFlags.previewNewer;
        if (S().layers) S().layers.hasWind = keepFlags.hasWind;
        S().ov = keepOv;
        S().ovDirty = false;
        S().undo = []; S().redo = [];
      }
    }

    // ---- S16 第四轮复核（2026-09-14）：滚轮缩放后锚点圈 / 笔刷圈跟着变、整体摆里右键拖照常擦、锚点右键落空要说、
    //      丢弃没保存的改动时撤掉推过的预览（撤预览走桩：真服务上它会删本机预览、通知游戏） ----
    {
      clearAll();
      S().dirty = false;
      S().undo = []; S().redo = [];
      for (const mm of document.querySelectorAll('.modal')) mm.remove();
      const stage = el('stage');
      const [nw, nh] = S().native;
      const keepOv = JSON.parse(JSON.stringify(S().ov));
      const keepShow = { ...S().show };
      const setRange = (id, v) => { el(id).value = String(v); el(id).dispatchEvent(new Event('input')); };
      const logFrom = () => { const at = el('log').textContent.length; return () => el('log').textContent.slice(at); };
      const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await wait(25); return !!cond(); };
      try {
        // 滚轮缩放：笔刷圈立刻按新缩放变；[ / ] 悬停着按也立刻变（原来都要等鼠标动一下）
        el('fit').click();
        setRange('size', 40);
        const c0 = toClient(nw / 2, nh / 2);
        stage.dispatchEvent(new PointerEvent('pointermove', { clientX: c0[0], clientY: c0[1], pointerId: 1601, bubbles: true, buttons: 0 }));
        for (let i = 0; i < 4; i++) {
          stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: c0[0], clientY: c0[1], bubbles: true, cancelable: true }));
        }
        const curW = () => parseFloat(el('cursor').style.width);
        const afterWheel = curW(), wantWheel = 40 * S().view.k;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
        const afterKey = curW(), wantKey = Number(el('size').value) * S().view.k;
        ok('S16 🔴 滚轮缩放 / 按 ] 之后笔刷圈立刻是新尺寸（原来要等鼠标动一下）',
          Math.abs(afterWheel - wantWheel) < 0.01 && Number(el('size').value) > 40 && Math.abs(afterKey - wantKey) < 0.01,
          { afterWheel, wantWheel, afterKey, wantKey });
        setRange('size', 40);

        // 锚点圈：只开锚点这一层，量十字横线往右伸多远（原画像素 ≈ 1.6×9/k）；缩放后滚轮停下 ~100 ms 整张重画
        for (const k of Object.keys(S().show)) S().show[k] = false;
        S().hover = 0;
        el('fit').click();
        const ax = Math.round(nw / 2), ay = Math.round(nh / 2);
        S().ov = { anchors: [[ax, ay]], coherent: [] };
        window.__draw();
        const oc = el('ov').getContext('2d');
        const reach = () => {
          const row = oc.getImageData(ax, ay, Math.min(nw - ax, 200), 1).data;
          let far = 0;
          for (let i = 0; i * 4 < row.length; i++) if (row[i * 4 + 3] > 0) far = i;
          return far;
        };
        const kFit = S().view.k, r0 = reach();
        const cz = toClient(ax, ay);
        for (let i = 0; i < 8; i++) {
          stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: cz[0], clientY: cz[1], bubbles: true, cancelable: true }));
        }
        const kIn = S().view.k, rStale = reach();
        await wait(250);
        const r1 = reach();
        ok('S16 🔴 滚轮放大后锚点圈按新缩放重画（滚轮停下再画；原来圈跟着胀大、盖住要看的竿底）',
          kIn > kFit * 2 && Math.abs(r0 - rStale) <= 1 && Math.abs(r1 - (1.6 * 9) / kIn) <= 2 && r1 < r0 * 0.7,
          { kFit, kIn, r0, rStale, r1, want: (1.6 * 9) / kIn });
        S().ov = { anchors: [], coherent: [] };
        Object.assign(S().show, keepShow);
        el('fit').click();

        // 整体摆工具里右键拖 = 擦当前层（原来把光标下那株的整体摆翻了、一个像素没擦）
        // 落在一株上（原来这一下会把这株标成整体摆）；找不到株就随便一处
        let plant = [500, 400];
        const m = S().idMap;
        if (m) {
          outer: for (let iy = m.h >> 1; iy < m.h; iy += 4) {
            for (let ix = 0; ix < m.w; ix += 4) {
              const o = (iy * m.w + ix) * 4;
              const px0 = ((ix + 0.5) / m.w) * nw;
              if (m.data[o] + 256 * m.data[o + 1] > 0 && px0 > 200 && px0 < nw - 200) { plant = [px0, ((iy + 0.5) / m.h) * nh]; break outer; }
            }
          }
        }
        el('t-rigid').click();
        drag(plant[0] - 150, plant[1], plant[0] + 150, plant[1]);
        const painted = px('rigid');
        el('t-coherent').click();
        const tail = logFrom();
        drag(plant[0] - 150, plant[1], plant[0] + 150, plant[1], 2);
        const left = px('rigid');
        ok('S16 🔴 整体摆工具里右键拖照常擦当前层，不动整体摆',
          painted > 3000 && left < painted * 0.05 && S().ov.coherent.length === 0 && !/整体摆/.test(tail()),
          { painted, left, coherent: S().ov.coherent.length, tail: tail().slice(-80) });
        // 锚点工具里右键落空：日志说一句（原来一声不响）
        el('t-anchor').click();
        const tail2 = logFrom();
        const c1 = toClient(nw / 2, nh / 2);
        stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: c1[0], clientY: c1[1], pointerId: 1602, bubbles: true, button: 2, buttons: 2 }));
        stage.dispatchEvent(new PointerEvent('pointerup', { clientX: c1[0], clientY: c1[1], pointerId: 1602, bubbles: true }));
        ok('S16 锚点工具里右键附近没有锚点：日志说清楚（锚点工具里右键是删锚点）', /附近 30 像素内没有锚点/.test(tail2()), { tail: tail2() });
        el('t-anchor').click();
        clearAll();
        S().undo = []; S().redo = [];
        S().dirty = false;
      } finally {
        S().ov = keepOv;
        S().ovDirty = false;
        Object.assign(S().show, keepShow);
      }

      // 丢弃没保存的改动：推过预览的场景要去撤（桩），没推过的不去问
      const link = window.__gameLinkForTest;
      const store = window.__draftStoreForTest;
      const realRevoke = link.revoke, realClear = store.clear, realGet = store.get;
      const revoked = [];
      link.revoke = (sid) => { revoked.push(sid); return Promise.resolve({ ok: true, revoked: true }); };
      store.clear = () => Promise.resolve({ ok: true });
      store.get = async () => null;
      try {
        const home = S().scene;
        S().hasPreview = true;
        S().buf.rigid.fillStyle = '#fff'; S().buf.rigid.fillRect(50, 50, 20, 20);
        S().dirty = true; S().chDirty = { rigid: true };
        const tail = logFrom();
        const pOpen = window.__openSceneForTest(home);
        for (let i = 0; i < 40 && !document.querySelector('.modal'); i++) await wait(25);
        const disc = document.querySelector('.modal [data-choice=discard]');
        if (disc) disc.click();
        await Promise.race([pOpen, wait(15000)]);
        ok('S16 🔴 推过预览后重装选「不保存」：去撤预览，日志说游戏换回资源那份',
          revoked.length === 1 && revoked[0] === home && /刚推的预览没保存，已撤掉/.test(tail()), { revoked, tail: tail().slice(-120) });
        // 没推过预览：不去问服务端
        revoked.length = 0;
        S().hasPreview = false;
        S().dirty = true;
        await window.__onDiscardUnsaved();
        const noAsk = revoked.length === 0;
        S().hasPreview = true;
        await window.__onDiscardUnsaved();
        ok('S16 关窗选「不保存」：推过预览才去撤，没推过不问', noAsk && revoked.length === 1, { noAsk, revoked });
        // 第七轮复核：资源里还没有这个场景能装的草木层（从没导出过）——游戏没东西可换回，不许说"游戏换回资源里这份"
        link.revoke = (sid) => { revoked.push(sid); return Promise.resolve({ ok: true, revoked: true, hasExport: false }); };
        S().hasPreview = true;
        const tail2 = logFrom();
        await window.__onDiscardUnsaved();
        ok('S16 资源里还没有这一层时撤预览：说清游戏里要出场再进才拿掉，不说换回了资源那份',
          /资源里还没有这个场景的草木层/.test(tail2()) && !/游戏换回资源里这份/.test(tail2()), { tail: tail2().slice(-120) });
      } finally {
        link.revoke = realRevoke; store.clear = realClear; store.get = realGet;
        for (const mm of document.querySelectorAll('.modal')) mm.remove();
        // __onDiscardUnsaved 停了定时草稿、压着草稿写入：放回去（它本来是窗口马上要关时才调的）
        S().draftSuppress = null;
        clearInterval(S().draftTimer);
        S().draftTimer = setInterval(window.__saveDraftForTest, 8000);
        S().hasPreview = false;
        clearAll();
        S().dirty = false;
      }
    }

    clearAll();
    S().dirty = false;
  } catch (e) {
    log.push('EXC ' + String((e && e.stack) || e));
  }
  window.__selftestResult = log.join('\n');
  return window.__selftestResult;
})();
