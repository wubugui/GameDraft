"""编辑器侧"这支挂件此刻长什么样"的解析：挂点标注面板与挂件预设页的预览共用。

⚠ 本模块是运行时 ``src/data/propPresets.ts`` 里 ``parsePropPresets`` 的清洗口径
+ ``resolvePropStateName`` + ``resolvePropAttach`` 贴图/摆放那一半的**跨语言镜像**，
以及 ``src/data/resolveAnimationSet.ts::resolveAnimationWorldSize`` 的镜像。
两边答案必须一致（``test_prop_preview.py`` 按 TS 测试同一组用例钉死；norms 第 8 条）——
预览与游戏不一致就是"编辑器里对齐了、游戏里歪着"。

只镜像预览要用的那几项（贴图、支点、自转、缩放、挂点驱动帧号，以及 2026-09-15 起的
**起火点 / 燃烧强度 / 火苗**与状态的「进入时动作」）；灯 / 效果 / 持久化与预览无关，
不在这里重写一遍。

燃烧物与火苗的清洗口径以数据契约（TS 权威 ``propPresets.ts``）为准：

- ``firePoint``：长度 ≥2 且前两项是有限数 → 各自夹到 0..1；否则当没写；
- ``burn``：有限数 → 夹到 0..1；否则当没写（合并：状态 → 基础块 → 1）；
- ``windShelter``：挡风比例，清洗同 ``burn``（合并：状态 → 基础块 → **0**）。火苗处气流乘
  ``1 − windShelter``（护火），**只影响火苗倾斜、不碰灯**；预览无风，所以只解析不画；
- ``flame``：``image`` 空串/非串、或 ``height`` ≤0/非有限 ⇒ **整块作废**；
  ``cols`` trunc 后 ≥1 否则 1、``frames`` trunc 后 ≥1 否则 = cols、``fps`` >0 有限否则 24；
- ``particles``（契约 v3，取代旧 ``vfx``）：粒子挂载 ``[{effect, point?}]``。条目须为对象且 ``effect`` 为
  非空串，否则丢该条；``point`` 同 firePoint 清洗（没写 = None：运行时落到 firePoint → 挂点本身）。
  **状态写了 ``particles`` 键就整体替换基础块那一串**（空数组 = 这个状态没有粒子），没写键沿用基础块；
- ``burn`` / ``windShelter`` 同时驱动帧动画火苗与该状态**全部**粒子挂载（发射率 × 闪烁、新生大小 burn^0.4、
  吃场景风 × (1 − windShelter)），都不碰灯；
- ``onEnterActions``：只在状态里有，基础块没有这个键。
- ``burnable``（可燃挂件，2026-09-16 A3.8 模板 + 实例）：开了 ⇒ 图取模板、挂点对准模板握点、
  ``scale = widthCm·0.88 / texW × 预设 scale``（``burnable_prop_placement``）；``BURNABLE_EXCLUSIVE_KEYS`` 与可燃互斥，
  ``BURNABLE_TAKEN_OVER_KEYS`` 被模板接管（写了不画）。
- ``blowout``（风吹灭，基础块 / 状态）的越线动作 ``onEmberActions`` / ``onOutActions`` 与 ``onEnterActions``
  一样会被运行时真执行（顶层 ``playPropVfx`` 同样注入"这件挂件"）——**全部**会执行的动作列表位置
  一律从 ``iter_prop_preset_action_lists`` 取，别在各扫描面再手写一份。
"""
from __future__ import annotations

import math
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

#: 摆放字段的运行时缺省（`SpriteEntity.syncAttachments` 里的 `?? 0.5` / `?? 1` / `?? 0`）
PLACEMENT_DEFAULTS: dict[str, float] = {"anchorX": 0.5, "anchorY": 0.5, "rotation": 0.0, "scale": 1.0}

