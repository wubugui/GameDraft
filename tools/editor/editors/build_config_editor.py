"""构建配置页：档位差异（从哪里开始、带不带调试设施）+ 构建入口。

## 为什么不写进 game_config.json

`tools/build/build_config.json` 管的是**"这一次打出来的包有什么不同"**，
而 `game_config.json`（隔壁 Config 页）管的是**"这个游戏是什么"**
——initialScene / dayNight / playerActs 那些，每个档位完全一样，属于游戏数据。

把构建概念混进游戏数据里，会让"改一个构建选项"变成"动了一次游戏数据"，
连带 DVC、校验、审阅全都被拖进来。所以本页**不走 Save All 的脏桶**，
自己带保存按钮、直接写 `tools/build/build_config.json`。

## 输出目录为什么不在这里

它不是"这个项目怎么构建"，而是"这一次把结果放哪"——每次调用时传参：
手动构建由「打包」菜单问一次（记在编辑器本机偏好里），
自动构建由构建工作台按时间戳算。见 `tools/build/README.md`。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QFormLayout, QGroupBox, QHBoxLayout, QLabel, QLineEdit,
    QMessageBox, QPushButton, QVBoxLayout, QWidget,
)

from tools.atomic_io import retry_transient
from tools.build_workbench.autostart import launch_argv
from tools.editor.project_model import ProjectModel

#: 相对仓库根
BUILD_CONFIG_REL = "tools/build/build_config.json"

_DEV_MODES = (
    ("从指定场景开始（dev 直达）", "scene"),
    ("从叙事锚点开始", "warp"),
    ("正常开局（和发行档一样走开场）", "normal"),
)


class BuildConfigEditor(QWidget):
    """编辑 `tools/build/build_config.json` 的 `targets.*.bootQuery`。

    界面上是"从哪里开始"这种人话，底下存的是一串 query
    （运行时逻辑见 `src/core/bootParams.ts`）。
    """

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._raw: dict = {}

        # ---------------- 发行档 ----------------
        self._release_title = QCheckBox("开局停在标题界面")
        self._release_title.setToolTip(
            "不勾的话每次启动直接开一局新游戏——玩家走不到标题上那个「继续」，\n"
            "存档存在却没有入口去读，看起来就像存档没了。这是发行阻断项。"
        )
        rel = QFormLayout()
        rel.addRow(self._release_title)
        rel_hint = QLabel("发行档还会：剥掉 dev 直达后门、按抽取清单裁素材、音频转 ogg。")
        rel_hint.setWordWrap(True)
        rel_hint.setStyleSheet("color:#8a857c;")
        rel.addRow(rel_hint)
        rel_box = QGroupBox("发行档（给玩家）")
        rel_box.setLayout(rel)

        # ---------------- dev 档 ----------------
        self._dev_mode = QComboBox()
        for label, data in _DEV_MODES:
            self._dev_mode.addItem(label, data)
        self._dev_mode.currentIndexChanged.connect(self._sync_dev_widgets)

        self._dev_scene = QComboBox()
        self._dev_scene.setEditable(True)
        self._dev_warp = QLineEdit()
        self._dev_warp.setPlaceholderText("dev_narrative_warps.json 里的锚点名")

        dev = QFormLayout()
        dev.addRow("起始位置", self._dev_mode)
        self._scene_row = QLabel("场景")
        dev.addRow(self._scene_row, self._dev_scene)
        self._warp_row = QLabel("锚点")
        dev.addRow(self._warp_row, self._dev_warp)
        dev_hint = QLabel(
            "dev 档保留 F2 调试面板、命令通道与光影切档载荷，不压缩。自己跑与测试用。"
        )
        dev_hint.setWordWrap(True)
        dev_hint.setStyleSheet("color:#8a857c;")
        dev.addRow(dev_hint)
        dev_box = QGroupBox("dev 档（自己用）")
        dev_box.setLayout(dev)

        # ---------------- 底部 ----------------
        self._summary = QLabel()
        self._summary.setWordWrap(True)
        self._summary.setStyleSheet("color:#7fa7c7;")

        save_btn = QPushButton("保存")
        save_btn.clicked.connect(self._save)
        wb_btn = QPushButton("打开构建工作台…")
        wb_btn.setToolTip("定期自动构建、归档整理都在那里")
        wb_btn.clicked.connect(self._open_workbench)

        bottom = QHBoxLayout()
        bottom.addWidget(self._summary, 1)
        bottom.addWidget(wb_btn)
        bottom.addWidget(save_btn)

        note = QLabel(
            "这一页存的是**构建**配置（tools/build/build_config.json），不是游戏数据，"
            "不进 Save All。输出目录不在这里——那是每次构建时传的参数。"
        )
        note.setWordWrap(True)
        note.setStyleSheet("color:#8a857c;")

        lay = QVBoxLayout(self)
        lay.addWidget(rel_box)
        lay.addWidget(dev_box)
        lay.addWidget(note)
        lay.addStretch(1)
        lay.addLayout(bottom)

        self.refresh()

    # ------------------------------------------------------------ 路径

    def _repo_root(self) -> Path | None:
        return Path(self._model.project_path) if self._model.project_path else None

    def _config_path(self) -> Path | None:
        root = self._repo_root()
        return (root / BUILD_CONFIG_REL) if root else None

    # ------------------------------------------------------------ 读

    def refresh(self) -> None:
        path = self._config_path()
        self._raw = {}
        if path and path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self._raw = loaded
            except (OSError, json.JSONDecodeError):
                pass

        self._dev_scene.clear()
        self._dev_scene.addItems(sorted(self._model.scenes.keys()) if self._model.scenes else [])

        targets = self._raw.get("targets") if isinstance(self._raw.get("targets"), dict) else {}
        rel_q = _parse_query(_boot_query(targets, "release"))
        dev_q = _parse_query(_boot_query(targets, "dev"))

        self._release_title.setChecked("screen_title" in rel_q)

        if "narrativeWarp" in dev_q or "narrative_warp" in dev_q:
            mode = "warp"
        elif "devScene" in dev_q or "dev_scene" in dev_q:
            mode = "scene"
        else:
            mode = "normal"
        idx = self._dev_mode.findData(mode)
        self._dev_mode.setCurrentIndex(idx if idx >= 0 else 0)
        self._dev_scene.setCurrentText(dev_q.get("devScene") or dev_q.get("dev_scene") or "")
        self._dev_warp.setText(dev_q.get("narrativeWarp") or dev_q.get("narrative_warp") or "")

        self._sync_dev_widgets()

    # ------------------------------------------------------------ 写

    def _compose(self) -> tuple[str, str]:
        release_q = "screen_title=1" if self._release_title.isChecked() else ""

        mode = self._dev_mode.currentData()
        if mode == "scene":
            scene = self._dev_scene.currentText().strip()
            # devScene 单独给不够：真正让游戏走 dev 分支的是 mode=dev，两个都要带
            dev_q = f"mode=dev&devScene={scene}" if scene else "mode=dev"
        elif mode == "warp":
            warp = self._dev_warp.text().strip()
            dev_q = f"mode=dev&narrativeWarp={warp}" if warp else "mode=dev"
        else:
            dev_q = ""
        return dev_q, release_q

    def _save(self) -> None:
        path = self._config_path()
        if path is None:
            QMessageBox.warning(self, "没打开工程", "先打开一个 GameDraft 工程。")
            return
        if not path.is_file():
            QMessageBox.warning(self, "找不到构建配置", f"{path}\n先确认仓库完整。")
            return
        dev_q, release_q = self._compose()

        raw = dict(self._raw)
        targets = dict(raw.get("targets") or {})
        for name, q in (("dev", dev_q), ("release", release_q)):
            entry = dict(targets.get(name) or {})
            entry["bootQuery"] = q
            targets[name] = entry
        raw["targets"] = targets

        payload = json.dumps(raw, ensure_ascii=False, indent=2) + "\n"
        tmp = path.with_suffix(".json.tmp")
        try:
            # newline="\n"：Windows 上 write_text 默认把 \n 翻成 \r\n
            tmp.write_text(payload, encoding="utf-8", newline="\n")
            import os
            retry_transient(os.replace, tmp, path)
        except OSError as e:
            QMessageBox.critical(self, "保存失败", f"{path}\n{e}")
            return
        self._raw = raw
        self._refresh_summary()

    # ------------------------------------------------------------ 杂项

    def _sync_dev_widgets(self) -> None:
        mode = self._dev_mode.currentData()
        self._dev_scene.setVisible(mode == "scene")
        self._scene_row.setVisible(mode == "scene")
        self._dev_warp.setVisible(mode == "warp")
        self._warp_row.setVisible(mode == "warp")
        self._refresh_summary()

    def _refresh_summary(self) -> None:
        dev_q, release_q = self._compose()
        self._summary.setText(
            f"发行档启动参数：{release_q or '（无，直接开新局）'}　·　"
            f"dev 档：{dev_q or '（无，走正常开局）'}"
        )

    def _open_workbench(self) -> None:
        """打开构建工作台。

        **不判断"是不是已经开着"**——工作台自带单实例守卫，再启动一次只会把
        已经在跑的那个唤到前台然后自己退出。判断放在这里等于把同一件事做两遍，
        而且另外几个启动入口（开机自启、npm、双击）照样绕得过去。
        """
        root = self._repo_root()
        if root is None:
            QMessageBox.warning(self, "没打开工程", "先打开一个 GameDraft 工程。")
            return
        try:
            subprocess.Popen(launch_argv(root), cwd=str(root))
        except OSError as e:
            QMessageBox.critical(self, "起不来", str(e))

    # ------------------------------------------------------------ 宿主钩子

    def flush_to_model(self) -> bool:
        """Save All 钩子。

        本页**不写游戏数据**，也不进脏桶——存的是构建配置。这里返回 True 让
        Save All 直接放行；改动靠页面自己的「保存」按钮落盘。
        """
        return True


def _boot_query(targets: dict, name: str) -> str:
    entry = targets.get(name)
    if not isinstance(entry, dict):
        return ""
    raw = entry.get("bootQuery")
    return raw.strip() if isinstance(raw, str) else ""


def _parse_query(query: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in query.lstrip("?").split("&"):
        if not part:
            continue
        k, _, v = part.partition("=")
        if k:
            out[k] = v
    return out
