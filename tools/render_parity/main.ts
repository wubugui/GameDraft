/**
 * 像素对照页入口。
 *
 * - 主页面:开两个 iframe(`?side=gl` / `?side=gpu`),各自只建一个渲染器把全部用例画完回读,
 *   结果传回主页面逐像素比较。两侧分开是因为 Pixi 有模块级单例,同页两个渲染器会互相覆盖。
 * - `?case=关键字` 只跑名字含关键字的用例;`?images=0` 不出缩略图。
 * 结果挂在 `window.__parity`(run.mjs 读它)。
 */
import { createSideRenderer, judge, renderSide, type ParityCase, type ParityResult, type SideOutput } from './harness';

interface ParityReport {
  done: boolean;
  fatal: string | null;
  results: ParityResult[];
}

// 用例按文件自动收集:每个 cases/*.ts 导出 `cases: ParityCase[]`(各模块各写各的文件,互不冲突)
const modules = import.meta.glob<{ cases: ParityCase[] }>('./cases/*.ts', { eager: true });
const ALL: ParityCase[] = Object.keys(modules)
  .sort()
  .flatMap((k) => modules[k].cases ?? []);

const query = new URLSearchParams(location.search);
const only = query.get('case');
const selected = ALL.filter((x) => !only || x.name.includes(only));

type SideMessage =
  | { kind: 'parity-side'; side: 'gl' | 'gpu'; fatal: string | null; outputs: SideOutput[] };

async function runSide(side: 'gl' | 'gpu'): Promise<void> {
  let msg: SideMessage;
  try {
    const sr = await createSideRenderer(side);
    const outputs: SideOutput[] = [];
    for (const c of selected) outputs.push(await renderSide(sr, c));
    msg = { kind: 'parity-side', side, fatal: null, outputs };
  } catch (e) {
    msg = { kind: 'parity-side', side, fatal: e instanceof Error ? `${e.name}: ${e.message}` : String(e), outputs: [] };
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
    for (const side of ['gpu', 'gl'] as const) {
      const f = document.createElement('iframe');
      const q = new URLSearchParams(query);
      q.set('side', side);
      f.src = `${location.pathname}?${q}`;
      f.style.display = 'none';
      document.body.append(f);
    }
  });
  const gl = got.get('gl')!;
  const gpu = got.get('gpu')!;
  if (gl.fatal || gpu.fatal) {
    report.fatal = [gl.fatal && `参考(WebGL):${gl.fatal}`, gpu.fatal && `候选(WebGPU):${gpu.fatal}`].filter(Boolean).join(';');
  } else {
    const ms = Math.round(performance.now() - t0);
    const withImages = query.get('images') !== '0';
    report.results = selected.map((c, i) => judge(c, gl.outputs[i], gpu.outputs[i], ms, withImages));
  }
  report.done = true;
  render(report);
}

const side = query.get('side');
if (side === 'gl' || side === 'gpu') void runSide(side);
else void runHost();
