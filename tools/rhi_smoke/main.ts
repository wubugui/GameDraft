/**
 * RHI 冒烟页入口。`?backend=webgpu|webgl2|auto` 选后端,`?case=关键字` 只跑部分用例;跑完把结果挂在 `window.__rhiSmoke`
 * (无头驱动读它,见 run.mjs),同时画成表格给人看。
 */
import { createRhiDevice, RhiError, type RhiBackendType } from '@src/rendering/rhi';
import { CASES } from './cases';

interface CaseResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  ms: number;
}

interface SmokeReport {
  done: boolean;
  requested: string;
  backend: RhiBackendType | null;
  renderer: string;
  fatal: string | null;
  results: CaseResult[];
}

const CASE_TIMEOUT_MS = 20_000;

const report: SmokeReport = { done: false, requested: '', backend: null, renderer: '', fatal: null, results: [] };
(window as unknown as { __rhiSmoke: SmokeReport }).__rhiSmoke = report;

function describe(e: unknown): string {
  if (e instanceof RhiError) return e.message;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`超时 ${ms}ms`)), ms))]);
}

function render(): void {
  const rows = document.getElementById('rows')!;
  rows.replaceChildren(
    ...report.results.map((r) => {
      const tr = document.createElement('tr');
      const mark = { pass: '✓ 通过', fail: '✗ 失败', skip: '– 跳过' }[r.status];
      for (const [text, cls] of [[r.name, ''], [`${mark}(${r.ms}ms)`, r.status], [r.detail, '']] as const) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        const pre = document.createElement('pre');
        pre.textContent = text;
        td.append(pre);
        tr.append(td);
      }
      return tr;
    }),
  );
  const pass = report.results.filter((r) => r.status === 'pass').length;
  const fail = report.results.filter((r) => r.status === 'fail').length;
  const skip = report.results.filter((r) => r.status === 'skip').length;
  const head = report.fatal
    ? `设备创建失败:${report.fatal}`
    : `${report.backend}(请求 ${report.requested})· ${report.renderer} —— 通过 ${pass} / 失败 ${fail} / 跳过 ${skip}${report.done ? '' : ' · 运行中…'}`;
  const summary = document.getElementById('summary')!;
  summary.textContent = head;
  summary.className = report.fatal || fail ? 'fail' : report.done ? 'pass' : '';
}

async function main(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const requested = (query.get('backend') ?? 'auto') as 'auto' | RhiBackendType;
  // ?case=关键字:只跑名字含关键字的用例(排查用)
  const only = query.get('case');
  report.requested = requested;
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  let dev;
  try {
    dev = await createRhiDevice({ canvas, backend: requested, useDevicePixels: false, autoResize: false });
  } catch (e) {
    report.fatal = describe(e);
    report.done = true;
    render();
    return;
  }
  report.backend = dev.caps.backend;
  report.renderer = dev.info.renderer;
  render();
  for (const c of CASES.filter((x) => !only || x.name.includes(only))) {
    const t0 = performance.now();
    if (c.only && c.only !== dev.caps.backend) {
      report.results.push({ name: c.name, status: 'skip', detail: `仅 ${c.only}`, ms: 0 });
      continue;
    }
    const scope = dev.createScope(c.name);
    const diagnostics: RhiError[] = [];
    const off = dev.onDiagnostic((e) => diagnostics.push(e));
    let result: CaseResult;
    try {
      const detail = await withTimeout(c.run({ dev, scope, diagnostics }), CASE_TIMEOUT_MS);
      result = { name: c.name, status: 'pass', detail: detail ?? '', ms: 0 };
    } catch (e) {
      const extra = diagnostics.length ? `\n诊断:${diagnostics.map((d) => d.message).join('\n')}` : '';
      result = { name: c.name, status: 'fail', detail: describe(e) + extra, ms: 0 };
    } finally {
      off();
      scope.destroy();
    }
    result.ms = Math.round(performance.now() - t0);
    report.results.push(result);
    render();
  }
  dev.destroy();
  report.done = true;
  render();
}

void main();
