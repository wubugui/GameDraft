/**
 * engine2d 像素对照页入口:主页面开两个 iframe(`?side=ref` / `?side=cand`),各自跑完全部用例回读,
 * 结果传回主页面比较。`?case=关键字` 只跑部分;`?images=0` 不出缩略图。结果挂在 `window.__parity`。
 */
import { createSide, judge, renderSide, type Case, type Result, type Side, type SideOutput } from './harness';

interface Report {
  done: boolean;
  fatal: string | null;
  results: Result[];
}

const modules = import.meta.glob<{ cases: Case[] }>('./cases/*.ts', { eager: true });
const ALL: Case[] = Object.keys(modules).sort().flatMap((k) => modules[k].cases ?? []);
const query = new URLSearchParams(location.search);
const only = query.get('case');
const selected = ALL.filter((x) => !only || x.name.includes(only));

type SideMessage = { kind: 'e2d-side'; side: Side; fatal: string | null; outputs: SideOutput[] };

async function runSide(side: Side): Promise<void> {
  let msg: SideMessage;
  try {
    const ctx = await createSide(side);
    const outputs: SideOutput[] = [];
    for (const c of selected) outputs.push(await renderSide(ctx, c));
    msg = { kind: 'e2d-side', side, fatal: null, outputs };
  } catch (e) {
    msg = { kind: 'e2d-side', side, fatal: e instanceof Error ? `${e.name}: ${e.message}` : String(e), outputs: [] };
  }
  parent.postMessage(msg, '*');
}

function render(report: Report): void {
  const rows = document.getElementById('rows')!;
  rows.replaceChildren(
    ...report.results.map((r) => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = r.name;
      const st = document.createElement('td');
      st.className = r.status;
      st.textContent = { pass: '✓ 一致', fail: '✗ 不一致', error: '✗ 出错' }[r.status];
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
  summary.textContent = report.fatal ? `初始化失败:${report.fatal}` : report.done ? `一致 ${pass} / 共 ${report.results.length}` : '运行中…';
  summary.className = report.fatal || (report.done && pass < report.results.length) ? 'fail' : report.done ? 'pass' : '';
}

async function runHost(): Promise<void> {
  const report: Report = { done: false, fatal: null, results: [] };
  (window as unknown as { __parity: Report }).__parity = report;
  render(report);
  const got = new Map<Side, SideMessage>();
  await new Promise<void>((resolve) => {
    window.addEventListener('message', (ev: MessageEvent<SideMessage>) => {
      if (ev.data?.kind !== 'e2d-side') return;
      got.set(ev.data.side, ev.data);
      if (got.size === 2) resolve();
    });
    for (const side of ['cand', 'ref'] as const) {
      const f = document.createElement('iframe');
      const q = new URLSearchParams(query);
      q.set('side', side);
      f.src = `${location.pathname}?${q}`;
      f.style.display = 'none';
      document.body.append(f);
    }
  });
  const ref = got.get('ref')!;
  const cand = got.get('cand')!;
  if (ref.fatal || cand.fatal) {
    report.fatal = [ref.fatal && `参考:${ref.fatal}`, cand.fatal && `候选:${cand.fatal}`].filter(Boolean).join(';');
  } else {
    const withImages = query.get('images') !== '0';
    report.results = selected.map((c, i) => judge(c, ref.outputs[i], cand.outputs[i], withImages));
  }
  report.done = true;
  render(report);
}

const side = query.get('side');
if (side === 'ref' || side === 'cand') void runSide(side);
else void runHost();
