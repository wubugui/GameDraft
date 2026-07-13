"""实体重构（迁移场景 / 重命名 / 安全删除）的预览确认对话框。

只做 UI：引用报告展示 + 参数收集 + 确认时调 ``entity_refactor`` 引擎；引擎前置校验
失败（EntityRefactorError）弹警告且**不关窗**，成功后由调用方刷新画布。零磁盘写入
（落盘仍走 Save All）。
"""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
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
        [(b["graphId"], "graph.ownerId") for b in report["ownerBindings"]],
    )
    group(
        "玩家可见文本 [tag:npc:…]",
        [(f"{h['bucket']}:{h['itemId']}", str(h["count"])) for h in report["tagRefs"]],
        "全局解析；删除全项目最后一个同 id 实例会卡整工程保存。",
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

    # 子类返回 summary（成功）或抛 EntityRefactorError
    def _do_refactor(self) -> dict[str, Any]:
        raise NotImplementedError

    def _on_accept(self) -> None:
        from PySide6.QtWidgets import QMessageBox
        try:
            summary = self._do_refactor()
        except er.EntityRefactorError as exc:
            QMessageBox.warning(self, self.windowTitle(), str(exc))
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
            "多场景重名的 id 只改写可证明指向本实体的引用，其余留给人工。")
        self._form.addRow("新 id", self._new_id)
        defined = self._report["definedInScenes"]
        if len(defined) > 1:
            warn = QLabel(f"⚠ 该 id 也出现在：{'、'.join(s for s in defined if s != scene_id)}"
                          "——全局面引用将不自动改写")
            warn.setWordWrap(True)
            self._form.addRow(warn)

    def _do_refactor(self) -> dict[str, Any]:
        summary = er.rename_entity(
            self._model, self._scene_id, self._kind,
            self._entity_id, self._new_id.text().strip())
        er.push_journal(self._model, summary)
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
