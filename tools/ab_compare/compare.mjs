/**
 * 对比:逐检查点的像素差、状态探针差、新报错,全部相对 A/A、B/B 噪声底判定。
 *
 * 每个场景跑 A1、B1、A2、B2(--repeats 2,缺省)。
 * - 像素:A/B 差 = min(A1↔B1, A2↔B2)(两轮都差才算差);噪声底 = max(A1↔A2, B1↔B2)。
 *   判「超噪声」:A/B 差 > 噪声底 × --noise-factor + --margin(百分点)。
 * - 状态:把探针拍平成 路径→值;A/B 差异路径 = (A1↔B1 ∩ A2↔B2) − (A1↔A2 ∪ B1↔B2)。
 * - 报错:非素材类的 error / pageerror / 失败请求,按归一化文本比;B 出现而**任何一轮 A 都没有**的记「新增」,
 *   只在部分 B 轮出现的另标「偶发」。缺素材类(图 / 音频 404、解码失败)单独计数,不参与判定。
 * --repeats 1 时没有噪声底:噪声记 0,A/B 直接对阈值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, diffImages, downscaleRgb, encodePngRgb, triptych } from './png.mjs';

/** 探针拍平:路径 → 叶子值(数组下标也进路径) */
export function flatten(v, prefix = '', out = new Map()) {
  if (v === null || typeof v !== 'object') {
    out.set(prefix || '(root)', v);
    return out;
  }
  const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
  if (keys.length === 0) out.set(prefix || '(root)', Array.isArray(v) ? '[]' : '{}');
  for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : String(k), out);
  return out;
}

function sameVal(a, b, eps) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps;
  return a === b;
}

export function diffPaths(fa, fb, eps = 1e-3) {
  const out = new Set();
  if (!fa || !fb) return out;
  for (const [k, v] of fa) if (!fb.has(k) || !sameVal(v, fb.get(k), eps)) out.add(k);
  for (const k of fb.keys()) if (!fa.has(k)) out.add(k);
  return out;
}

/** 只提示、不判失败的标记 */
export const INFO_FLAG = '偶发新报错';
export const INFO_BOOT_FLAKY = '启动不稳定(部分轮没就绪)';
export const ROW_SHIFT_NOTE = '≥95% 可由 ±1 行位移解释';
/** --freeze pump:同一侧两轮的装载帧数就不一样 = 泵没兜住某个真异步(工具的确定性问题,不是 B 的回归;只提示、大声报) */
export const INFO_PUMP_JITTER = '装载帧数抖动(泵不确定)';
/** --freeze pump:每侧两轮各自一致、但 A、B 装载帧数不同 = 两边装载等的定时器 / rAF 个数不同(真差异,判失败) */
export const PUMP_AB_FLAG = '装载帧数 A≠B';
/**
 * 两边都是墙钟毫秒时间戳(Date.now,≥1e12)且差不到一帧的状态路径:只提示、不判状态分歧。
 * 来源是装载期事件的亚帧时刻——master 揭幕闸的着色器预热 wait(0) 接力每跳推假时钟 1 ms,叙事跳转在装载期推的迁移
 * 留痕(narrativeState.recentTrace[*].at)A 晚 3 ms;同步点对齐之后的时间轴两边严格相同,这类差只在装载期留下的时间戳上。
 */
export const INFO_SUBFRAME_TS = '亚帧时间戳差(装载期,不计)';
const SUBFRAME_MS = 1000 / 60;
/**
 * 某一轮页面实际看到的 DPR / 视口不是设定值(driver.mjs 的环境守卫记在 run.envDrift):宿主显示缩放漏进来了,
 * 这一轮整幅截图亚像素错位、点阵字排版变,像素比较不可信。只提示(是环境问题,不是 B 的回归),run.mjs 大声报。
 */
export const INFO_ENV_DRIFT = '页面度量偏离设定(环境漂移,像素不可信)';