#: 动画包 worldWidth / worldHeight 都没写时运行时用的宽（`DEFAULT_WORLD_WIDTH`）
DEFAULT_WORLD_WIDTH = 100.0

#: `burn` 没写（状态与基础块都没写 / 写坏了）时的燃烧强度
BURN_DEFAULT = 1.0
#: `windShelter` 没写时的挡风比例（不挡风）
WIND_SHELTER_DEFAULT = 0.0
#: `flame.fps` 缺省 / 非法时的帧率
FLAME_DEFAULT_FPS = 24.0


def _finite(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


#: 「键不存在」的哨兵（JS 里读到 `undefined`，`Number(undefined)` 是 NaN；而 `null` 是 0，两者不能混）
ABSENT = object()

_JS_DECIMAL_RE = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")
_JS_RADIX_RE = re.compile(r"^0(?:[xX](?P<hex>[0-9a-fA-F]+)|[oO](?P<oct>[0-7]+)|[bB](?P<bin>[01]+))$")


def js_number(v: object) -> float | None:
    """`propPresets.ts::finiteOrUndefined` 的镜像：`Number(v)`，有限才返回，否则 None。

    JS 的强转不是"只认数"：`null`→0、`true`→1、`"0.5"`→0.5、`""`→0、`[]`→0、`[7]`→7，
    键不存在（`ABSENT`，即 `undefined`）→NaN。镜像不跟着这套走，预览就会与游戏答案不同
    （例：`burn: null` 运行时是**火灭**，只认数的镜像却当没写、按满火画）。
    """
    if v is ABSENT:
        return None
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return 0.0
        if _JS_DECIMAL_RE.match(s):
            f = float(s)
            return f if math.isfinite(f) else None
        m = _JS_RADIX_RE.match(s)
        if m:
            digits, base = next((d, b) for d, b in ((m.group("hex"), 16), (m.group("oct"), 8),
                                                     (m.group("bin"), 2)) if d)
            return float(int(digits, base))
        return None
    if isinstance(v, list):
        if not v:
            return 0.0
        if len(v) == 1 and not isinstance(v[0], (bool, dict)):
            return js_number(v[0])        # String([x]) 再 Number：null→""→0、[[5]]→"5"→5
        return None
    return None


def _clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def parse_fire_point(raw: object) -> tuple[float, float] | None:
    """起火点：长度 ≥2 且前两项 `Number()` 后有限 → 各自夹到 0..1；否则 None（= 当没写，从挂点本身出）。"""
    if not isinstance(raw, list) or len(raw) < 2:
        return None
    x = js_number(raw[0])
    y = js_number(raw[1])
    if x is None or y is None:
        return None
    return (_clamp01(x), _clamp01(y))


def parse_burn(raw: object) -> float | None:
    """燃烧强度：`Number()` 后有限 → 夹到 0..1；否则 None（= 当没写）。键不存在传 `ABSENT`。"""
    v = js_number(raw)
    return None if v is None else _clamp01(v)


def parse_wind_shelter(raw: object) -> float | None:
    """挡风比例：与 `burn` 同一个清洗（TS 里就是同一个 `parseBurn`）。键不存在传 `ABSENT`。"""
    return parse_burn(raw)


def _trunc_at_least_one(raw: object) -> int | None:
    v = js_number(raw)
    if v is None:
        return None
    n = int(math.trunc(v))
    return n if n >= 1 else None


@dataclass(frozen=True)
class FlameDef:
    """清洗后的火苗帧动画（格尺寸由贴图推：cellW = texW/cols、rows = ceil(frames/cols)）。"""

    image: str
    cols: int
    frames: int
    fps: float
    height: float

    def cell_size(self, tex_w: float, tex_h: float) -> tuple[float, float]:
        """一格帧的像素尺寸（贴图宽高取不到返回 (0, 0)）。"""
        if not (tex_w > 0 and tex_h > 0):
            return (0.0, 0.0)
        rows = max(1, math.ceil(self.frames / self.cols))
        return (float(tex_w) / self.cols, float(tex_h) / rows)


def parse_flame(raw: object) -> FlameDef | None:
    """火苗块。`image` 空串/非串或 `height` ≤0/非有限 ⇒ None（整块作废）。"""
    if not isinstance(raw, dict):
        return None
    image = raw.get("image")
    image = image.strip() if isinstance(image, str) else ""
    if not image:
        return None
    height = js_number(raw.get("height", ABSENT))
    if height is None or not height > 0:
        return None
    cols = _trunc_at_least_one(raw.get("cols", ABSENT)) or 1
    frames = _trunc_at_least_one(raw.get("frames", ABSENT)) or cols
    fps = js_number(raw.get("fps", ABSENT))
    if fps is None or not fps > 0:
        fps = FLAME_DEFAULT_FPS
    return FlameDef(image=image, cols=cols, frames=frames, fps=fps, height=height)


@dataclass(frozen=True)
class ParticleMount:
    """一条清洗后的粒子挂载：效果 id + 贴图上的挂点（None = 没写，落到起火点 → 挂点本身）。"""

    effect: str
    point: tuple[float, float] | None = None


def parse_particles(raw: object) -> list[ParticleMount]:
    """粒子挂载列表：非数组 ⇒ 空；条目非对象或 ``effect`` 不是非空串 ⇒ 丢该条；``point`` 同 firePoint 清洗。"""
    out: list[ParticleMount] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        effect = item.get("effect")
        effect = effect.strip() if isinstance(effect, str) else ""
        if not effect:
            continue
        out.append(ParticleMount(effect=effect, point=parse_fire_point(item.get("point"))))
    return out


def _action_list(raw: object) -> list[dict]:
    """`parseActionList` 镜像：只留 `type` 是非空字符串的对象，`params` 不是对象就换成 `{}`。"""
    out: list[dict] = []
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict):
            continue
        t = a.get("type")
        t = t.strip() if isinstance(t, str) else ""
        if not t:
            continue
        params = a.get("params")
        out.append({"type": t, "params": params if isinstance(params, dict) else {}})
    return out


