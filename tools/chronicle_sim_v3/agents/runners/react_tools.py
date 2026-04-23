"""ReAct 本地 tools。

签名约定：
    async def call(args: dict, ctx: ReactToolCtx) -> str  # 返回 OBSERVATION 文本

OBSERVATION 是 model-facing 的字符串，错误也以纯文本回馈（不抛）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ReactToolCtx:
    """ReAct 工具运行时上下文。"""

    vars: dict = field(default_factory=dict)
    chroma: Any = None


def _to_jsonable(v: Any) -> Any:
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    if isinstance(v, dict):
        return {str(k): _to_jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_to_jsonable(x) for x in v]
    return repr(v)


def _format_obs(payload: Any) -> str:
    try:
        return json.dumps(_to_jsonable(payload), ensure_ascii=False)
    except Exception:
        return repr(payload)


async def tool_read_key(args: dict, ctx: ReactToolCtx) -> str:
    key = args.get("key")
    if not isinstance(key, str) or not key:
        return "ERROR: read_key 需要 string 参数 key"
    cur: Any = ctx.vars
    for part in key.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                idx = int(part)
            except ValueError:
                return f"ERROR: read_key 路径 {key!r} 中 {part!r} 非法 list 索引"
            if idx < 0 or idx >= len(cur):
                return f"ERROR: read_key 路径 {key!r} 索引 {idx} 越界"
            cur = cur[idx]
        else:
            return f"ERROR: read_key 路径 {key!r} 不存在（断在 {part!r}）"
    return _format_obs(cur)


async def tool_chroma_search(args: dict, ctx: ReactToolCtx) -> str:
    if ctx.chroma is None:
        return "ERROR: chroma 未注入；本环境不支持 chroma_search"
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return "ERROR: chroma_search 需要 string 参数 query"
    collection = str(args.get("collection") or "default")
    n_raw = args.get("n", 5)
    try:
        n = int(n_raw)
    except (TypeError, ValueError):
        return f"ERROR: chroma_search 参数 n 非整数: {n_raw!r}"
    if n <= 0 or n > 50:
        return f"ERROR: chroma_search 参数 n 越界（1..50）: {n}"
    try:
        result = await _maybe_await(
            ctx.chroma.search(query=query, collection=collection, n=n)
        )
    except Exception as e:  # 不让工具错误炸 runner
        return f"ERROR: chroma_search 失败: {type(e).__name__}: {e}"
    return _format_obs(result)


async def tool_final(args: dict, ctx: ReactToolCtx) -> str:
    text = args.get("text")
    if not isinstance(text, str):
        return "ERROR: final 需要 string 参数 text"
    return text


async def _maybe_await(obj: Any) -> Any:
    if hasattr(obj, "__await__"):
        return await obj
    return obj


REACT_TOOLS = {
    "read_key": tool_read_key,
    "chroma_search": tool_chroma_search,
    "final": tool_final,
}


def render_tools_doc(enabled: list[str]) -> str:
    """生成 prompt 末尾 `<tools>` 段（只列启用的工具签名）。"""
    docs = {
        "read_key": "read_key(key: str) → JSON 字符串；按点路径从 task vars 取值",
        "chroma_search": (
            "chroma_search(query: str, collection: str = 'default', n: int = 5) "
            "→ JSON list；语义检索"
        ),
        "final": "final(text: str) → 提交最终回答并结束循环",
    }
    lines = ["<tools>"]
    for name in enabled:
        if name in docs:
            lines.append(f"- {docs[name]}")
    lines.append("</tools>")
    return "\n".join(lines)
