import type { LightDef, LightKind, SceneLightingDef } from '../data/types';
import type { DebugSectionContent } from './DebugPanelUI';
import {
  CHARACTER_HEIGHT_WU,
  DEFAULT_LAMP_RADIUS_WU,
  DEFAULT_LIGHT_RANGE_WU,
  SHADOW_LIGHT_BUDGET,
} from '../rendering/lighting/lightPacking';
// 新建/换型的缺省值搬去了 lightDefaults —— 画面上摆灯那条入口（authoring/）用的是同一份，
// 两个作者面新建出来的灯必须一模一样。
import { makeLight, nextId, retype } from '../rendering/lighting/lightDefaults';

/**
 * F2「光影」页 —— 灯的**增删改**与逐盏独奏。
 *
 * ## 为什么是独立一页而不是「工具」页里的一个 section
 *
 * 摆灯要反复对着画面调:改一个数、看一眼、再改。挤在一列 section 里,
 * 每次刷新都要重新滚到位置,而且灯表一长就把别的调试块挤没了。
 * 制作人 2026-08-21 明确要求「独立 tab 面板,不是 section」。
 *
 * ## 单位:一律 **wu**(世界空间)
 *
 * 与 NPC / 热区 / spawn 同一把尺;**角色高 150 wu**,估尺寸对着它比。
 * shader 里 march 走的是伪世界 q,那次 transform 在 `packLights` 里折,这里不管。
 * 详见 `agent_docs/runtime/mechanisms/coordinate-spaces.md`。
 *
 * ## 独奏(solo)
 *
 * 「只亮这盏」是验收灯最常用的动作——逐盏看它到底照到哪、影子往哪倒。
 * 独奏是**临时视图状态**，编辑器拉取灯位前会先恢复，不会把别的灯交成关着。
 */

const KIND_LABEL: Record<LightKind, string> = {
  point: '点光',
  spot: '聚光',
  area: '面光',
  directional: '平行光',
};

export interface DebugLightingDeps {
  /** 当前场景的光照参数;没配 lighting / 统一光影没启用时返回 null */
  getParams: () => SceneLightingDef | null;
  /** 打补丁(会触发重算) */
  patch: (part: Partial<SceneLightingDef>) => void;
  /** 重渲染本页 */
  refresh: () => void;
  /** 角色当前的世界坐标(wu),用于「移到角色处」;拿不到返回 null */
  getPlayerWorld: () => [number, number, number] | null;
  /** 场景世界宽度(wu),只用于读数 */
  getWorldWu: () => number;
  /**
   * 与桌面编辑器的同步状态（一行）。**必须显示出来**——
   * 这条通道最坏的坏法不是断，是"断了还以为在同步"，改了半天发现对面根本没收到。
   */
  syncStatus?: () => string;
  /**
   * 运行时编辑模式（在画面上直接拖灯）。prod 构建或还没装配时为 null。
   *
   * 选中态**两边同一个**：这张表里点一行、画面上点一盏灯，指的必须是同一盏，
   * 否则"在画面上选中的"和"表里在编辑的"会是两盏灯，改错了都不知道。
   */
  authoring?: {
    isActive: () => boolean;
    /** 不可用时给出原因（按钮灰着不给理由最气人） */
    availability: () => { ok: boolean; reason: string };
    toggle: () => void;
    selectedId: () => string | null;
    select: (id: string | null) => void;
  } | null;
  log: (message: string) => void;
}

export interface DebugLightingSectionHandle {
  build: () => DebugSectionContent;
  /** 现在是不是在独奏（只亮一盏）。同步拿它当「忙」的判据之一。 */
  isSoloActive: () => boolean;
  /**
   * 交给对面（编辑器）前的修正：把独奏临时关掉的灯还原成真实开关。
   *
   * 不改运行时状态（不强退独奏）——同步是每秒都在跑的，强退会让你刚点开
   * 独奏就被踢出来。只在交出去的那份拷贝上还原。
   */
  exportFixup: (def: SceneLightingDef) => SceneLightingDef;
  /**
   * 当前选中的灯 id。选中态**要过同步** —— 灯一多，编辑器灯表里选的那盏与
   * 画面上高亮的那盏对不上，就等于没法找灯（只能改个参数看画面哪儿变了来反推）。
   */
  getSelectedId: () => string | null;
  /** 套用对面的选中。画面上摆灯那条入口（authoring）也一并跟上。 */
  setSelectedId: (id: string | null) => void;
  dispose: () => void;
}

