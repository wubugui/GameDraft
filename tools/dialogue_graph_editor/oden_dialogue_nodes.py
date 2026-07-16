"""OdenGraphQt 节点类型：对话图节点与幽灵占位节点。"""
from __future__ import annotations

from typing import Any

from OdenGraphQt import BaseNode

from .graph_document import node_summary
from .dialogue_ports import (
    OUT_CHOICE,
    OUT_CONTEXT_STATE_CASE,
    OUT_CONTEXT_STATE_DEFAULT,
    OUT_NEXT,
    OUT_OWNER_STATE_CASE,
    OUT_OWNER_STATE_DEFAULT,
    OUT_OWNER_STATE_MISSING,
    OUT_SWITCH_CASE,
    OUT_SWITCH_DEFAULT,
    PN_CONTEXT_STATE_DEFAULT,
    PN_NEXT,
    PN_OWNER_STATE_DEFAULT,
    PN_OWNER_STATE_MISSING,
    PN_SWITCH_DEFAULT,
    parse_dialogue_out_port,
    port_name_for_spec,
    pn_choice,
    pn_context_state_case,
    pn_owner_state_case,
    pn_switch_case,
)
from .dialogue_topology import iter_output_slots


def _dialogue_type_label_zh(t: object) -> str:
    # 画布标题与布局尺寸估算共用同一份标签映射（graph_document.node_type_label_zh），避免漂移。
    from .graph_document import node_type_label_zh

    return node_type_label_zh(t)


# 画布节点填充 / 描边（与端口配色同系，便于一眼区分类型）
_TYPE_BODY_RGBA: dict[str, tuple[int, int, int, int]] = {
    "line": (52, 88, 132, 255),
    "runActions": (118, 78, 40, 255),
    "choice": (128, 76, 52, 255),
    "switch": (88, 62, 118, 255),
    "ownerState": (42, 110, 98, 255),
    "contextState": (62, 92, 128, 255),
    "end": (86, 48, 58, 255),
}
_TYPE_BORDER_RGBA: dict[str, tuple[int, int, int, int]] = {
    "line": (92, 138, 200, 255),
    "runActions": (200, 145, 75, 255),
    "choice": (215, 135, 95, 255),
    "switch": (165, 125, 205, 255),
    "ownerState": (95, 185, 155, 255),
    "contextState": (120, 160, 210, 255),
    "end": (175, 95, 110, 255),
}
_DEFAULT_BODY_RGBA = (52, 52, 58, 255)
_DEFAULT_BORDER_RGBA = (75, 75, 88, 255)
_PORT_RGBA_BY_KIND: dict[str, tuple[int, int, int]] = {
    OUT_NEXT: (100, 150, 230),
    OUT_CHOICE: (210, 150, 90),
    OUT_SWITCH_CASE: (160, 120, 200),
    OUT_SWITCH_DEFAULT: (120, 120, 140),
    OUT_OWNER_STATE_CASE: (80, 175, 140),
    OUT_OWNER_STATE_DEFAULT: (70, 140, 120),
    OUT_OWNER_STATE_MISSING: (90, 120, 110),
    OUT_CONTEXT_STATE_CASE: (110, 150, 200),
    OUT_CONTEXT_STATE_DEFAULT: (90, 120, 170),
}


