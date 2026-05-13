"""将 run 下 `world/` 全量只读信息渲染为单页 HTML（供「世界」标签概览子页使用）。"""
from __future__ import annotations

import json
from html import escape as E
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.fs import read_json
from tools.chronicle_sim_v2.core.world.seed_reader import (
    read_all_agents,
    read_all_factions,
    read_all_locations,
    read_anchor_events,
    read_design_pillars,
    read_social_graph,
    read_world_setting,
)
from tools.chronicle_sim_v2.gui.chronicle_display import _wrap_page


def _file_tree_rows(world_dir: Path, run_dir: Path) -> str:
    lines = ["<h2>数据文件</h2><table class='simple'>"]
    lines.append("<tr><th>相对路径</th><th>说明</th></tr>")
    if not world_dir.is_dir():
        return "<p class='muted'>（无 world 目录）</p>"
    for p in sorted(world_dir.rglob("*.json")):
        rel = p.relative_to(run_dir).as_posix()
        sub = p.relative_to(world_dir)
        if sub.parts[0] == "agents":
            kind = "角色"
        elif sub.parts[0] == "factions":
            kind = "势力"
        elif sub.parts[0] == "locations":
            kind = "地点"
        elif sub.parts[0] == "relationships":
            kind = "关系"
        else:
            kind = "根配置"
        lines.append(
            f"<tr><td><code>{E(rel)}</code></td><td>{E(kind)}</td></tr>"
        )
    lines.append("</table>")
    return "\n".join(lines)


def _dl_world_setting(ws: dict[str, Any]) -> str:
    if not ws:
        return "<p class='muted'>（无 world_setting.json）</p>"
    parts = ['<h2>世界背景 <span class="muted">world_setting</span></h2><div class="card">']
    for k, v in ws.items():
        if isinstance(v, (dict, list)):
            body = E(json.dumps(v, ensure_ascii=False, indent=2))
            parts.append(f"<p><b>{E(k)}</b></p><pre class='raw'>{body}</pre>")
        else:
            parts.append(f"<p><b>{E(k)}</b><br/>{E(str(v))}</p>")
    parts.append("</div>")
    return "\n".join(parts)


def _section_design_pillars(items: list[Any]) -> str:
    if not items:
        return "<h2>设计支柱</h2><p class='muted'>（空）</p>"
    parts = ['<h2>设计支柱</h2>']
    for it in items:
        if not isinstance(it, dict):
            parts.append(f'<div class="card"><pre class="raw">{E(str(it))}</pre></div>')
            continue
        title = E(str(it.get("name", it.get("id", ""))))
        parts.append(f'<div class="card"><p class="pillar-name">{title}</p>')
        for key in ("id", "name", "description", "implications"):
            if key in it and it[key] is not None:
                parts.append(
                    f"<p><b>{E(key)}</b><br/>{E(str(it[key]))}</p>"
                )
        for k, v in sorted(it.items()):
            if k in ("id", "name", "description", "implications"):
                continue
            parts.append(
                f"<p class='muted'><b>{E(k)}</b> {E(str(v))}</p>"
            )
        parts.append("</div>")
    return "\n".join(parts)


def _table_anchor_events(items: list[Any]) -> str:
    if not items:
        return "<h2>锚点事件</h2><p class='muted'>（空）</p>"
    lines = [
        "<h2>锚点事件</h2><table class='simple'>",
        "<tr><th>id</th><th>名称</th><th>描述</th></tr>",
    ]
    for it in items:
        if not isinstance(it, dict):
            continue
        lines.append(
            f"<tr><td><code>{E(str(it.get('id','')))}</code></td>"
            f"<td>{E(str(it.get('name','')))}</td>"
            f"<td>{E(str(it.get('description','')))}</td></tr>"
        )
    lines.append("</table>")
    return "\n".join(lines)


def _table_custom_sections(items: list[Any]) -> str:
    if not items:
        return "<h2>附加段落 custom_sections</h2><p class='muted'>（空）</p>"
    lines = [
        "<h2>附加段落 <span class='muted'>custom_sections</span></h2>",
        '<table class="simple">',
        "<tr><th>id</th><th>标题</th><th>正文</th></tr>",
    ]
    for it in items:
        if not isinstance(it, dict):
            continue
        body = str(it.get("body", ""))
        if len(body) > 600:
            body = body[:597] + "…"
        lines.append(
            f"<tr><td><code>{E(str(it.get('id','')))}</code></td>"
            f"<td>{E(str(it.get('title','')))}</td>"
            f"<td>{E(body)}</td></tr>"
        )
    lines.append("</table>")
    return "\n".join(lines)


