# -*- coding: utf-8 -*-
"""运行时模块包:打得出来(子进程里打,pytest 装着仓库写守卫)、缓存戳覆盖整棵依赖树、生成物不进版本;
页面没有第二份模拟 / 合成 / 着色组装——只许调包里的运行时代码与 breathingShade.glsl。"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.breathing_workbench import bundle  # noqa: E402

VIEWER = _ROOT / "tools" / "breathing_workbench" / "viewer"


def test_sources_cover_the_whole_import_tree():
    srcs = {p.relative_to(_ROOT).as_posix() for p in bundle.sources()}
    for m in ("src/systems/breathing/BreathingPerformance.ts", "src/systems/breathing/breathingParams.ts",
              "src/data/breathingParams.json", "src/data/breathingOverlays.ts", "src/rendering/breathingUniforms.ts",
              "src/audio/breathSynth.ts"):
        assert m in srcs, m
    # 不许把 Pixi / 游戏状态拖进页面包
    assert not any(s.endswith(("breathingOverlayMesh.ts", "BreathingOverlaySystem.ts", "Game.ts", "AudioManager.ts")) for s in srcs)


def test_gen_is_gitignored():
    gi = (_ROOT / "tools" / "breathing_workbench" / ".gitignore").read_text(encoding="utf-8")
    assert "viewer/_gen/" in gi


def test_viewer_does_not_reimplement_runtime():
    js = "\n".join(p.read_text(encoding="utf-8") for p in VIEWER.glob("*.js"))
    for banned in ("class BreathingPerformance", "function softCap", "kickFor", "createBiquadFilter", "gaspShape",
                   "function breathingUniforms", "mergeBreathingParams = ", "vec3 breathingShade", "uniform sampler2D uBase"):
        assert banned not in js, banned
    for required in ("rt.BreathingPerformance.BreathingPerformance", "rt.breathingUniforms.breathingUniforms",
                     "rt.breathingUniforms.sliceBreathingShade", "rt.breathSynth.createBreathSynth", "rt.breathingOverlays.resolveBreathingOverlay"):
        assert required in js, required


@pytest.mark.skipif(bundle.node_exe() is None, reason="没有 node")
def test_bundle_builds_in_subprocess():
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    r = subprocess.run([sys.executable, "-m", "tools.breathing_workbench", "--bundle"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240, env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    text = bundle.OUT.read_text(encoding="utf-8")
    assert "var BreathingPerformance = class" in text and "createBreathSynth" in text and "sliceBreathingShade" in text
