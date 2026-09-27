/**
 * 场景前景图层的**数据解析**（纯函数；装配与渲染在 `SceneForegroundLayers`）。
 *
 * 前景层 = 「蒙版 + 接地线」：蒙版里每个像素当成立在接地线上、朝相机的直立面，按与角色直立 quad **同一个**
 * 深度梯度现算深度，蒙版内**顶替深度图**参与遮挡——逐像素判，站位 / 部位不同答案就不同，被挡部分按深度遮挡
 * 同一个虚影系数画。见 [[scene-foreground-layers]]。
 *
 * 本期只有 `swayPlant` 一种来源：引用拆层里的一株植物。⚠ 数据里**不存实例 id**（每次重烘都会变），
 * 存「原画像素坐标」——落在这株植物上的任意一点；运行时查 `sway_ids.png` 得实例
 * （与 `sway_overrides.json` 同一口径：点正好不在任何一株上就往外找 {@link FG_SWAY_SNAP_PX} 像素内最近的一株）。
 */
import type { SceneForegroundBaseDef, SceneForegroundLayerDef } from '../../data/types';

/** 与 `tools/character_lighting_lab/sway_field.py` 的 `OVERRIDE_SNAP_PX` 同一个数（原画像素） */
export const FG_SWAY_SNAP_PX = 24;

/** 网格范围在「本株此刻的最大位移」之外再多留的余量（场景 wu）：覆盖图膨胀 + 一点保险 */
export const FG_RECT_EXTRA_PAD = 8;
/** 位移按几 wu 一档量化后再定范围：变档才改网格（树逐帧摆，网格不逐帧传顶点） */
export const FG_RECT_DISP_STEP = 8;
/** 接地线沿 x 采几个点交给覆盖图着色（着色里按 x 线性插值）；与 GLSL 里的数组长度同一个数 */
export const FG_BASE_SAMPLES = 32;
/** 接地采样的 x 范围在该株 bbox 两侧各外扩多少（场景 wu）：兜住摆动与覆盖图膨胀 */
export const FG_BASE_X_MARGIN = 256;

/** 位移 → 量化后的外扩量（向上取整到一档，所以量化后的范围永远兜得住真实位移） */
export function quantizeForegroundDisplacement(d: number): number {
  return Math.ceil(Math.max(0, d) / FG_RECT_DISP_STEP) * FG_RECT_DISP_STEP;
}

/**
 * 覆盖图网格的范围：该株 bbox 外扩「此刻的最大位移 + 余量」，钳在场景内。
 * 位移取这株**网格顶点此刻的真实最大位移**（`SwayBackground.instanceDisplacement`）：植物像素都在网格三角形里，
 * 像素的位移是三个顶点位移的凸组合，不会超过顶点的最大值——这是精确上界。
 * ⚠ 别按"增益开到顶"的上限铺（网格成了树的三倍大，白费 GPU），
 *   也别按位移软封顶铺：封顶约束的是转角 × 株长，投到屏幕上透视会放大，强阵风里树梢会摆出网格。
 */
export function foregroundRect(
  bbox: readonly [number, number, number, number], maxDisplacement: number, sceneSize: readonly [number, number],
): [number, number, number, number] {
  const pad = Math.max(0, maxDisplacement) + FG_RECT_EXTRA_PAD;
  return [
    Math.max(0, bbox[0] - pad), Math.max(0, bbox[1] - pad),
    Math.min(sceneSize[0], bbox[2] + pad), Math.min(sceneSize[1], bbox[3] + pad),
  ];
}

/** 解析后的一层（场景 wu） */
export interface ResolvedForegroundLayer {
  id: string;
  label: string;
  /** 拆层实例 id（本次装载有效；重烘后重新解析） */
  instId: number;
  /** 接地点（整层一个点时用；缺省 = 该株的根） */
  baseX: number;
  baseY: number;
  /** 接地折线（按 x 升序；给了就逐列取它，不看 baseX / baseY） */
  baseLine: [number, number][] | null;
  /** 网格范围 [x0, y0, x1, y1]（已钳到场景内；按解析那一刻的位移，之后由前景层逐帧跟） */
  rect: [number, number, number, number];
  /** 该株的包围盒（场景 wu）：位移变了按它重算范围 */
  bbox: [number, number, number, number];
}

