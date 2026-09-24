/**
 * 世界脑的详情面板（开发期 DOM 浮层，左上角）：跟街上某个人说话（按 E）或点他的名字牌 / 状态牌上那一行，
 * 就显示这个人的一切——是啥人、此刻在做啥 / 要去哪 / 还要做多久、他感觉得到的事、最近几次是怎么想的
 * （每个候选此刻的概率、基线、涨了多少，挑中的打勾）、最近一发问了决策服务啥、回了啥。
 *
 * 不是模态：不停世界、不抢按键，开着照样走路做事；只读 `inspect()`，不写任何东西。
 */
import type { WorldBrainInspection } from '../systems/worldBrain/WorldBrainSystem';

const stop = (ev: Event) => ev.stopPropagation();

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function num(v: number | null, signed = false): string {
  if (v === null) return '—';
  const s = v.toFixed(2);
  return signed && v >= 0 ? `+${s}` : s;
}

export class WorldBrainInspector {
  private root: HTMLDivElement | null = null;
  private body: HTMLDivElement | null = null;
  private title: HTMLSpanElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private showState = false;
  private lastHtml = '';

  constructor(
    private readonly getTarget: () => string | null,
    private readonly inspect: (npcId: string) => WorldBrainInspection | null,
    private readonly close: () => void,
  ) {}

