# -*- coding: utf-8 -*-
"""「用在哪」与「按剧情走一遍」:从对话图里把用到这张呼吸图的那一段抽成一条线性时间轴(只读)。

工作台不另写一份剧情(那会和真剧情漂开):哪张对话图里有 ``showBreathingOverlay``(``breathing`` = 这张图),
就从那一步起顺着 ``next`` 走,把之后的台词与呼吸图相关的动作按原顺序抽出来,直到同一个句柄被
``hideOverlayImage`` 收掉 / 走到 ``end`` / 遇到分支(分支后面走哪条工作台不猜,到那里为止)。

一步的形状(页面照着演):

  {"kind": "show", "handle", "xPercent", "yPercent", "widthPercent"}
  {"kind": "line", "speaker", "text"}                            台词:页面上等点击(出片时按设定秒数自动点)
  {"kind": "perform", "act", "wait"}                              breathingPerform
  {"kind": "params", "params", "durationMs"}                      setBreathingParams
  {"kind": "wait", "ms"}                                          waitMs
  {"kind": "black", "ms"}                                         fadeWorldToBlack(页面只拿来画黑场)
  {"kind": "hide"}                                                hideOverlayImage 收掉这个句柄
  {"kind": "other", "type"}                                       其余动作(只列出来,工作台不演)
"""
from __future__ import annotations

import json
from pathlib import Path

from tools.breathing_workbench import store

GRAPHS_REL = "public/assets/dialogues/graphs"
MAX_STEPS = 400


def _graphs_dir() -> Path:
    return store.PROJECT / GRAPHS_REL


def _speaker(node: dict) -> str:
    sp = node.get("speaker")
    if isinstance(sp, dict):
        if sp.get("kind") == "literal":
            return str(sp.get("name") or "")
        return str(sp.get("npcId") or sp.get("name") or sp.get("kind") or "")
    return str(sp or "")


def _num(v, default=0.0) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _walk(nodes: dict, start: str, start_index: int, handle: str) -> list[dict]:
    steps: list[dict] = []
    nid: str | None = start
    first = True
    seen: set[str] = set()
    while nid and len(steps) < MAX_STEPS:
        if nid in seen:
            steps.append({"kind": "other", "type": "(回到走过的节点,停在这里)"})
            break
        seen.add(nid)
        node = nodes.get(nid)
        if not isinstance(node, dict):
            break
        t = node.get("type")
        if t == "line":
            steps.append({"kind": "line", "speaker": _speaker(node), "text": str(node.get("text") or "")})
        elif t == "runActions":
            acts = node.get("actions") if isinstance(node.get("actions"), list) else []
            for i, a in enumerate(acts):
                if first and i < start_index:
                    continue
                if not isinstance(a, dict):
                    continue
                at = str(a.get("type") or "")
                p = a.get("params") if isinstance(a.get("params"), dict) else {}
                pid = str(p.get("id") or "").strip()
                if at == "showBreathingOverlay" and pid == handle:
                    steps.append({"kind": "show", "handle": handle, "xPercent": _num(p.get("xPercent"), 50),
                                  "yPercent": _num(p.get("yPercent"), 50), "widthPercent": _num(p.get("widthPercent"), 80)})
                elif at == "breathingPerform" and pid == handle:
                    steps.append({"kind": "perform", "act": str(p.get("act") or ""), "wait": p.get("wait") is True})
                elif at == "setBreathingParams" and pid == handle:
                    steps.append({"kind": "params", "params": p.get("params") if isinstance(p.get("params"), dict) else {},
                                  "durationMs": _num(p.get("durationMs"), 0)})
                elif at == "waitMs":
                    steps.append({"kind": "wait", "ms": _num(p.get("durationMs"), 0)})
                elif at == "fadeWorldToBlack":
                    steps.append({"kind": "black", "ms": _num(p.get("durationMs"), 0)})
                elif at == "hideOverlayImage" and pid == handle:
                    steps.append({"kind": "hide"})
                    return steps
                else:
                    steps.append({"kind": "other", "type": at})
        elif t == "end":
            break
        else:
            steps.append({"kind": "other", "type": f"(节点类型 {t},工作台不往下猜)"})
            break
        first = False
        nxt = node.get("next")
        nid = nxt if isinstance(nxt, str) else None
    return steps


def stories_for(bid: str) -> list[dict]:
    """用到这张呼吸图的每一处(对话图 × 句柄)各一条时间轴。"""
    out: list[dict] = []
    d = _graphs_dir()
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        try:
            g = json.loads(p.read_bytes().decode("utf-8"))
        except Exception:  # noqa: BLE001 — 坏文件不拖垮整张清单
            continue
        nodes = g.get("nodes") if isinstance(g, dict) else None
        if not isinstance(nodes, dict):
            continue
        for nid, node in nodes.items():
            if not isinstance(node, dict) or node.get("type") != "runActions":
                continue
            for i, a in enumerate(node.get("actions") or []):
                if not isinstance(a, dict) or a.get("type") != "showBreathingOverlay":
                    continue
                prm = a.get("params") if isinstance(a.get("params"), dict) else {}
                if str(prm.get("breathing") or "").strip() != bid:
                    continue
                handle = str(prm.get("id") or "").strip()
                steps = _walk(nodes, nid, i, handle)
                out.append({"graph": p.stem, "node": nid, "handle": handle, "steps": steps,
                            "lines": sum(1 for s in steps if s["kind"] == "line")})
    return out