/** 拆层里解析 `at` 要的那几样（`BackgroundSwayInput` 的子集，测试里给普通对象） */
export interface ForegroundSwaySource {
  /** 实例 id 图的 CPU 副本（RGBA，R + 256·G = 实例 id；可以是降采样的） */
  ids: { data: ArrayLike<number>; w: number; h: number } | null;
  /** 原画像素尺寸（`at` 的坐标系） */
  paintSize: readonly [number, number];
  /** 场景世界尺寸（实例 root / bbox 的坐标系） */
  sceneSize: readonly [number, number];
  instances: ReadonlyArray<{
    id: number;
    root: readonly [number, number];
    bbox: readonly [number, number, number, number];
  }>;
  /** 此刻的位移软封顶（场景 wu）：`0.8 × 补带 × clamp(草木增益, 1, 4)`；没给 `displacementOf` 时按它铺范围 */
  maxDisplacement: number;
  /** 某株网格顶点此刻的真实最大位移（场景 wu）；给了就按它铺范围（精确上界，见 {@link foregroundRect}） */
  displacementOf?: (instId: number) => number;
}

/**
 * 前景面的深度模型（由 `SceneDepthSystem.foregroundDepthModel` 给）：与遮挡滤镜里角色直立 quad **同一套**——
 * 行走面深度场取接地深度，`uprightPerY` = 深度梯度 × 世界→深度图像素（每往下 1 wu 深多少，直立面往上越近）。
 */
export interface ForegroundDepthModel {
  uprightPerY: number;
  /** 场景点处的行走面深度（与滤镜的脚点深度同一个函数）；场外 / 没有场 ⇒ null */
  groundAt: (x: number, y: number) => number | null;
}

/** 一层的接地采样：x 范围上等距 {@link FG_BASE_SAMPLES} 个点，交错存 [接地 y, 接地深度] */
export interface ForegroundBaseSamples {
  x0: number;
  x1: number;
  data: Float32Array;
  /** 各点接地深度的平均（多层叠覆盖图时按它远→近排） */
  meanDepth: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 按 x 升序的折线在 x 处的 y（两端外按端点延伸） */
export function baseLineY(line: readonly (readonly [number, number])[], x: number): number {
  if (x <= line[0][0]) return line[0][1];
  const n = line.length;
  if (x >= line[n - 1][0]) return line[n - 1][1];
  for (let i = 1; i < n; i++) {
    const [x1, y1] = line[i];
    if (x <= x1) {
      const [x0, y0] = line[i - 1];
      return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
    }
  }
  return line[n - 1][1];
}

/**
 * 前景面在场景点 (x, y) 的深度：立在 (x 那一列的) 接地点上、朝相机的直立面。
 * 与滤镜里角色的 `脚点深度 + 深度梯度 × (像素 y − 脚底 y)` 同一个式子——两块直立面放在一起比，才谈得上谁挡谁。
 */
export function foregroundSurfaceDepth(baseY: number, baseDepth: number, uprightPerY: number, y: number): number {
  return baseDepth + uprightPerY * (y - baseY);
}

/**
 * 一层的接地采样（给覆盖图着色）。接地点那一种：整层同一个接地 y、同一个接地深度（树立在树根那一点上，
 * 不是"树根那一行"——所以深度不随 x 变）；折线那一种：逐列取折线的点、各取各的行走面深度。
 * 取不到行走面深度的点用最近的有效点补；一个有效点都没有 ⇒ null（没有行走面场，这层判不了）。
 */
export function foregroundBaseSamples(
  layer: Pick<ResolvedForegroundLayer, 'baseX' | 'baseY' | 'baseLine' | 'bbox'>,
  model: ForegroundDepthModel,
  sceneSize: readonly [number, number],
  n = FG_BASE_SAMPLES,
): ForegroundBaseSamples | null {
  const x0 = Math.max(0, layer.bbox[0] - FG_BASE_X_MARGIN);
  const x1 = Math.min(sceneSize[0], layer.bbox[2] + FG_BASE_X_MARGIN);
  const data = new Float32Array(n * 2);
  if (!layer.baseLine) {
    const d = model.groundAt(layer.baseX, layer.baseY);
    if (d === null || !Number.isFinite(d)) return null;
    for (let i = 0; i < n; i++) { data[i * 2] = layer.baseY; data[i * 2 + 1] = d; }
    return { x0, x1, data, meanDepth: d };
  }
  const ok: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / Math.max(n - 1, 1);
    const y = baseLineY(layer.baseLine, x);
    const d = model.groundAt(x, y);
    data[i * 2] = y;
    ok[i] = d !== null && Number.isFinite(d);
    data[i * 2 + 1] = ok[i] ? (d as number) : 0;
  }
  if (!ok.some(Boolean)) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (!ok[i]) {
      let best = -1;
      for (let k = 1; k < n && best < 0; k++) {
        if (i - k >= 0 && ok[i - k]) best = i - k;
        else if (i + k < n && ok[i + k]) best = i + k;
      }
      data[i * 2 + 1] = data[best * 2 + 1];
    }
    sum += data[i * 2 + 1];
  }
  return { x0, x1, data, meanDepth: sum / n };
}