class DialogueFlowNode(BaseNode):
    """与 JSON 节点 id 同名的流程节点：左侧 in，右侧按类型若干 out。"""

    __identifier__ = "gamedraft.dialogue"
    NODE_NAME = "node"

    def __init__(self) -> None:
        super().__init__()
        self.set_port_deletion_allowed(True)
        self.add_input("in", multi_input=True, display_name=False)
        try:
            self.view.text_item.set_locked(True)
        except Exception:
            pass

    def output_port_signature(self, raw: dict[str, Any]) -> tuple[str, ...]:
        """期望的输出端口名序列；与画布现有端口比对以判断能否原地视觉更新。"""
        out: list[str] = []
        for slot in iter_output_slots(raw):
            pn = port_name_for_spec(slot.kind, slot.index)
            if pn is not None:
                out.append(pn)
        return tuple(out)

    def current_output_port_names(self) -> tuple[str, ...]:
        return tuple(p.name() for p in self.output_ports())

    def _rebuild_output_ports(self, raw: dict[str, Any]) -> None:
        """删除并重建输出端口（会断开既有连线）；仅在端口签名变化时调用。"""
        for p in list(self.output_ports()):
            self.delete_output(p)
        for slot in iter_output_slots(raw):
            port_name = port_name_for_spec(slot.kind, slot.index)
            if port_name is None:
                continue
            self.add_output(
                port_name,
                multi_output=False,
                display_name=True,
                color=_PORT_RGBA_BY_KIND.get(slot.kind, (120, 120, 140)),
            )
            self._set_output_port_caption(port_name, slot.label)

    def apply_dialogue_shape(
        self,
        raw: dict[str, Any],
        *,
        is_entry: bool,
        diag_tag: str | None,
        group_rgba: tuple[int, int, int, int] | None = None,
    ) -> None:
        """整建：重建端口 + 视觉。用于整图 rebuild。"""
        self._rebuild_output_ports(raw)
        self.apply_dialogue_visual(
            raw, is_entry=is_entry, diag_tag=diag_tag, group_rgba=group_rgba
        )

    def apply_dialogue_visual(
        self,
        raw: dict[str, Any],
        *,
        is_entry: bool,
        diag_tag: str | None,
        group_rgba: tuple[int, int, int, int] | None = None,
    ) -> None:
        """原地视觉更新：颜色/标签/端口标题/tooltip。不增删端口、不动连线，故安全无闪烁。

        端口数量/种类不变时由调用方择此路径（编辑节点正文/选项文字等高频场景）。
        """
        t = raw.get("type")
        # 端口标题可能随内容变化（如 choice 选项文字），原地更新已存在端口的 caption
        for slot in iter_output_slots(raw):
            port_name = port_name_for_spec(slot.kind, slot.index)
            if port_name is not None:
                self._set_output_port_caption(port_name, slot.label)

        type_key = t if isinstance(t, str) else None
        body_by_type = _TYPE_BODY_RGBA.get(type_key, _DEFAULT_BODY_RGBA)
        border_by_type = _TYPE_BORDER_RGBA.get(type_key, _DEFAULT_BORDER_RGBA)

        if diag_tag == "warn":
            self.set_property("color", (100, 75, 45, 255), push_undo=False)
            self.set_property("border_color", (190, 135, 70, 255), push_undo=False)
        elif is_entry:
            self.set_property("color", (45, 120, 85, 255), push_undo=False)
            self.set_property("border_color", (75, 195, 130, 255), push_undo=False)
        elif group_rgba is not None:
            self.set_property("color", group_rgba, push_undo=False)
            self.set_property("border_color", border_by_type, push_undo=False)
        else:
            self.set_property("color", body_by_type, push_undo=False)
            self.set_property("border_color", border_by_type, push_undo=False)

        label = _dialogue_type_label_zh(t)
        nid = self.name()
        summ = node_summary(nid, raw, max_text=24)
        if summ:
            self.view.text_item.setPlainText(f"{label} · {nid}\n{summ}")
        else:
            self.view.text_item.setPlainText(f"{label}\n{nid}")

        self.view.draw_node()

        tip_lines = [f"类型：{label}", f"节点 ID：{nid}"]
        summ_tip = node_summary(nid, raw, max_text=80)
        if summ_tip:
            tip_lines.append(f"摘要：{summ_tip}")
        if is_entry:
            tip_lines.append("入口节点")
        if diag_tag == "warn":
            tip_lines.append("校验：存在问题（详见左侧列表提示）")
        if group_rgba is not None:
            tip_lines.append("已着色：编辑器分组")
        self.view.setToolTip("<br/>".join(tip_lines))

    def _set_output_port_caption(self, port_name: str, caption: str) -> None:
        p = self.get_output(port_name)
        if p is None:
            return
        try:
            ti = self.view.get_output_text_item(p.view)
        except Exception:
            return
        ti.setPlainText(caption)


class DialogueGhostNode(BaseNode):
    """缺失目标 id 的占位：仅 in，属性 missing_id 为 JSON 中的目标字符串。"""

    __identifier__ = "gamedraft.dialogue"
    NODE_NAME = "missing"

    def __init__(self) -> None:
        super().__init__()
        self.add_input("in", multi_input=True, display_name=False)
        self.missing_id: str = ""
        try:
            self.view.text_item.set_locked(True)
        except Exception:
            pass

    def setup_ghost(self, gid: str) -> None:
        self.missing_id = gid
        self.set_property("color", (55, 55, 72, 255), push_undo=False)
        self.set_property("border_color", (120, 95, 140, 255), push_undo=False)
        self.set_name(f"? {gid}", push_undo=False)
        self.view.draw_node()
        self.view.setToolTip(
            f"缺失目标节点<br/>连线指向的 id「{gid}」不在本图 nodes 中。<br/>保存前请补节点或改连线。"
        )


class DialogueGroupNode(BaseNode):
    """折叠分组的「超级节点」：一个 in（收所有入组连线）+ 一个 out（发所有出组连线）。

    纯编辑器视觉——折叠时把整组画成一个节点，跨组边改接到它；展开即恢复。**不对应任何图节点、
    绝不进 JSON**（其保留节点名不是图节点 id，所有坐标/幽灵/分组快照都按类型过滤掉它）。
    """

    __identifier__ = "gamedraft.dialogue"
    NODE_NAME = "group"

    def __init__(self) -> None:
        super().__init__()
        self.group_gid: str = ""
        self.add_input("in", multi_input=True, display_name=False)
        self.add_output("out", multi_output=True, display_name=False)
        try:
            self.view.text_item.set_locked(True)
        except Exception:
            pass

    def setup_group(
        self, gid: str, title: str, count: int, rgba: tuple[int, int, int, int]
    ) -> None:
        # 不改 name（保留保留名，供边路由/命中检测按名反查）；可见标签走 text_item（同 DialogueFlowNode）。
        self.group_gid = gid
        self.set_property("color", rgba, push_undo=False)
        self.set_property("border_color", (235, 225, 180, 255), push_undo=False)
        self.view.text_item.setPlainText(f"▸ 分组：{title}\n（已折叠 {count} 个节点·双击展开）")
        self.view.draw_node()
        self.view.setToolTip(
            f"折叠的分组「{title}」<br/>含 {count} 个节点。<br/>"
            "跨组连线已改接到本节点；双击或右键可展开。<br/>纯视觉，不影响数据。"
        )