#: 风吹灭块 ``blowout`` 里的越线动作列表（运行时 ``HeldPropSystem.crossLine`` 执行，顺序即越线顺序）
BLOWOUT_ACTION_KEYS: tuple[str, ...] = ("onEmberActions", "onOutActions")


@dataclass(frozen=True)
class PropActionList:
    """挂件预设里一处会被执行的动作列表。``state`` 为 None = 基础块；``key`` 是状态 / 基础块内的键路径。"""

    state: str | None
    key: str
    raw: object

    @property
    def field(self) -> str:
        """点号路径：``states.out.onEnterActions`` / ``blowout.onOutActions``（动作总表的容器字段）。"""
        return self.key if self.state is None else f"states.{self.state}.{self.key}"

    @property
    def bracket_path(self) -> str:
        """下标路径：``states[out].onEnterActions`` / ``blowout.onOutActions``（校验报错里给人看的位置）。"""
        return self.key if self.state is None else f"states[{self.state}].{self.key}"


def iter_prop_preset_action_lists(entry: object) -> Iterator[PropActionList]:
    """一条挂件预设里**运行时会执行**的动作列表。

    - 基础块风吹灭块：``blowout.onEmberActions`` / ``blowout.onOutActions``；
    - 每个状态：``onEnterActions``，再 ``blowout.onEmberActions`` / ``blowout.onOutActions``。

    只在容器（状态 / 风吹灭块）是对象、且键存在时给出；原值不做清洗（可能是 ``None`` / 非列表，调用方自己判）。
    三处的顶层 ``playPropVfx`` 不写 target / socket 都 = 这件挂件（运行时同一条 ``selfTargeted`` 注入）。
    基础块的 ``onEnterActions`` 运行时不读，不在这里。
    """
    if not isinstance(entry, dict):
        return
    base = entry.get("blowout")
    if isinstance(base, dict):
        for key in BLOWOUT_ACTION_KEYS:
            if key in base:
                yield PropActionList(None, f"blowout.{key}", base[key])
    states = entry.get("states")
    if not isinstance(states, dict):
        return
    for sname, st in states.items():
        if not isinstance(st, dict):
            continue
        if "onEnterActions" in st:
            yield PropActionList(str(sname), "onEnterActions", st["onEnterActions"])
        blk = st.get("blowout")
        if isinstance(blk, dict):
            for key in BLOWOUT_ACTION_KEYS:
                if key in blk:
                    yield PropActionList(str(sname), f"blowout.{key}", blk[key])