/** 这个标记算不算失败:偶发新报错永远不算;「≥95% 可由行位移解释」的像素差在 --ignore-row-shift 下不算 */
export const isFailFlag = (f, opts) => f !== INFO_FLAG && f !== INFO_BOOT_FLAKY && f !== INFO_PUMP_JITTER && f !== INFO_SUBFRAME_TS && f !== INFO_ENV_DRIFT && !(opts?.ignoreRowShift && f.includes(ROW_SHIFT_NOTE));

/**
 * --freeze pump 的装载帧数对比(各轮 frames/ticks)。没有泵记录(别的冻结模式)⇒ null。
 * @returns {{A: (string|null)[], B: (string|null)[], same: boolean, aaSame: boolean, bbSame: boolean} | null}  各轮 "帧/tick"(没起来的轮 null)
 */
export function pumpBootCounts(runs) {
  const key = (r) => (r?.boot?.pump && r.boot.ok ? `${r.boot.pump.frames}/${r.boot.pump.ticks}` : null);
  const A = runs.A.map(key);
  const B = runs.B.map(key);
  if (![...A, ...B].some(Boolean)) return null;
  const uniq = (xs) => new Set(xs.filter(Boolean));
  const aaSame = uniq(A).size <= 1;
  const bbSame = uniq(B).size <= 1;
  const all = uniq([...A, ...B]);
  return { A, B, same: all.size <= 1, aaSame, bbSame };
}

/** 启动期输入必须逐帧同序;不同输入得到同样终态也不能冒充同输入 A/B。旧记录/无启动输入不改变判定。 */
export function pumpBootInputs(runs) {
  if (![...runs.A, ...runs.B].some((r) => r?.boot?.pump?.inputs?.length)) return null;
  const key = (r) => r?.boot?.ok ? JSON.stringify((r.boot.pump?.inputs ?? []).map((i) => ({
    frame: i.frame, scene: i.sceneId, kind: i.kind, name: i.name, args: i.args, cmd: i.cmd,
  }))) : null;
  const A = runs.A.map(key);
  const B = runs.B.map(key);
  return { A, B, same: new Set([...A, ...B].filter((v) => v !== null)).size <= 1 };
}

const isErr = (it) => !it.asset && (it.type === 'error' || it.type === 'pageerror' || it.type === 'requestfailed' || it.type === 'http');
const isWarn = (it) => !it.asset && it.type === 'warning';

/** 一轮运行里全部报错条目(启动期的挂在第一个检查点里,收尾的在 tailItems) */
function allItems(run) {
  if (!run) return [];
  return [...run.checkpoints.flatMap((c) => c.items), ...run.tailItems];
}

const loadImg = (cp, key = 'file') => {
  const f = cp?.[key];
  if (!f || !fs.existsSync(f)) return null;
  try {
    return decodePng(fs.readFileSync(f));
  } catch {
    return null;
  }
};

const rgbaToRgb = (img) => {
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    out[i] = img.data[j]; out[i + 1] = img.data[j + 1]; out[i + 2] = img.data[j + 2];
  }
  return { width: img.width, height: img.height, data: out };
};

function pxStat(d) {
  return d ? {
    badPct: +d.badPct.toFixed(4), changedPct: +d.changedPct.toFixed(4), max: d.max, mean: +d.mean.toFixed(3),
    rowShiftPct: +d.rowShiftPct.toFixed(2), sameSize: d.sameSize, bbox: d.bbox,
  } : null;
}

/**
 * 超出噪声底的像素差是否几乎全部(≥ 95%)可由 ±1 行位移解释(两轮 A/B 都如此)。
 * 不要求 100%:半像素水平边落在圆角 / 抗锯齿边上时,角上那几个像素移一行也对不齐(实测 dev_room 的 HUD 键帽约 1.6%)。
 */
const rowShiftOnly = (d1, d2) => !!d1 && d1.badPixels > 0 && d1.rowShiftPct >= 95 && (!d2 || d2.badPixels === 0 || d2.rowShiftPct >= 95);

