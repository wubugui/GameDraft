"""将结构化数据转为适合 QTextEdit 的 HTML（仅用于展示，不改变底层数据）。"""

from __future__ import annotations

import json
import re
from html import escape as html_escape
from typing import Any

from PySide6.QtGui import QTextDocument

_DOC_STYLE = """
body { font-family: 'Microsoft YaHei UI','Microsoft YaHei','PingFang SC','Segoe UI',sans-serif; font-size: 13px; color: #222; }
h1 { font-size: 17px; margin: 10px 0 6px; color: #1a1a1a; }
h2 { font-size: 15px; margin: 8px 0 4px; color: #2c5282; }
h3 { font-size: 14px; margin: 6px 0 3px; color: #2d3748; }
p { margin: 4px 0; line-height: 1.45; }
ul, ol { margin: 4px 0 8px 1.2em; padding-left: 0.5em; }
li { margin: 2px 0; }
code, pre { font-family: 'Consolas','Cascadia Mono',monospace; font-size: 12px; }
pre { background: #f4f4f5; border-radius: 4px; padding: 8px; overflow-x: auto; }
hr { border: none; border-top: 1px solid #ddd; margin: 12px 0; }
table { border-collapse: collapse; margin: 6px 0; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: #f0f4f8; font-weight: 600; }
"""


def markdown_fragment_to_html(md: str) -> str:
    """将 Markdown 转为可嵌入 QTextEdit 的 HTML 片段（提取 body 内层）。"""
    raw = md or ""
    if not raw.strip():
        return "<p></p>"
    doc = QTextDocument()
    doc.setDefaultStyleSheet(_DOC_STYLE)
    doc.setMarkdown(raw)
    full = doc.toHtml()
    m = re.search(r"<body[^>]*>(.*)</body>", full, re.DOTALL | re.IGNORECASE)
    inner = m.group(1).strip() if m else full
    return inner or "<p></p>"


def json_value_to_html(val: Any, *, depth: int = 0) -> str:
    """将 JSON 兼容值渲染为分块 HTML（嵌套 dict 左侧缩进，字符串内若像 MD 则渲染）。"""
    pad = min(depth * 12, 48)
    margin = f"margin-left:{pad}px" if pad else ""

    if val is None:
        return '<span style="color:#888">（空）</span>'
    if isinstance(val, bool):
        return "是" if val else "否"
    if isinstance(val, (int, float)):
        return html_escape(str(val))
    if isinstance(val, str):
        s = val
        if not s.strip():
            return '<span style="color:#888">（空字符串）</span>'
        if "\n" in s or s.strip().startswith("#") or "**" in s or "`" in s or re.match(r"^\s*[-*]\s+", s):
            frag = markdown_fragment_to_html(s)
            return f'<div style="{margin};border-left:2px solid #e2e8f0;padding-left:8px">{frag}</div>'
        return f"<p style='{margin};margin:2px 0'>{html_escape(s)}</p>"

    if isinstance(val, list):
        if not val:
            return '<span style="color:#888">（无）</span>'
        items = "".join(f"<li>{json_value_to_html(x, depth=depth + 1)}</li>" for x in val)
        return f"<ul style='{margin};margin:4px 0'>{items}</ul>"

    if isinstance(val, dict):
        if not val:
            return '<span style="color:#888">（无）</span>'
        parts: list[str] = []
        for k, v in val.items():
            label = html_escape(str(k))
            parts.append(
                f'<div style="margin:8px 0 8px {pad}px;border-left:3px solid #cbd5e0;padding-left:10px">'
                f'<div style="color:#2b6cb0;font-weight:600;font-size:13px">{label}</div>'
                f"<div>{json_value_to_html(v, depth=depth + 1)}</div></div>"
            )
        return "".join(parts)

    return html_escape(str(val))


def chronicle_event_block_html(
    event_id: str,
    type_id: str,
    week_number: int,
    body_html: str,
) -> str:
    return (
        f'<div style="margin:14px 0;padding:10px 12px;background:#fafafa;border:1px solid #e2e8f0;'
        f'border-radius:6px">'
        f'<div style="font-weight:700;color:#1a365d;margin-bottom:8px">事件 {html_escape(event_id)}</div>'
        f'<div style="color:#4a5568;font-size:12px;margin-bottom:8px">'
        f"类型 <b>{html_escape(type_id)}</b> · 第 {week_number} 周"
        f"</div>"
        f"<div>{body_html}</div></div>"
    )


def probe_split_answer_and_refs(text: str) -> tuple[str, Any | None]:
    """拆分探针正文与 JSON 引用块。"""
    if "--- 引用 ---" not in text:
        return text, None
    main, _, tail = text.partition("--- 引用 ---")
    raw = tail.strip()
    try:
        return main.strip(), json.loads(raw)
    except json.JSONDecodeError:
        return text, None