def _image_list(block: dict | None) -> list[str]:
    """`image` 在前、`images` 在后，空串滤掉（同 `propPresetImages` / `propStateImages`）。"""
    if not isinstance(block, dict):
        return []
    out: list[str] = []
    one = block.get("image")
    if isinstance(one, str) and one.strip():
        out.append(one.strip())
    many = block.get("images")
    if isinstance(many, list):
        out.extend(s.strip() for s in many if isinstance(s, str) and s.strip())
    return out


def _placement_value(block: dict | None, key: str) -> float | None:
    """一个摆放字段按运行时解析口径清洗：支点夹到 0..1、缩放非正当没填、非有限数当没填。"""
    if not isinstance(block, dict):
        return None
    v = _finite(block.get(key))
    if v is None:
        return None
    if key in ("anchorX", "anchorY"):
        return min(1.0, max(0.0, v))
    if key == "scale" and not v > 0:
        return None
    return v


def resolve_prop_state_name(preset: dict | None, requested: str = "") -> str:
    """挂上时用哪个状态：显式给的 → ``defaultState`` → ``states`` 第一个键 → 空串。

    给了**不存在**的状态名返回空串（同 `resolvePropStateName`：调用方据此报警，不静默挑一个）。
    """
    states = preset.get("states") if isinstance(preset, dict) else None
    if not isinstance(states, dict) or not states:
        return ""
    want = str(requested or "").strip()
    if want:
        return want if isinstance(states.get(want), dict) else ""
    preferred = str(preset.get("defaultState") or "").strip()
    if preferred and isinstance(states.get(preferred), dict):
        return preferred
    for name, st in states.items():
        if isinstance(st, dict) and str(name).strip():
            return str(name).strip()
    return ""


@dataclass(frozen=True)
class PropPreview:
    """一次挂载真正要画的样子（预设 + 状态合并后）。"""

    images: list[str] = field(default_factory=list)
    anchor_x: float = PLACEMENT_DEFAULTS["anchorX"]
    anchor_y: float = PLACEMENT_DEFAULTS["anchorY"]
    rotation: float = PLACEMENT_DEFAULTS["rotation"]
    scale: float = PLACEMENT_DEFAULTS["scale"]
    #: 起火点（贴图归一化，左上原点）；None = 没写，灯位/效果/火苗从挂点本身出
    fire_point: tuple[float, float] | None = None
    #: 燃烧强度 0..1（状态 → 基础块 → 1）
    burn: float = BURN_DEFAULT
    #: 挡风比例 0..1（状态 → 基础块 → 0）：只影响火苗倾斜，不碰灯
    wind_shelter: float = WIND_SHELTER_DEFAULT
    #: 看得见的火苗（只在基础块定义；状态换不了图集）
    flame: FlameDef | None = None
    #: 粒子挂载（状态写了键就整体替换基础块那一串）
    particles: list[ParticleMount] = field(default_factory=list)
    #: 进入这个状态时执行的动作（只在状态里有）
    on_enter_actions: list[dict] = field(default_factory=list)


