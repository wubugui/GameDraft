/* 呼吸工作台 · 交互层端到端回归(在真页面里跑;由 `sh scripts/py.sh -m tools.breathing_workbench --selftest` 注入)。
 *
 * 每条 `ok()` 一行 PASS / FAIL;异常记 EXC;跑完报告写进 window.__selftestResult(桌面壳打印、有 FAIL 退出码 1)。
 * 约定:整个进程的读写都指在临时样例工程(`/api/boot` 的 `real === false` 自证),真库一个字节不碰;
 * 游戏地址钉在 127.0.0.1:9(联动只验"软失败");页面是 module,状态从 window.__bw、函数从 window.__bwApi 取。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { try { if (fn()) return true; } catch (e) { /* 还没好 */ } await wait(50); } return false; };
  const api = async (p, b) => (await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  try {
    await until(() => window.__bw && window.__bw.ready, 20000);
    const S = window.__bw, A = window.__bwApi;
    const boot = await api('/api/boot');
    ok('S1 自检工程(不是真库)', boot.real === false, boot.project);
    ok('S2 打开样例呼吸图并加载分层与位移场', S.ready && S.id === 'sample_breath' && !!S.def, { id: S.id, err: window.__bootError });
    // 参数面板:参数表里每个参数都有滑条,值 = 盘上的值(没写的取缺省)
    const defs = [...S.rt.breathingParams.BREATHING_PARAM_DEFS.values()];
    const sliders = [...document.querySelectorAll('input[type=range][data-key]')];
    ok('S3 每个参数都有滑条', sliders.length === defs.length, { sliders: sliders.length, defs: defs.length });
    ok('S4 滑条值 = 盘上的值', Number(document.querySelector('[data-key="ti"]').value) === 2.7 && Number(document.querySelector('[data-key="lag"]').value) === 0);
    // 拖滑条:表演立刻换上、标脏、改过的值标橙
    const lag = document.querySelector('[data-key="lag"]');
    lag.value = '0.5'; lag.dispatchEvent(new Event('input', { bubbles: true }));
    ok('S5 拖滑条立刻生效', Math.abs(S.perf.p('lag') - 0.5) < 1e-9 && S.doc.params.lag === 0.5);
    ok('S6 标脏 + 改过的值标橙', A.isDirty() && lag.parentElement.querySelector('output').classList.contains('chg') && document.getElementById('bSave').classList.contains('dirty'));
    ok('S7 未保存提示接到桌面壳', window.__unsavedSummary().includes('sample_breath'));
    // 参数文本往返
    const txt = A.paramText();
    ok('S8 参数文本列出改过的', txt.includes('【改过的】纸比胸口晚 = 0.5 s'), txt.split('\n')[1]);
    const r = A.applyText('纸比胸口晚 = 0.25 s;吸气时长 = 3 s;不存在的参数 = 1');
    ok('S9 套用参数文本(认不出的报出来)', r.applied === 2 && r.unknown.includes('不存在的参数') && S.perf.p('lag') === 0.25 && S.perf.p('ti') === 3, r);
    // 同一份着色器真画出来了:纸位移 ≠ 0 的那一刻与原图不同、按住看原图时等于静止帧
    S.paused = true;
    A.draw(S.def.size[0], S.def.size[1]);
    const gl = S.gl, W = S.def.size[0], H = S.def.size[1];
    const px = () => { const b = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
    S.perf.stopNow(); for (let i = 0; i < 90; i++) A.tick(1 / 30);
    A.draw(W, H); const rest = px();
    S.perf.restart(); S.perf.setParams({ lag: 0 });
    let moved = null;
    for (let i = 0; i < 30 * 12; i++) { A.tick(1 / 30); if (Math.abs(S.perf.frame().paperMm) > 3) { A.draw(W, H); moved = px(); break; } }
    let diff = 0; if (moved) for (let i = 0; i < rest.length; i += 4) diff += Math.abs(rest[i] - moved[i]);
    ok('S10 着色器按表演把纸挪动了(读像素)', !!moved && diff > 1000, { diff });
    S.compare = true; A.draw(W, H); const cmp = px(); S.compare = false;
    let d2 = 0; for (let i = 0; i < rest.length; i += 4) d2 = Math.max(d2, Math.abs(rest[i] - cmp[i]));
    ok('S11 按住看原图 = 静止帧', d2 <= 1, { d2 });
    // 剧情时间轴(对话图里那一段原样演):逐帧推,渐弱等停住走完、猛吸、收掉
    ok('S12 用在哪:列出样例对话图', S.stories.length === 1 && S.stories[0].graph === 'sample_graph');
    A.startStory(S.stories[0], { breaths: 0, readSec: 0.5 });
    let lines = 0, prev = null, sawGasp = false;
    for (let i = 0; i < 30 * 120 && S.run && !S.run.ended; i++) {
      A.tick(1 / 30);
      const ln = S.run.line ? S.run.line.text : null;
      if (ln && ln !== prev) lines++;
      prev = ln;
      if (S.perf.frame().kind === 'gasp') sawGasp = true;
    }
    ok('S13 剧情走完:三句台词、渐弱停住、猛吸、收掉', S.run && S.run.ended && lines === 3 && sawGasp && !S.run.visible, { lines, sawGasp, ended: S.run && S.run.ended });
    A.stopStory();
    // 导出到游戏:写进临时工程、再开还是它;烘焙产物改了拒存
    const saved = await A.save();
    const disk = await api('/api/breathing/doc?id=sample_breath');
    ok('S14 导出到游戏写盘', saved && disk.doc.params.lag === 0.25 && disk.doc.params.ti === 3 && !A.isDirty(), disk.doc.params);
    const bad = JSON.parse(JSON.stringify(disk.doc)); bad.rig.pxPerMm = 7;
    const rej = await api('/api/save', { doc: bad, base: disk.doc });
    ok('S15 烘焙产物改了拒存', rej.ok === false && String(rej.err).includes('烘焙产物'), rej.err);
    // 推给游戏:游戏没开 → 软失败
    const pub = await A.publish('show');
    const st = await api('/api/link/status');
    ok('S16 推给游戏在游戏没开时软失败', st.connected === false, st.err);
    // 出片:一口循环
    const fin = await A.renderLoop();
    ok('S17 出一口循环 GIF', fin && fin.frames > 50 && fin.files.some((f) => f.endsWith('.gif')), fin && fin.files);
  } catch (e) {
    log.push('EXC ' + (e && e.stack || e));
  }
  window.__selftestResult = log.join('\n');
})();
