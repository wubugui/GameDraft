/**
 * 世界脑的常驻状态牌（开发期 DOM 浮层，右上角）。
 *
 * 连着跑的东西"早就断了却没人知道"是默认死法——所以开关一开，这块牌子就常驻：
 * 连没连上 Jev、问了几次、多慢、花了多少（累计 + 照最近的节奏估每小时）、街上刚出了啥事、
 * 每个人被挑了啥（概率 / 置信度）、头上此刻挂着的那句话（↩ = 回你的话）。
 * 只读 `getDebugState()`；关掉世界脑后牌子留着显示"正在走回原位"，走完自动收起。
 *
 * 抬头一行常驻（谁在判、开没开、此刻状态），点它或右边的「收起」把整块牌子收成这一行；
 * 下面一排开关：切决策服务（Laya / Jev，对比用）、切问法、名字牌、按 E 开详情；再下面是自己带滚动条的正文。
 * 牌子占着的那块接鼠标（滚轮滚正文、不漏给游戏），挡路了就收起。点"街上的人"里的某一行 = 打开这个人的详情面板。
 */
import type { DecisionMode } from '../systems/worldBrain/types';
import type { JevBackend } from '../systems/worldBrain/jevTransport';
import { USD_TO_CNY, type WorldBrainDebugState } from '../systems/worldBrain/WorldBrainSystem';

export interface WorldBrainOverlayActions {
  setBackend: (b: JevBackend | null) => void;
  setDecisionMode: (m: DecisionMode | null) => void;
  isNameTagsVisible: () => boolean;
  setNameTagsVisible: (v: boolean) => void;
  /** 按 E 搭话时要不要自动打开这个人的详情面板（缺省关：无脑弹出挡着玩） */
  isInspectOnInteract: () => boolean;
  setInspectOnInteract: (v: boolean) => void;
  inspect: (npcId: string) => void;
}

const stop = (ev: Event) => ev.stopPropagation();

interface Btn {
  el: HTMLButtonElement;
  /** 此刻是不是选中的那个 / 能不能点（没配好的那一路） */
  state: (s: WorldBrainDebugState) => { on: boolean; enabled: boolean; title?: string; label?: string };
}