def resolve_prop_preview(preset: dict | None, state_name: str = "") -> PropPreview:
    """合并预设与状态（同 `resolvePropAttach`，只是没有"本次调用的显式覆盖"那一层）。

    贴图：状态给了图就**整体替换**，没给才用基础块的。摆放：状态里写了的赢，没写的沿用基础块。
    起火点 / burn：状态写了（清洗后有效）用状态的，否则基础块；火苗只认基础块；
    粒子挂载：状态**写了键**就整体用状态的（哪怕是空数组），没写键才用基础块的。
    """
    base = preset if isinstance(preset, dict) else {}
    states = base.get("states")
    st = states.get(state_name) if state_name and isinstance(states, dict) else None
    st = st if isinstance(st, dict) else None
    images = _image_list(st) or _image_list(base)
    vals: dict[str, float] = {}
    for key, default in PLACEMENT_DEFAULTS.items():
        v = _placement_value(st, key)
        if v is None:
            v = _placement_value(base, key)
        vals[key] = default if v is None else v
    fire_point = parse_fire_point(st.get("firePoint")) if st is not None else None
    if fire_point is None:
        fire_point = parse_fire_point(base.get("firePoint"))
    burn = parse_burn(st.get("burn", ABSENT)) if st is not None else None
    if burn is None:
        burn = parse_burn(base.get("burn", ABSENT))
    shelter = parse_wind_shelter(st.get("windShelter", ABSENT)) if st is not None else None
    if shelter is None:
        shelter = parse_wind_shelter(base.get("windShelter", ABSENT))
    return PropPreview(
        images=images,
        anchor_x=vals["anchorX"],
        anchor_y=vals["anchorY"],
        rotation=vals["rotation"],
        scale=vals["scale"],
        fire_point=fire_point,
        burn=BURN_DEFAULT if burn is None else burn,
        wind_shelter=WIND_SHELTER_DEFAULT if shelter is None else shelter,
        flame=parse_flame(base.get("flame")),
        particles=parse_particles(st["particles"] if st is not None and "particles" in st
                                  else base.get("particles")),
        on_enter_actions=_action_list(st.get("onEnterActions")) if st is not None else [],
    )


def fire_point_offset(
    fire_point: tuple[float, float] | None,
    *,
    anchor_x: float,
    anchor_y: float,
    frame_w: float,
    frame_h: float,
    angle_deg: float,
    facing: int,
    scale: float,
    mirror_with_host: bool = True,
) -> tuple[float, float]:
    """起火点相对挂点（支点）的偏移：``Rot(θ) · Diag(s·m, s) · ((u − ax)·W, (v − ay)·H)``。

    - ``angle_deg`` = θ，**已合成**的最终角（挂点局部角 + 挂件自转·facing；
      试挂画布上等价于 ``(标注角 + 自转) · facing``）；
    - ``scale`` = s（挂件 scale × 透视系数）；``m`` = 镜像符号（``mirror_with_host=False`` 时为 1）；
    - ``fire_point`` 为 None（没写）⇒ 起火点就是挂点本身，偏移 (0, 0)。

    Qt 与 Pixi 的正角都是屏幕顺时针（y 朝下），矩阵同形，与 `paint_prop` 的
    translate → rotate → scale 顺序一致。
    """
    if fire_point is None:
        return (0.0, 0.0)
    m = (-1.0 if facing < 0 else 1.0) if mirror_with_host else 1.0
    lx = (fire_point[0] - anchor_x) * frame_w * scale * m
    ly = (fire_point[1] - anchor_y) * frame_h * scale
    th = math.radians(angle_deg)
    c, s = math.cos(th), math.sin(th)
    return (lx * c - ly * s, lx * s + ly * c)


