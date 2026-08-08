"""实体重构（迁移场景 / 重命名 / 安全删除）的预览确认对话框。

只做 UI：引用报告展示 + 参数收集 + 确认时调 ``entity_refactor`` 引擎；引擎前置校验
失败（EntityRefactorError）弹警告且**不关窗**，成功后由调用方刷新画布。零磁盘写入
（落盘仍走 Save All）。
"""

from __future__ import annotations

import re
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from . import entity_refactor as er
from .id_ref_selector import IdRefSelector


_KIND_LABEL = {"npc": "NPC", "hotspot": "热区", "zone": "Zone", "spawn": "出生点"}


def _usage_tree(report: dict[str, Any], parent: QWidget | None = None) -> QTreeWidget:
    """把 scan_entity_usages 报告渲染成分组树（按迁移/改名时的处置类别分组）。"""
    tree = QTreeWidget(parent)
    tree.setHeaderLabels(["引用位置", "计数 / 说明"])
    tree.setRootIsDecorated(True)
    tree.setColumnWidth(0, 300)

    def group(title: str, rows: list[tuple[str, str]], tip: str = "") -> None:
        if not rows:
            return
        top = QTreeWidgetItem(tree, [title, str(len(rows))])
        if tip:
            top.setToolTip(0, tip)
        for name, detail in rows:
            QTreeWidgetItem(top, [name, detail])
        top.setExpanded(True)

    group(
        "场景限定引用（迁移/改名自动跟随）",
        [(f"{h['bucket']}:{h['itemId']}", str(h["count"])) for h in report["qualified"]],
        "sceneId+id 寻址的动作（setSceneEntityPosition 等），机械改写跟随，无需人工。",
    )
    group(
        "本场景其它容器的裸引用（迁移后悬垂）",
        [(f"{h['container']}:{h['id']}", str(h["count"])) for h in report["sceneLocal"]],
        "运行时按当前场景解析；实体迁走后这些动作将静默跳过，需人工改指向或连带处理。",
    )
    group(
        "对话图裸引用（括号内为可达场景）",
        [(d["graphId"], f"{d['count']} ({'、'.join(d['reach']) if isinstance(d['reach'], list) else d['reach']})")
         for d in report["dialogues"]],
        "可达集 ⊆ 本场景的图改名可自动跟随；global / 跨场景可达的需人工判断。",
    )
    group(
        "全局面裸引用（叙事图/过场/任务等，无场景上下文）",
        [(f"{h['bucket']}:{h['itemId']}", str(h["count"]))
         for h in report["globalRefs"] if h.get("note") != "otherSceneBare"],
        "id 在多场景重复时指向歧义；只有全局唯一时改名才会自动跟随。",
    )
    group(
        "叙事图 wrapper 绑定（ownerType/ownerId）",
        # where=graph 是运行时真值面，where=element 是叙事编辑器读的镜像面，两者都会跟随改名
        [(b["graphId"], f"{b.get('where', 'graph')}.ownerId") for b in report["ownerBindings"]],
    )
    group(
        "玩家可见文本 [tag:npc:…]",
        [(f"{h['bucket']}:{h['itemId']}", str(h["count"])) for h in report["tagRefs"]],
        "全局解析；删除全项目最后一个同 id 实例会卡整工程保存。",
    )
    group(
        "任务引导目标（quests.json 的场景内浮标）",
        [(f"quest:{h['itemId']}", str(h["count"])) for h in report.get("questGuidance") or []],
        "sceneId+entityKind+entityId 的场景限定引用，改名/迁移自动跟随；"
        "**删除实体会让这些引导指空**（运行时不报错，只是引导默默不出现），需先改这些任务。",
    )
    group(
        "迁移后需人工复核的实体自带字段",
        [(item, "") for item in report.get("needsReview") or []],
    )
    trace = report.get("traceRefs") or 0
    if trace:
        QTreeWidgetItem(tree, ["emitNarrativeSignal 溯源串（trace-only，自动跟随）", str(trace)])
    if tree.topLevelItemCount() == 0:
        QTreeWidgetItem(tree, ["（无外部引用）", ""])
    return tree