export class WorldBrainOverlay {
  private root: HTMLDivElement | null = null;
  private content: HTMLDivElement | null = null;
  /** 抬头一行（收起后只剩它）/ 开关排 / 带滚动条的正文 */
  private headTitle: HTMLSpanElement | null = null;
  private headBtn: HTMLButtonElement | null = null;
  private controls: HTMLDivElement | null = null;
  private scroller: HTMLDivElement | null = null;
  private readonly buttons: Btn[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private visible = true;
  private collapsed = false;
  /** 上次写进去的 HTML：没变就不重写（每 300ms 整块重写会吃掉正点着的那一下） */
  private lastHtml = '';
  private lastHead = '';

  constructor(
    private readonly getState: () => WorldBrainDebugState,
    private readonly actions: WorldBrainOverlayActions | null = null,
  ) {}

  /** 用户在调试面板里关掉了牌子（世界脑照跑） */
  setVisible(v: boolean): void {
    this.visible = v;
    this.render();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** 收成抬头一行（世界脑照跑，牌子不挡画面） */
  setCollapsed(v: boolean): void {
    this.collapsed = v;
    this.render();
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  mount(): void {
    if (this.root || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.setAttribute('data-world-brain-overlay', '');
    Object.assign(el.style, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      width: '360px',
      maxHeight: '86vh',
      zIndex: '9000',
      background: 'rgba(18,16,12,0.78)',
      color: '#e8dfc8',
      font: '11px/1.4 "Microsoft YaHei", sans-serif',
      border: '1px solid rgba(200,170,110,0.5)',
      borderRadius: '6px',
      pointerEvents: 'auto',
      display: 'none',
      flexDirection: 'column',
      boxSizing: 'border-box',
    } satisfies Partial<CSSStyleDeclaration>);
    // 牌子上的鼠标一概不漏给游戏（滚轮在这儿只滚正文，不缩放镜头 / 不翻别的面板）
    for (const evName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel']) {
      el.addEventListener(evName, stop);
    }
    el.appendChild(this.buildHeader());
    if (this.actions) {
      const controls = this.buildControls(this.actions);
      Object.assign(controls.style, { padding: '0 10px', flex: '0 0 auto' } satisfies Partial<CSSStyleDeclaration>);
      el.appendChild(controls);
      this.controls = controls;
    }
    const scroller = document.createElement('div');
    Object.assign(scroller.style, {
      overflowY: 'auto', flex: '1 1 auto', minHeight: '0', padding: '0 10px 8px',
      scrollbarWidth: 'thin', scrollbarColor: 'rgba(220,185,110,0.6) rgba(0,0,0,0.2)',
    } satisfies Partial<CSSStyleDeclaration>);
    const content = document.createElement('div');
    content.style.whiteSpace = 'pre-wrap';
    // 点"街上的人"那一行：打开详情面板（行本身接鼠标，冒泡到这里）
    content.addEventListener('click', (ev) => {
      const row = (ev.target as HTMLElement | null)?.closest?.('[data-npc]') as HTMLElement | null;
      const id = row?.getAttribute('data-npc');
      if (!id || !this.actions) return;
      ev.stopPropagation();
      this.actions.inspect(id);
    });
    scroller.appendChild(content);
    el.appendChild(scroller);
    document.body.appendChild(el);
    this.root = el;
    this.content = content;
    this.scroller = scroller;
    this.timer = setInterval(() => this.render(), 300);
  }

  /** 抬头一行：谁在判 · 开没开 · 此刻状态；点整行或「收起 / 展开」切换 */
  private buildHeader(): HTMLDivElement {
    const head = document.createElement('div');
    Object.assign(head.style, {
      display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', cursor: 'pointer', flex: '0 0 auto',
    } satisfies Partial<CSSStyleDeclaration>);
    head.title = '点一下收起 / 展开这块牌子';
    const title = document.createElement('span');
    Object.assign(title.style, {
      flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    } satisfies Partial<CSSStyleDeclaration>);
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      font: '11px "Microsoft YaHei", sans-serif', borderRadius: '3px', padding: '1px 7px', cursor: 'pointer',
      border: '1px solid rgba(220,185,110,0.6)', color: '#f3d9a0', background: 'rgba(60,48,28,0.9)', flex: '0 0 auto',
    } satisfies Partial<CSSStyleDeclaration>);
    head.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    head.append(title, btn);
    this.headTitle = title;
    this.headBtn = btn;
    return head;
  }

  private buildControls(a: WorldBrainOverlayActions): HTMLDivElement {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', marginBottom: '6px', pointerEvents: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);
    for (const evName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'wheel']) bar.addEventListener(evName, stop);
    const label = (t: string) => {
      const s = document.createElement('span');
      s.textContent = t;
      s.style.color = '#9ab';
      bar.appendChild(s);
    };
    const add = (text: string, fn: () => void, state: Btn['state']) => {
      const b = document.createElement('button');
      b.textContent = text;
      Object.assign(b.style, {
        font: '11px "Microsoft YaHei", sans-serif', borderRadius: '3px', padding: '1px 7px', cursor: 'pointer',
        border: '1px solid rgba(220,185,110,0.6)',
      } satisfies Partial<CSSStyleDeclaration>);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (b.disabled) return;
        fn();
        this.render();
      });
      bar.appendChild(b);
      this.buttons.push({ el: b, state });
    };
    const backendOk = (s: WorldBrainDebugState, b: JevBackend) => {
      const info = s.jev?.backends?.[b];
      return { ok: info ? info.configured : true, missing: info?.missing ?? null };
    };
    const current = (s: WorldBrainDebugState): JevBackend | null => s.backend ?? s.jev?.defaultBackend ?? null;
    label('决策服务');
    for (const b of ['laya', 'jev'] as const) {
      add(b === 'laya' ? 'Laya（局域网）' : 'Jev（公网）', () => a.setBackend(b), (s) => {
        const { ok, missing } = backendOk(s, b);
        return { on: current(s) === b, enabled: ok, title: ok ? '' : `.env.local 里没填 ${missing ?? ''}` };
      });
    }
    const br = document.createElement('div');
    br.style.flexBasis = '100%';
    bar.appendChild(br);
    label('问法');
    const modes: [DecisionMode, string][] = [['auto', '自动'], ['perOption', '逐项是非'], ['choice', '选择题']];
    for (const [m, t] of modes) {
      add(t, () => a.setDecisionMode(m === 'auto' ? null : m), (s) => ({ on: s.decisionModeSetting === m, enabled: true }));
    }
    add('名字牌', () => a.setNameTagsVisible(!a.isNameTagsVisible()), () => {
      const on = a.isNameTagsVisible();
      return { on, enabled: true, label: on ? '名字牌：开' : '名字牌：关' };
    });
    add('按E开详情', () => a.setInspectOnInteract(!a.isInspectOnInteract()), () => {
      const on = a.isInspectOnInteract();
      return {
        on, enabled: true, label: on ? '按E开详情：开' : '按E开详情：关',
        title: '按 E 跟人搭话时自动打开他的详情面板；关着时点名字牌或下面"街上的人"那一行照样能开',
      };
    });
    return bar;
  }

  private render(): void {
    const el = this.root;
    const content = this.content;
    if (!el || !content) return;
    const s = this.getState();
    const show = this.visible && (s.enabled || s.status === 'returning');
    el.style.display = show ? 'flex' : 'none';
    if (!show) return;
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    const dot = s.enabled ? '<span style="color:#7fdc7f">●</span>' : '<span style="color:#aaa">○</span>';
    const color = s.status === 'error' ? '#ff8a7a' : s.status === 'waiting' ? '#f0d070' : '#cfe8cf';
    const head =
      `<b>${esc(s.decider)} 世界脑</b> ${dot} ${s.enabled ? '开' : '关'} · ` +
      `<span style="color:${color}">${esc(s.statusText)}</span>`;
    if (this.headTitle && head !== this.lastHead) {
      this.headTitle.innerHTML = head;
      this.lastHead = head;
    }
    if (this.headBtn) this.headBtn.textContent = this.collapsed ? '展开' : '收起';
    if (this.controls) this.controls.style.display = this.collapsed ? 'none' : 'flex';
    if (this.scroller) this.scroller.style.display = this.collapsed ? 'none' : 'block';
    if (this.collapsed) return;
    for (const b of this.buttons) {
      const st = b.state(s);
      b.el.disabled = !st.enabled;
      if (st.label && b.el.textContent !== st.label) b.el.textContent = st.label;
      b.el.title = st.title ?? '';
      b.el.style.color = st.on ? '#1a1206' : st.enabled ? '#f3d9a0' : '#777';
      b.el.style.background = st.on ? 'rgba(240,200,110,0.95)' : 'rgba(60,48,28,0.9)';
      b.el.style.cursor = st.enabled ? 'pointer' : 'not-allowed';
    }
    const red = (t: string) => `<span style="color:#ff8a7a">${t}</span>`;
    let jev = '查询中…';
    if (s.jev) {
      const j = s.jev;
      if (!j.reachable) jev = red(`开发服务器上没有${esc(s.decider)}转发`);
      else if (!j.configured) jev = red(`.env.local 里没填 ${esc(j.missing ?? '')}`);
      else {
        const where = j.provider === 'laya'
          ? `${esc(j.endpoint ?? '')}${j.upstream
            ? (!j.upstream.ok
              ? ` · ${red(`服务连不上：${esc(j.upstream.message ?? '')}`)}`
              : j.upstream.auth === 'rejected'
                ? ` · ${red(`服务在（${esc(j.upstream.version ?? '?')}），但不认 .env.local 里的 key`)}`
                : ` · 服务在（${esc(j.upstream.version ?? '?')}）`)
            : ''}`
          : `${esc(j.provider ?? '')}${j.proxy ? ` · 代理 ${esc(j.proxy)}` : ' · 直连'}`;
        const model = s.servedModel ?? j.model ?? '自动选';
        jev = `已接通 · ${where} · 模型 ${esc(model)}`;
      }
    }
    const lines: string[] = [];
    lines.push(`场景 ${esc(s.sceneId)}${s.hasConfig ? '' : '（本场景无配置）'}`);
    lines.push(`${esc(s.decider)}：${jev}`);
    lines.push(
      `请求 ${s.requests} 发（一人一发）· 排队 ${s.queueLength} · 在途 ${s.inFlight} · 往返 平均 ${s.avgLatencyMs ?? '—'} ms / 上次 ${s.lastLatencyMs ?? '—'} ms` +
      `${s.serverLatencyMs !== null ? ` · 服务端 ${Math.round(s.serverLatencyMs)} ms` : ''}` +
      ` · 输入 ${(s.inputTokens / 1000).toFixed(1)}k token${s.stateTokens !== null ? `（上一发 state ${s.stateTokens}）` : ''}`,
    );
    // 一拍一包的通道：熔断、暂代、撤单、P50 / P95、在途包数
    const ch = s.channel;
    if (ch) {
      const breaker = ch.breakerOpen
        ? `<span style="color:#f5a623">熔断中 ${Math.round(ch.breakerOpenMs / 1000)} 秒（${esc(ch.breakerReason)}）</span>`
        : '通道正常';
      lines.push(
        `一拍一包：${breaker} · 暂代 ${ch.substituted} 单 · 撤单 ${ch.cancelled} 单 · P50 ${ch.p50Ms ?? '—'} ms / P95 ${ch.p95Ms ?? '—'} ms` +
        ` · 在途 ${ch.packsInFlight} 包 · 推送通道${ch.streamOpen ? '开着' : '没开'}` +
        `${ch.hubActiveGroup ? ` · Hub 的 GPU 此刻在跑 ${esc(ch.hubActiveGroup)}` : ''}`,
      );
    }
    // 决策分层：各档多少人、最近一分钟各层发了几发
    const tc = s.tierCounts;
    const cpm = s.callsPerMinute;
    lines.push(
      `决策分层：近 ${tc['近'] ?? 0} · 中 ${tc['中'] ?? 0} · 远 ${tc['远'] ?? 0} · 停 ${tc['停'] ?? 0} 人` +
      `｜最近一分钟 ${cpm.total} 发（日常 ${cpm.routine} · 出事 ${cpm.event} · 拉近补问 ${cpm.catchup} · 回话 ${cpm.reply} · 背景巡检 ${cpm.background} · 显著度 ${cpm.salience} · 基线 ${cpm.baseline}）`,
    );
    const b = s.baselines;
    lines.push(
      s.decisionMode === 'perOption'
        ? `问法：逐项是非（每个选项一道是非题，跟同一街面的对照比涨了多少：出事的事去掉刚才的事比、日常的事去掉他是谁比）${b.pending ? ` · 对照在问 ${b.pending} 条` : ''}`
        : s.decisionMode === 'choice' ? '问法：选择题' : '问法：还不知道连的是谁',
    );
    if (s.warningCount) {
      lines.push(red(`${esc(s.decider)} 提示 ${s.warningCount} 条，最近：${esc(s.warnings[s.warnings.length - 1] ?? '')}`));
    }
    // 花费：累计 + 照最近几分钟的节奏估一小时（直连官方 Jev 时回包不带花费，按 token × 官方价估；局域网 Laya 不花钱）
    if (s.jev?.provider === 'laya' && s.cost === 0) {
      lines.push('<span style="color:#f0d070">花费：0（局域网 Laya，不花钱）</span>');
    } else {
      const money = (usd: number) => `$${usd < 0.1 ? usd.toFixed(4) : usd.toFixed(2)}（≈¥${(usd * USD_TO_CNY).toFixed(usd * USD_TO_CNY < 1 ? 3 : 2)}）`;
      lines.push(
        `<span style="color:#f0d070">花费${s.costEstimated ? '（估）' : ''}：已花 ${money(s.cost)}</span>`,
      );
      if (s.costPerHourUsd !== null) {
        const win = s.rateWindowSec >= 90 ? `最近 ${Math.round(s.rateWindowSec / 60)} 分钟` : `最近 ${s.rateWindowSec} 秒`;
        lines.push(
          `<span style="color:#f0d070">照${win}的节奏：≈ ${money(s.costPerHourUsd)} / 小时</span>` +
          ` · 约 ${Math.round(s.requestsPerHour ?? 0)} 次、${((s.tokensPerHour ?? 0) / 1e6).toFixed(2)}M token / 小时`,
        );
      } else {
        lines.push('<span style="color:#9ab">每小时花费：刚打开，攒够 20 秒再估</span>');
      }
    }
    lines.push(`街上紧张程度 ${s.tension.toFixed(2)}（${esc(s.decider)} 判的显著度）`);
    for (const e of s.configErrors) lines.push(`<span style="color:#ff8a7a">配置错误：${esc(e)}</span>`);
    if (s.configWarnings.length) lines.push(`<span style="color:#e0b060">配置警告 ${s.configWarnings.length} 条（见控制台）</span>`);
    if (s.events.length) {
      lines.push('<b>刚才街上：</b>');
      for (const ev of s.events.slice().reverse()) lines.push(`  ${esc(ev)}`);
    }
    if (s.people.length) {
      lines.push(`<b>街上的人：</b>${this.actions ? '<span style="color:#9ab">（点一行看这个人的详情）</span>' : ''}`);
      for (const p of s.people) {
        const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
        // 逐项是非：p = 挑中那项比基线涨了多少，打断 = "放下手上的事"比平静时涨了多少
        const pc = p.p !== null ? (s.decisionMode === 'perOption' ? ` 涨${signed(p.p)}` : ` p${p.p.toFixed(2)}`) : '';
        const cc = s.decisionMode === 'perOption'
          ? (p.gate !== null ? ` 打断${signed(p.gate)}` : '')
          : (p.conf !== null ? ` c${p.conf.toFixed(2)}` : '');
        const say = p.say
          ? p.sayIsReply
            ? ` <span style="color:#9fe0ff">↩「${esc(p.say)}」</span>`
            : ` 「${esc(p.say)}」`
          : '';
        const tag = p.away ? '（走开了）' : '';
        const wait = p.replyPending ? ' <span style="color:#9fe0ff">（在想咋个回你…）</span>' : '';
        const tierColor = p.tier === '近' ? '#9fe09f' : p.tier === '中' ? '#e0d890' : p.tier === '远' ? '#c0a080' : '#808080';
        const on = p.npcId === s.inspectTarget;
        const rowStyle = this.actions ? `cursor:pointer;${on ? 'background:rgba(240,200,110,0.22);' : ''}` : '';
        lines.push(
          `<span data-npc="${esc(p.npcId)}" style="${rowStyle}">  <span style="color:${tierColor}">[${esc(p.tier)}]</span> ` +
          `<span style="color:#f3d9a0">${esc(p.label)}</span>${tag} ${esc(p.doing)}<span style="color:#9ab">${pc}${cc}</span>${say}${wait}</span>`,
        );
      }
    }
    const html = lines.join('\n');
    if (html !== this.lastHtml) {
      content.innerHTML = html;
      this.lastHtml = html;
    }
  }

  destroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.root?.remove();
    this.root = null;
    this.content = null;
    this.headTitle = null;
    this.headBtn = null;
    this.controls = null;
    this.scroller = null;
    this.lastHtml = '';
    this.lastHead = '';
    this.buttons.length = 0;
  }
}