def fire_point_local(
    local_pose: dict,
    preview: PropPreview,
    frame_w: float,
    frame_h: float,
    *,
    mirror_with_host: bool = True,
) -> tuple[float, float]:
    """起火点在**容器局部坐标**里的位置（编辑器试挂预览与 `SpriteEntity` 同一套）。

    ``local_pose`` 是 `animation_sockets.socket_pose_to_local` 的结果
    （x / y / angleDeg / facing / scale 已按朝向与透视解好）。
    ``P = pose + Rot(pose.angleDeg + 自转·facing) · Diag(s·m, s) · ((u − ax)·W, (v − ay)·H)``，
    s = 挂件 scale × pose.scale。
    """
    facing = -1 if (_finite(local_pose.get("facing")) or 1) < 0 else 1
    depth = _finite(local_pose.get("scale"))
    depth = depth if depth is not None and depth > 0 else 1.0
    dx, dy = fire_point_offset(
        preview.fire_point,
        anchor_x=preview.anchor_x,
        anchor_y=preview.anchor_y,
        frame_w=frame_w,
        frame_h=frame_h,
        angle_deg=(_finite(local_pose.get("angleDeg")) or 0.0) + preview.rotation * facing,
        facing=facing,
        scale=preview.scale * depth,
        mirror_with_host=mirror_with_host,
    )
    return ((_finite(local_pose.get("x")) or 0.0) + dx, (_finite(local_pose.get("y")) or 0.0) + dy)


def fire_point_from_offset(
    dx: float,
    dy: float,
    *,
    anchor_x: float,
    anchor_y: float,
    frame_w: float,
    frame_h: float,
    angle_deg: float,
    facing: int,
    scale: float,
    mirror_with_host: bool = True,
) -> tuple[float, float] | None:
    """`fire_point_offset` 的逆：相对挂点的偏移 → 贴图归一化 (u, v)，夹到 0..1。

    试挂预览上"点哪儿起火点就在哪儿"用它；退化（帧尺寸 / 缩放为 0）返回 None。
    """
    m = (-1.0 if facing < 0 else 1.0) if mirror_with_host else 1.0
    if not (frame_w > 0 and frame_h > 0 and scale > 0):
        return None
    th = math.radians(angle_deg)
    c, s = math.cos(th), math.sin(th)
    lx = dx * c + dy * s        # Rot(-θ)
    ly = -dx * s + dy * c
    u = lx / (frame_w * scale * m) + anchor_x
    v = ly / (frame_h * scale) + anchor_y
    return (_clamp01(u), _clamp01(v))


def frame_image_index(image_count: int, pose_frame: object) -> int:
    """挂点驱动帧号选第几张（同 `syncAttachments`：多于一张且标了帧号才取模，否则第一张）。"""
    n = int(image_count)
    if n <= 1:
        return 0
    f = _finite(pose_frame)
    if f is None:
        return 0
    return int(math.trunc(f)) % n


def prop_image_file(project_path: Path | None, url: str) -> Path | None:
    """挂件贴图 URL（``/resources/...``）→ 磁盘文件；找不到返回 None。"""
    if project_path is None:
        return None
    rel = str(url or "").strip().replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    for root in (Path(project_path) / "public", Path(project_path)):
        candidate = root / rel
        if candidate.is_file():
            return candidate
    return None


def anim_world_size(anim: dict | None, atlas_w: float, atlas_h: float) -> tuple[float, float] | None:
    """动画包的世界宽高（同 `resolveAnimationWorldSize`）：两个都写沿用、写一个按格长宽比推另一个、
    都没写宽取 100。格像素尺寸取不到（没写 cellWidth/Height 又没有图集尺寸）返回 None。
    """
    if not isinstance(anim, dict):
        return None
    cols = max(1, int(_finite(anim.get("cols")) or 1))
    rows = max(1, int(_finite(anim.get("rows")) or 1))
    cw = _finite(anim.get("cellWidth"))
    ch = _finite(anim.get("cellHeight"))
    frame_w = cw if cw is not None and cw > 0 else (float(atlas_w) / cols if atlas_w and atlas_w > 0 else None)
    frame_h = ch if ch is not None and ch > 0 else (float(atlas_h) / rows if atlas_h and atlas_h > 0 else None)
    w = _finite(anim.get("worldWidth"))
    h = _finite(anim.get("worldHeight"))
    w = w if w is not None and w > 0 else None
    h = h if h is not None and h > 0 else None
    if w is not None and h is not None:
        return (w, h)
    if not frame_w or not frame_h:
        return None
    aspect_hw = frame_h / frame_w
    if w is not None:
        return (w, _js_round_6(w * aspect_hw))
    if h is not None:
        return (_js_round_6(h / aspect_hw), h)
    return (DEFAULT_WORLD_WIDTH, _js_round_6(DEFAULT_WORLD_WIDTH * aspect_hw))