def _table_agents(agents: list[dict[str, Any]]) -> str:
    if not agents:
        return "<h2>角色</h2><p class='muted'>（空）</p>"
    lines = [
        "<h2>角色 <span class='muted'>world/agents</span></h2>",
        '<table class="simple">',
        "<tr><th>id</th><th>姓名</th><th>层级</th><th>状态</th><th>势力提示</th><th>地点提示</th><th>理由摘要</th></tr>",
    ]
    for a in sorted(agents, key=lambda x: str(x.get("id", ""))):
        reason = str(a.get("reason", ""))
        if len(reason) > 200:
            reason = reason[:197] + "…"
        tier = a.get("current_tier") or a.get("tier") or a.get("suggested_tier") or ""
        lines.append(
            f"<tr><td><code>{E(str(a.get('id','')))}</code></td>"
            f"<td>{E(str(a.get('name','')))}</td>"
            f"<td>{E(str(tier))}</td>"
            f"<td>{E(str(a.get('life_status','')))}</td>"
            f"<td>{E(str(a.get('faction_hint','')))}</td>"
            f"<td>{E(str(a.get('location_hint','')))}</td>"
            f"<td>{E(reason)}</td></tr>"
        )
    lines.append("</table>")
    return "\n".join(lines)


def _table_factions(items: list[dict[str, Any]]) -> str:
    if not items:
        return "<h2>势力</h2><p class='muted'>（空）</p>"
    lines = [
        "<h2>势力 <span class='muted'>world/factions</span></h2>",
        '<table class="simple">',
        "<tr><th>id</th><th>名称</th><th>描述</th></tr>",
    ]
    for it in sorted(items, key=lambda x: str(x.get("id", ""))):
        d = str(it.get("description", ""))
        if len(d) > 500:
            d = d[:497] + "…"
        lines.append(
            f"<tr><td><code>{E(str(it.get('id','')))}</code></td>"
            f"<td>{E(str(it.get('name','')))}</td>"
            f"<td>{E(d)}</td></tr>"
        )
    lines.append("</table>")
    return "\n".join(lines)


def _table_locations(items: list[dict[str, Any]]) -> str:
    if not items:
        return "<h2>地点</h2><p class='muted'>（空）</p>"
    lines = [
        "<h2>地点 <span class='muted'>world/locations</span></h2>",
        '<table class="simple">',
        "<tr><th>id</th><th>名称</th><th>描述</th></tr>",
    ]
    for it in sorted(items, key=lambda x: str(x.get("id", ""))):
        d = str(it.get("description", ""))
        if len(d) > 500:
            d = d[:497] + "…"
        lines.append(
            f"<tr><td><code>{E(str(it.get('id','')))}</code></td>"
            f"<td>{E(str(it.get('name','')))}</td>"
            f"<td>{E(d)}</td></tr>"
        )
    lines.append("</table>")
    return "\n".join(lines)


def _section_relationships(edges: list[dict[str, Any]]) -> str:
    n = len(edges)
    body = (
        f'<div class="card"><p>共 <b>{n}</b> 条有向关系边，源字段 '
        f'<code>from_agent_id</code> / <code>to_agent_id</code> 可表示角色、势力等任意实体 id。'
        f"</p><p class='muted'>拓扑可视化请切到本页「关系网络」子标签（NetworkX + 节点/边）。</p></div>"
    )
    if n == 0:
        return f"<h2>关系 <span class='muted'>relationships/graph</span></h2>{body}"
    lines = [
        f"<h2>关系 <span class='muted'>relationships/graph</span></h2>",
        body,
        "<table class='simple'>",
        "<tr><th>#</th><th>自</th><th>至</th><th>关系类型</th><th>强度</th></tr>",
    ]
    for i, e in enumerate(edges, 1):
        if not isinstance(e, dict):
            continue
        lines.append(
            f"<tr><td>{i}</td>"
            f"<td><code>{E(str(e.get('from_agent_id','')))}</code></td>"
            f"<td><code>{E(str(e.get('to_agent_id','')))}</code></td>"
            f"<td>{E(str(e.get('rel_type','')))}</td>"
            f"<td>{E(str(e.get('strength','')))}</td></tr>"
        )
    lines.append("</table>")
    return "\n".join(lines)


def build_world_overview_html(run_dir: Path) -> str:
    world_dir = run_dir / "world"
    inner_parts: list[str] = []

    inner_parts.append(
        '<div class="card"><p class="ws-title">World 总览</p>'
        f"<p class='muted'>Run：<code>{E(str(run_dir))}</code></p>"
        "<p>以下为 <code>world/</code> 下可读 JSON 的汇总；"
        "可构图部分在「关系网络」中绘制（与下表同源）。</p></div>"
    )
    inner_parts.append(_file_tree_rows(world_dir, run_dir))
    ws = read_world_setting(run_dir)
    if not isinstance(ws, dict):
        ws = {}
    inner_parts.append(_dl_world_setting(ws))
    inner_parts.append(_section_design_pillars(read_design_pillars(run_dir)))
    inner_parts.append(_table_anchor_events(read_anchor_events(run_dir)))

    custom = read_json(run_dir, "world/custom_sections.json")
    if not isinstance(custom, list):
        custom = []
    inner_parts.append(_table_custom_sections(custom))

    inner_parts.append(_table_agents(read_all_agents(run_dir)))
    inner_parts.append(_table_factions(read_all_factions(run_dir)))
    inner_parts.append(_table_locations(read_all_locations(run_dir)))

    soc = read_social_graph(run_dir)
    inner_parts.append(_section_relationships([e for e in soc if isinstance(e, dict)]))

    return _wrap_page("世界", "\n".join(inner_parts))
