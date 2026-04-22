"""编年史浏览：JSON/Markdown 转友好 HTML（事件、意图、记忆、谣言图谱、总结）。"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from html import escape as E
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.seed_reader import read_agent


def _wrap_page(title: str, inner: str) -> str:
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<style>"
        "body{font-family:'Microsoft YaHei',SimHei,sans-serif;font-size:13px;color:#222;"
        "line-height:1.55;margin:12px;background:#fafafa;}"
        "h1{font-size:16px;color:#1a365d;border-bottom:1px solid #cbd5e0;padding-bottom:6px;margin:0 0 12px;}"
        "h2{font-size:14px;color:#2c5282;margin:16px 0 8px;}"
        "h3{font-size:13px;color:#4a5568;margin:12px 0 6px;}"
        ".card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:10px;"
        "box-shadow:0 1px 2px rgba(0,0,0,.04);}"
        ".muted{color:#718096;font-size:12px;}"
        ".tag{display:inline-block;background:#edf2f7;color:#4a5568;border-radius:4px;padding:2px 8px;"
        "margin:2px;font-size:11px;}"
        ".tier-s{background:#e9d8fd;color:#553c9a;}"
        ".tier-a{background:#bee3f8;color:#2c5282;}"
        ".tier-b{background:#c6f6d5;color:#276749;}"
        ".tier-c{background:#feebc8;color:#744210;}"
        ".tier-bgrp{background:#e9d8fd;color:#6b21a8;}"
        "table.simple{border-collapse:collapse;width:100%;font-size:12px;}"
        "table.simple th,table.simple td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top;}"
        "table.simple th{background:#edf2f7;color:#2d3748;width:28%;}"
        "blockquote{margin:8px 0;padding:8px 12px;border-left:4px solid #63b3ed;background:#f7fafc;"
        "color:#4a5568;}"
        "pre.raw{white-space:pre-wrap;background:#1a202c;color:#e2e8f0;padding:12px;border-radius:6px;"
        "font-size:11px;font-family:Consolas,monospace;}"
        ".notes-intro,.notes-prose{background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;"
        "color:#2d3748;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}"
        ".notes-section{margin-bottom:12px;}"
        ".notes-section-title{font-weight:600;color:#2c5282;margin:0 0 8px;font-size:13px;}"
        ".draft-wrap{background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;}"
        ".pillar-item{background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;margin:8px 0;}"
        ".pillar-name{font-weight:600;color:#2b6cb0;margin-bottom:6px;font-size:12px;}"
        ".ws-title{font-size:15px;font-weight:700;color:#1a365d;margin-bottom:8px;}"
        ".ws-logline{margin:8px 0;font-size:13px;color:#4a5568;line-height:1.55;}"
        "</style></head><body>"
        f"<h1>{E(title)}</h1>{inner}</body></html>"
    )


def _agent_label(run_dir: Path | None, agent_id: str) -> str:
    if not run_dir:
        return agent_id
    ag = read_agent(run_dir, agent_id)
    if not ag:
        return agent_id
    name = ag.get("name") or ""
    if name:
        return f"{name} ({agent_id})"
    return agent_id


def _tier_badge_class(agent_id: str, tier: str | None) -> str:
    if agent_id == "tier_b_group":
        return "tier-bgrp"
    t = (tier or "").upper().strip()
    if t == "S":
        return "tier-s"
    if t == "A":
        return "tier-a"
    if t == "B":
        return "tier-b"
    if t == "C":
        return "tier-c"
    return "tag"


def _intent_role_line(run_dir: Path | None, agent_id: str) -> str:
    """意图页眉：角色类 + 显示名。"""
    if agent_id == "tier_b_group":
        badge = '<span class="tag tier-bgrp">B 类 · 群体汇总</span>'
        return f"{badge} <code>{E(agent_id)}</code>"
    ag = read_agent(run_dir, agent_id) if run_dir else None
    tier = None
    if ag:
        tier = ag.get("current_tier") or ag.get("tier") or ag.get("suggested_tier")
    cls = _tier_badge_class(agent_id, tier)
    tier_txt = f"{tier}" if tier else "未标注"
    badge = f'<span class="tag {cls}">{E(tier_txt)} 类</span>'
    name = ag.get("name", "") if ag else ""
    if name:
        return f"{badge} <b>{E(name)}</b> <code>{E(agent_id)}</code>"
    return f"{badge} <code>{E(agent_id)}</code>"


def _safe_parse_json(s: str) -> Any | None:
    s = s.strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    try:
        from json_repair import repair_json

        return repair_json(s, return_objects=True)
    except Exception:
        return None


def _json_to_friendly_html(obj: Any) -> str:
    if isinstance(obj, dict):
        if {"title", "logline"} <= set(obj.keys()) and isinstance(obj.get("title"), str):
            parts: list[str] = ['<div class="world-block">']
            parts.append(f'<div class="ws-title">{E(str(obj["title"]))}</div>')
            parts.append(f'<blockquote class="ws-logline">{E(str(obj.get("logline", "")))}</blockquote>')
            rest = {k: v for k, v in obj.items() if k not in ("title", "logline")}
            if rest:
                parts.append(_dict_to_simple_table(rest))
            parts.append("</div>")
            return "".join(parts)
        return _dict_to_simple_table(obj)
    if isinstance(obj, list):
        if not obj:
            return "<p class='muted'>（空列表）</p>"
        if all(isinstance(x, dict) for x in obj):
            return _dict_list_cards(obj)
        return (
            "<ul style='margin:6px 0;padding-left:20px;'>"
            + "".join(f"<li>{_json_to_friendly_html(x)}</li>" for x in obj)
            + "</ul>"
        )
    return f"<span>{E(str(obj))}</span>"


def _dict_to_simple_table(d: dict[str, Any]) -> str:
    rows: list[str] = []
    for k, v in d.items():
        if isinstance(v, (dict, list)):
            cell = _json_to_friendly_html(v)
        else:
            cell = E(str(v))
        rows.append(f"<tr><th>{E(str(k))}</th><td>{cell}</td></tr>")
    return f'<table class="simple">{"".join(rows)}</table>'


def _dict_list_cards(items: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for it in items:
        title = str(it.get("name") or it.get("id") or "")
        head = f'<div class="pillar-name">{E(title)}</div>' if title else ""
        sub: list[str] = []
        for k, v in it.items():
            if k == "name":
                continue
            if k == "id" and it.get("name"):
                continue
            if isinstance(v, (dict, list)):
                sub.append(
                    f"<div style='margin-top:6px'><span class='muted'>{E(k)}</span>"
                    f"{_json_to_friendly_html(v)}</div>"
                )
            else:
                sub.append(
                    f"<p style='margin:4px 0;font-size:12px'><b>{E(k)}</b>：{E(str(v))}</p>"
                )
        out.append(f'<div class="pillar-item">{head}{"".join(sub)}</div>')
    return "".join(out)


def _director_draft_to_html(draft: dict[str, Any]) -> str:
    """导演草案：浅色表格，避免深色 code 块观感。"""
    rows = []
    for k, v in draft.items():
        label = {
            "from_draft": "来源草案类型 / ID",
            "stakes": "赌注/利害",
            "open_hooks": "开放钩子",
        }.get(k, k)
        if isinstance(v, (dict, list)):
            cell = _json_to_friendly_html(v)
        else:
            cell = f"<span>{E(str(v))}</span>"
        rows.append(f"<tr><th>{E(str(label))}</th><td>{cell}</td></tr>")
    return f'<div class="draft-wrap"><table class="simple">{"".join(rows)}</table></div>'


def _memory_notes_to_html_fragment(notes: str) -> str:
    """解析【章节】+ JSON/文本，生成浅色结构化 HTML。"""
    notes = notes.strip()
    if not notes:
        return ""

    segments = re.split(r"(【[^】]+】)", notes)
    parts: list[str] = []
    if segments and segments[0].strip():
        parts.append(f'<div class="notes-intro">{E(segments[0].strip())}</div>')

    # split 结果为 [前导, 【标题1】, 正文1, 【标题2】, 正文2, …]，标题在奇数下标
    for i in range(1, len(segments), 2):
        if i + 1 >= len(segments):
            break
        header = segments[i].strip()
        body = segments[i + 1].strip()
        if not body:
            continue
        parsed = _safe_parse_json(body)
        if parsed is not None:
            inner = _json_to_friendly_html(parsed)
        else:
            inner = f'<div class="notes-prose">{E(body)}</div>'
        parts.append(
            f'<div class="notes-section card">'
            f'<div class="notes-section-title">{E(header)}</div>{inner}'
            f"</div>"
        )

    return "".join(parts) if parts else f'<div class="notes-prose">{E(notes)}</div>'


def event_json_to_html(run_dir: Path | None, data: dict[str, Any], filename: str = "") -> str:
    truth = data.get("truth_json") or {}
    if not isinstance(truth, dict):
        truth = {}
    what = truth.get("what_happened") or truth.get("note") or ""
    wkw = truth.get("who_knows_what")
    parts: list[str] = []

    head_bits = [
        f"<div class='card'><table class='simple'>",
        f"<tr><th>事件 ID</th><td><code>{E(str(data.get('id', '')))}</code></td></tr>",
        f"<tr><th>类型</th><td>{E(str(data.get('type_id', '')))}</td></tr>",
        f"<tr><th>周次</th><td>{E(str(data.get('week_number', '')))}</td></tr>",
        f"<tr><th>地点</th><td>{E(str(data.get('location_id', '')))}</td></tr>",
    ]
    if data.get("supernatural_level"):
        head_bits.append(
            f"<tr><th>超自然程度</th><td>{E(str(data.get('supernatural_level')))}</td></tr>"
        )
    head_bits.append("</table></div>")
    parts.append("".join(head_bits))

    parts.append("<h2>真相摘要</h2>")
    parts.append(f"<div class='card'><p>{E(what) if what else '（无）'}</p></div>")

    if isinstance(wkw, dict) and wkw:
        parts.append("<h2>谁知道什么</h2><div class='card'><table class='simple'>")
        for k, v in wkw.items():
            parts.append(f"<tr><th>{E(str(k))}</th><td>{E(str(v))}</td></tr>")
        parts.append("</table></div>")

    actors = data.get("actor_ids") or []
    rel = data.get("related_agents") or []
    spa = data.get("spread_agents") or []
    if actors or rel or spa:
        parts.append("<h2>角色与传播</h2><div class='card'><table class='simple'>")
        if actors:
            al = ", ".join(_agent_label(run_dir, x) if run_dir else str(x) for x in actors)
            parts.append(f"<tr><th>演员 actor_ids</th><td>{E(al)}</td></tr>")
        if rel:
            rl = ", ".join(_agent_label(run_dir, x) if run_dir else str(x) for x in rel)
            parts.append(f"<tr><th>相关人</th><td>{E(rl)}</td></tr>")
        if spa:
            sl = ", ".join(_agent_label(run_dir, x) if run_dir else str(x) for x in spa)
            parts.append(f"<tr><th>传播起点 spread_agents</th><td>{E(sl)}</td></tr>")
        parts.append("</table></div>")

    witnesses = data.get("witness_accounts") or []
    if witnesses:
        parts.append("<h2>目击者证词</h2>")
        for w in witnesses:
            if not isinstance(w, dict):
                continue
            aid = w.get("agent_id", "?")
            label = _agent_label(run_dir, str(aid)) if run_dir else str(aid)
            acc = w.get("account_text", "")
            hint = w.get("supernatural_hint", "")
            hint_html = f"<div class='muted'>暗示：{E(hint)}</div>" if hint else ""
            parts.append(
                f"<div class='card'><b>{E(label)}</b>{hint_html}"
                f"<blockquote>{E(str(acc))}</blockquote></div>"
            )

    tags = data.get("tags") or []
    if tags:
        parts.append("<h2>标签</h2><div>")
        for t in tags:
            parts.append(f"<span class='tag'>{E(str(t))}</span>")
        parts.append("</div>")

    rvers = data.get("rumor_versions") or []
    if rvers:
        parts.append("<h2>谣言候选句式</h2><ul>")
        for rv in rvers:
            parts.append(f"<li>{E(str(rv))}</li>")
        parts.append("</ul>")

    dd = data.get("director_draft_json")
    if isinstance(dd, dict) and dd:
        parts.append("<h2>导演草案</h2>")
        parts.append(_director_draft_to_html(dd))

    title = data.get("type_id") or filename or "事件"
    return _wrap_page(f"事件 · {title}", "".join(parts))


def _intent_card_fragment_html(run_dir: Path | None, data: dict[str, Any]) -> str:
    agent_id = str(data.get("agent_id", ""))
    header = _intent_role_line(run_dir, agent_id)
    mood = data.get("mood_delta", "")
    itxt = data.get("intent_text", "")
    targets = data.get("target_ids") or []
    hints = data.get("relationship_hints") or []

    parts = [
        f"<div class='card'><div style='margin-bottom:10px'>{header}</div>",
        f"<p class='muted'>第 {E(str(data.get('week', '')))} 周 · 心境：{E(str(mood))}</p>",
        f"<h2>意图</h2><p style='font-size:14px'>{E(str(itxt))}</p>",
    ]
    if targets:
        tl = ", ".join(_agent_label(run_dir, x) if run_dir else str(x) for x in targets)
        parts.append(f"<h3>目标角色</h3><p>{E(tl)}</p>")
    if hints:
        parts.append("<h3>关系提示</h3><ul>")
        for h in hints:
            parts.append(f"<li>{E(str(h))}</li>")
        parts.append("</ul>")
    parts.append("</div>")
    return "".join(parts)


def intent_json_to_html(run_dir: Path | None, data: dict[str, Any]) -> str:
    agent_id = str(data.get("agent_id", ""))
    frag = _intent_card_fragment_html(run_dir, data)
    return _wrap_page(f"意图 · {agent_id}", frag)


def memory_json_to_html(run_dir: Path | None, data: dict[str, Any]) -> str:
    """记忆：突出结构化意图，长 notes 折叠摘要。"""
    agent_id = str(data.get("agent_id", ""))
    inner = data.get("intent")
    if isinstance(inner, dict):
        body = _intent_card_fragment_html(run_dir, inner)
    else:
        body = "<p class='muted'>（无嵌套 intent 字段）</p>"

    notes = data.get("notes")
    notes_str = str(notes) if notes is not None else ""
    notes_block = ""
    if notes_str:
        limit = 4000
        truncated = len(notes_str) > limit
        work = notes_str[:limit] if truncated else notes_str
        if truncated:
            work += "\n\n…（上文已截断；完整原始文本请在「JSON / 原文」标签查看。）"
        frag = _memory_notes_to_html_fragment(work)
        title = "注入上下文（摘要）" if truncated else "注入上下文"
        notes_block = f"<h2>{title}</h2>{frag}"

    parts = [
        f"<div class='card'><b>记忆载体</b> {_intent_role_line(run_dir, agent_id)} · 第 {E(str(data.get('week','')))} 周</div>",
        "<h2>本周意图（嵌套）</h2>",
        body,
        notes_block,
    ]
    return _wrap_page(f"记忆 · {agent_id}", "".join(parts))


def _undirected_components(nodes: set[str], edges_u: list[tuple[str, str]]) -> list[set[str]]:
    adj: dict[str, set[str]] = {n: set() for n in nodes}
    for a, b in edges_u:
        if a in adj and b in adj:
            adj[a].add(b)
            adj[b].add(a)

    seen: set[str] = set()
    comps: list[set[str]] = []
    for n in nodes:
        if n in seen:
            continue
        stack = [n]
        comp: set[str] = set()
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            comp.add(x)
            for y in adj.get(x, ()):
                if y not in seen:
                    stack.append(y)
        comps.append(comp)
    return comps


def build_rumor_graph_svg(run_dir: Path | None, rows: list[Any]) -> str:
    """生成 SVG 字符串；与界面共用 `rumor_nx`（NetworkX spring 布局）。"""
    from tools.chronicle_sim_v2.gui.rumor_nx import build_rumor_graph_svg as _svg

    return _svg(run_dir, rows)


def rumors_html_stats_and_table_only(run_dir: Path | None, rows: list[Any], *, graph_hint: bool) -> str:
    """统计 + 明细表（不含拓扑图）；供分栏界面下方 QTextBrowser 使用。"""
    if not rows:
        return _wrap_page("谣言传播", "<p class='muted'>（空）</p>")
    list_rows = [r for r in rows if isinstance(r, dict)]
    n = len(list_rows)
    nodes: set[str] = set()
    directed: list[tuple[str, str]] = []
    for r in list_rows:
        t = str(r.get("teller_id", ""))
        h = str(r.get("hearer_id", ""))
        nodes.add(t)
        nodes.add(h)
        directed.append((t, h))
    edges_u: list[tuple[str, str]] = [(a, b) for a, b in directed]
    comps = _undirected_components(nodes, edges_u)
    comp_ul = ["<ul style='font-size:12px;margin:6px 0 0 18px;color:#4a5568;'>"]
    for i, c in enumerate(sorted(comps, key=lambda s: -len(s)), 1):
        names = "，".join(sorted(c))
        comp_ul.append(f"<li>分量 {i}（{len(c)} 人）：{E(names)}</li>")
    comp_ul.append("</ul>")
    hint = ""
    if graph_hint:
        hint = (
            "<p class='muted' style='margin-top:8px'>"
            "上图：左键拖动画布平移，滚轮缩放；可拖动节点重排；"
            "左键点边：会高亮同「来源事件」下整条传播链的边与节点，便于对照下方明细表；点空白或按 Esc 取消。"
            "灰箭头：未走样；绿箭头：走样（distorted）。"
            "</p>"
        )
    stats = (
        f"<div class='card'><p><b>共 {n} 条</b>谣言记录；<b>{len(nodes)}</b> 个角色节点；"
        f"<b>{len(directed)}</b> 条有向边。</p>"
        f"<p class='muted'>无向视角下的连通分量：<b>{len(comps)}</b> 个（下列列表）。"
        f"箭头方向：讲述者 &rarr; 听众。</p>"
        f"{''.join(comp_ul)}</div>{hint}"
    )
    table = ["<h2>谣言明细</h2><table class='simple'>"]
    table.append(
        "<tr><th>#</th><th>来源事件</th><th>讲述</th><th>听众</th><th>跳数</th><th>走样</th><th>摘要</th></tr>"
    )
    for i, r in enumerate(list_rows, 1):
        ev = str(r.get("originating_event_id", ""))
        content = str(r.get("content", ""))
        snip = content if len(content) <= 120 else content[:117] + "…"
        dist = "是" if r.get("distorted") else "否"
        table.append(
            f"<tr><td>{i}</td><td><code>{E(ev)}</code></td>"
            f"<td>{E(str(r.get('teller_id','')))}</td>"
            f"<td>{E(str(r.get('hearer_id','')))}</td>"
            f"<td>{E(str(r.get('propagation_hop','')))}</td>"
            f"<td>{E(dist)}</td><td>{E(snip)}</td></tr>"
        )
    table.append("</table>")
    return _wrap_page("谣言传播", stats + "".join(table))


def rumors_json_to_html(
    run_dir: Path | None,
    rows: list[Any],
    *,
    graph_png_data_url: str | None = None,
) -> str:
    """单页 HTML：统计 + 可选位图 + 明细表。若无位图则与 `rumors_html_stats_and_table_only` 一致。"""
    if not rows:
        return _wrap_page("谣言", "<p class='muted'>（空）</p>")
    if not graph_png_data_url:
        return rumors_html_stats_and_table_only(run_dir, rows, graph_hint=False)

    list_rows = [r for r in rows if isinstance(r, dict)]
    n = len(list_rows)
    nodes: set[str] = set()
    directed: list[tuple[str, str]] = []
    for r in list_rows:
        t = str(r.get("teller_id", ""))
        h = str(r.get("hearer_id", ""))
        nodes.add(t)
        nodes.add(h)
        directed.append((t, h))
    edges_u: list[tuple[str, str]] = [(a, b) for a, b in directed]
    comps = _undirected_components(nodes, edges_u)
    comp_ul = ["<ul style='font-size:12px;margin:6px 0 0 18px;color:#4a5568;'>"]
    for i, c in enumerate(sorted(comps, key=lambda s: -len(s)), 1):
        names = "，".join(sorted(c))
        comp_ul.append(f"<li>分量 {i}（{len(c)} 人）：{E(names)}</li>")
    comp_ul.append("</ul>")
    stats = (
        f"<div class='card'><p><b>共 {n} 条</b>谣言记录；<b>{len(nodes)}</b> 个角色节点；"
        f"<b>{len(directed)}</b> 条有向边。</p>"
        f"<p class='muted'>无向视角下的连通分量：<b>{len(comps)}</b> 个（下列列表）。"
        f"图谱箭头为 <b>传播方向</b>（讲述者 &rarr; 听众）。</p>"
        f"{''.join(comp_ul)}</div>"
    )
    graph_html = (
        "<h2>传播图谱</h2>"
        "<p class='muted'>灰线：未走样；绿线：走样（distorted）。箭头：讲述者 &rarr; 听众。</p>"
        f'<p style="text-align:center;margin:8px 0"><img src="{graph_png_data_url}" '
        'style="max-width:100%;height:auto;border:1px solid #e2e8f0;border-radius:8px;background:#fff"/></p>'
    )
    table = ["<h2>谣言明细</h2><table class='simple'>"]
    table.append(
        "<tr><th>#</th><th>来源事件</th><th>讲述</th><th>听众</th><th>跳数</th><th>走样</th><th>摘要</th></tr>"
    )
    for i, r in enumerate(list_rows, 1):
        ev = str(r.get("originating_event_id", ""))
        content = str(r.get("content", ""))
        snip = content if len(content) <= 120 else content[:117] + "…"
        dist = "是" if r.get("distorted") else "否"
        table.append(
            f"<tr><td>{i}</td><td><code>{E(ev)}</code></td>"
            f"<td>{E(str(r.get('teller_id','')))}</td>"
            f"<td>{E(str(r.get('hearer_id','')))}</td>"
            f"<td>{E(str(r.get('propagation_hop','')))}</td>"
            f"<td>{E(dist)}</td><td>{E(snip)}</td></tr>"
        )
    table.append("</table>")
    return _wrap_page("谣言传播", stats + graph_html + "".join(table))


def summary_markdown_to_html(text: str) -> str:
    try:
        import markdown as md  # type: ignore
    except ImportError:
        inner = f"<div class='card'><pre class='raw'>{E(text)}</pre></div>"
        inner += (
            "<p class='muted'>（未安装 markdown 库，已显示原文；请 pip install markdown）</p>"
        )
        return _wrap_page("周总结", inner)
    body = md.markdown(
        text,
        extensions=[
            "markdown.extensions.fenced_code",
            "markdown.extensions.tables",
            "markdown.extensions.nl2br",
        ],
    )
    styled = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<style>"
        "body{font-family:'Microsoft YaHei',SimHei,sans-serif;font-size:14px;color:#222;line-height:1.65;"
        "margin:16px 20px;background:#fafafa;max-width:920px;}"
        "h1{font-size:18px;color:#1a365d;border-bottom:1px solid #cbd5e0;}"
        "h2{font-size:15px;color:#2c5282;}"
        "code,pre{background:#1a202c;color:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:12px;}"
        "pre{padding:12px;overflow:auto;}"
        "blockquote{border-left:4px solid #63b3ed;padding-left:12px;color:#4a5568;}"
        "table{border-collapse:collapse;width:100%;}"
        "th,td{border:1px solid #e2e8f0;padding:6px;}"
        "th{background:#edf2f7;}"
        "</style></head><body>"
        f"<h1>周总结</h1>{body}</body></html>"
    )
    return styled


def month_markdown_to_html(text: str, title: str) -> str:
    try:
        import markdown as md  # type: ignore
    except ImportError:
        inner = f"<div class='card'><pre class='raw'>{E(text)}</pre></div>"
        return _wrap_page(title, inner)
    body = md.markdown(
        text,
        extensions=[
            "markdown.extensions.fenced_code",
            "markdown.extensions.tables",
            "markdown.extensions.nl2br",
        ],
    )
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<style>"
        "body{font-family:'Microsoft YaHei',SimHei,sans-serif;font-size:14px;color:#222;line-height:1.65;"
        "margin:16px 20px;background:#fafafa;max-width:920px;}"
        "h1{font-size:18px;color:#1a365d;}"
        "</style></head><body>"
        f"<h1>{E(title)}</h1>{body}</body></html>"
    )


def generic_json_preview(data: Any, title: str) -> str:
    inner = f"<pre class='raw'>{E(json.dumps(data, ensure_ascii=False, indent=2))}</pre>"
    return _wrap_page(title, f"<div class='card'>{inner}</div>")