/** `base` 字段 → 合法形状（坏了返回错误说明）。折线按 x 排好序，x 相同的点只留第一个 */
function normalizeBase(raw: unknown): { base?: SceneForegroundBaseDef; error?: string } {
  if (raw === undefined) return {};
  const b = raw as { x?: unknown; y?: unknown; line?: unknown } | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'base 须为对象 {x?, y?, line?}' };
  if (b.x !== undefined && !isNum(b.x)) return { error: 'base.x 须为数' };
  if (b.y !== undefined && !isNum(b.y)) return { error: 'base.y 须为数' };
  const out: SceneForegroundBaseDef = {};
  if (isNum(b.x)) out.x = b.x;
  if (isNum(b.y)) out.y = b.y;
  if (b.line !== undefined) {
    if (!Array.isArray(b.line) || b.line.length < 2
      || !b.line.every((p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]))) {
      return { error: 'base.line 须为至少两个 [x, y] 点（场景 wu）' };
    }
    const pts = (b.line as [number, number][]).map((p) => [p[0], p[1]] as [number, number])
      .sort((p, q) => p[0] - q[0]);
    const line = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0]);
    if (line.length < 2) return { error: 'base.line 至少要两个 x 不同的点' };
    out.line = line;
  }
  return { base: out };
}

/**
 * 场景 JSON 的 `foregroundLayers` → 合法的定义表。非法项丢弃并经 `warn` 说一次（不抛）：
 * 运行时对内容错误容错跳过、dev 下出声；拦截在校验器（`tools/editor/validator.py`）。
 */
export function normalizeForegroundLayerDefs(
  raw: unknown, warn: (msg: string) => void,
): SceneForegroundLayerDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn('foregroundLayers 须为数组，整份忽略');
    return [];
  }
  const out: SceneForegroundLayerDef[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const r = item as Partial<SceneForegroundLayerDef> | null;
    if (!r || typeof r !== 'object') { warn(`foregroundLayers[${i}] 不是对象，跳过`); return; }
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) { warn(`foregroundLayers[${i}] 缺 id，跳过`); return; }
    if (seen.has(id)) { warn(`foregroundLayers 里 id「${id}」重复，后一个跳过`); return; }
    const src = r.source as { kind?: unknown; at?: unknown } | undefined;
    if (!src || src.kind !== 'swayPlant') {
      warn(`前景层「${id}」的 source.kind ${JSON.stringify(src?.kind)} 不认识（本期只有 swayPlant），跳过`);
      return;
    }
    const at = src.at;
    if (!Array.isArray(at) || at.length !== 2 || !isNum(at[0]) || !isNum(at[1])) {
      warn(`前景层「${id}」的 source.at 须为两个数 [x, y]（原画像素），跳过`);
      return;
    }
    const { base, error } = normalizeBase(r.base);
    if (error) { warn(`前景层「${id}」的 ${error}，跳过`); return; }
    seen.add(id);
    const def: SceneForegroundLayerDef = { id, source: { kind: 'swayPlant', at: [at[0], at[1]] } };
    if (typeof r.label === 'string' && r.label.trim()) def.label = r.label.trim();
    if (base) def.base = base;
    out.push(def);
  });
  return out;
}

/**
 * 原画像素点 → 拆层实例 id（0 = 找不到）。id 图可以是降采样的副本：点按比例落到它的格子上，
 * 吸附半径也按比例缩。与烘焙端 `owner_at` 同形：点在某株上就是它，否则找 `snapPx` 内最近的一株。
 */
