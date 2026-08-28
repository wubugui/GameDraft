"""跑构建与归档的两个执行器。

## 为什么构建用 QProcess、归档用 QThread

- **构建**（`scripts/release.mjs`，两分多钟）要**流式回显**：抽取到哪一步、编译多久、
  验收哪条不过——等它跑完再一次性吐出来，等待期就是一片黑。QProcess 的
  `readyReadStandardOutput` 天然是增量的，还能中途 kill。
- **归档**（7z，几十秒）没有中间输出可看（`-bso0 -bsp0` 关掉了进度刷屏），
  纯 CPU 活儿，放 QThread 里跑完回报即可。

两者都**不在 UI 线程里同步等**——那会把整个工作台冻住。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import QObject, QProcess, QProcessEnvironment, QThread, Signal

from tools.editor.shared.npm_process import node_script_command, node_process_environment

from .archive import ArchiveResult, archive_build, restore_archive
from .builds import BuildEntry


@dataclass(frozen=True)
class BuildRequest:
    project_root: Path
    out_dir: Path
    target: str
    skip_verify: bool


class BuildRunner(QObject):
    """跑一次 `scripts/release.mjs`。同一时刻只允许一个。"""

    line = Signal(str)
    finished_ok = Signal(object)      # BuildRequest
    finished_fail = Signal(object, str)  # BuildRequest, 尾部日志

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._proc: QProcess | None = None
        self._req: BuildRequest | None = None
        self._log: list[str] = []

    def is_running(self) -> bool:
        return self._proc is not None

    def start(self, req: BuildRequest) -> bool:
        if self.is_running():
            return False
        self._req = req
        self._log = []

        # 直接调 node，不经 npm/cmd：输出目录可能带空格，cmd 那层的引号规则会把它拆错，
        # 而拆错的表现是"跑起来了但去了别的目录"。见 npm_process.node_script_command。
        args = ["--target", req.target, "--out-dir", str(req.out_dir)]
        if req.skip_verify:
            args.append("--skip-verify")
        program, argv = node_script_command("scripts/release.mjs", *args)

        proc = QProcess(self)
        proc.setWorkingDirectory(str(req.project_root))
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        env: QProcessEnvironment = node_process_environment()
        proc.setProcessEnvironment(env)
        proc.readyReadStandardOutput.connect(self._drain)
        proc.finished.connect(self._on_finished)
        proc.errorOccurred.connect(self._on_error)

        self.line.emit(f"$ {program} {' '.join(argv)}")
        proc.start(program, argv)
        if not proc.waitForStarted(5000):
            self.line.emit("起不来：没找到 node（确认 Node.js 装了且在 PATH 里）")
            proc.deleteLater()
            self._proc = None
            return False
        self._proc = proc
        return True

    def cancel(self) -> None:
        if self._proc is not None:
            self.line.emit("已请求中止构建…")
            self._proc.kill()

    # ------------------------------------------------------------ 内部

    def _drain(self) -> None:
        if self._proc is None:
            return
        text = bytes(self._proc.readAllStandardOutput()).decode("utf-8", "replace")
        for raw in text.splitlines():
            if raw.strip():
                self._log.append(raw)
                self.line.emit(raw)

    def _on_error(self, _err: QProcess.ProcessError) -> None:
        if self._proc is not None and self._proc.error() == QProcess.ProcessError.FailedToStart:
            self.line.emit("起不来：没找到 node")

    def _on_finished(self, code: int, _status: QProcess.ExitStatus) -> None:
        self._drain()
        req = self._req
        proc = self._proc
        self._proc = None
        self._req = None
        if proc is not None:
            proc.deleteLater()
        if req is None:
            return
        if code == 0:
            self.finished_ok.emit(req)
        else:
            # 失败原因（缺 ffmpeg、验收不过、输出目录被拒）都在尾部，
            # 这些报错通常带着一段可照做的处置说明
            self.finished_fail.emit(req, "\n".join(self._log[-40:]))


class ArchiveWorker(QThread):
    """把若干次构建压成 7z（顺序做，不并发——7z 本来就吃满 CPU）。"""

    progress = Signal(str)
    done = Signal(list)  # list[ArchiveResult]

    def __init__(
        self,
        builds: list[BuildEntry],
        archive_root: Path,
        seven_zip: str,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._builds = builds
        self._root = archive_root
        self._7z = seven_zip

    def run(self) -> None:  # noqa: D102
        results: list[ArchiveResult] = []
        for b in self._builds:
            try:
                results.append(archive_build(
                    b, self._root, seven_zip=self._7z, progress=self.progress.emit,
                ))
            except Exception as exc:  # noqa: BLE001 —— 一个失败不该带走整批
                self.progress.emit(f"✖ {b.name} 归档时抛错：{exc}")
                results.append(ArchiveResult(False, None, 0, 0, f"{b.name}: {exc}"))
        self.done.emit(results)


class RestoreWorker(QThread):
    """把一份归档解回可跑的目录。"""

    progress = Signal(str)
    done = Signal(bool, str)

    def __init__(
        self, archive_path: Path, dest_root: Path, seven_zip: str,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._archive = archive_path
        self._dest = dest_root
        self._7z = seven_zip

    def run(self) -> None:  # noqa: D102
        try:
            ok, msg = restore_archive(
                self._archive, self._dest, seven_zip=self._7z, progress=self.progress.emit,
            )
        except Exception as exc:  # noqa: BLE001
            ok, msg = False, str(exc)
        self.done.emit(ok, msg)
