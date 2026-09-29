"""残留清理只识别 GameDraft 自己的桌面进程。"""

from scripts.kill_gamedraft_residue import classify


def _process(name: str, *cmd: str) -> dict:
    return {"name": name, "cmd": [name, *cmd], "exe": "F:/build/GameDraft/GameDraft.exe", "cwd": "F:/build/GameDraft"}


def test_electron_process_tree_and_legacy_webview_are_recognized() -> None:
    assert classify(_process("gamedraft.exe")) == "游戏(打包版)"
    assert classify(_process("gamedraft.exe", "--type=renderer")) == "游戏(打包版 Electron 子进程)"
    assert classify(_process("gamedraft.exe", "--type=utility")) == "游戏(打包版 Electron 子进程)"
    assert classify(_process("msedgewebview2.exe", "--webview-exe-name=GameDraft.exe")) == "游戏(打包版)WebView2"
    assert classify(_process("electron.exe", "--type=renderer")) is None