export function createDebugLightingSection(deps: DebugLightingDeps): DebugLightingSectionHandle {
  /** 选中的灯 id(不是下标——删一盏之后下标会错位) */
  let selected: string | null = null;
  /** 独奏的灯 id;非 null 时其余灯**临时**关掉 */
  let solo: string | null = null;
  /** 独奏前每盏灯的 enabled,退出独奏时还原 */
  let preSolo: Map<string, boolean> | null = null;
  let msg = '';

  const lightsOf = (p: SceneLightingDef): LightDef[] => p.lights ?? [];

  const commit = (p: SceneLightingDef, lights: LightDef[]): void => {
    deps.patch({ lights });
  };

  /** 独奏:记住原状态,只留一盏 enabled。再点一次(或点别的)按需还原。 */
  const applySolo = (p: SceneLightingDef, id: string | null): void => {
    const lights = lightsOf(p);
    if (id === null) {
      if (preSolo) {
        commit(p, lights.map((l) => ({ ...l, enabled: preSolo!.get(l.id) ?? true })));
        preSolo = null;
      }
      solo = null;
      return;
    }
    if (!preSolo) preSolo = new Map(lights.map((l) => [l.id, l.enabled ?? true]));
    solo = id;
    commit(p, lights.map((l) => ({ ...l, enabled: l.id === id })));
  };

  const build = (): DebugSectionContent => {
    const p = deps.getParams();
    if (!p) {
      return {
        text: '这个场景没配 lighting 块,或统一光影没启用。\n'
          + '（编辑器里给场景加 lighting 块 + 跑 `scene-relight --bake` 烘 lighting2/ 载荷）',
      };
    }
    const lights = lightsOf(p);
    // 编辑模式开着时以画面上的选中为准（那边是主操作面，这里是它的参数表）
    const authoring = deps.authoring ?? null;
    if (authoring?.isActive()) selected = authoring.selectedId();
    const shadowCount = lights.filter((l) => (l.enabled ?? true) && l.castShadow).length;
    const over = shadowCount > SHADOW_LIGHT_BUDGET;

    const wrap = document.createElement('div');
    wrap.className = 'debug-dock__section-extra';

    // ---------------------------------------------------------------- 读数
    const head = document.createElement('div');
    head.className = 'debug-dock__slider-hint';
    head.style.whiteSpace = 'pre-wrap';
    head.textContent =
      `灯 ${lights.length} 盏　带影 ${shadowCount}/${SHADOW_LIGHT_BUDGET}`
      + (over ? '  ⚠ 超预算,跑起来会掉帧' : '')
      + `　世界宽 ${deps.getWorldWu().toFixed(0)} wu　角色高 ${CHARACTER_HEIGHT_WU} wu\n`
      + `单位一律 wu（与 NPC 坐标同尺）。对着角色身高估尺寸最可靠。`
      + (solo ? `\n▶ 独奏中：只亮 ${solo}（交给编辑器前会自动还原其余灯）` : '')
      + (deps.syncStatus ? `\n${deps.syncStatus()}` : '')
      + (msg ? `\n${msg}` : '');
    wrap.appendChild(head);

    // ---------------------------------------------------------------- 控件工厂
    const row = (): HTMLDivElement => {
      const d = document.createElement('div');
      d.style.display = 'flex';
      d.style.gap = '6px';
      d.style.alignItems = 'center';
      d.style.flexWrap = 'wrap';
      d.style.margin = '3px 0';
      return d;
    };
    const label = (t: string, w = '76px'): HTMLSpanElement => {
      const s = document.createElement('span');
      s.textContent = t;
      s.style.minWidth = w;
      s.style.opacity = '0.75';
      return s;
    };
    const btn = (t: string, fn: () => void, title = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      if (title) b.title = title;
      b.className = 'debug-dock__btn';
      b.addEventListener('click', fn);
      return b;
    };
    const num = (
      get: () => number, set: (v: number) => void,
      step = 1, width = '82px', title = '',
    ): HTMLInputElement => {
      const i = document.createElement('input');
      i.type = 'number';
      i.step = String(step);
      i.value = String(Math.round(get() * 1000) / 1000);
      i.style.width = width;
      if (title) i.title = title;
      // change 而不是 input:拖着改会每个中间值触发一次重算(脏时全屏重打光)
      i.addEventListener('change', () => {
        const v = Number(i.value);
        if (Number.isFinite(v)) { set(v); deps.refresh(); }
      });
      return i;
    };
    const check = (t: string, get: () => boolean, set: (v: boolean) => void): HTMLLabelElement => {
      const l = document.createElement('label');
      l.style.display = 'inline-flex';
      l.style.gap = '4px';
      l.style.alignItems = 'center';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = get();
      c.addEventListener('change', () => { set(c.checked); deps.refresh(); });
      l.appendChild(c);
      l.appendChild(document.createTextNode(t));
      return l;
    };
    const hint = (t: string): void => {
      const h = document.createElement('div');
      h.className = 'debug-dock__slider-hint';
      h.textContent = t;
      h.style.marginTop = '8px';
      wrap.appendChild(h);
    };

    // ---------------------------------------------------------------- 编辑模式入口
    if (authoring) {
      const avail = authoring.availability();
      const on = authoring.isActive();
      hint(on
        ? '⏸ 编辑模式开着：游戏已冻结，直接在画面上拖灯。Esc/F3 退出。\n'
          + '落盘在编辑器：场景页 → 统一光影 →「从运行时拉取灯位」，再 Save All'
        : '⏵ 在画面上摆灯：进入后游戏冻结、自由相机，拖灯即改 pos。快捷键 F3');
      const em = row();
      const b = btn(
        on ? '退出编辑模式' : '进入编辑模式（在画面上摆灯）',
        () => { authoring.toggle(); deps.refresh(); },
        on ? '退出（有未被编辑器拉走的改动会先问）' : avail.reason,
      );
      if (!avail.ok && !on) {
        b.disabled = true;
        b.style.opacity = '0.5';
      }
      em.appendChild(b);
      wrap.appendChild(em);
      if (!avail.ok && !on) {
        const why = document.createElement('div');
        why.className = 'debug-dock__slider-hint';
        why.style.whiteSpace = 'pre-wrap';
        why.textContent = `不可用：${avail.reason}`;
        wrap.appendChild(why);
      }
    }

    // ---------------------------------------------------------------- 新建
    hint('① 新建（放在画面中心上方一个人高处，建好用「移到角色处」或改 pos 挪走）');
    const mk = row();
    (['point', 'spot', 'area', 'directional'] as LightKind[]).forEach((k) => {
      mk.appendChild(btn(`+ ${KIND_LABEL[k]}`, () => {
        const l = makeLight(lights, k);
        commit(p, [...lights, l]);
        selected = l.id;
        authoring?.select(l.id);
        msg = `新建 ${l.id}（${KIND_LABEL[k]}）`;
        deps.refresh();
      }));
    });
    wrap.appendChild(mk);

    // ---------------------------------------------------------------- 灯表
    hint('② 灯表　　点行选中｜◉ 独奏（只亮这盏）｜✓ 开关');
    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '2px';
    list.style.margin = '4px 0';
    for (const l of lights) {
      const r = row();
      r.style.margin = '0';
      r.style.padding = '2px 4px';
      r.style.borderRadius = '3px';
      if (l.id === selected) r.style.background = 'rgba(185,120,54,0.22)';

      r.appendChild(check('', () => l.enabled ?? true, (v) => {
        if (solo) { applySolo(p, null); }
        commit(p, lights.map((x) => (x.id === l.id ? { ...x, enabled: v } : x)));
      }));
      r.appendChild(btn(l.id === solo ? '◉' : '○', () => {
        applySolo(p, l.id === solo ? null : l.id);
        selected = l.id;
        authoring?.select(l.id);
        msg = l.id === solo ? `独奏 ${l.id}` : '退出独奏';
        deps.refresh();
      }, '只亮这盏（临时，存盘前自动还原）'));

      const tag = document.createElement('span');
      tag.textContent = KIND_LABEL[l.kind] ?? l.kind;
      tag.style.minWidth = '44px';
      tag.style.opacity = '0.7';
      r.appendChild(tag);

      const name = btn(l.id, () => {
        selected = l.id;
        authoring?.select(l.id);
        deps.refresh();
      });
      name.style.minWidth = '92px';
      r.appendChild(name);

      const info = document.createElement('span');
      info.style.opacity = '0.6';
      info.textContent = `I=${l.intensity}　${l.kelvin ?? '-'}K`
        + (l.castShadow ? '　影' : '');
      r.appendChild(info);
      list.appendChild(r);
    }
    if (lights.length === 0) {
      const e = document.createElement('div');
      e.className = 'debug-dock__slider-hint';
      e.textContent = '（还没有灯）';
      list.appendChild(e);
    }
    wrap.appendChild(list);

    const bulk = row();
    bulk.appendChild(btn('全部点亮', () => {
      applySolo(p, null);
      commit(p, lights.map((l) => ({ ...l, enabled: true })));
      msg = '全部点亮'; deps.refresh();
    }));
    bulk.appendChild(btn('全部熄灭', () => {
      applySolo(p, null);
      commit(p, lights.map((l) => ({ ...l, enabled: false })));
      msg = '全部熄灭（只剩天光——这就是"不打灯的纯夜"）'; deps.refresh();
    }));
    wrap.appendChild(bulk);

    // ---------------------------------------------------------------- 选中灯的编辑器
    const cur = lights.find((l) => l.id === selected) ?? null;
    if (cur) {
      const put = (patchLight: Partial<LightDef>): void => {
        commit(p, lights.map((x) => (x.id === cur.id ? { ...x, ...patchLight } : x)));
      };

      hint(`③ 编辑 ${cur.id}（${KIND_LABEL[cur.kind]}）`);

      const idRow = row();
      idRow.appendChild(label('id'));
      const idIn = document.createElement('input');
      idIn.type = 'text';
      idIn.value = cur.id;
      idIn.style.width = '130px';
      idIn.addEventListener('change', () => {
        const v = idIn.value.trim();
        if (!v || lights.some((x) => x.id === v && x.id !== cur.id)) {
          msg = 'id 不能为空或与别的灯重复'; deps.refresh(); return;
        }
        commit(p, lights.map((x) => (x.id === cur.id ? { ...x, id: v } : x)));
        if (solo === cur.id) solo = v;
        selected = v; deps.refresh();
      });
      idRow.appendChild(idIn);

      const kindSel = document.createElement('select');
      (['point', 'spot', 'area', 'directional'] as LightKind[]).forEach((k) => {
        const o = document.createElement('option');
        o.value = k; o.textContent = KIND_LABEL[k];
        if (k === cur.kind) o.selected = true;
        kindSel.appendChild(o);
      });
      kindSel.addEventListener('change', () => {
        const k = kindSel.value as LightKind;
        commit(p, lights.map((x) => (x.id === cur.id ? retype(x, k) : x)));
        msg = `${cur.id} → ${KIND_LABEL[k]}（已换掉该灯型不需要的字段）`;
        deps.refresh();
      });
      idRow.appendChild(kindSel);
      idRow.appendChild(check('投影', () => cur.castShadow ?? false,
        (v) => put({ castShadow: v })));
      wrap.appendChild(idRow);

      const iRow = row();
      iRow.appendChild(label('强度 / 色温'));
      iRow.appendChild(num(() => cur.intensity, (v) => put({ intensity: v }), 0.1));
      iRow.appendChild(num(() => cur.kelvin ?? 2400, (v) => put({ kelvin: v }), 50, '82px',
        '色温 K。1800≈烛火 2400≈灯笼 5200≈月 6500≈天光'));
      wrap.appendChild(iRow);

      if (cur.kind !== 'directional') {
        const pos = cur.pos ?? [0, 0, 0];
        const pRow = row();
        pRow.appendChild(label('位置 wu'));
        (['x', 'y', 'z'] as const).forEach((axis, i) => {
          pRow.appendChild(num(() => pos[i], (v) => {
            const np: [number, number, number] = [pos[0], pos[1], pos[2]];
            np[i] = v; put({ pos: np });
          }, 10, '76px', `${axis}（wu，世界空间；y 是高度，角色高 ${CHARACTER_HEIGHT_WU}）`));
        });
        pRow.appendChild(btn('移到角色处', () => {
          const w = deps.getPlayerWorld();
          if (!w) { msg = '拿不到角色世界坐标（没进场景？）'; deps.refresh(); return; }
          put({ pos: [w[0], w[1] + CHARACTER_HEIGHT_WU * 1.6, w[2]] });
          msg = `${cur.id} 移到角色头顶`;
        }, '放到角色所在处，抬高到 1.6 个人高（街灯的高度）'));
        wrap.appendChild(pRow);

        const rRow = row();
        rRow.appendChild(label('半径 wu'));
        rRow.appendChild(num(() => cur.range ?? DEFAULT_LIGHT_RANGE_WU,
          (v) => put({ range: v }), 10, '82px',
          `作用半径（wu）。${DEFAULT_LIGHT_RANGE_WU} ≈ 3 个人高`));
        // 面光**不吃**软化半径（`lcAreaLight` 的参数表里没有它，只有点/聚光
        // 走的 `lcFalloff` 用）。连标签一起收掉——只留一个光秃秃的「发光体」
        // 标签比留着输入框更让人以为是坏了。
        if (cur.kind === 'point' || cur.kind === 'spot') {
          rRow.appendChild(label('发光体', '54px'));
          rRow.appendChild(num(() => cur.softeningRadius ?? DEFAULT_LAMP_RADIUS_WU,
            (v) => put({ softeningRadius: v }), 1, '70px',
            '发光体半径（wu）。进 1/(r²+c²) 防贴脸核爆。调大 = 光斑变平摊'));
        }
        wrap.appendChild(rRow);
      }

      if (cur.kind === 'spot') {
        const sRow = row();
        sRow.appendChild(label('锥角 内/外'));
        sRow.appendChild(num(() => cur.innerAngleDeg ?? 25,
          (v) => put({ innerAngleDeg: v }), 1, '70px', '内锥角（度）'));
        // ⚠ 缺省 **40**，不是 45：`packLights` 里写的是 `?? 40`。
        //   面板兜底与它不一致的话，一盏没显式填过外角的灯会显示 45、渲成 40，
        //   而且人一碰这个框就把 45 写进了数据 —— 看着"没改"，实际改了。
        sRow.appendChild(num(() => cur.outerAngleDeg ?? 40,
          (v) => put({ outerAngleDeg: v }), 1, '70px', '外锥角（度，须 ≥ 内角、< 90）'));
        wrap.appendChild(sRow);
        // 同上：packLights 的兜底是 [0,0,-1]（`l.dir ?? l.orientation ?? [0,0,-1]`）
        const d = cur.dir ?? [0, 0, -1];
        const dRow = row();
        dRow.appendChild(label('射出方向'));
        (['x', 'y', 'z'] as const).forEach((axis, i) => {
          dRow.appendChild(num(() => d[i], (v) => {
            const nd: [number, number, number] = [d[0], d[1], d[2]];
            nd[i] = v; put({ dir: nd });
          }, 0.1, '66px', `方向 ${axis}（不必归一）`));
        });
        wrap.appendChild(dRow);
      }

      if (cur.kind === 'area') {
        const sz = cur.size ?? [1, 1];
        const aRow = row();
        aRow.appendChild(label('尺寸 / 自转'));
        aRow.appendChild(num(() => sz[0], (v) => put({ size: [v, sz[1]] }), 10, '76px', '宽（wu）'));
        aRow.appendChild(num(() => sz[1], (v) => put({ size: [sz[0], v] }), 10, '76px', '高（wu）'));
        aRow.appendChild(num(() => cur.rollDeg ?? 0,
          (v) => put({ rollDeg: v }), 5, '70px',
          '自转（度）：矩形绕自身法线转。没有它，横竖是从法线推出来的，斜窗表达不了'));
        aRow.appendChild(check('双面发光', () => cur.twoSided ?? false,
          (v) => put({ twoSided: v })));
        wrap.appendChild(aRow);
        const o = cur.orientation ?? [0, 0, -1];
        const oRow = row();
        oRow.appendChild(label('朝向'));
        (['x', 'y', 'z'] as const).forEach((axis, i) => {
          oRow.appendChild(num(() => o[i], (v) => {
            const no: [number, number, number] = [o[0], o[1], o[2]];
            no[i] = v; put({ orientation: no });
          }, 0.1, '66px', `法线 ${axis}`));
        });
        wrap.appendChild(oRow);
      }

      if (cur.kind === 'directional') {
        const dRow = row();
        dRow.appendChild(label('仰角 / 方位'));
        dRow.appendChild(num(() => cur.elevationDeg ?? 45,
          (v) => put({ elevationDeg: v }), 1, '70px', '仰角（度）'));
        dRow.appendChild(num(() => cur.azimuthDeg ?? 180,
          (v) => put({ azimuthDeg: v }), 1, '70px', '方位（度，0 = 画面深处，90 = 右）'));
        wrap.appendChild(dRow);
      }

      const opRow = row();
      opRow.appendChild(btn('复制一盏', () => {
        const copy: LightDef = { ...cur, id: nextId(lights, cur.kind) };
        if (cur.pos) copy.pos = [...cur.pos];
        commit(p, [...lights, copy]);
        selected = copy.id; msg = `复制出 ${copy.id}`; deps.refresh();
      }));
      opRow.appendChild(btn('删除这盏', () => {
        if (solo === cur.id) { solo = null; preSolo = null; }
        commit(p, lights.filter((x) => x.id !== cur.id));
        selected = null; authoring?.select(null); msg = `已删 ${cur.id}`; deps.refresh();
      }));
      wrap.appendChild(opRow);
    } else if (lights.length > 0) {
      hint('③ 点灯表里的 id 选一盏来编辑');
    }

    // ---------------------------------------------------------------- 快捷旋钮
    // 只放两个:制作人验收时最先要动的就是这两个。完整参数在下面那块「统一光影（场景）」。
    hint('④ 快捷（完整参数见本页下方「统一光影（场景）」）');
    const em = p.emissive ?? { gain: 0 };
    const d = p.display;
    const q = row();
    q.appendChild(label('灯体发光'));
    q.appendChild(num(() => em.gain ?? 0,
      (v) => deps.patch({ emissive: { ...em, gain: v } }), 0.1, '70px',
      '灯**本身**看得见的那团亮 + 大气光晕。0 = 完全关掉。它不是照明，是画上去的发光体'));
    q.appendChild(btn('光晕清零', () => {
      deps.patch({ emissive: { ...em, gain: 0 } });
      msg = '灯体发光已关（画面里只剩真正的照明）'; deps.refresh();
    }, '一键把灯体发光与光晕关掉，只看纯照明'));
    q.appendChild(label('EV', '32px'));
    q.appendChild(num(() => d.ev, (v) => deps.patch({ display: { ...d, ev: v } }), 0.1, '70px',
      'filmic 在高端是压缩的——EV 调过头会把高光压成同一个值，看着就是"过爆"'));
    q.appendChild(label('天光', '38px'));
    q.appendChild(num(() => p.sky.intensity,
      (v) => deps.patch({ sky: { ...p.sky, intensity: v } }), 0.005, '76px',
      '夜景基调：不打灯时有多黑'));
    wrap.appendChild(q);

    return {
      text: '',
      extra: wrap,
    };
  };

  return {
    build,
    getSelectedId: () => selected,
    setSelectedId: (id) => {
      if (id === selected) return;
      selected = id;
      // 画面上摆灯那条入口与本页共用同一个选中态，两边必须一起跟
      deps.authoring?.select(id);
      deps.refresh();
    },
    isSoloActive: () => solo !== null,
    exportFixup: (def) => {
      if (!solo || !preSolo) return def;
      return { ...def, lights: def.lights.map((l) => ({ ...l, enabled: preSolo!.get(l.id) ?? true })) };
    },
    dispose: () => { selected = null; solo = null; preSolo = null; },
  };
}
