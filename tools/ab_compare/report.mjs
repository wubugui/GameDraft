import { isFailFlag } from './compare.mjs';

/**
 * 生成 report.html:单文件、无外部依赖(样式 / 脚本内联;图片按相对路径引用同目录下的 img/,
 * 加 --embed-images 时缩略图直接内嵌成 data URI,单文件就能看)。按分歧程度排序。
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(v >= 10 ? 1 : v >= 1 ? 2 : 3)}%`);

function pxCell(p) {
  if (!p) return '<td>—</td>';
  return `<td title="变化像素 ${pct(p.changedPct)} · 最大通道差 ${p.max} · 均差 ${p.mean} · 超阈值像素里可由 ±1 行位移解释的 ${p.rowShiftPct}%">${pct(p.badPct)}<small> / ${p.max}</small></td>`;
}

function imgBlock(images) {
  const one = (tag, label) => {
    if (!images[tag]) return '';
    const src = images[`${tag}Embed`] ?? images[tag];
    return `<figure><figcaption>${esc(label)} <a href="${esc(images[tag])}" target="_blank">原图</a></figcaption>`
      + `<a href="${esc(images[tag])}" target="_blank"><img loading="lazy" src="${esc(src)}" alt="${esc(label)}"></a></figure>`;
  };
  return one('A1-B1', '整页 A1 | B1 | 差异热图(红→黄 = 超阈值,蓝 = 阈值内)')
    + one('same', '整页 A1(与 B1 逐像素相同)')
    + one('A1-B1__canvas', '画布层(DOM 覆盖层全隐藏)A1 | B1 | 热图')
    + one('A1-A2', 'A/A 噪声(整页):A1 | A2 | 热图')
    + one('B1-B2', 'B/B 噪声(整页):B1 | B2 | 热图')
    + one('A1-A2__canvas', 'A/A 噪声(画布层)')
    + one('B1-B2__canvas', 'B/B 噪声(画布层)');
}

function checkpointRows(sc, opts) {
  return sc.checkpoints.map((c) => {
    const bad = c.flags.some((f) => isFailFlag(f, opts));
    const detail = [
      c.state.diffs.length
        ? `<div class="sub"><b>状态分歧</b>(A/A、B/B 里抖动的路径已剔除,共 ${c.state.divergent} 条)<table class="kv"><tr><th>路径</th><th>A1</th><th>B1</th></tr>${
          c.state.diffs.map((d) => `<tr><td><code>${esc(d.path)}</code></td><td><code>${esc(d.A)}</code></td><td><code>${esc(d.B)}</code></td></tr>`).join('')}</table></div>`
        : '',
      c.state.noisyList?.length ? `<div class="sub muted">A/A 或 B/B 自己就抖的状态路径(已排除在分歧之外):${c.state.noisyList.map((p) => `<code>${esc(p)}</code>`).join(' ')}</div>` : '',
      c.newErrors.length ? `<div class="sub"><b>本检查点 B 新增报错</b><ul>${c.newErrors.map((e) => `<li><code>${esc(e.slice(0, 600))}</code></li>`).join('')}</ul></div>` : '',
      c.ops.differ ? `<div class="sub"><b>命令兑现状态不同</b> A:<code>${esc(JSON.stringify(c.ops.A))}</code> B:<code>${esc(JSON.stringify(c.ops.B))}</code></div>` : '',
      `<div class="sub muted">A:场景 ${esc(c.summary.A?.scene)} 玩家 ${esc(JSON.stringify(c.summary.A?.player))}${c.summary.A?.dialogue ? ` 对白「${esc(c.summary.A.dialogue)}」` : ''}<br>`
        + `B:场景 ${esc(c.summary.B?.scene)} 玩家 ${esc(JSON.stringify(c.summary.B?.player))}${c.summary.B?.dialogue ? ` 对白「${esc(c.summary.B.dialogue)}」` : ''}</div>`,
      `<div class="imgs">${imgBlock(c.images)}</div>`,
    ].join('');
    return `<tr class="${bad ? 'bad' : ''}"><td>${esc(c.name)}<small> @${c.tick ?? '—'}</small></td>`
      + `<td>${bad ? c.flags.map((f) => `<span class="tag">${esc(f)}</span>`).join(' ') : '<span class="ok">一致</span>'}</td>`
      + `<td><b>${pct(c.px.ab)}</b></td><td><b>${pct(c.pxCanvas.ab)}</b></td>${pxCell(c.px.ab1)}${pxCell(c.px.aa)}${pxCell(c.px.bb)}${pxCell(c.pxCanvas.aa)}${pxCell(c.pxCanvas.bb)}`
      + `<td>${pct(c.px.floorPct)}<small> / ${pct(c.pxCanvas.floorPct)}</small></td>`
      + `<td>${c.state.divergent}<small> / 噪 ${c.state.noisyPaths}</small></td><td>${c.newErrors.length}</td>`
      + `<td><details><summary>展开</summary>${detail}</details></td></tr>`;
  }).join('');
}

function scenarioBlock(sc, opts) {
  const boot = (arr) => arr.map((b) => (b ? (b.ok ? `✓ ${(b.ms / 1000).toFixed(1)}s` : `✗ ${esc(b.reason ?? '')}`) : '—')).join(' / ');
  const steps = (arr) => arr.map((s) => `<li><code>${esc(s.desc)}</code> @${s.atTick} → ${esc(s.final ?? s.immediate)}${s.result ? ` <small>${esc(String(s.result).slice(0, 160))}</small>` : ''}</li>`).join('');
  const errs = sc.errors;
  return `<details class="sc" data-bad="${sc.diverged || sc.inconclusive ? 1 : 0}" data-kind="${esc(sc.kind)}" data-name="${esc(sc.id)}" ${sc.diverged ? 'open' : ''}>
<summary><span class="kind">${esc(sc.kind)}</span> <b>${esc(sc.name)}</b> ${sc.flags.map((f) => `<span class="tag">${esc(f)}</span>`).join(' ')}${sc.inconclusive ? ` <span class="tag">${esc(sc.inconclusive)}</span>` : sc.diverged ? '' : ' <span class="ok">一致</span>'} <small class="muted">分 ${sc.score}</small></summary>
<div class="meta">
<div>启动 A:${boot(sc.boot.A)} · B:${boot(sc.boot.B)}</div>
${sc.fatal.A.some(Boolean) || sc.fatal.B.some(Boolean) ? `<div class="warn">中断 A:${esc(sc.fatal.A.join(' / '))} · B:${esc(sc.fatal.B.join(' / '))}</div>` : ''}
${sc.unsupported.A.length || sc.unsupported.B.length ? `<div class="warn">unsupported A:${esc(sc.unsupported.A.join(';') || '无')} · B:${esc(sc.unsupported.B.join(';') || '无')}</div>` : ''}
<div>缺素材类报错(不计):A ${errs.asset.A.join('/')} · B ${errs.asset.B.join('/')}</div>
${errs.assetOnlyB?.length || errs.assetOnlyA?.length ? `<details class="sub"><summary>两边缺的素材不完全一样(B 独有 ${errs.assetOnlyB.length} · A 独有 ${errs.assetOnlyA.length};不计入判定,但说明两边请求的文件不同)</summary><div class="cols"><div><b>只在 B</b><ul>${errs.assetOnlyB.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul></div><div><b>只在 A</b><ul>${errs.assetOnlyA.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul></div></div></details>` : ''}
${errs.newStable.length ? `<div class="sub"><b>B 新增报错(每轮 B 都有、任何一轮 A 都没有)</b><ul>${errs.newStable.map((e) => `<li><code>${esc(e.slice(0, 800))}</code></li>`).join('')}</ul></div>` : ''}
${errs.newFlaky.length ? `<div class="sub"><b>B 偶发新报错(部分 B 轮)</b><ul>${errs.newFlaky.map((e) => `<li><code>${esc(e.slice(0, 800))}</code></li>`).join('')}</ul></div>` : ''}
${errs.gone.length ? `<div class="sub muted"><b>A 有而 B 没有的报错</b><ul>${errs.gone.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul></div>` : ''}
${errs.newWarnings.length ? `<details class="sub"><summary>B 新增告警 ${errs.newWarnings.length} 条(不计入判定)</summary><ul>${errs.newWarnings.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul></details>` : ''}
${sc.steps.A.length ? `<details class="sub"><summary>输入步骤与兑现状态</summary><div class="cols"><div><b>A1</b><ul>${steps(sc.steps.A)}</ul></div><div><b>B1</b><ul>${steps(sc.steps.B)}</ul></div></div></details>` : ''}
</div>
<div class="tw"><table class="cp"><thead><tr><th>检查点</th><th>结论</th><th>整页 A/B</th><th>画布 A/B</th><th>整页 A1↔B1<small> / 最大差</small></th><th>整页 A/A</th><th>整页 B/B</th><th>画布 A/A</th><th>画布 B/B</th><th>判定线<small> 整页 / 画布</small></th><th>状态分歧</th><th>新报错</th><th></th></tr></thead>
<tbody>${checkpointRows(sc, opts)}</tbody></table></div>
</details>`;
}

function perfBlock(perf) {
  if (!perf) return '';
  const scenes = [...new Set(perf.flatMap((p) => p.scenes.map((s) => s.scene)))];
  const cell = (side, scene) => {
    const rows = perf.filter((p) => p.side === side).map((p) => p.scenes.find((s) => s.scene === scene)).filter(Boolean);
    return rows.map((r) => (r.ok ? `${r.frames} 帧 · 均 ${r.meanMs.toFixed(2)} ms · p95 ${r.p95Ms?.toFixed(2)} ms` : `✗ ${esc(r.reason)}`)).join('<br>') || '—';
  };
  const heap = (side) => perf.filter((p) => p.side === side).map((p) => p.heap.map((h) => (h.usedMB === undefined ? '—' : `${h.round}:${h.usedMB.toFixed(1)}`)).join(' → ')).join('<br>');
  return `<section><h2>性能(真实时间,不控时钟;仅供参考)</h2><div class="tw"><table class="cp"><thead><tr><th>场景</th><th>A</th><th>B</th></tr></thead><tbody>
${scenes.map((s) => `<tr><td>${esc(s)}</td><td>${cell('A', s)}</td><td>${cell('B', s)}</td></tr>`).join('')}
<tr><td>JS 堆(MB,轮次:用量;每轮把上列场景轮切一遍后 gc 再读)</td><td>${heap('A')}</td><td>${heap('B')}</td></tr>
</tbody></table></div>${perf.flatMap((p) => p.errors.map((e) => `<div class="warn">${esc(p.side)}:${esc(e)}</div>`)).join('')}</section>`;
}

export function renderReport(summary) {
  const m = summary.meta;
  const scs = [...summary.scenarios].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const nBad = scs.filter((s) => s.diverged).length;
  const nInc = scs.filter((s) => s.inconclusive).length;
  const iso = m.isolation;
  const isoLines = [
    ...['A', 'B'].map((k) => `${k}:树 ${esc(iso[k].dir)} · 已跟踪文件改动 ${iso[k].trackedChanges.length ? `<b class="bad">${esc(iso[k].trackedChanges.join(' | '))}</b>` : '无'}`
      + ` · 预构建依赖 ${iso[k].viteDeps.checked ? `${iso[k].viteDeps.entries} 项${iso[k].viteDeps.problems.length ? ` <b class="bad">${esc(iso[k].viteDeps.problems.join(' | '))}</b>` : ' 全在树内'}` : '未生成'}`
      + ` · /@fs 越界请求 ${iso[k].fsViolations.length ? `<b class="bad">${esc(iso[k].fsViolations.slice(0, 8).join(' | '))}</b>` : '无'}`),
  ];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A/B 真游戏对照</title>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1a;--muted:#6b6b66;--card:#fff;--line:#e3e2dd;--bad:#b3261e;--badbg:#fdecea;--ok:#1b6e3a;--warn:#8a5a00;--warnbg:#fff4dc;--tag:#b3261e;--code:#f0efe9}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#e8e6e1;--muted:#9a978f;--card:#1f1f1d;--line:#34332f;--bad:#ff8a80;--badbg:#3a1d1b;--ok:#7bd89b;--warn:#f0c060;--warnbg:#3a2f14;--tag:#ff8a80;--code:#2a2a27}}
:root[data-theme="dark"]{--bg:#161615;--fg:#e8e6e1;--muted:#9a978f;--card:#1f1f1d;--line:#34332f;--bad:#ff8a80;--badbg:#3a1d1b;--ok:#7bd89b;--warn:#f0c060;--warnbg:#3a2f14;--tag:#ff8a80;--code:#2a2a27}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:1400px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:24px 0 8px}
.muted,small{color:var(--muted)}code{background:var(--code);padding:0 4px;border-radius:4px;font-size:12px;word-break:break-all}
.banner{padding:10px 14px;border-radius:8px;margin:10px 0;border:1px solid var(--line);background:var(--card)}
.banner.bad{background:var(--badbg);border-color:var(--bad)}.banner.warn{background:var(--warnbg);border-color:var(--warn)}
.warn{color:var(--warn)}.bad{color:var(--bad)}.ok{color:var(--ok)}
.tag{display:inline-block;font-size:12px;padding:0 6px;border-radius:10px;border:1px solid var(--tag);color:var(--tag)}
.kind{display:inline-block;font-size:12px;padding:0 6px;border-radius:4px;background:var(--code)}
.sc{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:6px 12px}
.sc>summary{cursor:pointer;padding:4px 0}.meta{margin:6px 0 10px}.sub{margin:6px 0}
.tw{overflow-x:auto}table.cp{border-collapse:collapse;width:100%;font-size:13px}table.cp th,table.cp td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
tr.bad>td:first-child{border-left:3px solid var(--bad)}table.kv{border-collapse:collapse;margin-top:4px}table.kv td,table.kv th{border:1px solid var(--line);padding:2px 6px;font-size:12px;text-align:left}
.imgs{display:flex;flex-direction:column;gap:10px;margin-top:8px}figure{margin:0}figure img{max-width:100%;height:auto;border:1px solid var(--line);display:block}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:700px){.cols{grid-template-columns:1fr}}
.controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:10px 0}input[type=search]{padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);min-width:200px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
</style></head><body><main>
<h1>A/B 真游戏对照</h1>
<dl>
<dt>A</dt><dd>${esc(m.A.ref)} @ <code>${esc(m.A.sha)}</code></dd>
<dt>B</dt><dd>${esc(m.B.ref)} @ <code>${esc(m.B.sha)}</code></dd>
<dt>时间</dt><dd>${esc(m.startedAt)} → ${esc(m.finishedAt)}</dd>
<dt>控制</dt><dd>视口 ${m.opts.viewport.width}×${m.opts.viewport.height} @${m.opts.dpr} · 假时钟纪元 ${esc(new Date(m.opts.epoch).toISOString())} · 暂停于 +${m.opts.pauseOffset} ms · 种子 ${m.opts.seed} · 冻结时机 ${esc(m.opts.freezeAt)} · 每步 ${m.opts.chunk} 帧 · 轮数 ${m.opts.repeats} · 阈值 单通道>${m.opts.threshold} · 判定线 = 噪声×${m.opts.noiseFactor}+${m.opts.margin} 个百分点${m.opts.ignoreRowShift ? ' · 「≥95% 可由 ±1 行位移解释」的像素差不判失败' : ''}</dd>
<dt>浏览器</dt><dd>${esc(m.browser)}</dd>
</dl>
<div class="banner ${nBad ? 'bad' : ''}"><b>${nBad ? `${nBad} / ${scs.length} 个场景 B 相对 A 超出噪声底或有新报错` : nInc ? `可对照的 ${scs.length - nInc} 个场景在噪声底内一致、无新增报错` : `全部 ${scs.length} 个场景在噪声底内一致、无新增报错`}</b></div>
${m.opts.freezeAt !== 'boot' && scs.some((s) => s.flags.includes('状态分歧')) ? `<div class="banner warn">有「状态分歧」:本次冻结时机是 <code>${esc(m.opts.freezeAt)}</code>,装载期逻辑按墙钟跑,两边装载快慢不同也会留下不同状态(A/A 量不出来)。先用 <code>--freeze boot</code> 复核再下结论。</div>` : ''}
${nInc ? `<div class="banner warn"><b>${nInc} 个场景无法对照</b>(A 一轮都没起来):${scs.filter((s) => s.inconclusive).map((s) => esc(s.id)).join('、')}</div>` : ''}
${m.assets.linked ? '' : `<div class="banner warn"><b>⚠ 没有素材目录(${esc(m.assets.src)}):场景是在缺原画、缺光照数据的情况下渲染的</b>。画面对照只反映「无素材」路径;缺素材类报错两边一样,已单列不计。</div>`}
${m.mainDirty.tracked.length || m.mainDirty.untracked.length ? `<div class="banner warn">⚠ 主工作区有 ${m.mainDirty.tracked.length} 处未提交的已跟踪改动、${m.mainDirty.untracked.length} 个未跟踪文件 / 目录,它们<b>不在</b> B(${esc(m.B.sha.slice(0, 10))})里。</div>` : ''}
${m.unsupported.length ? `<div class="banner warn">以下入口在某一侧不存在,相应步骤记为 unsupported:<br>${m.unsupported.map((u) => esc(u)).join('<br>')}</div>` : ''}
<h2>独立性复核</h2><div class="banner">${isoLines.join('<br>')}</div>
<h2>噪声底(A/A、B/B)</h2><div class="banner">${summary.noise.lines.map(esc).join('<br>')}</div>
${perfBlock(summary.perf)}
<h2>场景(按分歧程度排序)</h2>
<div class="controls"><label><input type="checkbox" id="onlyBad"> 只看有差异的</label><input type="search" id="q" placeholder="按名字 / 种类过滤"></div>
<div id="list">${scs.map((sc) => scenarioBlock(sc, m.opts)).join('\n')}</div>
</main>
<script>
(() => {
  const only = document.getElementById('onlyBad');
  const q = document.getElementById('q');
  const apply = () => {
    const s = q.value.trim().toLowerCase();
    for (const el of document.querySelectorAll('.sc')) {
      const hit = !s || el.dataset.name.toLowerCase().includes(s) || el.dataset.kind.includes(s);
      el.style.display = (only.checked && el.dataset.bad !== '1') || !hit ? 'none' : '';
    }
  };
  only.addEventListener('change', apply);
  q.addEventListener('input', apply);
})();
</script>
</body></html>`;
}
