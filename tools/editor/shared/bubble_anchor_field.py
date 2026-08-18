"""气泡头顶锚编辑控件：所见即所得的舞台 + 「继承 / 覆盖」闸门 + 数值微调。

解决的问题（用户 2026-07-25 点名）：
- 气泡位置以前只有一个 ``anchorOffsetY`` 裸数字框，**初值恒 0、没有任何预览**，
  等于让人对着 0 盲调——全工程 35 处 anchorOffset 里 34 处是 0、只有 1 处填了真值，
  就是这么来的。
- 现在展开即显示**当前生效的绝对锚点值**（自动算的 / 图集授权的 / 本处已覆盖的），
  勾「覆盖」后初值就是那个生效值，直接微调；不勾则不写键（继承）。
  **绝不初始化成 0 让人从零调。**

舞台画的三样东西与运行时同口径（`anim_atlas_preview` 是数学镜像，配 parity 测试）：
灰虚线 = 格子 quad（旧口径贴的地方）、青实线 = 当前帧内容框（新口径贴的地方）、
墨匣泡 = 气泡本体（按真实字号量宽高，含尾巴；皮肤与运行时 2026-08-18 定稿同口径）。
切状态下拉到 ``lie_down`` 就能看见两者差多少。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QFontMetricsF, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from .anim_atlas_preview import (
    HEAD_GAP,
    auto_bubble_anchor_y,
    authored_state_anchor,
    cell_pixel_size,
    content_box_local,
    crop_atlas_cell,
    frame_slots_of_state,
    reference_world_size,
    resolved_anim_world_pair,
    spritesheet_public_path,
)
from .character_dialogue import npc_uses_graph
from .form_layout import compact_form

STAGE_W = 260
STAGE_H = 220
_STAGE_MARGIN = 10

# 运行时气泡基准量（EmoteBubbleManager 的 BUBBLE_*），单位是世界 px。
# 2026-07-25 与运行时一同减半（原 20/8/4/6）——预览撒谎的代价比数字难看大得多，必须同步。
# 2026-08-18 与运行时一同换「墨匣」皮肤（方案甲定稿）：白圆角矩形 → 墨底金褐勾线切角+尾巴。
_BUBBLE_FONT_PX = 10
_BUBBLE_PAD_X = 6
_BUBBLE_PAD_Y = 3.5
_BUBBLE_CUT = 3.5
_BUBBLE_TAIL_W = 10
_BUBBLE_TAIL_H = 7

_COL_QUAD = QColor(150, 150, 150, 170)
_COL_CONTENT = QColor(64, 200, 210, 230)
_COL_GROUND = QColor(120, 120, 120, 120)
# 与运行时 BUBBLE_FILL/LINE 及 speech 分型取色同值（0x12100d×.92 / 0x6b5636 / 0xe8dcc8）
_COL_BUBBLE_BG = QColor(18, 16, 13, 235)
_COL_BUBBLE_LINE = QColor(107, 86, 54)
_COL_BUBBLE_TEXT = QColor(232, 220, 200)
# 与运行时 BUBBLE_FONT_FAMILY 同栈（楷体优先，字族缺失时逐级回落）
_BUBBLE_FONT_FAMILIES = ["Kaiti SC", "STKaiti", "KaiTi", "Songti SC", "SimSun"]


#: 「同步到游戏」推送口：主窗口在有 WebEngine 面时安装（见 main_window._push_bubble_anchor_preview）。
#: 签名 (target, anchor_y|None, emote, scale) -> 是否推送成功；未安装 = 该开关整体不出现。
_GAME_ANCHOR_PUSHER: Callable[[str, float | None, str, float], bool] | None = None


def set_game_anchor_pusher(fn: Callable[[str, float | None, str, float], bool] | None) -> None:
    """主窗口注入/撤销「同步到游戏」通道。共享控件散布在多个包里，用模块级注册避免层层穿参。"""
    global _GAME_ANCHOR_PUSHER
    _GAME_ANCHOR_PUSHER = fn


@dataclass
class BubbleAnchorActor:
    """舞台要画的对象。``kind`` 决定三态：actor 有动画、hotspot 只有展示图、none 画不了。"""

    kind: str = "none"                      # actor | hotspot | none
    label: str = ""
    hint: str = "先选 target 才能预览气泡位置"
    anim_data: dict | None = None
    anim_manifest_url: str | None = None
    world_w: float = 0.0
    world_h: float = 0.0
    inst_scale: float = 1.0
    inst_rot_deg: float = 0.0
    image_path: str | None = None           # hotspot 展示图磁盘路径
    states: list[str] = field(default_factory=list)
    default_state: str = ""


def actor_from_anim_bundle(
    model,
    bundle_key: str,
    *,
    label: str = "",
    inst_scale: float = 1.0,
    inst_rot_deg: float = 0.0,
) -> BubbleAnchorActor | None:
    """动画包名 → 舞台对象；包不存在 / 世界尺寸推不出时返回 None。"""
    from .anim_atlas_preview import anim_manifest_url_for_bundle

    data = (getattr(model, "animations", {}) or {}).get(str(bundle_key).strip())
    if not isinstance(data, dict):
        return None
    url = anim_manifest_url_for_bundle(bundle_key)
    pair = resolved_anim_world_pair(data, model, anim_manifest_url=url)
    if pair is None:
        return None
    states = [s for s in (data.get("states") or {}) if isinstance(s, str)]
    preferred = next((s for s in ("idle", "stand", "walk") if s in states), "")
    return BubbleAnchorActor(
        kind="actor",
        label=label or str(bundle_key),
        hint="",
        anim_data=data,
        anim_manifest_url=url,
        world_w=pair[0],
        world_h=pair[1],
        inst_scale=inst_scale,
        inst_rot_deg=inst_rot_deg,
        states=states,
        default_state=preferred or (states[0] if states else ""),
    )


def actor_for_emote_target(model, scene_id: str | None, target: str) -> BubbleAnchorActor:
    """`showEmote` 等的 target → 舞台对象。三态：能画的角色 / 只有展示图的热点 / 画不了并说明原因。"""
    from .anim_atlas_preview import anim_bundle_key_from_manifest_url
    from .image_path_picker import disk_path_for_runtime_url

    tid = str(target or "").strip()
    if not tid:
        return BubbleAnchorActor(hint="先选 target 才能预览气泡位置")
    if model is None:
        return BubbleAnchorActor(hint="无工程上下文，无法预览")
    if tid.startswith("_cut_"):
        return BubbleAnchorActor(
            hint=f"过场临时演员 {tid}\n运行时才生成，编辑器取不到它的动画包，只能靠数值调",
        )

    manifest = (
        model.player_avatar_anim_manifest()
        if tid == "player"
        else model.npc_anim_manifest_for_scene(scene_id, tid)
    )
    if manifest.strip():
        actor = actor_from_anim_bundle(
            model, anim_bundle_key_from_manifest_url(manifest), label=tid,
        )
        if actor is not None:
            npc = _scene_entity(model, scene_id, "npcs", tid)
            if npc:
                actor.inst_scale = _num(npc.get("scale"), 1.0, positive=True)
                actor.inst_rot_deg = _num(npc.get("rotation"), 0.0)
            return actor
        return BubbleAnchorActor(hint=f"{tid} 的动画包 {manifest} 读不到，无法预览")

    hs = _scene_entity(model, scene_id, "hotspots", tid)
    if hs:
        di = hs.get("displayImage")
        if isinstance(di, dict):
            ww = _num(di.get("worldWidth"), 0.0, positive=True)
            wh = _num(di.get("worldHeight"), 0.0, positive=True)
            disk = disk_path_for_runtime_url(model, str(di.get("image") or ""))
            if ww > 0 and wh > 0:
                return BubbleAnchorActor(
                    kind="hotspot",
                    label=tid,
                    hint="",
                    world_w=ww,
                    world_h=wh,
                    inst_scale=_num(hs.get("scale"), 1.0, positive=True),
                    inst_rot_deg=_num(hs.get("rotation"), 0.0),
                    image_path=str(disk) if disk else None,
                )
        return BubbleAnchorActor(hint=f"热点 {tid} 没有展示图，气泡锚在占位点上方，无从预览")

    return BubbleAnchorActor(hint=f"{tid} 不在当前场景（{scene_id or '未知'}）里，无法预览")


def actor_for_dialogue_speaker(
    model,
    kind: str,
    extra: str = "",
    graph_id: str = "",
) -> BubbleAnchorActor:
    """图对话说话人 → 舞台对象。

    图对话没有场景上下文（一张图可能挂在多个场景的 NPC 上），故按「全工程扫场景」解析，
    与立绘预览的 ``npc_portrait_slug_index`` / ``graph_context_portrait_slug`` 同套路：
    - ``player``：取 game_config 的默认装扮动画包（运行时可被 setPlayerAvatar 换，故仅静态预览）；
    - ``npc`` / ``sceneNpc`` 带显式 id：全场景找该 id 的 animFile（含 characterId 注册表继承）；
    - ``sceneNpc`` 不带 id（``@contextNpc``）：找 dialogueGraphId 指向本图的 NPC，唯一才认；
    - ``literal``：不是世界实体，本就不出气泡。
    """
    from .anim_atlas_preview import anim_bundle_key_from_manifest_url

    k = str(kind or "").strip()
    if k == "literal":
        return BubbleAnchorActor(hint="字面说话人不是世界实体，不会出「…」气泡")
    if model is None:
        return BubbleAnchorActor(hint="无工程上下文，无法预览")

    label = extra.strip() or k
    if k == "player":
        manifest = model.player_avatar_anim_manifest()
        label = "player"
    else:
        nid = extra.strip()
        if nid and nid != "@contextNpc":
            manifest, npc = _npc_anim_manifest_anywhere(model, nid)
            label = nid
        else:
            manifest, npc, why = _graph_context_npc_anim(model, graph_id)
            if not manifest:
                return BubbleAnchorActor(hint=why)
            label = str(npc.get("id") or "") if npc else "（按图归属解析）"
        if not manifest.strip():
            return BubbleAnchorActor(hint=f"{nid or '该说话人'} 没配 animFile（或不在任何场景里），无法预览")
        actor = actor_from_anim_bundle(model, anim_bundle_key_from_manifest_url(manifest), label=label)
        if actor is None:
            return BubbleAnchorActor(hint=f"动画包 {manifest} 读不到，无法预览")
        if npc:
            actor.inst_scale = _num(npc.get("scale"), 1.0, positive=True)
            actor.inst_rot_deg = _num(npc.get("rotation"), 0.0)
        return actor

    if not manifest.strip():
        return BubbleAnchorActor(hint="game_config 没配 playerAvatar.animManifest，无法预览")
    actor = actor_from_anim_bundle(model, anim_bundle_key_from_manifest_url(manifest), label=label)
    return actor or BubbleAnchorActor(hint=f"动画包 {manifest} 读不到，无法预览")


def _npc_anim_manifest_anywhere(model, npc_id: str) -> tuple[str, dict | None]:
    """全场景找该 npcId 的 animFile（先见非空者优先，与立绘索引同口径）。"""
    for sc in (getattr(model, "scenes", {}) or {}).values():
        for npc in (sc or {}).get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            if str(npc.get("id") or npc.get("npcId") or "").strip() != npc_id:
                continue
            af = model.character_field(npc, "animFile")
            if af.strip():
                return af.strip(), npc
    return "", None


def _graph_context_npc_anim(model, graph_id: str) -> tuple[str, dict | None, str]:
    """按「谁挂了这张图」反查 NPC；唯一才认，歧义/找不到时把原因说清楚。"""
    gid = str(graph_id or "").strip()
    if not gid:
        return "", None, "本图未指定说话 NPC，且拿不到图 id，无法预览"
    found: list[tuple[str, dict]] = []
    registry = getattr(model, "character_registry", {}) or {}
    for sc in (getattr(model, "scenes", {}) or {}).values():
        for npc in (sc or {}).get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            # 图也要经注册表解引用：角色级绑定的图不在就地字段上，只读原始键会漏掉整类 NPC
            if not npc_uses_graph(npc, gid, registry):
                continue
            af = model.character_field(npc, "animFile")
            if af.strip():
                found.append((af.strip(), npc))
    if not found:
        return "", None, f"没有场景 NPC 挂着 {gid}，解析不出说话人，无法预览"
    uniq = {af for af, _ in found}
    if len(uniq) > 1:
        return "", None, f"{gid} 被多个不同动画包的 NPC 挂着，预览有歧义——请在拍级指定说话人"
    return found[0][0], found[0][1], ""


def _scene_entity(model, scene_id: str | None, bucket: str, entity_id: str) -> dict | None:
    if not scene_id:
        return None
    sc = (getattr(model, "scenes", {}) or {}).get(scene_id) or {}
    for e in sc.get(bucket) or []:
        if isinstance(e, dict) and str(e.get("id") or e.get("npcId") or "").strip() == entity_id:
            return e
    return None


def _num(v: object, default: float, *, positive: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    f = float(v)
    if positive and not f > 0:
        return default
    return f


class _BubbleStage(QWidget):
    """脚点固定在底部中线，世界→屏幕等比缩放；气泡可竖向拖，拖到哪写到哪。"""

    anchorDragged = Signal(float)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFixedSize(STAGE_W, STAGE_H)
        self.setCursor(Qt.CursorShape.ArrowCursor)
        self._actor = BubbleAnchorActor()
        self._sprite: QPixmap | None = None
        self._content: tuple[float, float, float] | None = None
        self._anchor_y = -100.0
        self._offset_x = 0.0
        self._bubble_text = "……"
        self._scale = 1.0
        self._drag_grab: float | None = None

    # -- 数据入口 -------------------------------------------------------
    def set_scene(
        self,
        actor: BubbleAnchorActor,
        sprite: QPixmap | None,
        content: tuple[float, float, float] | None,
    ) -> None:
        self._actor = actor
        self._sprite = sprite
        self._content = content
        self.update()

    def set_anchor(self, anchor_y: float, offset_x: float = 0.0) -> None:
        self._anchor_y = float(anchor_y)
        self._offset_x = float(offset_x)
        self.update()

    def set_bubble_text(self, text: str) -> None:
        self._bubble_text = str(text or "……")
        self.update()

    def set_bubble_scale(self, k: float) -> None:
        self._scale = float(k) if (isinstance(k, (int, float)) and k > 0) else 1.0
        self.update()

    # -- 几何 -----------------------------------------------------------
    def _bubble_world_size(self) -> tuple[float, float]:
        """与运行时 EmoteBubbleManager 同一组基准量 × 缩放（那边按新字号重排，这里同理）。"""
        k = self._scale
        f = QFont(self.font())
        f.setFamilies(_BUBBLE_FONT_FAMILIES)
        f.setPixelSize(max(1, int(round(_BUBBLE_FONT_PX * k))))
        fm = QFontMetricsF(f)
        # 高度含尾巴：运行时摆位口径是「总高贴锚点」（尾尖即锚点方向），预览必须同口径
        return (
            fm.horizontalAdvance(self._bubble_text) + _BUBBLE_PAD_X * k * 2,
            fm.height() + _BUBBLE_PAD_Y * k * 2 + _BUBBLE_TAIL_H * k,
        )

    def _fit(self) -> tuple[float, QPointF]:
        """世界→屏幕比例 k 与脚点屏幕坐标。竖向要同时塞下实体与气泡（锚点可能远高于头顶）。"""
        a = self._actor
        body_h = max(a.world_h * max(a.inst_scale, 0.01), 1.0)
        bw, bh = self._bubble_world_size()
        top_world = min(-body_h, self._anchor_y - bh)
        span_v = max(abs(top_world), 1.0)
        span_h = max(a.world_w * max(a.inst_scale, 0.01), bw, 1.0)
        k = min(
            (STAGE_H - _STAGE_MARGIN * 2) / span_v,
            (STAGE_W - _STAGE_MARGIN * 2) / span_h,
        )
        k = max(0.05, min(k, 4.0))
        return k, QPointF(STAGE_W / 2.0, STAGE_H - _STAGE_MARGIN)

    def _bubble_rect_px(self) -> QRectF:
        k, foot = self._fit()
        bw, bh = self._bubble_world_size()
        return QRectF(
            foot.x() + (self._offset_x - bw / 2.0) * k,
            foot.y() + (self._anchor_y - bh) * k,
            bw * k,
            bh * k,
        )

    # -- 绘制 -----------------------------------------------------------
    def paintEvent(self, _e) -> None:  # noqa: N802 (Qt 命名)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        a = self._actor
        if a.kind == "none":
            p.setPen(QPen(self.palette().mid().color()))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, a.hint or "无法预览")
            return

        k, foot = self._fit()
        p.setPen(QPen(_COL_GROUND, 1, Qt.PenStyle.DashLine))
        p.drawLine(int(_STAGE_MARGIN), int(foot.y()), int(STAGE_W - _STAGE_MARGIN), int(foot.y()))

        # 实体本体 + 两个框：与实例 transform 一起转（气泡不转——运行时挂在实体层不是实体容器上）
        p.save()
        p.translate(foot)
        if a.inst_rot_deg:
            p.rotate(a.inst_rot_deg)
        p.scale(k * a.inst_scale, k * a.inst_scale)
        if self._sprite is not None and not self._sprite.isNull():
            p.drawPixmap(
                QRectF(-a.world_w / 2.0, -a.world_h, a.world_w, a.world_h),
                self._sprite,
                QRectF(self._sprite.rect()),
            )
        pen = QPen(_COL_QUAD, 0, Qt.PenStyle.DashLine)
        pen.setCosmetic(True)
        p.setPen(pen)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(QRectF(-a.world_w / 2.0, -a.world_h, a.world_w, a.world_h))
        if self._content is not None:
            cw, ch, gap = self._content
            pen2 = QPen(_COL_CONTENT, 1.4)
            pen2.setCosmetic(True)
            p.setPen(pen2)
            p.drawRect(QRectF(-cw / 2.0, -(gap + ch), cw, ch))
        p.restore()

        # 「墨匣」泡：切角矩形 + 底边正中尾尖，一条路径成形（与运行时勾线连续同口径）
        rect = self._bubble_rect_px()
        kk = self._scale * k
        cut = _BUBBLE_CUT * kk
        tail_w = _BUBBLE_TAIL_W * kk
        tail_h = _BUBBLE_TAIL_H * kk
        body_bottom = rect.bottom() - tail_h
        cx = rect.center().x()
        path = QPainterPath()
        path.moveTo(rect.left() + cut, rect.top())
        path.lineTo(rect.right() - cut, rect.top())
        path.lineTo(rect.right(), rect.top() + cut)
        path.lineTo(rect.right(), body_bottom - cut)
        path.lineTo(rect.right() - cut, body_bottom)
        path.lineTo(cx + tail_w / 2, body_bottom)
        path.lineTo(cx, rect.bottom())
        path.lineTo(cx - tail_w / 2, body_bottom)
        path.lineTo(rect.left() + cut, body_bottom)
        path.lineTo(rect.left(), body_bottom - cut)
        path.lineTo(rect.left(), rect.top() + cut)
        path.closeSubpath()
        p.setPen(QPen(_COL_BUBBLE_LINE, max(1.0, kk)))
        p.setBrush(_COL_BUBBLE_BG)
        p.drawPath(path)
        f = QFont(self.font())
        f.setFamilies(_BUBBLE_FONT_FAMILIES)
        f.setPixelSize(max(6, int(round(_BUBBLE_FONT_PX * kk))))
        p.setFont(f)
        p.setPen(QPen(_COL_BUBBLE_TEXT))
        body_rect = QRectF(rect.left(), rect.top(), rect.width(), max(1.0, body_bottom - rect.top()))
        p.drawText(body_rect, Qt.AlignmentFlag.AlignCenter, self._bubble_text)

    # -- 拖拽 -----------------------------------------------------------
    def mousePressEvent(self, e) -> None:  # noqa: N802
        if e.button() != Qt.MouseButton.LeftButton or self._actor.kind == "none":
            return
        pos = e.position()
        if not self._bubble_rect_px().adjusted(-4, -6, 4, 6).contains(pos):
            return
        k, foot = self._fit()
        # 记住"按住点相对锚点"的偏移，拖起来不跳
        self._drag_grab = (pos.y() - foot.y()) / max(k, 1e-6) - self._anchor_y
        self.setCursor(Qt.CursorShape.ClosedHandCursor)

    def mouseMoveEvent(self, e) -> None:  # noqa: N802
        if self._drag_grab is None:
            if self._actor.kind != "none" and self._bubble_rect_px().contains(e.position()):
                self.setCursor(Qt.CursorShape.OpenHandCursor)
            else:
                self.setCursor(Qt.CursorShape.ArrowCursor)
            return
        k, foot = self._fit()
        y = (e.position().y() - foot.y()) / max(k, 1e-6) - self._drag_grab
        self._anchor_y = float(y)
        self.update()
        self.anchorDragged.emit(self._anchor_y)

    def mouseReleaseEvent(self, _e) -> None:  # noqa: N802
        self._drag_grab = None
        self.setCursor(Qt.CursorShape.ArrowCursor)


class BubbleAnchorPickField(QWidget):
    """气泡头顶锚字段：``value()`` 返回 ``float | None``（None = 继承，不写键）。"""

    changed = Signal()

    def __init__(
        self,
        parent: QWidget | None,
        model,
        committed: object,
        actor_provider: Callable[[], BubbleAnchorActor | None],
        *,
        bubble_text_provider: Callable[[], str] | None = None,
        committed_scale: object = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._actor_provider = actor_provider
        self._bubble_text_provider = bubble_text_provider
        self._actor = BubbleAnchorActor()
        self._auto_anchor = -100.0
        self._has_content_box = False
        self._authored_state_frac: float | None = None
        self._loading = False

        self._stage = _BubbleStage(self)
        self._stage.anchorDragged.connect(self._on_dragged)

        self._chk = QCheckBox("覆盖", self)
        self._chk.setToolTip(
            "不勾 = 继承自动锚（不写键，随动画/素材自动跟随）。\n"
            "勾上 = 本处固定为下面这个绝对锚点值（初值就是当前生效值，直接微调即可）。",
        )
        self._chk.toggled.connect(self._on_override_toggled)

        self._spin = QDoubleSpinBox(self)
        self._spin.setRange(-4000.0, 4000.0)
        self._spin.setDecimals(1)
        self._spin.setSingleStep(2.0)
        self._spin.setSuffix(" px")
        self._spin.setMaximumWidth(120)
        self._spin.setToolTip("气泡**底边**相对角色脚点的世界 y：负=在脚点上方。越接近 0 越贴地。")
        self._spin.valueChanged.connect(self._on_spin)

        self._src = QLabel("", self)
        self._src.setWordWrap(True)

        # 大小：与锚点同一套阶梯——不勾=继承 game_config.emoteBubbleScale（显示的就是那个生效值），
        # 勾上=本处单独给。同样绝不初始化成 0/1 这种"跟当前不符"的数。
        self._scale_chk = QCheckBox("覆盖大小", self)
        self._scale_chk.setToolTip(
            "不勾 = 继承全局气泡缩放（game_config.emoteBubbleScale），不写键。\n"
            "勾上 = 本处单独给一个倍率；左边预览会立刻按新尺寸重画。",
        )
        self._scale_chk.toggled.connect(self._on_scale_override_toggled)
        self._scale_spin = QDoubleSpinBox(self)
        self._scale_spin.setRange(0.3, 4.0)
        self._scale_spin.setSingleStep(0.1)
        self._scale_spin.setDecimals(2)
        self._scale_spin.setMaximumWidth(90)
        self._scale_spin.setEnabled(False)
        self._scale_spin.setToolTip("气泡整体倍率：字号/内边距/圆角/描边一起放大，文字按新字号重排不糊")
        self._scale_spin.valueChanged.connect(self._on_scale_spin)

        self._state = QComboBox(self)
        self._state.setMaximumWidth(150)
        self._state.setToolTip("只影响预览，不写进数据。切到 lie_down / crouch 可检查矮姿态下气泡是否还贴身。")
        self._state.currentIndexChanged.connect(lambda _i: self._refresh_frame_range())

        self._frame = QSlider(Qt.Orientation.Horizontal, self)
        self._frame.setMaximumWidth(150)
        self._frame.setToolTip("预览帧（只影响预览）")
        self._frame.valueChanged.connect(lambda _v: self._redraw())

        reset = QPushButton("回到自动", self)
        reset.setToolTip("清掉本处覆盖，回到按当前帧内容自动算的锚点")
        reset.clicked.connect(self._reset_to_auto)

        # 「同步到游戏」：把当前锚点与大小实时打进正在跑的游戏，看真场景真透视下的落点。
        # 只有主窗口装好了推送口（游戏在 WebEngine 面里跑着）才出现，否则是个骗人的死开关。
        self._sync_game = QCheckBox("同步到游戏", self)
        self._sync_game.setToolTip(
            "勾上后每次改锚点/大小都实时打进正在运行的游戏里，在真场景真透视下看效果。\n"
            "需要游戏正在编辑器的游戏页签/弹窗里跑着；取消勾选会清掉预览气泡。",
        )
        self._sync_game.toggled.connect(self._on_sync_game_toggled)
        self._sync_game.setVisible(_GAME_ANCHOR_PUSHER is not None)

        form = compact_form(QFormLayout())
        form.addRow(self._chk, self._spin)
        form.addRow(self._scale_chk, self._scale_spin)
        form.addRow("来源", self._src)
        form.addRow("预览状态", self._state)
        form.addRow("预览帧", self._frame)
        form.addRow("", reset)
        form.addRow("", self._sync_game)

        right = QVBoxLayout()
        right.setContentsMargins(0, 0, 0, 0)
        right.addLayout(form)
        right.addStretch(1)

        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.addWidget(self._stage)
        row.addLayout(right, 1)

        self._committed: float | None = _as_float_or_none(committed)
        self._committed_scale: float | None = _as_float_or_none(committed_scale)
        self.refresh_actor()
        self._apply_committed()
        self._apply_committed_scale()

    # -- 对外 -----------------------------------------------------------
    def value(self) -> float | None:
        """None = 继承（调用方不要写这个键）。"""
        return float(self._spin.value()) if self._chk.isChecked() else None

    def set_committed_anchor(self, anchor_y: float | None) -> None:
        """外部换了编辑对象（如 anim 编辑器换选状态）：重置为该对象的已存值。
        None = 无授权，回到继承态并显示自动值（**不是 0**）。"""
        self._committed = _as_float_or_none(anchor_y)
        self._loading = True
        try:
            self._chk.setChecked(self._committed is not None)
        finally:
            self._loading = False
        self._redraw()
        if self._committed is not None:
            self._loading = True
            try:
                self._spin.setValue(self._committed)
            finally:
                self._loading = False
            self._stage.set_anchor(self._current_anchor())
            self._sync_enabled()

    def set_offset_x(self, ox: float) -> None:
        """兄弟字段 anchorOffsetX 的当前值：只影响预览摆位（X 的基准恒为实体中心，0 就是全局值）。"""
        self._stage.set_anchor(self._current_anchor(), float(ox or 0.0))

    def refresh_actor(self) -> None:
        """target / 说话人变了时重建舞台。取不到对象就进「画不了」态并说明原因。"""
        actor = None
        try:
            actor = self._actor_provider()
        except Exception:  # noqa: BLE001 — 预览绝不能反噬编辑器
            actor = None
        self._actor = actor or BubbleAnchorActor()
        self._loading = True
        try:
            self._state.clear()
            for s in self._actor.states:
                self._state.addItem(s)
            if self._actor.default_state:
                i = self._state.findText(self._actor.default_state)
                if i >= 0:
                    self._state.setCurrentIndex(i)
        finally:
            self._loading = False
        self.refresh_bubble_text()
        self._refresh_frame_range()

    def refresh_bubble_text(self) -> None:
        """气泡文案变了：只重量气泡宽高，不重建状态列表（否则预览状态会被顶回缺省）。"""
        if self._bubble_text_provider is None:
            return
        try:
            self._stage.set_bubble_text(self._bubble_text_provider())
        except Exception:  # noqa: BLE001 — 预览绝不能反噬编辑器
            pass

    # -- 内部 -----------------------------------------------------------
    def _refresh_frame_range(self) -> None:
        slots = self._current_slots()
        self._frame.blockSignals(True)
        self._frame.setMinimum(0)
        self._frame.setMaximum(max(0, len(slots) - 1))
        if self._frame.value() > self._frame.maximum():
            self._frame.setValue(0)
        self._frame.blockSignals(False)
        self._frame.setEnabled(len(slots) > 1)
        self._redraw()

    def _current_slots(self) -> list[int]:
        a = self._actor
        if a.kind != "actor" or not isinstance(a.anim_data, dict):
            return []
        return frame_slots_of_state(a.anim_data, self._state.currentText())

    def _current_slot(self) -> int | None:
        slots = self._current_slots()
        if not slots:
            return None
        return slots[min(self._frame.value(), len(slots) - 1)]

    def _atlas_pixmap(self) -> QPixmap | None:
        a = self._actor
        if a.kind == "hotspot" and a.image_path:
            pm = QPixmap(a.image_path)
            return pm if not pm.isNull() else None
        if a.kind != "actor" or not isinstance(a.anim_data, dict):
            return None
        path = spritesheet_public_path(
            self._model, str(a.anim_data.get("spritesheet", "")), a.anim_manifest_url,
        )
        if path is None or not path.is_file():
            return None
        pm = QPixmap(str(path))
        return pm if not pm.isNull() else None

    def _compute(self) -> tuple[QPixmap | None, tuple[float, float, float] | None, float]:
        """→ (当前帧图, 内容框, 自动锚)。热点无 atlasFrames，内容框为 None、锚回落 quad。"""
        a = self._actor
        atlas = self._atlas_pixmap()
        if a.kind == "hotspot":
            auto = -max(a.world_h * max(a.inst_scale, 0.01), 1.0) - HEAD_GAP
            return atlas, None, auto
        if a.kind != "actor" or not isinstance(a.anim_data, dict) or atlas is None:
            return None, None, self._fallback_anchor()
        slot = self._current_slot()
        if slot is None:
            return None, None, self._fallback_anchor()
        cell = cell_pixel_size(a.anim_data, atlas)
        frame_pm = crop_atlas_cell(
            atlas,
            int(a.anim_data.get("cols", 1) or 1),
            int(a.anim_data.get("rows", 1) or 1),
            slot,
            cell_w=int(cell[0]) if cell else None,
            cell_h=int(cell[1]) if cell else None,
        )
        content = content_box_local(a.anim_data, slot, a.world_w, a.world_h, atlas=atlas)
        auto = auto_bubble_anchor_y(
            a.anim_data, slot, a.world_w, a.world_h, atlas=atlas,
            state=self._state.currentText(),
            inst_scale=a.inst_scale, inst_rot_deg=a.inst_rot_deg,
        )
        return frame_pm, content, auto

    # -- 大小 -----------------------------------------------------------
    def scale_value(self) -> float | None:
        """None = 继承全局（调用方不要写这个键）。"""
        return float(self._scale_spin.value()) if self._scale_chk.isChecked() else None

    def _global_scale(self) -> float:
        """全局缺省（game_config.emoteBubbleScale）；读不到按 1。"""
        cfg = getattr(self._model, "game_config", None) if self._model is not None else None
        raw = cfg.get("emoteBubbleScale") if isinstance(cfg, dict) else None
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not raw > 0:
            return 1.0
        return max(0.3, min(4.0, float(raw)))

    def _effective_scale(self) -> float:
        return float(self._scale_spin.value()) if self._scale_chk.isChecked() else self._global_scale()

    def _sync_scale_ui(self) -> None:
        on = self._scale_chk.isChecked()
        self._scale_spin.setEnabled(on)
        if not on:
            self._loading = True
            try:
                self._scale_spin.setValue(self._global_scale())   # 显示的就是当前生效值
            finally:
                self._loading = False
        self._stage.set_bubble_scale(self._effective_scale())

    def _on_scale_override_toggled(self, on: bool) -> None:
        if on and not self._loading:
            self._loading = True
            try:
                self._scale_spin.setValue(self._global_scale())   # 从全局值起步，不从别处
            finally:
                self._loading = False
        self._sync_scale_ui()
        if not self._loading:
            self._push_to_game()
            self.changed.emit()

    def _on_scale_spin(self, _v: float) -> None:
        if self._loading:
            return
        self._stage.set_bubble_scale(self._effective_scale())
        self._push_to_game()
        self.changed.emit()

    def _apply_committed_scale(self) -> None:
        self._loading = True
        try:
            self._scale_chk.setChecked(self._committed_scale is not None)
            if self._committed_scale is not None:
                self._scale_spin.setValue(self._committed_scale)
        finally:
            self._loading = False
        self._sync_scale_ui()

    def _fallback_anchor(self) -> float:
        """预览对象取不到时的起步值：按参考角色（player_anim）的身高给，至少量级不离谱。
        绝不用 0 或 1px——那种值给出去等于让人从头盲调，正是本控件要消灭的东西。"""
        h = self._actor.world_h
        if not (h > 0):
            h = reference_world_size(self._model)[1] if self._model is not None else 160.0
        return -max(h * max(self._actor.inst_scale, 0.01), 1.0) - HEAD_GAP

    def _current_anchor(self) -> float:
        return float(self._spin.value()) if self._chk.isChecked() else self._auto_anchor

    def _redraw(self) -> None:
        sprite, content, auto = self._compute()
        self._auto_anchor = auto
        self._has_content_box = content is not None
        self._authored_state_frac = (
            authored_state_anchor(self._actor.anim_data, self._state.currentText())
            if isinstance(self._actor.anim_data, dict) else None
        )
        self._stage.set_scene(self._actor, sprite, content)
        # 关键：未覆盖时，数值框显示的就是**当前生效值**，勾上覆盖即从此值起步微调
        if not self._chk.isChecked():
            self._loading = True
            try:
                self._spin.setValue(auto)
            finally:
                self._loading = False
        self._stage.set_anchor(self._current_anchor())
        if hasattr(self, "_scale_chk"):
            self._sync_scale_ui()
        self._sync_enabled()

    def _sync_enabled(self) -> None:
        overridden = self._chk.isChecked()
        self._spin.setEnabled(overridden)
        if self._actor.kind == "none":
            self._src.setText(self._actor.hint or "无法预览")
        elif overridden:
            self._src.setText(f"本处覆盖（自动值为 {self._auto_anchor:.1f}）")
        else:
            if self._authored_state_frac is not None:
                src = f"图集授权锚（{self._state.currentText()} = {self._authored_state_frac:.2f} 格高）"
            elif self._has_content_box:
                src = "内容框自动"
            else:
                src = "格子 quad（图集无 atlasFrames）"
            self._src.setText(f"继承：{src}")

    def _on_override_toggled(self, on: bool) -> None:
        if on and not self._loading:
            self._loading = True
            try:
                self._spin.setValue(self._auto_anchor)   # 从生效值起步，绝不从 0
            finally:
                self._loading = False
        self._stage.set_anchor(self._current_anchor())
        self._sync_enabled()
        if not self._loading:
            self._push_to_game()
            self.changed.emit()

    def _on_spin(self, v: float) -> None:
        if self._loading:
            return
        self._stage.set_anchor(float(v))
        self._sync_enabled()
        self._push_to_game()
        self.changed.emit()

    def _on_dragged(self, y: float) -> None:
        self._loading = True
        try:
            if not self._chk.isChecked():
                self._chk.setChecked(True)      # 拖了就是要覆盖
            self._spin.setValue(y)
        finally:
            self._loading = False
        self._sync_enabled()
        self._push_to_game()
        self.changed.emit()

    def _push_to_game(self) -> None:
        """把当前锚点与大小推给正在跑的游戏。推不动（游戏没跑 / 目标解析不到）就关掉开关并说明——
        fail-safe 不 fail-open：不给"以为同步上了其实没有"的假象。"""
        if not getattr(self, "_sync_game", None) or not self._sync_game.isChecked():
            return
        pusher = _GAME_ANCHOR_PUSHER
        if pusher is None or self._actor.kind == "none" or not self._actor.label:
            return
        text = "……"
        if self._bubble_text_provider is not None:
            try:
                text = self._bubble_text_provider() or "……"
            except Exception:  # noqa: BLE001
                pass
        try:
            ok = pusher(self._actor.label, self._current_anchor(), text, self._effective_scale())
        except Exception:  # noqa: BLE001 — 预览通道绝不能反噬编辑器
            ok = False
        if not ok:
            self._sync_game.blockSignals(True)
            self._sync_game.setChecked(False)
            self._sync_game.blockSignals(False)
            self._src.setText("游戏侧推送失败（没在跑？目标不在当前场景？），已关掉同步")

    def _on_sync_game_toggled(self, on: bool) -> None:
        if on:
            self._push_to_game()
            return
        pusher = _GAME_ANCHOR_PUSHER
        if pusher is not None:
            try:
                pusher("", None, "", 1.0)      # 空 target = 清预览
            except Exception:  # noqa: BLE001
                pass

    def _reset_to_auto(self) -> None:
        if not self._chk.isChecked():
            return
        self._loading = True
        try:
            self._chk.setChecked(False)
        finally:
            self._loading = False
        self._redraw()
        self.changed.emit()

    def _apply_committed(self) -> None:
        if self._committed is None:
            return
        self._loading = True
        try:
            self._chk.setChecked(True)
            self._spin.setValue(self._committed)
        finally:
            self._loading = False
        self._sync_enabled()
        self._stage.set_anchor(self._current_anchor())


def _as_float_or_none(v: object) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None