def _js_round_6(x: float) -> float:
    """`Math.round(x * 1e6) / 1e6`。Python 的 round 是银行家舍入，恰好 .5 时与 JS 答案不同。"""
    return math.floor(x * 1e6 + 0.5) / 1e6


# ---------------------------------------------------------------------------- 可燃挂件（A3.8 模板 + 实例）


#: 与可燃互斥的挂件预设块（开了 ``burnable`` 写了它们 = 校验器 error）。界面上灰掉并说明"与可燃互斥"。
BURNABLE_EXCLUSIVE_KEYS = ("light", "particles", "flame", "firePoint", "playerControl", "blowout", "igniter",
                           "fuel", "effects", "levels", "states")
#: 开了 ``burnable`` 被模板接管、写了不画的键（校验器 warning）。
BURNABLE_TAKEN_OVER_KEYS = ("image", "images", "anchorX", "anchorY")


def burnable_template_id(preset: dict | None) -> str:
    """挂件预设开了可燃时绑的模板 id（``burnable.template`` 去空白）；没开 / 形状坏 ⇒ ``""``（同 ``resolveBurnableHost``）。"""
    host = preset.get("burnable") if isinstance(preset, dict) else None
    t = host.get("template") if isinstance(host, dict) else None
    return t.strip() if isinstance(t, str) else ""


@dataclass(frozen=True)
class BurnablePropPlacement:
    """可燃挂件真正要画的样子：模板的图，挂点对准模板握点，等比缩放到模板真实宽（× 预设 scale）。"""

    image: str
    anchor_x: float
    anchor_y: float
    rotation: float
    scale: float


def burnable_prop_placement(
    preset: dict | None, template_doc: dict | None, tex_w: float,
) -> BurnablePropPlacement | None:
    """可燃挂件的摆放（口径与运行时一致）：

    - 图 = 模板 ``image``（预设自己的 ``image`` / ``images`` 被接管）；
    - 支点 = 模板握点 ``grip``（缺省底边中点 0.5 / 1），预设的 ``anchorX`` / ``anchorY`` 被接管；
    - 运行时挂件贴图宽 = ``texW × scale`` ⇒ ``scale = widthCm·0.88 / texW × 预设 scale``；
    - ``rotation`` 取预设基础块（状态表与可燃互斥，不合并状态）。

    模板没图 / 没真实宽 / 贴图宽不知道 ⇒ None（画不出来，调用方写原因）。
    """
    from .burn_geometry import prop_anchor_for_template, prop_scale_for_template

    if not isinstance(template_doc, dict):
        return None
    image = template_doc.get("image")
    if not isinstance(image, str) or not image.strip():
        return None
    base = preset if isinstance(preset, dict) else {}
    preset_scale = _placement_value(base, "scale")
    scale = prop_scale_for_template(template_doc, tex_w, PLACEMENT_DEFAULTS["scale"] if preset_scale is None else preset_scale)
    if scale is None:
        return None
    rot = _placement_value(base, "rotation")
    ax, ay = prop_anchor_for_template(template_doc)
    return BurnablePropPlacement(
        image=image.strip(), anchor_x=ax, anchor_y=ay,
        rotation=PLACEMENT_DEFAULTS["rotation"] if rot is None else rot, scale=scale,
    )