def probe_refs_to_html(refs: Any) -> str:
    if refs is None:
        return ""
    return (
        '<div style="margin-top:8px;padding:8px;background:#f7fafc;border-radius:6px">'
        "<div style='font-weight:600;color:#2d3748;margin-bottom:6px'>引用来源</div>"
        f"{json_value_to_html(refs)}</div>"
    )


def probe_reply_to_html(full_text: str) -> str:
    """探针整段回复（含可选引用 JSON）→ HTML。"""
    main, refs = probe_split_answer_and_refs(full_text)
    main_html = markdown_fragment_to_html(main) if main else "<p></p>"
    if refs is not None:
        return main_html + probe_refs_to_html(refs)
    if "--- 引用 ---" in full_text and refs is None:
        _, _, tail = full_text.partition("--- 引用 ---")
        return (
            main_html
            + "<hr/>"
            + "<p style='font-weight:600'>引用（无法解析为 JSON）</p>"
            + f"<pre style='background:#fff5f5'>{html_escape(tail.strip())}</pre>"
        )
    return main_html


def format_jsonl_log_html(raw: str) -> str:
    """agent_logs / director_trace 的 JSONL → 分条 HTML。"""
    chunks: list[str] = []
    for i, line in enumerate(raw.splitlines(), 1):
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            chunks.append(
                f'<pre style="background:#f8f8f8;border-radius:4px;padding:6px">{html_escape(line)}</pre>'
            )
            continue
        phase = obj.get("phase") if isinstance(obj, dict) else None
        head = f"条目 {i}"
        if phase:
            head += f" · <span style='color:#2b6cb0'>{html_escape(str(phase))}</span>"
        inner = json_value_to_html(obj)
        chunks.append(
            f'<div style="margin:12px 0;padding:10px;background:#fcfcfd;border:1px solid #e2e8f0;border-radius:6px">'
            f'<div style="font-size:11px;color:#718096;margin-bottom:6px">{head}</div>{inner}</div>'
        )
    return "".join(chunks) if chunks else "<p>（无内容）</p>"


def seed_draft_dict_to_html(d: dict[str, Any]) -> str:
    """SeedDraft 字典 → 分节阅读视图。"""
    parts: list[str] = ['<div style="max-width:920px">']

    ws = d.get("world_setting")
    if isinstance(ws, dict) and ws:
        parts.append("<h2>世界观</h2>")
        parts.append(json_value_to_html(ws))

    pillars = d.get("design_pillars")
    if isinstance(pillars, list) and pillars:
        parts.append("<h2>设计支柱</h2>")
        parts.append(json_value_to_html(pillars))

    sections = d.get("custom_sections")
    if isinstance(sections, list) and sections:
        parts.append("<h2>自定义设定区块</h2>")
        parts.append(json_value_to_html(sections))

    agents = d.get("agents")
    if isinstance(agents, list) and agents:
        parts.append("<h2>角色</h2><table>")
        parts.append(
            "<tr><th>id</th><th>姓名</th><th>建议档</th><th>备注</th></tr>"
        )
        for a in agents:
            if not isinstance(a, dict):
                continue
            parts.append(
                "<tr>"
                f"<td>{html_escape(str(a.get('id','')))}</td>"
                f"<td>{html_escape(str(a.get('name','')))}</td>"
                f"<td>{html_escape(str(a.get('suggested_tier','')))}</td>"
                f"<td>{html_escape(str(a.get('reason','')))}</td>"
                "</tr>"
            )
        parts.append("</table>")

    for key, title in (
        ("factions", "派系"),
        ("locations", "地点"),
        ("relationships", "关系"),
        ("anchor_events", "锚点事件"),
        ("social_graph_edges", "社交边"),
        ("event_type_candidates", "事件类型候选"),
    ):
        block = d.get(key)
        if isinstance(block, list) and block:
            parts.append(f"<h2>{html_escape(title)}</h2>")
            parts.append(json_value_to_html(block))
        elif isinstance(block, dict) and block:
            parts.append(f"<h2>{html_escape(title)}</h2>")
            parts.append(json_value_to_html(block))

    parts.append("</div>")
    return "".join(parts)


def llm_config_dict_to_html(cfg: dict[str, Any]) -> str:
    """LLM 配置字典 → 分层展示（仍完整保留信息）。"""
    return (
        '<div style="font-size:12px"><p style="color:#718096">以下为将写入 runs.llm_config_json 的配置结构（阅读视图）。</p>'
        f"{json_value_to_html(cfg)}</div>"
    )