class _RefactorDialogBase(QDialog):
    """公共骨架：说明行 + 报告树 + 表单区 + OK/Cancel；子类实现 _do_refactor。"""

    def __init__(
        self, model: Any, scene_id: str, kind: str, entity_id: str,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        self._kind = kind
        self._entity_id = entity_id
        self.result_summary: dict[str, Any] | None = None
        self._report = er.scan_entity_usages(model, scene_id, kind, entity_id)

        vbox = QVBoxLayout(self)
        head = QLabel(self._headline())
        head.setWordWrap(True)
        vbox.addWidget(head)
        vbox.addWidget(_usage_tree(self._report, self), stretch=1)
        self._form = QFormLayout()
        vbox.addLayout(self._form)
        self._buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        self._buttons.accepted.connect(self._on_accept)
        self._buttons.rejected.connect(self.reject)
        vbox.addWidget(self._buttons)
        self.resize(640, 480)

    def _headline(self) -> str:
        label = _KIND_LABEL.get(self._kind, self._kind)
        return (f"{label}「{self._entity_id}」（场景：{self._scene_id}）——"
                f"共 {self._report['totalRefs']} 处引用")

    # 子类返回 summary（成功）、None（用户在子对话框里取消，静默留在本框）或抛 EntityRefactorError
    def _do_refactor(self) -> dict[str, Any] | None:
        raise NotImplementedError

    def _on_accept(self) -> None:
        from PySide6.QtWidgets import QMessageBox
        try:
            summary = self._do_refactor()
        except er.EntityRefactorError as exc:
            QMessageBox.warning(self, self.windowTitle(), str(exc))
            return
        if summary is None:
            return
        self.result_summary = summary
        self.accept()


class MoveEntityDialog(_RefactorDialogBase):
    """迁移到其它场景：目标场景选择 + 报告确认。坐标保留原值，迁移后需在目标场景重摆。"""

    def __init__(self, model: Any, scene_id: str, kind: str, entity_id: str,
                 parent: QWidget | None = None) -> None:
        super().__init__(model, scene_id, kind, entity_id, parent)
        self.setWindowTitle("迁移到场景")
        self._dst = IdRefSelector(self, allow_empty=False, click_opens_popup=True)
        self._dst.set_items(
            [(s, s) for s in model.all_scene_ids() if s != scene_id])
        self._dst.setToolTip("实体 def 将整体搬到该场景；坐标保留原值，请迁移后在画布重新摆位。")
        self._form.addRow("目标场景", self._dst)
        note = QLabel("裸引用不会自动改写（见上方分组）；场景限定引用自动跟随。")
        note.setWordWrap(True)
        self._form.addRow(note)

    def _do_refactor(self) -> dict[str, Any]:
        dst = self._dst.current_id().strip()
        if not dst:
            raise er.EntityRefactorError("请选择目标场景")
        summary = er.move_entity(
            self._model, self._scene_id, self._kind, self._entity_id, dst)
        er.push_journal(self._model, summary)
        return summary


# 与新建场景 id（scene_editor._new_scene）同规则：空格 / 中文 / []: 等会破坏
# [tag:npc:…] 正则寻址与全局搜索。
_ID_CHARSET_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


class RenameEntityDialog(_RefactorDialogBase):
    """重命名实体 id：按歧义分级自动改写引用（详见 entity_refactor 模块 docstring）。"""

    def __init__(self, model: Any, scene_id: str, kind: str, entity_id: str,
                 parent: QWidget | None = None) -> None:
        super().__init__(model, scene_id, kind, entity_id, parent)
        self.setWindowTitle("重命名实体 id")
        # 新 id 是"定义自身"，自由输入合法（选择器铁律的唯一例外）
        self._new_id = QLineEdit(self)
        self._new_id.setText(entity_id)
        self._new_id.setToolTip(
            "全局唯一的 id 会连同对话图/叙事图/文本 [tag:npc:…] 一起改写；"
            "多场景重名的 id 只改写可证明指向本实体的引用，其余留给人工。\n"
            "新 id 仅允许字母 / 数字 / 下划线 / 连字符（与新建场景 id 同规则；"
            "空格、[]: 等字符会破坏 [tag:npc:…] 寻址）。")
        self._form.addRow("新 id", self._new_id)
        defined = self._report["definedInScenes"]
        if len(defined) > 1:
            warn = QLabel(f"⚠ 该 id 也出现在：{'、'.join(s for s in defined if s != scene_id)}"
                          "——全局面引用将不自动改写")
            warn.setWordWrap(True)
            self._form.addRow(warn)

    def _tag_follow_choice(self, new_id: str) -> bool | None:
        """非全局唯一 + 本场景是最后一个 npc 实例 + 存在 [tag:npc:…]：问「跟随改写/取消」。

        返回 False=无需处理、True=确认跟随改写、None=用户取消（静默留框）。
        与删除路径的硬拒口径对齐（引擎侧仍兜底硬拒，防绕过）。
        """
        if self._kind != "npc" or not self._report.get("tagRefs"):
            return False
        defined = self._report.get("definedInScenes") or []
        other_kind = self._report.get("otherKindScenes") or []
        unique_global = defined == [self._scene_id] and not other_kind
        last_instance = defined == [self._scene_id]
        if unique_global or not last_instance:
            return False  # 唯一→引擎自动跟随；非最后实例→旧 id 仍有 npc 落点，tag 不悬垂
        from PySide6.QtWidgets import QMessageBox
        n = sum(int(h.get("count") or 0) for h in self._report["tagRefs"])
        box = QMessageBox(self)
        box.setWindowTitle(self.windowTitle())
        box.setIcon(QMessageBox.Icon.Warning)
        box.setText(
            f"文本中有 {n} 处 [tag:npc:{self._entity_id}] 引用，而本场景是全项目最后一个"
            f" npc「{self._entity_id}」（该 id 因与他场景实体重名不做全局改写）。\n"
            "直接改名会让这些 tag 悬垂并卡住整工程保存。")
        follow_btn = box.addButton(
            f"跟随改写为 [tag:npc:{new_id}]", QMessageBox.ButtonRole.AcceptRole)
        box.addButton("取消", QMessageBox.ButtonRole.RejectRole)
        box.exec()
        return True if box.clickedButton() is follow_btn else None

    def _do_refactor(self) -> dict[str, Any] | None:
        new_id = self._new_id.text().strip()
        if not new_id:
            raise er.EntityRefactorError("新 id 不能为空")
        if not _ID_CHARSET_RE.match(new_id):
            raise er.EntityRefactorError(
                f"非法 id：{new_id!r}\n仅允许字母、数字、下划线、连字符"
                "（空格 / 中文 / []: 等字符会破坏 [tag:npc:…] 寻址与全局搜索）。")
        follow = self._tag_follow_choice(new_id)
        if follow is None:
            return None
        summary = er.rename_entity(
            self._model, self._scene_id, self._kind,
            self._entity_id, new_id, follow_tag_refs=bool(follow))
        er.push_journal(self._model, summary)
        return summary


class ConvertHotspotToNpcDialog(_RefactorDialogBase):
    """纯展示热点 → NPC：选动画包 + 定名字/交互半径，预览尺寸换算与丢弃项。

    id 不变，所以引用网零改写（理由见 ``entity_refactor.convert_hotspot_to_npc``）；
    这里只把两件事摆到人眼前：**会失效的热点专用动作**（必须勾强制才放行）与
    **形变/丢弃字段**（转换后由 summary 回报，调用方弹出）。
    """

    def __init__(self, model: Any, scene_id: str, kind: str, entity_id: str,
                 parent: QWidget | None = None) -> None:
        super().__init__(model, scene_id, kind, entity_id, parent)
        self.setWindowTitle("转为 NPC")
        hotspot = self._hotspot_def()
        display = (hotspot or {}).get("displayImage") or {}

        self._anim = IdRefSelector(allow_empty=False, editable=True)
        items = list(model.anim_asset_path_choices())
        self._anim.set_items(items)
        guess = self._guess_bundle(items, str(display.get("image") or ""))
        if guess:
            self._anim.set_current(guess)
        self._form.addRow("animFile（单帧占位包也行）", self._anim)

        self._name = QLineEdit(str((hotspot or {}).get("name") or entity_id))
        self._form.addRow("NPC 名字", self._name)

        self._range = QDoubleSpinBox()
        self._range.setRange(0.0, 9999.0)
        self._range.setDecimals(1)
        self._range.setValue(0.0)
        self._range.setMaximumWidth(110)
        self._range.setToolTip(
            "装饰 NPC 范式：交互半径 0 = 玩家够不着（原纯展示热点结构上就不提供交互，"
            "保持一致）。要让它能说话，转完再配图对话并把半径调回 50 左右。")
        self._form.addRow("interactionRange", self._range)

        self._render_raw = QCheckBox("renderRaw（贴图取自已烤光照的背景）")
        self._render_raw.setToolTip(
            "从场景原画里抠出来、要贴回原位的图必须勾：否则再叠一层逐 entity 光照，"
            "色调与背景不符、露出方框接缝。独立画的角色立绘不要勾。")
        self._form.addRow(self._render_raw)

        dead = er._hotspot_only_action_hits(model, entity_id)
        self._force = QCheckBox(
            f"强制转换（{len(dead)} 处热点专用动作将失效，需自行清理）")
        self._force.setVisible(bool(dead))
        if dead:
            self._force.setToolTip("、".join(
                f"{h['bucket']}:{h['itemId']}({h['action']})" for h in dead[:8]))
            ok_btn = self._buttons.button(QDialogButtonBox.StandardButton.Ok)
            ok_btn.setEnabled(False)
            self._force.toggled.connect(ok_btn.setEnabled)
        self._form.addRow(self._force)

    def _hotspot_def(self) -> dict[str, Any] | None:
        scene = (getattr(self._model, "scenes", None) or {}).get(self._scene_id)
        if not isinstance(scene, dict):
            return None
        for row in scene.get("hotspots") or []:
            if isinstance(row, dict) and str(row.get("id") or "") == self._entity_id:
                return row
        return None

    @staticmethod
    def _guess_bundle(items: list[tuple[str, str]], image_path: str) -> str:
        """展示图文件名与包目录名同名时预选——只是省一次点击，选错由人改。"""
        stem = image_path.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0].strip()
        if not stem:
            return ""
        for rid, _name in items:
            bundle = er._anim_bundle_id_from_animfile(rid)
            if bundle in (stem, f"{stem}_anim"):
                return rid
        return ""

    def _do_refactor(self) -> dict[str, Any]:
        summary, reverse_ops = er.convert_hotspot_to_npc(
            self._model, self._scene_id, self._entity_id,
            anim_file=self._anim.current_id().strip(),
            name=self._name.text().strip() or None,
            interaction_range=float(self._range.value()),
            render_raw=True if self._render_raw.isChecked() else None,
            force=self._force.isChecked(),
        )
        er.push_journal(self._model, {**summary, "reverseOps": reverse_ops})
        return summary


class SafeDeleteEntityDialog(_RefactorDialogBase):
    """安全删除：展示引用报告；有外部引用时必须勾选强制删除（引用悬垂交校验器）。"""

    def __init__(self, model: Any, scene_id: str, kind: str, entity_id: str,
                 parent: QWidget | None = None) -> None:
        super().__init__(model, scene_id, kind, entity_id, parent)
        self.setWindowTitle("安全删除")
        refs = self._report["totalRefs"] - self._report["selfRefs"]
        self._force = QCheckBox(f"强制删除（{refs} 处外部引用将悬垂，由数据校验报告）")
        self._force.setVisible(refs > 0)
        if refs > 0:
            ok_btn = self._buttons.button(QDialogButtonBox.StandardButton.Ok)
            ok_btn.setEnabled(False)
            self._force.toggled.connect(ok_btn.setEnabled)
        self._form.addRow(self._force)

    def _do_refactor(self) -> dict[str, Any]:
        summary, reverse_ops = er.delete_entity(
            self._model, self._scene_id, self._kind, self._entity_id,
            force=self._force.isChecked())
        er.push_journal(self._model, {**summary, "reverseOps": reverse_ops})
        return summary
