"""章节导演清单编辑器（narrative_packages.json）。

导演只管章节包 live/dormant（谁在听信号），**不触发演出**——一行=一个章节包的装卸规则：
`when∧¬done` 成立 → 置包 live（开拍=剧组在场）；`done` 成立 → 置包 dormant（收工冻结，状态永存可查）。
「进场演哪场戏」由策划在场景 onEnter → 图对话路由里 switch 自己拍板（2026-07-18 制作人定案），不在此配。
状态永久可查，done 直接查叙事记录。策划只在此可视化编辑，不碰 JSON。
"""
from __future__ import annotations

from copy import deepcopy

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared.collapsible_section import CollapsibleSection
from ..shared.condition_editor import ConditionEditor
from ..shared.form_layout import compact_form
from ..shared.id_ref_selector import IdRefSelector

try:  # 表单布局用 QFormLayout；compact_form 需要一个已建的 layout
    from PySide6.QtWidgets import QFormLayout
except Exception:  # pragma: no cover
    QFormLayout = None  # type: ignore


class NarrativePackagesEditor(QWidget):
    """主从列表 + 详情：编辑章节导演清单（narrative_packages.json 的 packages 数组）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading = False
        self._dirty = False   # 表单相对已提交行是否有改动（防伪脏：flush 只在真改动时提交）
        self._rows: list[dict] = []
        self._current: int = -1

        root = QVBoxLayout(self)
        tip = QLabel(
            "章节导演清单：一行=一个章节包的装卸规则。导演只管包 live/dormant（谁在听信号），不触发演出——"
            "进场演哪场戏在「场景 onEnter → 图对话路由」里由你 switch 拍板。"
        )
        tip.setWordWrap(True)
        tip.setToolTip(
            "导演只管章节包 live/dormant，不开戏。一行=一个章节包何时 live、何时 dormant。\n"
            "· 章节包（必填）：本行装卸哪个叙事包（编排上打了 package 标的）\n"
            "· 场景：进这个场景时载包（场景驱动，如支线/开局章节）；留空=里程碑驱动，任何叙事状态变化时按条件评估\n"
            "· 开拍条件(when)：满足才 live；留空=只要没收工就 live\n"
            "· 收工判据(done)：满足即 dormant（状态永存冻结），越过窗口自动卸\n"
            "进场自动演出：写在场景的 onEnter → startDialogueGraph 入口路由图，路由图里用 switch 选分支。\n"
            "改完点「应用」→ Ctrl+S 保存工程。"
        )
        root.addWidget(tip)

        split = QSplitter(Qt.Orientation.Horizontal)

        # ---- 左：戏列表 ----
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.addWidget(QLabel("戏（清单行）"))
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_row_changed)
        ll.addWidget(self._list)
        lb = QHBoxLayout()
        b_add = QPushButton("添加")
        b_add.setToolTip("新建一场戏；填好 id 与场景/动作后 Ctrl+S 保存")
        b_add.clicked.connect(self._add)
        b_del = QPushButton("删除")
        b_del.setToolTip("删除当前选中的戏")
        b_del.clicked.connect(self._del)
        lb.addWidget(b_add)
        lb.addWidget(b_del)
        ll.addLayout(lb)
        split.addWidget(left)

        # ---- 右：详情 ----
        right_scroll = QScrollArea()
        right_scroll.setWidgetResizable(True)
        rh = QWidget()
        rl = QVBoxLayout(rh)

        head = QWidget()
        f = compact_form(QFormLayout(head))
        self._f_id = QLineEdit()
        self._f_id.setToolTip("这场戏的标识（自己起名，工程内唯一）")
        self._f_id.editingFinished.connect(self._on_edit)
        f.addRow("id", self._f_id)

        self._f_scene = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
        self._f_scene.setToolTip("进这个场景时评估本行。cue 行（无章节包）必填；纯章节包行可留空（任何状态变化时评估）")
        self._f_scene.value_changed.connect(self._on_edit)
        f.addRow("场景", self._f_scene)

        self._f_package = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
        self._f_package.setToolTip("本行装卸哪个叙事章节包（编排上打了 package 标的）。必填——导演只管包。")
        self._f_package.value_changed.connect(self._on_edit)
        f.addRow("章节包", self._f_package)
        rl.addWidget(head)

        # 两个复杂块进折叠区、默认折叠（编辑器铁律：复杂块折叠且默认折叠，别铺满一屏）
        self._f_when = ConditionEditor("")
        self._f_when.changed.connect(self._on_edit)
        sec_when = CollapsibleSection("开拍条件 when（留空=恒真）", start_open=False)
        sec_when.set_header_tool_tip("满足才 live；留空=只要没收工就 live")
        sec_when.add_body(self._f_when)
        rl.addWidget(sec_when)

        self._f_done = ConditionEditor("")
        self._f_done.changed.connect(self._on_edit)
        sec_done = CollapsibleSection("收工判据 done（满足即 dormant 冻结）", start_open=False)
        sec_done.set_header_tool_tip("满足即 dormant（状态永存冻结），越过窗口自动卸；留空=永不自动收工")
        sec_done.add_body(self._f_done)
        rl.addWidget(sec_done)

        apply_btn = QPushButton("应用")
        apply_btn.setToolTip("把当前表单写回内存（Ctrl+S 才写盘）")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)
        rl.addStretch(1)

        right_scroll.setWidget(rh)
        split.addWidget(right_scroll)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([220, 640])
        root.addWidget(split, 1)   # 伸展因子=1：split 占满 tip 以下全部竖向空间，消除顶部空白

        self.reload_from_model()

    # ---- 载入 / 刷新 ----

    def reload_from_model(self) -> None:
        data = self._model.narrative_packages if isinstance(self._model.narrative_packages, dict) else {}
        rows = data.get("packages")
        self._rows = [deepcopy(r) for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
        self._refresh_list(select=0 if self._rows else -1)

    def _refresh_list(self, select: int = -1) -> None:
        self._loading = True
        self._list.clear()
        for r in self._rows:
            rid = str(r.get("id") or "(未命名)")
            scene = str(r.get("scene") or "")
            pkg = str(r.get("package") or "")
            suffix = f"  · {scene}" if scene else ""
            if pkg:
                suffix += f"  [{pkg}]"
            self._list.addItem(rid + suffix)
        self._loading = False
        if 0 <= select < len(self._rows):
            self._list.setCurrentRow(select)
        else:
            self._current = -1
            self._clear_form()

    def _update_selectors(self) -> None:
        self._f_scene.set_items([(s, s) for s in self._model.all_scene_ids()])
        self._f_package.set_items([(p, p) for p in self._model.narrative_package_ids_ordered()])
        self._f_when.set_flag_pattern_context(self._model, None)
        self._f_done.set_flag_pattern_context(self._model, None)

    def _clear_form(self) -> None:
        self._loading = True
        self._f_id.clear()
        self._update_selectors()
        self._f_scene.set_current("")
        self._f_package.set_current("")
        self._f_when.set_data([])
        self._f_done.set_data([])
        self._loading = False

    def _on_row_changed(self, row: int) -> None:
        if self._loading:
            return
        # 切行前提交上一行（commit-on-leave）
        if 0 <= self._current < len(self._rows) and self._current != row:
            self._apply(silent=True)
        self._current = row
        if not (0 <= row < len(self._rows)):
            self._clear_form()
            return
        r = self._rows[row]
        self._loading = True
        self._update_selectors()
        self._f_id.setText(str(r.get("id") or ""))
        self._f_scene.set_current(str(r.get("scene") or ""))
        self._f_package.set_current(str(r.get("package") or ""))
        self._f_when.set_data([c for c in (r.get("when") or []) if isinstance(c, dict)])
        self._f_done.set_data([c for c in (r.get("done") or []) if isinstance(c, dict)])
        self._loading = False
        self._dirty = False   # 刚载入=与模型一致

    # ---- 编辑 / 应用 ----

    def _on_edit(self, *_args) -> None:
        if self._loading:
            return
        self._dirty = True

    def _build_row_from_form(self, silent: bool = False) -> dict | None:
        rid = self._f_id.text().strip()
        if not rid:
            if not silent:
                QMessageBox.warning(self, "章节清单", "戏的 id 不能为空。")
            return None
        row: dict = {"id": rid}
        scene = self._f_scene.current_id() or ""
        pkg = self._f_package.current_id() or ""
        if not pkg:
            if not silent:
                QMessageBox.warning(
                    self, "章节清单",
                    "必须选「章节包」：导演只管章节包 live/dormant。\n"
                    "进场自动演出请写在场景的 onEnter → startDialogueGraph 入口路由图（图对话里 switch）。")
            return None
        if scene:
            row["scene"] = scene
        row["package"] = pkg
        when = self._f_when.to_list()
        if when:
            row["when"] = when
        done = self._f_done.to_list()
        if done:
            row["done"] = done
        return row

    def _apply(self, silent: bool = False) -> bool:
        if not (0 <= self._current < len(self._rows)):
            return True
        row = self._build_row_from_form(silent=silent)
        if row is None:
            # 静默路径（切行/Save All）：表单不完整就保留该行既有模型值、不打断、不丢数据。
            return silent
        # id 唯一性
        for i, other in enumerate(self._rows):
            if i != self._current and str(other.get("id") or "") == row["id"]:
                if not silent:
                    QMessageBox.warning(self, "章节清单", f"id 与其它行重复：{row['id']}")
                return False
        self._rows[self._current] = row
        self._commit_to_model()
        self._dirty = False
        if not silent:
            self._refresh_list(select=self._current)
        return True

    def _commit_to_model(self) -> None:
        new_data = {"packages": [deepcopy(r) for r in self._rows]}
        if new_data != (self._model.narrative_packages or {"packages": []}):
            self._model.narrative_packages = new_data
            self._model.mark_dirty("narrative_packages")

    # ---- 增删 ----

    def _add(self) -> None:
        if 0 <= self._current < len(self._rows):
            self._apply(silent=True)
        base = "新戏"
        existing = {str(r.get("id") or "") for r in self._rows}
        n = 0
        rid = base
        while rid in existing:
            n += 1
            rid = f"{base}_{n}"
        self._rows.append({"id": rid})
        self._commit_to_model()
        self._refresh_list(select=len(self._rows) - 1)

    def _del(self) -> None:
        if not (0 <= self._current < len(self._rows)):
            return
        rid = str(self._rows[self._current].get("id") or "")
        if QMessageBox.question(self, "删除", f"删除戏「{rid}」？") != QMessageBox.StandardButton.Yes:
            return
        del self._rows[self._current]
        self._current = -1
        self._commit_to_model()
        self._refresh_list(select=min(self._current if self._current >= 0 else 0, len(self._rows) - 1))

    # ---- 关闭路径钩子（与其它编辑器一致，鸭子协议）----

    def flush_to_model(self) -> bool:
        """Save All 前提交当前未应用编辑；无改动则零副作用（防伪脏）。"""
        if not self._dirty:
            return True
        if 0 <= self._current < len(self._rows):
            return self._apply(silent=True)
        return True

    def confirm_close(self, parent=None) -> bool:
        """关闭前：有未应用改动则询问。Discard 必须把表单回滚到模型值（否则随后统一 flush 复活弃改）。"""
        if not self._dirty:
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前戏有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            return self._apply(silent=True)
        # Discard：回填模型当前值 → _dirty 清零，随后统一 flush 判为无改动、不复活
        self._on_row_changed(self._current)
        self._dirty = False
        return True
