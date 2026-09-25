/**
 * 像素对照页入口(master 对本分支)。
 *
 * - 主页面(候选服务上):开两个 iframe —— `?side=gl` 指向**参考服务**(`?ref=<参考服务地址>`,master 的 src + Pixi WebGL),
 *   `?side=gpu` 指向本服务(本分支的 src + engine2d WebGPU);各自只建一个渲染器把全部用例画完回读,
 *   结果 postMessage 回主页面逐像素比较。
 * - `?case=关键字` 只跑名字含关键字的用例;`?images=0` 不出缩略图。
 * 结果挂在 `window.__parity`(run.mjs 读它)。
 */
import { createSideRenderer } from '@parity-side';
import { judge, renderSide, type ParityCase, type ParityResult, type SideOutput } from './harness';

interface ParityReport {
  done: boolean;
  fatal: string | null;
  results: ParityResult[];
}

// 用例按文件自动收集:每个 cases/*.ts 导出 `cases: ParityCase[]`(各模块各写各的文件,互不冲突)。
// 按需加载、逐文件兜错:一侧的某个用例文件加载失败(比如引用了那一侧树里没有的模块)只让那个文件的用例报错,
// 不能让整侧页面的模块图炸掉、主页面干等。
const loaders = import.meta.glob<{ cases: ParityCase[] }>('./cases/*.ts');

const query = new URLSearchParams(location.search);
const only = query.get('case');

async function loadCases(): Promise<{ cases: ParityCase[]; loadErrors: string[] }> {
  const cases: ParityCase[] = [];
  const loadErrors: string[] = [];
  for (const k of Object.keys(loaders).sort()) {
    try {
      cases.push(...((await loaders[k]()).cases ?? []));
    } catch (e) {
      loadErrors.push(`${k}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { cases: cases.filter((x) => !only || x.name.includes(only)), loadErrors };
}

type SideMessage =
  | { kind: 'parity-side'; side: 'gl' | 'gpu'; fatal: string | null; outputs: SideOutput[]; loadErrors: string[] };

async function runSide(side: 'gl' | 'gpu'): Promise<void> {
  let msg: SideMessage;
  try {
    const sr = await createSideRenderer();
    if (sr.side !== side) throw new Error(`这个服务提供的是 ${sr.side} 侧,却被当作 ${side} 侧打开(参考服务地址给错了?)`);
    const { cases, loadErrors } = await loadCases();
    const outputs: SideOutput[] = [];
    for (const c of cases) outputs.push(await renderSide(sr, c));
    msg = { kind: 'parity-side', side, fatal: null, outputs, loadErrors };
  } catch (e) {
    msg = { kind: 'parity-side', side, fatal: e instanceof Error ? `${e.name}: ${e.message}` : String(e), outputs: [], loadErrors: [] };
  }
  parent.postMessage(msg, '*');
}

function render(report: ParityReport): void {
  const rows = document.getElementById('rows')!;
  rows.replaceChildren(
    ...report.results.map((r) => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = r.name;
      const st = document.createElement('td');
      st.className = r.status;
      st.textContent = `${{ pass: '✓ 一致', fail: '✗ 不一致', error: '✗ 出错' }[r.status]}`;
      const imgs = document.createElement('td');
      if (r.images) {
        for (const src of [r.images.ref, r.images.cand, r.images.diff]) {
          const img = document.createElement('img');
          img.src = src;
          imgs.append(img);
        }
      }
      const detail = document.createElement('td');
      const pre = document.createElement('pre');
      pre.textContent = r.detail;
      detail.append(pre);
      tr.append(name, st, imgs, detail);
      return tr;
    }),
  );
  const pass = report.results.filter((r) => r.status === 'pass').length;
  const summary = document.getElementById('summary')!;
  summary.textContent = report.fatal
    ? `初始化失败:${report.fatal}`
    : report.done
      ? `一致 ${pass} / 共 ${report.results.length}`
      : '运行中…';
  summary.className = report.fatal || (report.done && pass < report.results.length) ? 'fail' : report.done ? 'pass' : '';
}

async function runHost(): Promise<void> {
  const report: ParityReport = { done: false, fatal: null, results: [] };
  (window as unknown as { __parity: ParityReport }).__parity = report;
  render(report);
  const t0 = performance.now();
  const got = new Map<'gl' | 'gpu', SideMessage>();
  await new Promise<void>((resolve) => {
    window.addEventListener('message', (ev: MessageEvent<SideMessage>) => {
      if (ev.data?.kind !== 'parity-side') return;
      got.set(ev.data.side, ev.data);
      if (got.size === 2) resolve();
    });
    const refBase = query.get('ref');
    if (!refBase) {
      report.fatal = '缺参考服务地址(?ref=…);用 node tools/render_parity/run.mjs 跑,或 --serve 起两个服务再打开它给的地址';
      resolve();
      return;
    }
    for (const side of ['gpu', 'gl'] as const) {
      const f = document.createElement('iframe');
      const q = new URLSearchParams(query);
      q.delete('ref');
      q.set('side', side);
      f.src = side === 'gl' ? `${new URL(location.pathname, refBase)}?${q}` : `${location.pathname}?${q}`;
      f.style.display = 'none';
      document.body.append(f);
    }
  });
  const gl = got.get('gl');
  const gpu = got.get('gpu');
  if (report.fatal) {
    // 已记下
  } else if (!gl || !gpu || gl.fatal || gpu.fatal) {
    report.fatal = [gl?.fatal && `参考(master · Pixi WebGL):${gl.fatal}`, gpu?.fatal && `候选(本分支 · engine2d WebGPU):${gpu.fatal}`].filter(Boolean).join(';');
  } else {
    const ms = Math.round(performance.now() - t0);
    const withImages = query.get('images') !== '0';
    const { cases } = await loadCases();
    const missing = (sideMsg: SideMessage, name: string): SideOutput => ({
      name,
      data: null,
      error: `这一侧没有这个用例的结果;用例文件加载失败:\n${sideMsg.loadErrors.join('\n') || '(无)'}`,
      warnings: [],
    });
    const pick = (sideMsg: SideMessage, name: string) => sideMsg.outputs.find((o) => o.name === name) ?? missing(sideMsg, name);
    report.results = cases.map((c) => judge(c, pick(gl, c.name), pick(gpu, c.name), ms, withImages));
    for (const [label, m] of [['参考(master · Pixi WebGL)', gl], ['候选(本分支 · engine2d WebGPU)', gpu]] as const) {
      for (const err of m.loadErrors) {
        report.results.push({ name: `用例文件加载 / ${label}`, status: 'error', maxDiff: 0, meanDiff: 0, badPixels: 0, bbox: null, detail: err, ms });
      }
    }
  }
  report.done = true;
  render(report);
}

const side = query.get('side');
if (side === 'gl' || side === 'gpu') void runSide(side);
else void runHost();