export function swayInstanceAtPaint(
  ids: { data: ArrayLike<number>; w: number; h: number },
  paintSize: readonly [number, number],
  at: readonly [number, number],
  snapPx = FG_SWAY_SNAP_PX,
): number {
  const { data, w, h } = ids;
  const kx = w / Math.max(paintSize[0], 1), ky = h / Math.max(paintSize[1], 1);
  const xi = Math.floor(at[0] * kx), yi = Math.floor(at[1] * ky);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0;
  const idAt = (x: number, y: number): number => {
    const o = (y * w + x) * 4;
    return data[o] + 256 * data[o + 1];
  };
  const here = idAt(xi, yi);
  if (here) return here;
  const snap = Math.max(1, Math.round(snapPx * Math.max(kx, ky)));
  let best = 0, bd = Infinity;
  for (let y = Math.max(0, yi - snap); y <= Math.min(h - 1, yi + snap); y++) {
    for (let x = Math.max(0, xi - snap); x <= Math.min(w - 1, xi + snap); x++) {
      const id = idAt(x, y);
      if (!id) continue;
      const d = (x - xi) * (x - xi) + (y - yi) * (y - yi);
      if (d < bd) { bd = d; best = id; }
    }
  }
  return bd <= snap * snap ? best : 0;
}

/**
 * 定义 + 本场景的拆层 → 可以装配的层。解析不了的层（点不在任何一株上 / 该株不在这份拆层里）
 * 经 `warn` 说出来并跳过。
 *
 * 接地点缺省取该株的 root（场景 wu，拆层烘焙时就是按原画 → 场景比例换算好的）；
 * 写了 `base.x` / `base.y` 就覆盖对应那一项，写了 `base.line` 就逐列取折线。
 * 网格范围 = 该株 bbox 外扩「此刻的最大位移 + 余量」（{@link foregroundRect}）：树摆开之后画到的每一个像素都还在网格里。
 */
export function resolveForegroundLayers(
  defs: readonly SceneForegroundLayerDef[],
  sway: ForegroundSwaySource,
  warn: (msg: string) => void,
): ResolvedForegroundLayer[] {
  if (defs.length === 0) return [];
  if (!sway.ids) {
    warn('拆层没有 CPU 版的实例 id 图，前景层全部跳过');
    return [];
  }
  const byId = new Map(sway.instances.map((d) => [d.id, d]));
  const out: ResolvedForegroundLayer[] = [];
  for (const def of defs) {
    const at = def.source.at;
    if (at[0] < 0 || at[1] < 0 || at[0] >= sway.paintSize[0] || at[1] >= sway.paintSize[1]) {
      warn(`前景层「${def.id}」的 source.at (${at[0]}, ${at[1]}) 在原画 ${sway.paintSize[0]}×${sway.paintSize[1]} 之外，跳过`);
      continue;
    }
    const instId = swayInstanceAtPaint(sway.ids, sway.paintSize, at);
    const inst = instId ? byId.get(instId) : undefined;
    if (!inst) {
      warn(instId
        ? `前景层「${def.id}」的点落在实例 ${instId} 上，但这份拆层里没有它，跳过`
        : `前景层「${def.id}」的点 (${at[0]}, ${at[1]}) 附近 ${FG_SWAY_SNAP_PX} 像素内没有任何一株植物，跳过（重烘后分割变了？）`);
      continue;
    }
    const bbox: [number, number, number, number] = [inst.bbox[0], inst.bbox[1], inst.bbox[2], inst.bbox[3]];
    const disp = quantizeForegroundDisplacement(sway.displacementOf ? sway.displacementOf(instId) : sway.maxDisplacement);
    const rect = foregroundRect(bbox, disp, sway.sceneSize);
    if (!(rect[2] > rect[0] && rect[3] > rect[1])) {
      warn(`前景层「${def.id}」的范围是空的（bbox ${inst.bbox.join(',')}），跳过`);
      continue;
    }
    out.push({
      id: def.id,
      label: def.label ?? def.id,
      instId,
      baseX: def.base?.x ?? inst.root[0],
      baseY: def.base?.y ?? inst.root[1],
      baseLine: def.base?.line ? def.base.line.map((p) => [p[0], p[1]] as [number, number]) : null,
      rect,
      bbox,
    });
  }
  return out;
}
