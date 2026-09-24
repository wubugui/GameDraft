# -*- coding: utf-8 -*-
"""「用在哪」/「按剧情走一遍」:从对话图抽出用到这张呼吸图的那一段——起点是 showBreathingOverlay,顺着 next 走,
台词与呼吸图相关动作原样按顺序,别的动作只列类型,同一个句柄被收掉就停;别的句柄的呼吸图动作不算;分支不往下猜。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.breathing_workbench import fixtures, store, story  # noqa: E402


@pytest.fixture()
def proj(tmp_path, monkeypatch):
    fixtures.build_project(tmp_path)
    monkeypatch.setattr(store, "PROJECT", tmp_path)
    monkeypatch.setattr(store, "DATA", tmp_path)
    return tmp_path


def test_timeline_from_fixture_graph(proj):
    out = story.stories_for(fixtures.ASSET_ID)
    assert len(out) == 1
    s = out[0]
    assert s["graph"] == "sample_graph" and s["handle"] == "paper" and s["lines"] == 3
    kinds = [(x["kind"], x.get("act") or x.get("ms")) for x in s["steps"]]
    assert kinds == [("show", None), ("line", None), ("perform", "fadeOut"), ("line", None),
                     ("perform", "gasp"), ("wait", 200.0), ("line", None), ("wait", 400.0), ("hide", None)]
    assert s["steps"][2]["wait"] is True and s["steps"][4]["wait"] is False
    assert s["steps"][0]["widthPercent"] == 82.0


def test_other_handle_ignored_and_branch_stops(proj):
    gp = proj / story.GRAPHS_REL / "sample_graph.json"
    g = json.loads(gp.read_text(encoding="utf-8"))
    g["nodes"]["c"]["actions"].append({"type": "breathingPerform", "params": {"id": "别的句柄", "act": "gasp"}})
    g["nodes"]["d"] = {"type": "choice", "options": []}
    gp.write_text(json.dumps(g, ensure_ascii=False), encoding="utf-8")
    s = story.stories_for(fixtures.ASSET_ID)[0]
    assert [x["kind"] for x in s["steps"]] == ["show", "line", "perform", "other", "other"]
    assert s["steps"][3]["type"] == "breathingPerform" and "choice" in s["steps"][4]["type"]


def test_unused_asset_has_no_stories(proj):
    assert story.stories_for("nobody_uses_this") == []