function showVal(v) {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/**
 * @param {object} o
 * @param {object} o.scenario
 * @param {{A:object[],B:object[]}} o.runs    每侧按轮次排好的运行记录
 * @param {string} o.imgDir                   该场景的出图目录(相对 outDir 的路径写进结果)
 * @param {string} o.outDir
 * @param {object} o.opts                     threshold / noiseFactor / margin / embed
 */
export function compareScenario({ scenario, runs, imgDir, outDir, opts }) {
  fs.mkdirSync(imgDir, { recursive: true });
  const [A1, A2] = runs.A;
  const [B1, B2] = runs.B;
  const twoRounds = !!(A2 && B2);
  const rel = (p) => path.relative(outDir, p).split(path.sep).join('/');

  // 场景级报错集合(按归一化文本)
  const errSet = (run) => new Set(allItems(run).filter(isErr).map((i) => i.norm));
  const warnSet = (run) => new Set(allItems(run).filter(isWarn).map((i) => i.norm));
  const aErr = new Set([...errSet(A1), ...errSet(A2)]);
  const aWarn = new Set([...warnSet(A1), ...warnSet(A2)]);
  const bRunsErr = [B1, B2].filter(Boolean).map(errSet);
  const bErrAny = new Set(bRunsErr.flatMap((s) => [...s]));
  const newErrors = [...bErrAny].filter((e) => !aErr.has(e));
  const newErrorsStable = newErrors.filter((e) => bRunsErr.every((s) => s.has(e)));
  const newErrorsFlaky = newErrors.filter((e) => !newErrorsStable.includes(e));
  const goneErrors = [...aErr].filter((e) => !bErrAny.has(e));
  const newWarnings = [...new Set([...warnSet(B1), ...warnSet(B2)])].filter((w) => !aWarn.has(w));
  const assetCount = (run) => allItems(run).filter((i) => i.asset).length;
  const assetSet = (run) => new Set(allItems(run).filter((i) => i.asset).map((i) => i.norm));
  const aAsset = new Set([...assetSet(A1), ...assetSet(A2)]);
  const bAsset = new Set([...assetSet(B1), ...assetSet(B2)]);
  const fullText = new Map();
  for (const it of [...allItems(B1), ...allItems(B2)]) if (!fullText.has(it.norm)) fullText.set(it.norm, it.text);

  const names = scenario.steps.filter((s) => 'checkpoint' in s).map((s) => s.checkpoint);
  const checkpoints = [];
  for (const [ci, name] of names.entries()) {
    const get = (r) => r?.checkpoints.find((c) => c.name === name) ?? null;
    const c = { A1: get(A1), A2: get(A2), B1: get(B1), B2: get(B2) };
    // 两层各比一遍:整页(画布 + DOM 覆盖层,判定依据)与画布层(DOM 全隐藏,只剩渲染器画的东西)
    const base = `${String(ci).padStart(2, '0')}_${name.replace(/[\\/:*?"<>|\s]+/g, '_')}`;
    const images = {};
    const layer = (key, suffix) => {
      const img = { A1: loadImg(c.A1, key), A2: loadImg(c.A2, key), B1: loadImg(c.B1, key), B2: loadImg(c.B2, key) };
      const pair = (x, y) => (img[x] && img[y] ? diffImages(img[x], img[y], opts.threshold) : null);
      const ab1 = pair('A1', 'B1');
      const ab2 = twoRounds ? pair('A2', 'B2') : null;
      const aa = twoRounds ? pair('A1', 'A2') : null;
      const bb = twoRounds ? pair('B1', 'B2') : null;
      // 交叉配对(A1↔B2、A2↔B1)也算:两边都会随机落进同一组变体时(同一份代码自己两局就不同,例如枯井一拍 A1 = B2、A2 = B1),
      // 只看同轮配对会把「落进了不同变体」误判成 A/B 差;任一配对逐像素相同,就说明 B 画得出与 A 相同的这一帧
      const abx1 = twoRounds ? pair('A1', 'B2') : null;
      const abx2 = twoRounds ? pair('A2', 'B1') : null;
      const abAll = [ab1, ab2, abx1, abx2].filter(Boolean).map((d) => d.badPct);
      const abPct = abAll.length ? Math.min(...abAll) : null;
      const noisePct = Math.max(aa?.badPct ?? 0, bb?.badPct ?? 0);
      const floorPct = noisePct * opts.noiseFactor + opts.margin;
      // 出图:A1|B1|热图(有任何像素差时);A/A、B/B 有差时各出一张,方便看噪声长什么样
      const writeTrip = (x, y, d, tag) => {
        const t = triptych(img[x], img[y], d.heat);
        const f = path.join(imgDir, `${base}${suffix}__${tag}.png`);
        fs.writeFileSync(f, encodePngRgb(t.width, t.height, t.data));
        images[`${tag}${suffix}`] = rel(f);
        if (opts.embed) {
          const small = downscaleRgb(t, t.width > 2400 ? 3 : 2);
          images[`${tag}${suffix}Embed`] = `data:image/png;base64,${encodePngRgb(small.width, small.height, small.data).toString('base64')}`;
        }
      };
      if (ab1 && ab1.changedPct > 0) writeTrip('A1', 'B1', ab1, 'A1-B1');
      else if (img.A1 && !suffix) {
        const f = path.join(imgDir, `${base}__same.png`);
        const half = downscaleRgb(rgbaToRgb(img.A1), 2);
        fs.writeFileSync(f, encodePngRgb(half.width, half.height, half.data));
        images.same = rel(f);
        if (opts.embed) images.sameEmbed = `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
      }
      if (aa && aa.changedPct > 0) writeTrip('A1', 'A2', aa, 'A1-A2');
      if (bb && bb.changedPct > 0) writeTrip('B1', 'B2', bb, 'B1-B2');
      return {
        ab: abPct === null ? null : +abPct.toFixed(4), ab1: pxStat(ab1), ab2: pxStat(ab2), abx1: pxStat(abx1), abx2: pxStat(abx2), aa: pxStat(aa), bb: pxStat(bb),
        noisePct: +noisePct.toFixed(4), floorPct: +floorPct.toFixed(4), diverged: abPct !== null && abPct > floorPct, sameSize: ab1 ? ab1.sameSize : null,
        rowShiftOnly: rowShiftOnly(ab1, ab2),
      };
    };
    const px = layer('file', '');
    const pxCanvas = layer('canvasFile', '__canvas');
    const abPct = px.ab;
    const floorPct = px.floorPct;
    const pixelDiverged = px.diverged;

    // 状态
    const f = { A1: c.A1 ? flatten(c.A1.probe) : null, A2: c.A2 ? flatten(c.A2.probe) : null, B1: c.B1 ? flatten(c.B1.probe) : null, B2: c.B2 ? flatten(c.B2.probe) : null };
    const sAA = diffPaths(f.A1, f.A2);
    const sBB = diffPaths(f.B1, f.B2);
    const sAB1 = diffPaths(f.A1, f.B1);
    const sAB2 = twoRounds ? diffPaths(f.A2, f.B2) : null;
    const noisy = new Set([...sAA, ...sBB]);
    const noisyList = [...noisy].sort().slice(0, 30);
    const subframeTs = (p) => [[f.A1, f.B1], [f.A2, f.B2]].every(([a, b]) => {
      if (!a || !b) return true;
      const x = Number(a.get(p)), y = Number(b.get(p));
      return x >= 1e12 && y >= 1e12 && Math.abs(x - y) < SUBFRAME_MS;
    });
    const stateAll = [...sAB1].filter((p) => (!sAB2 || sAB2.has(p)) && !noisy.has(p)).sort();
    const stateTs = stateAll.filter(subframeTs);
    const stateDiv = stateAll.filter((p) => !stateTs.includes(p));
    const stateDiffs = stateDiv.slice(0, 60).map((p) => ({ path: p, A: showVal(f.A1?.get(p)), B: showVal(f.B1?.get(p)) }));

    // 本检查点新出现的报错(相对整个场景里 A 的报错集合)
    const cpNew = [...new Set([...(c.B1?.items ?? []), ...(c.B2?.items ?? [])].filter(isErr).map((i) => i.norm))].filter((e) => !aErr.has(e));
    const cpNewStable = cpNew.filter((e) => newErrorsStable.includes(e));

    const missingB = (c.A1 && !c.B1) || (c.A1 && c.A1.file && !(c.B1 && c.B1.file));
    const opsOf = (cp) => Object.fromEntries(Object.entries(cp?.ops ?? {}).map(([k, v]) => [k, v.state]));
    const opsDiffer = JSON.stringify(opsOf(c.A1)) !== JSON.stringify(opsOf(c.B1));
    const flags = [];
    if (missingB) flags.push('B 缺检查点');
    const rs = (l) => (l.rowShiftOnly ? `(${ROW_SHIFT_NOTE})` : '');
    if (pixelDiverged) flags.push(`整页像素超噪声${pxCanvas.diverged ? rs(px) : '(画布层在噪声内 → 差在 DOM 覆盖层)'}`);
    if (pxCanvas.diverged) flags.push(`画布层像素超噪声${rs(pxCanvas)}`);
    if (stateDiv.length) flags.push('状态分歧');
    if (stateTs.length) flags.push(INFO_SUBFRAME_TS);
    if (cpNewStable.length) flags.push('新增报错');
    else if (cpNew.length) flags.push(INFO_FLAG);
    if (px.sameSize === false) flags.push('尺寸不同');
    const score = (missingB ? 100 : 0) + (cpNewStable.length ? 50 : cpNew.length ? 5 : 0) + (stateDiv.length ? 10 + Math.min(20, stateDiv.length) : 0)
      + (abPct !== null ? Math.max(0, abPct - floorPct) : 0) + (pxCanvas.ab !== null ? Math.max(0, pxCanvas.ab - pxCanvas.floorPct) : 0);
    checkpoints.push({
      name,
      tick: c.A1?.tick ?? c.B1?.tick ?? null,
      px,
      pxCanvas,
      state: { divergent: stateDiv.length, noisyPaths: noisy.size, noisyList, diffs: stateDiffs, subframeTs: stateTs.length, subframeTsList: stateTs.slice(0, 10) },
      summary: {
        A: c.A1 ? { scene: c.A1.probe?.sceneId, player: c.A1.probe?.player, dialogue: c.A1.probe?.playerDialogue?.text ?? null } : null,
        B: c.B1 ? { scene: c.B1.probe?.sceneId, player: c.B1.probe?.player, dialogue: c.B1.probe?.playerDialogue?.text ?? null } : null,
      },
      ops: { A: opsOf(c.A1), B: opsOf(c.B1), differ: opsDiffer },
      newErrors: cpNew.map((e) => fullText.get(e) ?? e),
      assetErrors: { A: (c.A1?.items ?? []).filter((i) => i.asset).length, B: (c.B1?.items ?? []).filter((i) => i.asset).length },
      images,
      flags,
      score: +score.toFixed(4),
    });
  }

  const bootA = runs.A.map((r) => r?.boot?.ok ?? false);
  const bootB = runs.B.map((r) => r?.boot?.ok ?? false);
  const fatal = { A: runs.A.map((r) => r?.fatal ?? null), B: runs.B.map((r) => r?.fatal ?? null) };
  const flags = new Set(checkpoints.flatMap((c) => c.flags));
  // 起没起来:两边都没起来 / 只有 B 起得来 = 这个场景没法对照(不是 B 的回归,但也绝不能算「一致」)
  const inconclusive = !bootA.some(Boolean)
    ? (bootB.some(Boolean) ? '只有 B 起得来(A 全部没就绪),无法对照' : '两边都没起来,无法对照')
    : null;
  if (inconclusive) flags.clear();
  if (bootA.some(Boolean) && !bootB.some(Boolean)) flags.add('B 起不来');
  if (!inconclusive && (bootA.some((x) => !x) || bootB.some((x) => !x)) && !flags.has('B 起不来')) flags.add(INFO_BOOT_FLAKY);
  if (newErrorsStable.length) flags.add('新增报错');
  // 起来之后才中断的(卡死 / 整页重载 / 截图失败…);没起来的已经记在上面
  const ranThenDied = (side, boot) => fatal[side].some((f, i) => f && boot[i]);
  if (ranThenDied('B', bootB) && !ranThenDied('A', bootA)) flags.add('B 运行中断');
  const pumpCounts = pumpBootCounts(runs);
  if (pumpCounts && !inconclusive && !pumpCounts.same) flags.add(pumpCounts.aaSame && pumpCounts.bbSame ? PUMP_AB_FLAG : INFO_PUMP_JITTER);
  const bootInputs = pumpBootInputs(runs);
  if (bootInputs && !inconclusive && !bootInputs.same) flags.add('启动输入不一致(无法按相同输入对照)');
  const envDrift = { A: runs.A.map((r) => r?.envDrift ?? []), B: runs.B.map((r) => r?.envDrift ?? []) };
  if ([...envDrift.A, ...envDrift.B].some((d) => d.length)) flags.add(INFO_ENV_DRIFT);
  const unsupported = { A: [...new Set(runs.A.flatMap((r) => r?.unsupported ?? []))], B: [...new Set(runs.B.flatMap((r) => r?.unsupported ?? []))] };
  const diverged = [...flags].some((f) => isFailFlag(f, opts));
  const score = Math.max(0, ...checkpoints.map((c) => c.score)) + (flags.has('B 起不来') ? 200 : 0) + (inconclusive ? 150 : 0)
    + (newErrorsStable.length ? 50 : 0);
  // 泵式装载的记录只在 pump 下才有:别的模式的行逐字不变
  const bootRow = (r) => r && {
    ok: r.boot?.ok ?? false, ms: r.boot?.bootMs ?? null, froze: r.boot?.froze ?? null, reason: r.boot?.reason ?? null,
    ...(r.boot?.pump ? {
      pump: {
        frames: r.boot.pump.frames, ticks: r.boot.pump.ticks, timerSteps: r.boot.pump.timerSteps ?? null, fakeMs: r.boot.pump.fakeMs, syncNow: r.boot.pump.syncNow ?? null,
        firstStepFrame: r.boot.pump.firstStepFrame, stalls: r.boot.pump.stalls, reloads: r.boot.pump.reloads, idleMs: r.boot.pump.idleMs,
        phases: r.boot.pump.phases, timerLog: r.boot.pump.timerLog ?? null, clockLeaks: r.boot.pump.clockLeaks ?? [],
        inputs: r.boot.pump.inputs ?? [],
      },
    } : {}),
  };
  return {
    id: scenario.id,
    kind: scenario.kind,
    name: scenario.name,
    note: scenario.note ?? null,
    boot: {
      A: runs.A.map(bootRow),
      B: runs.B.map(bootRow),
    },
    ...(pumpCounts ? { pumpBoot: pumpCounts } : {}),
    ...(bootInputs ? { bootInputs } : {}),
    ...([...envDrift.A, ...envDrift.B].some((d) => d.length) ? { envDrift } : {}),
    fatal,
    unsupported,
    steps: { A: A1?.steps ?? [], B: B1?.steps ?? [] },
    errors: {
      newStable: newErrorsStable.map((e) => fullText.get(e) ?? e),
      newFlaky: newErrorsFlaky.map((e) => fullText.get(e) ?? e),
      gone: goneErrors,
      newWarnings: newWarnings.slice(0, 50),
      asset: { A: runs.A.map(assetCount), B: runs.B.map(assetCount) },
      // 缺素材类报错不参与判定,但两边请求的素材集合不同本身是信息(比如 B 多请求了一个 A 不要的文件)
      assetOnlyB: [...bAsset].filter((e) => !aAsset.has(e)).slice(0, 30),
      assetOnlyA: [...aAsset].filter((e) => !bAsset.has(e)).slice(0, 30),
      aaFlaky: [...new Set([...errSet(A1)].filter((e) => A2 && !errSet(A2).has(e)))].slice(0, 20),
    },
    checkpoints,
    flags: [...flags],
    inconclusive,
    diverged,
    score: +score.toFixed(4),
    wallMs: { A: runs.A.map((r) => r?.wallMs ?? null), B: runs.B.map((r) => r?.wallMs ?? null) },
  };
}
