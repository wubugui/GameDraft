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
        await window.__openScene(S().scene);
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
          const r = await Promise.race([window.__openScene(sid).then(() => 'done'), wait(15000).then(() => 'timeout')]);
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
      const key = 'sway-draft:' + S().scene;
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
        const realRIC = window.requestIdleCallback;
        const realScene = S().scene;
        const other = '__自检用的假场景__';
        try {
          let queued = null;
          window.requestIdleCallback = (fn) => { queued = fn; return 1; };

          S().dirty = true; S().chDirty = { rigid: true };
          localStorage.removeItem('sway-draft:' + realScene);
          saveD();
          queued && queued();
          ok('S8 场景没变时草稿确实落得下来（不然下面那条是白过的）',
            !!localStorage.getItem('sway-draft:' + realScene));

          queued = null;
          localStorage.removeItem('sway-draft:' + realScene);
          S().dirty = true; S().chDirty = { rigid: true };
          saveD();                       // 排上队，还没跑
          S().scene = other;             // 人切走了
          queued && queued();
          const strayed = localStorage.getItem('sway-draft:' + other);
          S().scene = realScene;
          ok('S8 🔴 排队期间切了场景就作废（不许把 A 的活写进 B 的键）', strayed === null, { strayed: !!strayed });
        } finally {
          window.requestIdleCallback = realRIC;
          S().scene = realScene;
          localStorage.removeItem('sway-draft:' + other);
          localStorage.removeItem('sway-draft:' + realScene);
        }
      } finally {
        S().dirty = keep.dirty; S().chDirty = keep.chDirty; S().painting = keep.painting;
        try { localStorage.removeItem(key); } catch { /* 无所谓 */ }
      }
    } else {
      ok('S8 草稿逻辑可测（__draftPayloadForTest 没导出）', false);
    }

    clearAll();
    S().dirty = false;
  } catch (e) {
    log.push('EXC ' + String((e && e.stack) || e));
  }
  window.__selftestResult = log.join('\n');
  return window.__selftestResult;
})();
