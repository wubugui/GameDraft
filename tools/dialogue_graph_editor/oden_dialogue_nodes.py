"""OdenGraphQt 节点类型：对话图节点与幽灵占位节点。"""
from __future__ import annotations

from typing import Any

from OdenGraphQt import BaseNode

from .graph_document import node_summary
from .graph_mutations import (
    OUT_CHOICE,
    OUT_NEXT,
    OUT_SWITCH_CASE,
    OUT_SWITCH_DEFAULT,
)

PN_NEXT = "p_next"


def pn_choice(i: int) -> str:
    return f"p_c{i}"


def pn_switch_case(i: int) -> str:
    return f"p_s{i}"


PN_SWITCH_DEFAULT = "p_sd"


def parse_dialogue_out_port(name: str) -> tuple[str, int] | None:
    if name == PN_NEXT:
        return OUT_NEXT, 0
    if name.startswith("p_c") and name[3:].isdigit():
        return OUT_CHOICE, int(name[3:])
    if name.startswith("p_s") and name[3:].isdigit():
        return OUT_SWITCH_CASE, int(name[3:])
    if name == PN_SWITCH_DEFAULT:
        return OUT_SWITCH_DEFAULT, -1
    return None


def _dialogue_type_label_zh(t: object) -> str:
    if not isinstance(t, str):
        return "未知"
    return {
        "line": "对白",
        "runActions": "动作",
        "choice": "选项",
        "switch": "分支",
        "end": "结束",
    }.get(t, f"其它({t})")


# 画布节点填充 / 描边（与端口配色同系，便于一眼区分类型）
_TYPE_BODY_RGBA: dict[str, tuple[int, int, int, int]] = {
    "line": (52, 88, 132, 255),
    "runActions": (118, 78, 40, 255),
    "choice": (128, 76, 52, 255),
    "switch": (88, 62, 118, 255),
    "end": (86, 48, 58, 255),
}
_TYPE_BORDER_RGBA: dict[str, tuple[int, int, int, int]] = {
    "line": (92, 138, 200, 255),
    "runActions": (200, 145, 75, 255),
    "choice": (215, 135, 95, 255),
    "switch": (165, 125, 205, 255),
    "end": (175, 95, 110, 255),
}
_DEFAULT_BODY_RGBA = (52, 52, 58, 255)
_DEFAULT_BORDER_RGBA = (75, 75, 88, 255)


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

    def apply_dialogue_shape(
        self,
        raw: dict[str, Any],
        *,
        is_entry: bool,
        diag_tag: str | None,
        group_rgba: tuple[int, int, int, int] | None = None,
    ) -> None:
        for p in list(self.output_ports()):
            self.delete_output(p)
        t = raw.get("type")
        if t in ("line", "runActions"):
            self.add_output(
                PN_NEXT,
                multi_output=False,
                display_name=True,
                color=(100, 150, 230),
            )
        elif t == "choice":
            opts = raw.get("options") or []
            for i in range(len(opts)):
                self.add_output(
                    pn_choice(i),
                    multi_output=False,
                    display_name=True,
                    color=(210, 150, 90),
                )
            for i, opt in enumerate(opts):
                if not isinstance(opt, dict):
                    opt = {}
                self._set_output_port_caption(pn_choice(i), self._choice_port_caption(i, opt))
        elif t == "switch":
            cases = raw.get("cases") or []
            for i in range(len(cases)):
                self.add_output(
                    pn_switch_case(i),
                    multi_output=False,
                    display_name=True,
                    color=(160, 120, 200),
                )
            for i, c in enumerate(cases):
                if not isinstance(c, dict):
                    c = {}
                self._set_output_port_caption(pn_switch_case(i), self._switch_case_port_caption(i, c))
            self.add_output(
                PN_SWITCH_DEFAULT,
                multi_output=False,
                display_name=True,
                color=(120, 120, 140),
            )
            self._set_output_port_caption(PN_SWITCH_DEFAULT, "else")
        elif t == "end":
            pass
        else:
            pass

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

    @staticmethod
    def _choice_port_caption(index: int, opt: dict[str, Any]) -> str:
        oid = str(opt.get("id") or "").strip()
        otxt = str(opt.get("text") or "").strip()
        if oid and otxt:
            short = otxt if len(otxt) <= 20 else otxt[:17] + "…"
            return f"{oid} · {short}"
        if oid:
            return oid
        if otxt:
            return otxt[:24] + "…" if len(otxt) > 24 else otxt
        return f"[{index}]"

    @staticmethod
    def _switch_case_port_caption(index: int, case: dict[str, Any]) -> str:
        conds = case.get("conditions")
        if isinstance(conds, list) and conds:
            c0 = conds[0]
            if isinstance(c0, dict):
                if "flag" in c0:
                    fl = str(c0.get("flag") or "").strip()
                    if fl:
                        return fl[:22] + "…" if len(fl) > 22 else fl
                if "scenario" in c0:
                    s = str(c0.get("scenario") or "").strip()
                    ph = str(c0.get("phase") or "").strip()
                    label = f"{s}/{ph}" if ph else s
                    if label:
                        return label[:22] + "…" if len(label) > 22 else label
                if "questId" in c0:
                    q = str(c0.get("questId") or "").strip()
                    if q:
                        return f"Q:{q[:18]}" + ("…" if len(q) > 18 else "")
                if "quest" in c0:
                    q = str(c0.get("quest") or "").strip()
                    if q:
                        return f"Q:{q[:18]}" + ("…" if len(q) > 18 else "")
        cond = case.get("condition")
        if isinstance(cond, dict) and cond:
            if any(k in cond for k in ("any", "all", "not")):
                return f"[{index}] 条件组"
            if "flag" in cond:
                fl = str(cond.get("flag") or "").strip()
                if fl:
                    return fl[:22] + "…" if len(fl) > 22 else fl
            if "scenario" in cond:
                s = str(cond.get("scenario") or "").strip()
                ph = str(cond.get("phase") or "").strip()
                label = f"{s}/{ph}" if ph else s
                if label:
                    return label[:22] + "…" if len(label) > 22 else label
        return f"case{index}"

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
