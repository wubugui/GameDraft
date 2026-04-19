"""Agent 共享工具定义：read_file, write_file, list_dir, grep_search, glob_search, chroma_search。"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Awaitable

from pydantic_ai import Tool

from tools.chronicle_sim_v2.core.world import fs as fs_mod
from tools.chronicle_sim_v2.core.world import chroma as chroma_mod


def make_read_file(base: Path) -> Tool:
    """读取 run 目录下任意文件，返回原文。"""
    async def read_file(path: str) -> str:
        """读取文件内容。path 是相对于 run 目录的相对路径。"""
        return fs_mod.read_text(base, path)

    return Tool(read_file)


def make_write_file(base: Path) -> Tool:
    """写入 run 目录下文件（原子写）。"""
    async def _write_file(path: str, content: str) -> str:
        """写入文件内容。path 是相对于 run 目录的相对路径。"""
        fs_mod.write_text(base, path, content)
        return f"已写入 {path}"
    return Tool(_write_file)


def make_list_dir(base: Path) -> Tool:
    """列出目录内容。"""
    async def _list_dir(path: str) -> str:
        """列出目录中的文件名。"""
        items = fs_mod.list_dir(base, path)
        return "\n".join(items) if items else "(空目录)"
    return Tool(_list_dir)


def make_grep_search(base: Path) -> Tool:
    """正则搜索文件内容。"""
    async def _grep_search(pattern: str, path: str = "") -> str:
        """在目录下搜索 pattern（正则）。返回匹配行。"""
        results = fs_mod.grep_search(base, pattern, path)
        if not results:
            return "未找到匹配"
        lines = [f"{rel}:{ln}: {txt}" for rel, ln, txt in results[:30]]
        return "\n".join(lines)
    return Tool(_grep_search)


def make_glob_search(base: Path) -> Tool:
    """glob 模式匹配文件。"""
    async def _glob_search(pattern: str, path: str = "") -> str:
        """在目录下匹配 pattern（glob）。返回文件路径列表。"""
        results = fs_mod.glob_search(base, pattern, path)
        if not results:
            return "未找到匹配"
        return "\n".join(results[:30])
    return Tool(_glob_search)


def make_chroma_search(
    base: Path,
    collection_getter: Callable[[Path], Any | None],
    collection_name: str,
) -> Tool:
    """ChromaDB 语义搜索。"""
    async def _chroma_search(query: str, n_results: int = 5) -> str:
        f"""在 {collection_name} 集合中语义搜索。"""
        results = chroma_mod.search_world(base, query, n_results) if collection_name == "world" else chroma_mod.search_ideas(base, query, n_results)
        if not results:
            return "未找到相关结果"
        parts = []
        for i, r in enumerate(results, 1):
            meta = r.get("metadata") or {}
            doc = r.get("document", "")
            kind = meta.get("kind", "unknown")
            ref_id = meta.get("ref_id", meta.get("agent_id", ""))
            parts.append(f"[{i}] kind={kind} id={ref_id}\n{doc[:300]}")
        return "\n\n".join(parts)
    return Tool(_chroma_search)


def npc_s_tools(base: Path, agent_id: str) -> list[Tool]:
    """S 类 NPC 工具集：只能访问自己的数据。"""
    return [
        make_read_file(base),
        make_write_file(base),
        make_list_dir(base),
        make_grep_search(base),
    ]


def npc_a_tools(base: Path) -> list[Tool]:
    """A 类 NPC 工具集。"""
    return [
        make_read_file(base),
        make_list_dir(base),
        make_glob_search(base),
        make_chroma_search(base, chroma_mod.get_world_collection, "world"),
    ]


def npc_b_tools(base: Path) -> list[Tool]:
    """B/C 类 NPC 工具集：最小。"""
    return [
        make_read_file(base),
        make_list_dir(base),
    ]


def director_tools(base: Path) -> list[Tool]:
    """Director 工具集。"""
    return [
        make_read_file(base),
        make_write_file(base),
        make_list_dir(base),
        make_grep_search(base),
        make_glob_search(base),
        make_chroma_search(base, chroma_mod.get_world_collection, "world"),
    ]


def gm_tools(base: Path) -> list[Tool]:
    """GM 工具集。"""
    return [
        make_read_file(base),
        make_write_file(base),
        make_list_dir(base),
        make_chroma_search(base, chroma_mod.get_world_collection, "world"),
    ]


def rumor_tools(base: Path) -> list[Tool]:
    """Rumor 工具集。"""
    return [
        make_read_file(base),
        make_write_file(base),
        make_list_dir(base),
    ]


def summarizer_tools(base: Path) -> list[Tool]:
    """Summarizer 工具集。"""
    return [
        make_read_file(base),
        make_write_file(base),
        make_list_dir(base),
        make_grep_search(base),
        make_chroma_search(base, chroma_mod.get_world_collection, "world"),
    ]


def initializer_tools(base: Path) -> list[Tool]:
    """Initializer 工具集。"""
    return [
        make_read_file(base),
        make_chroma_search(base, chroma_mod.get_ideas_collection, "ideas"),
    ]


def make_list_chronicle_files(base: Path, *, max_files: int = 800) -> Tool:
    """递归列出 chronicle/ 下所有相对路径（有上限）。"""
    async def list_chronicle_files() -> str:
        root = base / "chronicle"
        if not root.is_dir():
            return "chronicle/ 目录不存在（尚无编年史数据）。"
        files = fs_mod.list_dir_recursive(base, "chronicle")
        if not files:
            return "(chronicle 下无文件)"
        total = len(files)
        if total > max_files:
            head = files[:max_files]
            return (
                "\n".join(head)
                + f"\n\n…（共 {total} 个文件，仅列出前 {max_files} 个；请用 grep_search / glob_search 缩小范围）"
            )
        return "\n".join(files)

    return Tool(list_chronicle_files)


def make_chroma_search_world_probe(base: Path) -> Tool:
    """world 集合语义搜索；未配置嵌入时返回说明。"""
    async def chroma_search_world(query: str, n_results: int = 8) -> str:
        if not chroma_mod.is_embedding_configured(base):
            return (
                "语义搜索不可用：未在 Run 的 LLM 配置中配置「嵌入」模型。"
                "请改用 list_chronicle_files、read_file、grep_search、glob_search 读取磁盘上的编年史 JSON/MD。"
            )
        n = max(1, min(20, int(n_results)))
        results = chroma_mod.search_world(base, query, n)
        if not results:
            return "未找到相关结果（可先重建索引，或换用 grep/read_file）。"
        parts = []
        for i, r in enumerate(results, 1):
            meta = r.get("metadata") or {}
            doc = r.get("document", "")
            kind = meta.get("kind", "unknown")
            ref_id = meta.get("ref_id", meta.get("agent_id", ""))
            parts.append(f"[{i}] kind={kind} id={ref_id}\n{doc[:500]}")
        return "\n\n".join(parts)

    return Tool(chroma_search_world)


def probe_tools(base: Path) -> list[Tool]:
    """探针：只读；磁盘 + world 语义检索。"""
    return [
        make_read_file(base),
        make_list_dir(base),
        make_list_chronicle_files(base),
        make_grep_search(base),
        make_glob_search(base),
        make_chroma_search_world_probe(base),
    ]