  mount(): void {
    if (this.root || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.setAttribute('data-world-brain-inspector', '');
    Object.assign(el.style, {
      position: 'fixed', top: '8px', left: '8px', width: '430px', maxHeight: '88vh', zIndex: '9001',
      display: 'none', flexDirection: 'column',
      background: 'rgba(16,14,10,0.9)', color: '#e8dfc8', font: '11px/1.45 "Microsoft YaHei", sans-serif',
      border: '1px solid rgba(220,185,110,0.7)', borderRadius: '6px', pointerEvents: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);
    for (const evName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'wheel', 'keydown']) {
      el.addEventListener(evName, stop);
    }
    const head = document.createElement('div');
    Object.assign(head.style, {
      display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px',
      borderBottom: '1px solid rgba(220,185,110,0.35)', flex: '0 0 auto',
    } satisfies Partial<CSSStyleDeclaration>);
    const title = document.createElement('span');
    Object.assign(title.style, { fontWeight: 'bold', fontSize: '13px', color: '#f3d9a0', flex: '1 1 auto' });
    const stateBtn = document.createElement('button');
    stateBtn.textContent = '看 state';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '收起 ✕';
    for (const b of [stateBtn, closeBtn]) {
      Object.assign(b.style, {
        font: '11px "Microsoft YaHei", sans-serif', color: '#f3d9a0', background: 'rgba(60,48,28,0.9)',
        border: '1px solid rgba(220,185,110,0.6)', borderRadius: '3px', padding: '1px 6px', cursor: 'pointer',
      } satisfies Partial<CSSStyleDeclaration>);
    }
    stateBtn.addEventListener('click', () => {
      this.showState = !this.showState;
      stateBtn.textContent = this.showState ? '收 state' : '看 state';
      this.render();
    });
    closeBtn.addEventListener('click', () => {
      this.close();
      this.render();
    });
    head.append(title, stateBtn, closeBtn);
    const body = document.createElement('div');
    // minHeight 0：flex 子项缺省不肯缩到内容以下，不写它正文会撑出面板、滚动条永远不出来
    Object.assign(body.style, {
      overflowY: 'auto', padding: '6px 10px 10px', flex: '1 1 auto', minHeight: '0', whiteSpace: 'normal',
      scrollbarWidth: 'thin', scrollbarColor: 'rgba(220,185,110,0.6) rgba(0,0,0,0.2)',
    } satisfies Partial<CSSStyleDeclaration>);
    el.append(head, body);
    document.body.appendChild(el);
    this.root = el;
    this.body = body;
    this.title = title;
    this.timer = setInterval(() => this.render(), 400);
  }

  private render(): void {
    const root = this.root;
    const body = this.body;
    if (!root || !body || !this.title) return;
    const id = this.getTarget();
    const d = id ? this.inspect(id) : null;
    if (!d) {
      root.style.display = 'none';
      return;
    }
    root.style.display = 'flex';
    this.title.textContent = `${d.label}${d.kind === 'animal' ? '（牲口）' : ''} · 详情`;
    const sec = (t: string) => `<div style="margin:8px 0 3px;color:#f0c870;font-weight:bold">${esc(t)}</div>`;
    const kv = (k: string, v: string) => `<div><span style="color:#9ab">${esc(k)}：</span>${esc(v)}</div>`;
    const h: string[] = [];
    const n = d.now;
    h.push(sec('此刻'));
    h.push(kv('在做', n.doing));
    if (n.heading) h.push(kv('要去', n.heading));
    const timing = [
      n.takenOver ? `做了 ${n.forSec} 秒` : '',
      n.leftSec !== null ? `还要约 ${n.leftSec} 秒` : '',
      n.phase ? `阶段 ${n.phase}` : '',
    ].filter(Boolean).join(' · ');
    if (timing) h.push(kv('进度', timing));
    h.push(kv('决策档', `${n.tier}${n.playerDist !== null ? `（离你 ${n.playerDist}）` : ''}${n.away ? ' · 不在街上' : ''}`));
    h.push(kv('上次惊动他的', n.lastReason || '—'));
    h.push(kv('请求', n.request === 'inFlight' ? '在问…' : n.request === 'queued' ? '排着队' : '没在问'));
    if (n.say) h.push(kv('头上那句', `「${n.say}」`));

    h.push(sec('是啥人'));
    h.push(kv('身份', d.identity));
    h.push(kv('脾气', d.temper));
    h.push(kv('平时', d.activity));
    h.push(kv('窝', d.home));
    if (d.haunts.length) h.push(kv('常去', d.haunts.join('、')));
    for (const r of d.relations) h.push(kv('关系', r));
    if (d.says.length) h.push(kv('会说', d.says.join(' / ')));
    for (const x of d.handOut) h.push(kv('发道具', x));

    h.push(sec(`他感觉得到的事（${d.perceives.length}）`));
    if (!d.perceives.length) h.push('<div style="color:#888">没得啥子特别的事</div>');
    for (const p of d.perceives.slice().reverse()) h.push(`<div>· ${esc(p)}</div>`);

    h.push(sec(`最近怎么想的（新的在上，共 ${d.history.length} 次）`));
    if (!d.history.length) h.push('<div style="color:#888">还没问过他</div>');
    for (const r of d.history.slice().reverse()) {
      const gate = r.gate !== null ? ` · 打断 ${num(r.gate, true)}` : '';
      h.push(
        `<div style="margin-top:5px;border-top:1px dashed rgba(200,170,110,0.25);padding-top:3px">` +
        `<span style="color:#9ab">${r.at}s · ${esc(r.layer)} · ${esc(r.decider)}${r.mode === 'perOption' ? '·逐项是非' : '·选择题'}${gate}</span><br>` +
        `<b>${esc(r.outcome)}</b>${r.said ? `<br>说：「${esc(r.said)}」` : ''}</div>`,
      );
      if (r.rows.length) {
        const perOption = r.mode === 'perOption';
        h.push(
          '<table style="border-collapse:collapse;width:100%;margin-top:2px">' +
          `<tr style="color:#9ab"><td></td><td>候选</td><td style="text-align:right">此刻</td>${perOption ? '<td style="text-align:right">基线</td><td style="text-align:right">涨</td>' : ''}</tr>`,
        );
        let group = '';
        for (const row of r.rows) {
          const g = row.group !== group ? row.group : '';
          group = row.group;
          const mark = row.picked ? '✔ ' : '';
          const color = row.picked ? '#9fe09f' : '#d8cfb8';
          h.push(
            `<tr style="color:${color}"><td style="color:#c0a070;white-space:nowrap;padding-right:4px">${esc(g)}</td>` +
            `<td>${mark}${esc(row.text)}</td>` +
            `<td style="text-align:right">${num(row.p)}</td>` +
            (perOption ? `<td style="text-align:right">${num(row.base)}</td><td style="text-align:right">${num(row.score, true)}</td>` : '') +
            '</tr>',
          );
        }
        h.push('</table>');
      }
    }

    if (d.lastAsk) {
      h.push(sec(`最近一发（${d.lastAsk.at}s）问了啥、回了啥`));
      for (const q of d.lastAsk.questions) {
        h.push(`<div><span style="color:#c0a070">${esc(q.key)}</span> ${esc(q.text)} → <b>${esc(q.answer)}</b></div>`);
      }
      if (this.showState) {
        h.push(`<pre style="white-space:pre-wrap;color:#bcd;margin:4px 0 0;font-size:10px">${esc(d.lastAsk.state)}</pre>`);
      }
    }
    // 没变就不重写：每 400ms 整块重写会抢掉正在选的字 / 正点着的那一下
    const html = h.join('');
    if (html !== this.lastHtml) {
      body.innerHTML = html;
      this.lastHtml = html;
    }
  }

  destroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.root?.remove();
    this.root = null;
    this.body = null;
    this.title = null;
  }
}
