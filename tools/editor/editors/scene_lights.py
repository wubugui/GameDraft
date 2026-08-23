"""统一光影：场景灯位的坐标换算与数据模型。

## 为什么单独一个模块

灯位在**伪世界空间**（铁律：一切光照发生在伪世界空间），而画布是**场景坐标**。
两者之间隔着「场景坐标 → 背景像素 → 伪世界 q → M-world」整条链路，
这条链路在运行时是 `src/utils/worldReconstruct.ts` 的唯一真相源；
编辑器这一份是它的 **Python 镜像**，口径必须一致，所以集中在一处，
不散进 11000 行的 `scene_editor.py` 里。

## 作者模型

**点哪儿摆哪儿，再拉杆调高度**：
1. 在画布上点一个地面点 → 取该像素的深度 → 反投影成伪世界地面坐标；
2. 拖竖直手柄抬高 → 只改世界 Y。

这是唯一说得通的交互：2D 画布只能给两个自由度，第三个必须由深度图补出来，
高度则必须另给一个手柄——而高度直接决定 `N·L/r²` 的形状，摆不准灯就不像灯。

## 单位

灯摆在**世界空间**,单位 **wu** —— 与 NPC、热区、spawn、碰撞同一把尺
(`worldWidth` 就是世界宽度:雾津街头 4000 wu,teahouse 700 wu;角色高 **150 wu**,
28 个场景恒定,拿它估尺寸最可靠)。原点就是世界空间的原点。

## 与伪世界 q 的关系

画布是**场景坐标**(= wu),而深度重建出来的是**伪世界 q**——两者差一个逐场景的
比例 `wu_per_q = worldWidth / (native_w / ppu)`(雾津街头 880、teahouse 154)。
q 要 transform 才能和世界空间对齐,这个类就是干这件事的。

## 两次踩过的坑(都不要回退)

① 一度给所有长度加了 `*Meters` 后缀,换算系数取 `1.7 / char_wu`(假设角色 1.7 米高)。
   **游戏里没有米**,那是凭空造的单位。
② 推倒①之后又把**伪世界 q 单位**叫成了 wu,还说"同一个 wu 在不同场景差 5.7 倍"。
   那是把**相机变换**当成了世界单位的变化——角色在 q 里从 0.17 变到 0.97,
   在 wu 里 28 个场景**恒为 150**。
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_ROOT = Path(__file__).resolve().parents[3]

#: 与运行时 `MAX_STATIC_LIGHTS` 同值。超了运行时会丢弃并告警。
MAX_LIGHTS = 24

#: GTX 970 上带阴影的灯的预算。超了编辑器要标红——不能等跑起来掉帧才发现。
SHADOW_LIGHT_BUDGET = 6

LIGHT_KINDS = ('point', 'spot', 'area', 'directional')

#: 与运行时 `CHARACTER_HEIGHT_WU` 同值。**尺度锚**:角色高 150 wu,28 个场景恒定。
CHARACTER_HEIGHT_WU = 150

#: 与运行时 `DEFAULT_LAMP_RADIUS_WU` 同值。发光体半径(**wu**,约 1/15 个人高)。
DEFAULT_LAMP_RADIUS_WU = 10

#: 与运行时 `DEFAULT_LIGHT_RANGE_WU` 同值。作用半径(**wu**,约 3 个人高)。
DEFAULT_LIGHT_RANGE_WU = 450

#: 与运行时同值(**wu**)。偏置约 1/5 个人高;厚度窗约 1.7 个人高(一堵墙的进深)。
DEFAULT_SHADOW_BIAS_WU = 30.8
DEFAULT_SHADOW_THICKNESS_WU = 264

#: 已**删除**的字段 → 为什么删。留在 JSON 里同样是静默失效，必须报出来。
#: 这两个当初都只声明了类型与文档、**运行时零消费者**——看着像旋钮的常量。
REMOVED_LIGHT_FIELDS = {
    'shadowSamples': '面光软阴影没有实现（阴影 march 是单根光线），这个采样数从来没被读过',
    'dynamic': '"每帧重算"那一档没有实现——所有灯都进脏时缓存，写 true 不会让烛火闪',
}

#: 已改名的字段：旧名 → 新名。旧名留在 JSON 里运行时**读不到**，必须报出来。
RENAMED_LIGHT_FIELDS = {
    # 旧 `softening` 量纲是 wu²、缺省 0.25(= 半径 0.5 wu ≈ 3 个角色身高的大灯泡),
    # 把作用域内的 1/r² 压成只有 2.4 倍变化。改成填**半径**,消费端平方。
    'softening': 'softeningRadius',
    # 下面这一批是那层「米」的残骸。游戏里没有米——只有 wu。
    'rangeMeters': 'range',
    'sizeMeters': 'size',
    'softeningMeters': 'softeningRadius',
    'scaleHeightMeters': 'scaleHeight',
    'baseHeightMeters': 'baseHeight',
    'coreRadiusMeters': 'coreRadius',
    'haloRadiusMeters': 'haloRadius',
    'biasMeters': 'bias',
    'thicknessMeters': 'thickness',
    'lengthMeters': 'length',
}


class SceneLightSpace:
    """一个场景的坐标换算器：场景坐标 ↔ 伪世界。

    需要 `depthConfig`（M/ppu/cx/cy/depth_mapping）与深度图；
    没有深度图时只能做「给定 y 的平面反投影」，点选取不到地面高度。
    """

    def __init__(self, scene_id: str, scene_data: dict) -> None:
        self.scene_id = scene_id
        cfg = scene_data.get('depthConfig') or {}
        m = cfg.get('M') or {}
        self.ok = bool(cfg and m)
        self.R: list[list[float]] = m.get('R') or [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        self.ppu = float(m.get('ppu') or 1.0)
        self.cx = float(m.get('cx') or 0.0)
        self.cy = float(m.get('cy') or 0.0)
        dm = cfg.get('depth_mapping') or {}
        self.invert = bool(dm.get('invert'))
        self.dscale = float(dm.get('scale') or 1.0)
        self.doffset = float(dm.get('offset') or 0.0)
        self.world_w = float(scene_data.get('worldWidth') or 0.0)
        self.world_h = float(scene_data.get('worldHeight') or 0.0)

        self._depth: Any = None          # numpy 数组，惰性载入
        self._native = (0, 0)
        self._depth_name = cfg.get('depth_map') or 'raw_depth_rg.png'
        self._wu_per_q = 0.0

    # ---------------------------------------------------------------- 载入
    def _rt_dir(self) -> Path:
        return _ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / self.scene_id

    def load_depth(self) -> bool:
        """惰性载入深度图。失败返回 False（编辑器应降级为"只能给固定高度"）。"""
        if self._depth is not None:
            return True
        try:
            import numpy as np
            from PIL import Image
        except ImportError:
            return False
        f = self._rt_dir() / self._depth_name
        if not f.exists():
            return False
        rg = np.asarray(Image.open(f).convert('RGB'), np.uint16)
        raw = rg[..., 0] * 256 + rg[..., 1]
        t = raw.astype(np.float32) / 65535.0
        if self.invert:
            t = 1.0 - t
        self._depth = t * self.dscale + self.doffset
        self._native = (self._depth.shape[1], self._depth.shape[0])
        return True

    @property
    def wu_per_q(self) -> float:
        """**1 个伪世界 q 单位 = 多少 wu**。世界空间与深度重建空间之间的桥。

        `= worldWidth / (native_w / ppu)`,逐场景不同(雾津街头 880、teahouse 154)。
        取自烘焙产物 `lighting2/meta.json` 的 `scale.scene_per_wu`。
        """
        if self._wu_per_q:
            return self._wu_per_q
        f = self._rt_dir() / 'lighting2' / 'meta.json'
        try:
            meta = json.loads(f.read_text(encoding='utf-8'))
            self._wu_per_q = float(meta['scale']['scene_per_wu'])
        except (OSError, ValueError, KeyError, TypeError):
            self._wu_per_q = 1.0
        return self._wu_per_q

    # -------------------------------------------------------------- 换算
    def scene_to_native_px(self, sx: float, sy: float) -> tuple[float, float]:
        nw, nh = self._native
        if not nw or not self.world_w:
            return sx, sy
        return sx * (nw / self.world_w), sy * (nh / self.world_h)

    def native_px_to_scene(self, px: float, py: float) -> tuple[float, float]:
        nw, nh = self._native
        if not nw or not self.world_w:
            return px, py
        return px * (self.world_w / nw), py * (self.world_h / nh)

    def depth_at_native(self, px: float, py: float) -> float | None:
        if self._depth is None:
            return None
        nw, nh = self._native
        xi = max(0, min(nw - 1, int(round(px))))
        yi = max(0, min(nh - 1, int(round(py))))
        return float(self._depth[yi, xi])

    def q_from_native(self, px: float, py: float, d: float) -> tuple[float, float, float]:
        """像素 + 深度 → 伪世界 q。**翻 Y 就在这里**（cy − sy，不是 sy − cy）。"""
        return ((px - self.cx) / self.ppu, (self.cy - py) / self.ppu, d)

    def q_to_native(self, q: tuple[float, float, float]) -> tuple[float, float]:
        """上者的逆。"""
        return (self.cx + q[0] * self.ppu, self.cy - q[1] * self.ppu)

    def q_to_world(self, q: tuple[float, float, float]) -> tuple[float, float, float]:
        """伪世界 q → **世界空间(wu)**。转一次朝向(R),再折一次尺度(wu_per_q)。"""
        R, k = self.R, self.wu_per_q
        return tuple(  # type: ignore[return-value]
            (R[i][0] * q[0] + R[i][1] * q[1] + R[i][2] * q[2]) * k for i in range(3)
        )

    def world_to_q(self, w: tuple[float, float, float]) -> tuple[float, float, float]:
        """上者的逆。M 正交 ⇒ 转置即逆（按列点乘）。"""
        R, k = self.R, 1.0 / max(self.wu_per_q, 1e-9)
        wq = (w[0] * k, w[1] * k, w[2] * k)
        return tuple(  # type: ignore[return-value]
            R[0][i] * wq[0] + R[1][i] * wq[1] + R[2][i] * wq[2] for i in range(3)
        )

    # --------------------------------------------------- 作者面的两个方向
    def ground_world_at_scene(self, sx: float, sy: float) -> tuple[float, float, float] | None:
        """画布上点一个地面点 → 伪世界坐标。深度图缺失则 None。"""
        if not self.load_depth():
            return None
        px, py = self.scene_to_native_px(sx, sy)
        d = self.depth_at_native(px, py)
        if d is None:
            return None
        return self.q_to_world(self.q_from_native(px, py, d))

    def world_to_scene(self, w: tuple[float, float, float]) -> tuple[float, float]:
        """伪世界坐标 → 画布场景坐标（灯的 gizmo 画在这里）。"""
        px, py = self.q_to_native(self.world_to_q(w))
        return self.native_px_to_scene(px, py)

    def raise_world(self, w: tuple[float, float, float], wu: float) -> tuple[float, float, float]:
        """把一个世界点沿**世界 Y** 抬高若干 **wu**（角色高 150 wu，可以对着估）。"""
        return (w[0], w[1] + wu, w[2])

    def height_wu_above(
        self, w: tuple[float, float, float], ground: tuple[float, float, float],
    ) -> float:
        """离地高度（**wu**）。角色高 150 wu —— 街灯大约挂在 2.5 个人高的位置。"""
        return w[1] - ground[1]


def default_light(index: int, kind: str = 'point') -> dict:
    """一盏新灯的缺省值。一切长度都是 **wu**。

    缺省值按**角色高 150 wu** 定:作用半径 450 wu = 3 个人高,发光体半径
    10 wu ≈ 1/15 个人高。摆灯时对着角色比,比记绝对值可靠。
    """
    base: dict[str, Any] = {
        'id': f'light_{index}',
        'kind': kind,
        'pos': [0.0, 0.0, 0.0],
        'kelvin': 2400.0,
        'intensity': 2.5,
        'range': DEFAULT_LIGHT_RANGE_WU,
        'softeningRadius': DEFAULT_LAMP_RADIUS_WU,
        'castShadow': False,
        'enabled': True,
    }
    if kind == 'spot':
        base.update(dir=[0.0, -1.0, 0.3], innerAngleDeg=25.0, outerAngleDeg=45.0)
    elif kind == 'area':
        base.update(size=[135.0, 90.0], orientation=[0.0, 0.0, -1.0], twoSided=False)
    elif kind == 'directional':
        base.pop('pos', None)
        base.pop('range', None)
        base.pop('softeningRadius', None)
        base.update(elevationDeg=45.0, azimuthDeg=180.0, intensity=0.4, kelvin=7000.0)
    return base


def default_lighting_block() -> dict:
    """一个场景第一次启用统一光影时的缺省 `lighting` 块（v3 / G-buffer）。

    ⚠ `sky.intensity` / `ambient.intensity` / `charRefIntensity` 正常**不该手填**：
    它们由 `tools/scene_relight/migrate3.py` 从烘焙反解出的 `E_est = c0 + c1*T0`
    写入。这里给的只是"还没烘焙时也别崩"的占位值。

    ⚠ v2 的 `day` / `aoStrength` / `ratioMax` / `dehaze` 已整体移除 ——
    去霾搬进了烘焙期，遮蔽与朝向进了传输基，比值钳位随分母一起没了。
    """
    return {
        'sky': {'kelvin': 9000.0, 'intensity': 0.05, 'profile': 0.0},
        'ambient': {'kelvin': 9000.0, 'intensity': 0.05},
        'lights': [],
        'fog': {'sigma': 0.0, 'scaleHeight': 530.0, 'baseHeight': 0.0,
                'kelvin': 7000.0, 'scatter': 0.15},
        'display': {'ev': 0.0, 'tonemap': 'filmic', 'whiteKelvin': 7000.0,
                    'contrast': 0.85, 'saturation': 0.9, 'lift': 0.0, 'liftKelvin': 10000.0},
        'emissive': {'gain': 2.0, 'coreRadius': 30.0,
                     'haloRadius': 140.0, 'haloGain': 0.18},
        # 阴影 march 的偏置与遮挡体厚度窗(**wu**)。深度场只有可见壳、没有背面,
        # 所以遮挡体的厚度必须人为给：太薄漏挡，太厚「隔山打影」（远处的墙挡住近处的地）。
        'shadowBias': {'bias': DEFAULT_SHADOW_BIAS_WU,
                       'thickness': DEFAULT_SHADOW_THICKNESS_WU},
    }


#: 每种灯型**只**用得上的字段。换型时其余的必须摘掉 ——
#: 留着不报错，只是静默失效（运行时按缺省走，作者以为自己调了）。
#: 与运行时 `src/rendering/lighting/lightDefaults.ts` 的 `retype` 同口径。
KIND_ONLY_FIELDS = {
    'point': (),
    'spot': ('dir', 'innerAngleDeg', 'outerAngleDeg'),
    'area': ('size', 'orientation', 'rollDeg', 'twoSided'),
    'directional': ('elevationDeg', 'azimuthDeg'),
}

#: 平行光没有位置，也没有距离衰减。
NON_DIRECTIONAL_FIELDS = ('pos', 'range')

#: 只有点光/聚光吃软化半径。**面光不吃** —— `lcAreaLight` 的参数表里没有软化项
#: （C.y 那一格对面光另作他用：装自转角）。换成面光时带过去 = 留一个静默失效的字段。
SOFTENING_KINDS = ('point', 'spot')


def retype(src: dict, kind: str) -> dict:
    """把一盏灯换成另一种类型。

    从该类型的缺省值起手（所以新型的必需字段一定齐），只把**与类型无关**的
    作者意图搬过去：id / 强度 / 色温 / 颜色 / 投影 / 开关，以及非平行光的
    位置与半径。旧型专属的字段一概不带 —— 那是静默失效的来源。

    ⚠ 别写 `out['color'] = src.get('color')`：源灯没有 color 时会留下一个值为
      None 的键。JSON 里看不见，但按"键在不在"分支的代码会走错。
    """
    out = default_light(1, kind)
    out['id'] = src.get('id') or out['id']
    for k in ('intensity', 'kelvin', 'castShadow', 'enabled'):
        if k in src:
            out[k] = src[k]
    if src.get('color'):
        out['color'] = src['color']
    if kind != 'directional':
        for k in NON_DIRECTIONAL_FIELDS:
            v = src.get(k)
            if v is not None:
                out[k] = list(v) if isinstance(v, list) else v
        if kind in SOFTENING_KINDS and src.get('softeningRadius') is not None:
            out['softeningRadius'] = src['softeningRadius']
        else:
            out.pop('softeningRadius', None)
    # 编辑器专用的派生量跟着走，免得换型后高度手柄跳回缺省
    if '_editorHeightWu' in src and kind != 'directional':
        out['_editorHeightWu'] = src['_editorHeightWu']
    return out


def shadow_budget_status(lights: list[dict]) -> tuple[int, int, bool]:
    """(带影灯数, 预算, 是否超) —— 编辑器必须常驻显示这个。

    带阴影的灯每盏都要沿深度场 march，是**性能预算的唯一约束项**；
    静默超预算的后果是跑起来才掉帧，那时已经摆了一屋子灯。
    """
    n = sum(1 for l in lights
            if l.get('castShadow') and l.get('enabled', True)
            and l.get('kind') != 'directional')
    return n, SHADOW_LIGHT_BUDGET, n > SHADOW_LIGHT_BUDGET


def validate_lights(lights: list[dict]) -> list[str]:
    """返回问题清单（editor 与 validator 共用同一份判据）。"""
    issues: list[str] = []
    seen: set[str] = set()
    for i, l in enumerate(lights):
        lid = str(l.get('id') or '')
        if not lid:
            issues.append(f'第 {i + 1} 盏灯没有 id')
        elif lid in seen:
            issues.append(f'灯 id 重复: {lid}')
        else:
            seen.add(lid)
        kind = l.get('kind')
        if kind not in LIGHT_KINDS:
            issues.append(f'{lid}: 未知灯型 {kind!r}（应为 {"/".join(LIGHT_KINDS)}）')
        if kind != 'directional':
            pos = l.get('pos')
            if not (isinstance(pos, list) and len(pos) == 3):
                issues.append(f'{lid}: 缺 pos[3]（伪世界坐标）')
            r = l.get('range')
            if not isinstance(r, (int, float)) or r <= 0:
                issues.append(f'{lid}: range 必须 > 0(单位 **wu**)')
        if kind == 'spot':
            inner = float(l.get('innerAngleDeg') or 0)
            outer = float(l.get('outerAngleDeg') or 0)
            if not (0 < inner <= outer < 90):
                issues.append(f'{lid}: 聚光锥角应满足 0 < 内角 ≤ 外角 < 90（现 {inner}/{outer}）')
        if kind == 'area':
            s = l.get('size')
            if not (isinstance(s, list) and len(s) == 2 and all(float(v) > 0 for v in s)):
                issues.append(f'{lid}: 面光需要 size[w,h]，且都 > 0（**米**）')
        if not isinstance(l.get('intensity'), (int, float)):
            issues.append(f'{lid}: intensity 必须是数值')
        # 改过名的字段留在 JSON 里是**静默失效**：运行时按缺省走，作者以为自己调了
        for _old, _new in RENAMED_LIGHT_FIELDS.items():
            if _old in l:
                issues.append(
                    f'{lid}: 字段 {_old!r} 已改名为 {_new!r}（单位改成**米**），'
                    f'留着不会报错但运行时读不到')
        for _gone, _why in REMOVED_LIGHT_FIELDS.items():
            if _gone in l:
                issues.append(f'{lid}: 字段 {_gone!r} 已删除——{_why}')
        if 'rollDeg' in l:
            r = l.get('rollDeg')
            if not isinstance(r, (int, float)) or isinstance(r, bool):
                issues.append(f'{lid}: rollDeg 必须是数（度）')
            elif kind != 'area':
                # 非面光带着它不报错也不生效——正是"静默失效"，必须当场说出来
                issues.append(f'{lid}: rollDeg 只对面光有意义（当前 kind={kind}）')
        if 'twoSided' in l and not isinstance(l.get('twoSided'), bool):
            issues.append(f'{lid}: twoSided 必须是 true/false')
        if l.get('twoSided') and kind != 'area':
            issues.append(f'{lid}: twoSided 只对面光有意义（当前 kind={kind}）')
        sm = l.get('softeningRadius')
        if sm is not None and (not isinstance(sm, (int, float)) or sm <= 0):
            issues.append(f'{lid}: softeningRadius 必须 > 0(发光体**半径**,单位 wu)')
    if len(lights) > MAX_LIGHTS:
        issues.append(f'灯数 {len(lights)} 超过运行时上限 {MAX_LIGHTS}，多出的会被丢弃')
    n, budget, over = shadow_budget_status(lights)
    if over:
        issues.append(f'带阴影的灯 {n} 盏超过预算 {budget}（GTX 970 上会掉帧）')
    return issues


def spot_dir_from_angles(elev_deg: float, azim_deg: float) -> list[float]:
    """聚光的射出方向。与运行时 `directionFromAngles` 同式（方位 0=画面深处）。"""
    e = math.radians(elev_deg)
    a = math.radians(azim_deg)
    return [math.cos(e) * math.sin(a), math.sin(e), math.cos(e) * math.cos(a)]


# ---------------------------------------------------------------- 角色阴影绑定
# 制作人 2026-08-20 定死：角色阴影**必须手动指定光源**，可绑真实灯或虚拟灯，
# **禁止自动 resolve**。所以这里的每一条都是作者显式写下的，编辑器不替他猜。

SHADOW_SOURCE_NONE = 'none'
SHADOW_SOURCE_VIRTUAL = 'virtual'
SHADOW_LIGHT_PREFIX = 'light:'
#: 角色阴影绑定条数上限。每条都是一个 planar 剪影实例，多了既看不清也白费。
MAX_SHADOW_BINDINGS = 3


def default_shadow_binding(source: str = SHADOW_SOURCE_NONE) -> dict:
    """新建一条绑定。虚拟灯给一组"看得见"的缺省角度，别让作者从 0 开始猜。"""
    if source == SHADOW_SOURCE_VIRTUAL:
        return {
            'source': SHADOW_SOURCE_VIRTUAL,
            'virtual': {
                # ⚠ 这里的 azimuthDeg 是**屏幕**方向，不是世界方位。
                #   虚拟灯没有世界位置，绕世界坐标只会让作者调的数与看到的效果对不上。
                'azimuthDeg': 135.0,
                'elevationDeg': 50.0,
                'darkness': 0.6,
                'softness': 0.35,
                'length': 0.0,      # 0 = 按仰角自动算影长
            },
        }
    return {'source': source}


def shadow_binding_label(binding: dict, lights: list[dict] | None = None) -> str:
    """列表里显示的一行。绑丢了的灯要**当场看得出来**，不能等到跑起来才发现没影子。"""
    src = str(binding.get('source') or SHADOW_SOURCE_NONE)
    if src == SHADOW_SOURCE_NONE:
        return '不投影'
    if src == SHADOW_SOURCE_VIRTUAL:
        v = binding.get('virtual') or {}
        return (f"虚拟灯  屏幕 {float(v.get('azimuthDeg', 0)):.0f}°  "
                f"仰角 {float(v.get('elevationDeg', 0)):.0f}°  "
                f"浓度 {float(v.get('darkness', 0)):.2f}")
    if src.startswith(SHADOW_LIGHT_PREFIX):
        lid = src[len(SHADOW_LIGHT_PREFIX):]
        known = {str(l.get('id')) for l in (lights or [])}
        return f'灯 {lid}' + ('' if lid in known else '  ⚠ 场景里没有这盏灯')
    return f'⚠ 无法识别的绑定 {src!r}'


def validate_shadow_bindings(bindings: list[dict], lights: list[dict],
                             who: str = '实体') -> list[str]:
    """校验一组绑定（editor 与 validator 共用同一份判据）。

    ⚠ 绑到不存在的灯是 **error 不是 warning**：运行时的行为是"没有影子"，
    而"影子莫名其妙没了"在画面上完全看不出是配错了还是本来就该没有。
    """
    issues: list[str] = []
    ids = {str(l.get('id')) for l in lights}
    for i, b in enumerate(bindings):
        tag = f'{who} 第 {i + 1} 条阴影绑定'
        if not isinstance(b, dict):
            issues.append(f'{tag}: 不是对象')
            continue
        src = b.get('source')
        if not isinstance(src, str) or not src:
            issues.append(f'{tag}: 缺 source（应为 '
                          f"'{SHADOW_LIGHT_PREFIX}<灯id>' / '{SHADOW_SOURCE_VIRTUAL}' "
                          f"/ '{SHADOW_SOURCE_NONE}'）")
            continue
        if src == SHADOW_SOURCE_VIRTUAL:
            v = b.get('virtual')
            if not isinstance(v, dict):
                issues.append(f'{tag}: source=virtual 但没有 virtual 块 → 运行时不投影')
            else:
                for k in ('azimuthDeg', 'elevationDeg', 'darkness', 'softness'):
                    if not isinstance(v.get(k), (int, float)):
                        issues.append(f'{tag}: virtual.{k} 必须是数值')
        elif src.startswith(SHADOW_LIGHT_PREFIX):
            lid = src[len(SHADOW_LIGHT_PREFIX):]
            if not lid:
                issues.append(f'{tag}: {SHADOW_LIGHT_PREFIX} 后面没有灯 id')
            elif lid not in ids:
                issues.append(f'{tag}: 绑的灯 {lid!r} 不在本场景灯表里 → 运行时没有影子')
        elif src != SHADOW_SOURCE_NONE:
            issues.append(f'{tag}: 无法识别的 source {src!r}')
        for k in ('darkness', 'softness', 'lengthScale'):
            if k in b and not isinstance(b[k], (int, float)):
                issues.append(f'{tag}: {k} 必须是数值')
    if len(bindings) > MAX_SHADOW_BINDINGS:
        issues.append(f'{who} 阴影绑定 {len(bindings)} 条超过上限 {MAX_SHADOW_BINDINGS}')
    return issues


# ---------------------------------------------------------------------------
# 光照的**双向实时同步**：编辑器 ↔ 游戏
#
# 摆灯最准的地方是跑起来的画面（真透视、真遮挡、真光照），改数值最顺手的地方是这张表。
# 所以两边改的是同一份 `lighting`：任一边动了，另一边下一拍就跟上，**不用按按钮**。
#
# ## 走 dev server 的同步槽，不走 WebEngine 桥
#
# 游戏可能跑在外部 Chrome、内嵌页签、弹出窗口，两边还各自中途开关重启。
# dev server 是唯一两边都始终可达的点。第一版用 `runJavaScript` 直接问游戏，
# 只在"游戏正好跑在编辑器里"时成立——游戏开在外部浏览器时整条线是断的，
# 而那恰恰是最常见的用法。
#
# ## 落盘仍然只有一个出口
#
# 同步槽在 `editor_data/`（与 F2 pin、Flag 收藏同族的交接文件），**不是工程数据**。
# 场景 JSON 只有本编辑器的 `save_all` 一个写入者：同步只负责把参数搬过来入脏，
# 落盘还是人按 Save All。
# ---------------------------------------------------------------------------

SYNC_PATH = '/__gamedraft-api/runtime-lighting'

#: 同步轮询间隔（毫秒）。拖灯时对面每 ~0.4s 跟一次，够跟手又不至于打满 dev server。
SYNC_POLL_MS = 400

#: HTTP 超时（秒）。同步跑在 UI 线程上，绝不能因为 dev server 没在跑就把编辑器卡住。
SYNC_TIMEOUT_S = 0.6

#: 同步槽的**新鲜期**（毫秒）。超过这个岁数的文档不再自动套用——槽是"当前会话的对讲机"，
#: 不是状态存档。没有这道闸，昨天留下的残留会在今天一开编辑器就被当成"游戏刚改的"套回来。
#: 与运行时 `src/dev/runtimeLightingSync.ts` 的 `STALE_MS` 同值。
SYNC_STALE_MS = 5 * 60 * 1000

#: 主窗口安装：返回 dev server 基址（如 http://localhost:5173）。未安装 = 同步整体不启用。
_SYNC_BASE_URL: Any = None


def set_runtime_lighting_endpoint(fn: Any) -> None:
    """主窗口注入/撤销 dev server 基址取值口（None = 撤销）。"""
    global _SYNC_BASE_URL
    _SYNC_BASE_URL = fn


def normalize_dev_base_url(url: str) -> str:
    """规范 dev server 基址。

    ⚠ **`localhost` 必须换成 `127.0.0.1`**：vite 只监听 IPv4，而 Python 的 urllib 在
    这台机器上会先试 IPv6 的 `::1`，于是每次请求都白等到超时（实测 `localhost` 3 秒超时、
    `127.0.0.1` 0.00 秒返回）。vite 启动日志打的恰恰是 `http://localhost:5173/`，
    照抄进来就等于同步永远连不上——而且表现为"没反应"，不报错。
    """
    u = (url or '').strip().rstrip('/')
    if not u:
        return ''
    return u.replace('//localhost:', '//127.0.0.1:').replace('//localhost/', '//127.0.0.1/')


def runtime_lighting_base_url() -> str:
    fn = _SYNC_BASE_URL
    if fn is None:
        return ''
    try:
        return normalize_dev_base_url(str(fn() or ''))
    except Exception:  # noqa: BLE001 - 取不到地址只是同步不可用，不能反噬编辑器
        return ''


def _canonical(lighting: dict) -> str:
    """比较用的规范文本。剥掉只给编辑器看的 `_editorHeightWu`——它是从 pos 推出来的派生量，
    留着会让"表里显示的高度变了"被误判成"参数变了"，于是无谓地发一轮。"""
    def strip(d: Any) -> Any:
        if isinstance(d, dict):
            return {k: strip(v) for k, v in d.items() if k != '_editorHeightWu'}
        if isinstance(d, list):
            return [strip(x) for x in d]
        return d
    return json.dumps(strip(lighting), sort_keys=True, ensure_ascii=False)


def should_apply_doc(doc: Any, me: str, last_seen_rev: int, my_scene_id: str) -> bool:
    """这份文档要不要应用。**与运行时 `src/dev/runtimeLightingSync.ts` 同一套规则**——
    规则分家不报错，只表现为"某一边偶尔不跟"，极难查。"""
    if not isinstance(doc, dict):
        return False
    rev = doc.get('rev')
    if not isinstance(rev, int):
        return False
    lit = doc.get('lighting')
    if not isinstance(lit, dict) or not isinstance(lit.get('lights'), list):
        return False
    if str(doc.get('writer') or '') == me:      # 自己写的别读回来（否则回声写循环）
        return False
    if rev <= last_seen_rev:                    # 旧的、或已经见过
        return False
    if not my_scene_id or str(doc.get('sceneId') or '') != my_scene_id:
        return False                            # 跨场景绝不套用
    return True


#: 连不上时按次退避到这个上限（毫秒）。一成功立刻回到 `SYNC_POLL_MS`。
SYNC_POLL_MS_MAX = 3000

#: 探端口的候选。dev server 不一定在 5173：编辑器自己起的那次知道端口（放第一位），
#: 用户自己在终端 `npm run dev` 起的就只能猜——所以连不上时每拍换一个候选试，
#: 试通了就**钉住**。全是 127.0.0.1（见 normalize_dev_base_url 里那条 IPv6 坑）。
SYNC_PORT_CANDIDATES = (5173, 5174, 5175, 5176, 5177, 5178, 5180, 5188)


class LightingSyncTransport:
    """同步的**连接层**：退避、换端口、重连、状态可见。

    「连着连着就没了」的三种死法在这里堵：①请求挂死 → 短超时；②失败后死磕 →
    指数退避；③断了没人知道 → `status_line()` 摆到界面上。
    换端口是第四种：dev server 换了端口（或用户自己起的服在别的端口）时，
    死盯一个地址就是永远连不上，而且看起来像"功能坏了"。
    """

    def __init__(self, primary_url_fn: Any) -> None:
        self._primary = primary_url_fn
        self._stuck: str = ''          # 试通过的地址，钉住不再乱换
        self._cand_idx = 0
        self.fail_streak = 0
        self.last_error = ''
        self.last_ok_ms = 0.0

    # ---- 地址 ----------------------------------------------------------
    def candidates(self) -> list[str]:
        out: list[str] = []
        if self._stuck:
            out.append(self._stuck)
        try:
            primary = normalize_dev_base_url(str(self._primary() or ''))
        except Exception:  # noqa: BLE001 - 取不到就只用候选表
            primary = ''
        if primary:
            out.append(primary)
        for port in SYNC_PORT_CANDIDATES:
            out.append('http://127.0.0.1:%d' % port)
        seen: set[str] = set()
        uniq = []
        for u in out:
            if u and u not in seen:
                seen.add(u)
                uniq.append(u)
        return uniq

    def _current_base(self) -> str:
        cands = self.candidates()
        if not cands:
            return ''
        if self._stuck:
            return self._stuck
        return cands[self._cand_idx % len(cands)]

    # ---- 诊断计数 ----------------------------------------------------
    # ⚠ 这几个不是锦上添花。2026-08-22 的事故：编辑器这半边因为拿错对象，
    #   整条 tick 一次都没跑过，而状态标签停在初始那句"等待游戏（会自动连上）"，
    #   看着完全正常，排查花了一整轮。有「发 0 收 0」这四个字就一眼看穿。
    #   与游戏侧 `runtimeLightingSync.ts` 的 statusLine 同口径。
    applied = 0          # 套用过对面几次
    published = 0        # 发出去过几次
    last_writer = ''     # 槽里最后一次是谁写的
    last_doc_age_ms: Any = None
    last_doc_scene = ''
    suppressed = ''      # 此刻本侧为什么不收（'' = 没被挡）
    ticks = 0            # tick 真正跑到取面板之后的次数

    def _note_ok(self, base: str, now_ms: float) -> None:
        self._stuck = base
        self.fail_streak = 0
        self.last_error = ''
        self.last_ok_ms = now_ms

    def _note_fail(self, err: str) -> None:
        self.fail_streak += 1
        self.last_error = err
        # 钉住的地址连不上了：松开，下一拍从头轮候选（dev server 换端口就是这么恢复的）
        self._stuck = ''
        self._cand_idx += 1

    # ---- 节流 ----------------------------------------------------------
    def poll_ms(self) -> int:
        if self.fail_streak == 0:
            return SYNC_POLL_MS
        return min(SYNC_POLL_MS_MAX, SYNC_POLL_MS * (2 ** min(self.fail_streak, 4)))

    def due(self, now_ms: float, last_tick_ms: float) -> bool:
        return (now_ms - last_tick_ms) >= self.poll_ms()

    # ---- 状态 ----------------------------------------------------------
    def status_line(self, now_ms: float) -> str:
        """一行给人看的状态。**必须带收发计数与最后写入者**——理由见上面的诊断计数。"""
        io_ = '发%d 收%d' % (self.published, self.applied)
        if self.last_writer:
            who = '游戏' if self.last_writer.startswith('game:') else '编辑器'
            age = '' if self.last_doc_age_ms is None else '(%ds前)' % int(
                float(self.last_doc_age_ms) / 1000)
            peer = '　最后写入:%s%s' % (who, age)
        else:
            peer = '　槽里还没有任何文档'
        gate = ('\n　⏸ ' + self.suppressed) if self.suppressed else ''

        if self.fail_streak != 0 or self.last_ok_ms <= 0:
            if self.last_ok_ms <= 0:
                return '↔ 同步等待连接…%s　%s' % (
                    ('（%s）' % self.last_error) if self.last_error else '', io_)
            return '⚠ 同步已断 %ds，自动重连中%s　%s' % (
                int((now_ms - self.last_ok_ms) / 1000),
                ('：' + self.last_error) if self.last_error else '', io_)
        # 连着、但一次都没收发过 —— 这正是那次事故的样子，必须自己喊出来
        if self.published == 0 and self.applied == 0:
            return '⚠ 通道连着(%s)但**一次都没收发过**　%s%s%s' % (
                self._stuck or '', io_, peer, gate)
        return '↔ 同步中(%s)　%s%s%s' % (self._stuck or '', io_, peer, gate)

    # ---- 收发 ----------------------------------------------------------
    def fetch(self, now_ms: float, timeout: float = SYNC_TIMEOUT_S) -> tuple[Any, Any, str]:
        base = self._current_base()
        if not base:
            self._note_fail('没有 dev server 地址')
            return None, None, self.last_error
        try:
            with urlopen(base + SYNC_PATH, timeout=timeout) as r:  # noqa: S310 - 固定本机 dev 服
                body = json.loads(r.read().decode('utf-8'))
        except (URLError, HTTPError, TimeoutError, OSError, ValueError) as e:
            self._note_fail('%s 连不上（%s）' % (base, e))
            return None, None, self.last_error
        if not isinstance(body, dict):
            self._note_fail('%s 返回的不是对象' % (base,))
            return None, None, self.last_error
        self._note_ok(base, now_ms)
        return body.get('doc'), body.get('ageMs'), ''

    def publish(self, scene_id: str, writer: str, lighting: dict,
                now_ms: float, timeout: float = SYNC_TIMEOUT_S,
                selected_id: Any = None) -> tuple[int, str]:
        base = self._current_base()
        if not base:
            return 0, '没有 dev server 地址'
        payload = json.dumps(
            {'sceneId': scene_id, 'writer': writer, 'lighting': lighting,
             'selectedId': selected_id},
            ensure_ascii=False).encode('utf-8')
        req = Request(base + SYNC_PATH, data=payload,  # noqa: S310 - 固定本机 dev 服
                      headers={'Content-Type': 'application/json'})
        try:
            with urlopen(req, timeout=timeout) as r:  # noqa: S310
                body = json.loads(r.read().decode('utf-8'))
        except (URLError, HTTPError, TimeoutError, OSError, ValueError) as e:
            self._note_fail('%s 发布失败（%s）' % (base, e))
            return 0, self.last_error
        self._note_ok(base, now_ms)
        rev = body.get('rev') if isinstance(body, dict) else None
        return (int(rev) if isinstance(rev, int) else 0), ''


#: 全进程共用一个连接层：定时同步与「立即抓一次」按钮共享同一个钉住的地址、
#: 同一份退避与连接状态。各用各的会出现"按钮能连、自动同步连不上"这种最费解的分裂。
_DEFAULT_TRANSPORT: Any = None


def default_transport() -> Any:
    global _DEFAULT_TRANSPORT
    if _DEFAULT_TRANSPORT is None:
        _DEFAULT_TRANSPORT = LightingSyncTransport(runtime_lighting_base_url)
    return _DEFAULT_TRANSPORT


def reset_default_transport() -> None:
    """测试用：清掉钉住的地址与退避状态。"""
    global _DEFAULT_TRANSPORT
    _DEFAULT_TRANSPORT = None


def _now_ms() -> float:
    return time.monotonic() * 1000.0


def fetch_sync_doc(timeout: float = SYNC_TIMEOUT_S) -> tuple[Any, Any, str]:
    """取同步槽。返回 (doc|None, ageMs|None, 错误说明)。

    连不上不是异常，是"暂时没有对面"——dev server 没起、游戏没开都很正常。
    `ageMs` 由服务端按文件 mtime 算，调用方据此判断这份是不是陈年残留。
    """
    return default_transport().fetch(_now_ms(), timeout=timeout)


def is_sync_doc_stale(age_ms: Any) -> bool:
    """这份文档是不是陈年残留（拿不到岁数就当新鲜，宁可同步也别假装没有对面）。"""
    return isinstance(age_ms, (int, float)) and age_ms > SYNC_STALE_MS


def publish_sync_doc(scene_id: str, writer: str, lighting: dict,
                     timeout: float = SYNC_TIMEOUT_S,
                     selected_id: Any = None) -> tuple[int, str]:
    """把本地这份发进同步槽。返回 (服务端分配的 rev, 错误说明)；rev 为 0 即没发出去。"""
    return default_transport().publish(scene_id, writer, lighting, _now_ms(),
                                       timeout=timeout, selected_id=selected_id)


class LightingSyncClient:
    """同步的**状态与判定**（不碰 Qt、不碰网络，可直接单测）。

    调用方每拍：`plan_apply(doc, scene_id)` → 有就应用并 `note_applied(lit, rev)`；
    然后 `needs_publish(lit)` → 要发就发并 `note_published(lit, rev)`。
    """

    def __init__(self, writer: str) -> None:
        self.writer = writer
        self.last_seen_rev = 0
        self._synced = ''

    def reset(self) -> None:
        """换场景/重载后基线作废：新场景的第一份内容不是"已与对面对齐"。"""
        self._synced = ''

    def plan_apply(self, doc: Any, my_scene_id: str) -> dict | None:
        if not should_apply_doc(doc, self.writer, self.last_seen_rev, my_scene_id):
            # 自己写的那份也要记下 rev，省得每拍重新判定同一份
            if (isinstance(doc, dict) and isinstance(doc.get('rev'), int)
                    and str(doc.get('writer') or '') == self.writer):
                self.last_seen_rev = max(self.last_seen_rev, int(doc['rev']))
            return None
        return doc['lighting']

    def note_applied(self, lighting: dict, rev: int, selected_id: Any = None) -> None:
        self.last_seen_rev = max(self.last_seen_rev, int(rev or 0))
        self._synced = self._baseline(lighting, selected_id)

    def needs_publish(self, lighting: Any, selected_id: Any = None) -> bool:
        if not isinstance(lighting, dict):
            return False
        return self._baseline(lighting, selected_id) != self._synced

    def note_published(self, lighting: dict, rev: int, selected_id: Any = None) -> None:
        self._synced = self._baseline(lighting, selected_id)
        if rev:
            self.last_seen_rev = max(self.last_seen_rev, int(rev))

    @staticmethod
    def _baseline(lighting: Any, selected_id: Any) -> str:
        """基线 = 灯参 + 选中。收发共用这一处。

        ⚠ 选中**必须**进基线：只比 lighting 的话，「只换了选中的灯」这件事永远
          发不出去，选中同步就成了单向的（对面选谁我跟，我选谁对面不知道）。
        """
        return _canonical(lighting) + '\u0000' + (selected_id or '')


def doc_selected_id(doc: Any) -> str | None:
    """同步文档里的选中灯 id。**会话态，不是策划数据**：它住在文档层，不进
    `lighting`，所以 Save All 落盘时带不出去。"""
    if not isinstance(doc, dict):
        return None
    sid = doc.get('selectedId')
    return sid if isinstance(sid, str) and sid else None


def validate_pulled_lighting(payload: Any, expect_scene_id: str) -> tuple[dict | None, str]:
    """校验一份要落进编辑器的 lighting。返回 (lighting, 错误说明)；lighting 为 None 即拒绝。

    ⚠ 形状校验不是洁癖：这是**整块替换** `lighting`。缺半个对象就落进来，会把
    这个场景调好的天光/雾/显示变换一起冲掉，而且当场看不出来（要下次跑起来才发现）。
    与运行时 `SceneLightingDef` 的必需键对齐：sky / day / lights / display 四样缺一不可。
    """
    if not isinstance(payload, dict):
        return None, '游戏没返回数据（没在跑？没进场景？F2「光影」页显示这个场景没配 lighting？）'
    sid = str(payload.get('sceneId') or '')
    if not sid:
        return None, '游戏没报出场景 id'
    if expect_scene_id and sid != expect_scene_id:
        return None, ('游戏当前在「%s」，你正在编辑「%s」——'
                      '跨场景拉取会把灯摆到错的场景里，已拒绝。先让游戏切到这个场景。'
                      % (sid, expect_scene_id))
    lit = payload.get('lighting')
    if not isinstance(lit, dict):
        return None, '「%s」没有 lighting 块' % (sid,)
    missing = [k for k in ('sky', 'day', 'lights', 'display') if k not in lit]
    if missing:
        return None, 'lighting 块缺少必需键 %s——半个对象不能覆盖已调好的参数' % (missing,)
    if not isinstance(lit.get('lights'), list):
        return None, 'lighting.lights 不是数组'
    return lit, ''
