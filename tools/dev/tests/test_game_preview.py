# -*- coding: utf-8 -*-
"""游戏预览窗：命令行必须带齐"免手势音频 / 不后台降级 / 禁缓存"三组开关，找不到 Chromium 时退回默认浏览器并明说。"""
from __future__ import annotations

from pathlib import Path

import pytest

from tools.dev import game_preview as gp


def test_build_command_has_the_three_groups_of_flags_and_app_mode(tmp_path: Path) -> None:
    cmd = gp.build_command(Path("C:/x/chrome.exe"), "http://127.0.0.1:5173/?mode=dev&devScene=a", tmp_path)
    assert cmd[0] == "C:/x/chrome.exe" or cmd[0].endswith("chrome.exe")
    # 音频不等手势
    assert "--autoplay-policy=no-user-gesture-required" in cmd
    # 没焦点 / 被盖住不降级
    for f in ("--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"):
        assert f in cmd
    assert any(f.startswith("--disable-features=") and "IntensiveWakeUpThrottling" in f and "CalculateNativeWinOcclusion" in f for f in cmd)
    # 桌面窗口一律禁缓存
    for f in ("--disable-http-cache", "--disk-cache-size=1", "--media-cache-size=1", "--v8-cache-options=none", "--disable-gpu-shader-disk-cache"):
        assert f in cmd
    # 专用 profile + app 模式，url 原样（含 query）
    assert f"--user-data-dir={tmp_path}" in cmd
    assert cmd[-1] == "--app=http://127.0.0.1:5173/?mode=dev&devScene=a"


def test_open_uses_dedicated_instance_when_chromium_found(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    exe = tmp_path / "msedge.exe"
    exe.write_bytes(b"")
    spawned: list[list[str]] = []

    class _P:  # noqa: D401 — Popen 替身
        def __init__(self, cmd, **kw):
            spawned.append(list(cmd))

    monkeypatch.setattr(gp, "find_chromium", lambda: exe)
    monkeypatch.setattr(gp, "profile_dir", lambda: tmp_path / "prof")
    monkeypatch.setattr(gp.subprocess, "Popen", _P)
    monkeypatch.setattr(gp.webbrowser, "open", lambda url: pytest.fail("不该退回系统浏览器"))
    note = gp.open_game_preview("http://127.0.0.1:5173/?mode=dev")
    assert spawned and spawned[0][0] == str(exe) and spawned[0][-1] == "--app=http://127.0.0.1:5173/?mode=dev"
    assert "msedge.exe" in note and "免手势" in note
    assert (tmp_path / "prof").is_dir()


def test_open_falls_back_to_default_browser_and_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(gp, "find_chromium", lambda: None)
    monkeypatch.setattr(gp.webbrowser, "open", lambda url: opened.append(url) or True)
    note = gp.open_game_preview("http://127.0.0.1:5173/?mode=dev")
    assert opened == ["http://127.0.0.1:5173/?mode=dev"]
    assert "系统默认浏览器" in note and "点一下" in note


def test_env_override_default_disables_dedicated_window(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(gp.ENV_BROWSER, "default")
    assert gp.find_chromium() is None


def test_env_override_path_must_exist(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv(gp.ENV_BROWSER, str(tmp_path / "nope.exe"))
    assert gp.find_chromium() is None
    exe = tmp_path / "chrome.exe"
    exe.write_bytes(b"")
    monkeypatch.setenv(gp.ENV_BROWSER, str(exe))
    assert gp.find_chromium() == exe
