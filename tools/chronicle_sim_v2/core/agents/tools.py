"""Agent 共享工具定义：read_file, write_file, list_dir, grep_search, glob_search, chroma_search（CrewStructuredTool，Pydantic v2，供 CrewAI 使用）。"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from crewai.tools.structured_tool import CrewStructuredTool
from pydantic import BaseModel, Field

from tools.chronicle_sim_v2.core.world import chroma as chroma_mod
from tools.chronicle_sim_v2.core.world import fs as fs_mod


# 显式声明参数模型，避免与 LangChain StructuredTool（易生成 pydantic v1 schema）混用导致 CrewAI Agent 校验失败。
class ReadFileInput(BaseModel):
    path: str = Field(description="相对于 run 目录的文件路径")


class WriteFileInput(BaseModel):
    path: str = Field(description="相对于 run 目录的文件路径")
    content: str = Field(description="要写入的文本内容")


class ListDirInput(BaseModel):
    path: str = Field(description="相对于 run 目录的目录路径")


class GrepSearchInput(BaseModel):
    pattern: str = Field(description="正则表达式")
    path: str = Field(default="", description="目录或前缀，空表示整库")


class GlobSearchInput(BaseModel):
    pattern: str = Field(description="glob 模式")
    path: str = Field(default="", description="目录或前缀，空表示整库")


class ChromaSearchInput(BaseModel):
    query: str = Field(description="语义检索查询")
    n_results: int = Field(default=5, ge=1, le=50, description="返回条数上限")


class ListChronicleFilesInput(BaseModel):
    """list_chronicle_files 无参数；模型为空以生成 {} schema。"""


def _append_tool_log(
    log: list[dict[str, Any]] | None,
    tool_name: str,
    args: dict[str, Any],
    content: str,
) -> None:
    if log is None:
        return
    log.append({"tool_name": tool_name, "args": args, "content": content})


def make_read_file(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> CrewStructuredTool:
    """读取 run 目录下任意文件，返回原文。"""

    def read_file(path: str) -> str:
        out = fs_mod.read_text_for_agent_tool(base, path)
        _append_tool_log(instrument_log, "read_file", {"path": path}, out)
        return out

    return CrewStructuredTool.from_function(
        read_file,
        name="read_file",
        description="读取文件内容。path 是相对于 run 目录的相对路径。",
        args_schema=ReadFileInput,
        infer_schema=False,
    )


def make_write_file(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> CrewStructuredTool:
    """写入 run 目录下文件（原子写）。"""

    def _write_file(path: str, content: str) -> str:
        fs_mod.write_text(base, path, content)
        msg = f"已写入 {path}"
        _append_tool_log(instrument_log, "write_file", {"path": path, "content_len": len(content or "")}, msg)
        return msg

    return CrewStructuredTool.from_function(
        _write_file,
        name="write_file",
        description="写入文件内容。path 是相对于 run 目录的相对路径。",
        args_schema=WriteFileInput,
        infer_schema=False,
    )


def make_list_dir(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> CrewStructuredTool:
    """列出目录内容。"""

    def _list_dir(path: str) -> str:
        items = fs_mod.list_dir(base, path)
        out = "\n".join(items) if items else "(空目录)"
        _append_tool_log(instrument_log, "list_dir", {"path": path}, out)
        return out

    return CrewStructuredTool.from_function(
        _list_dir,
        name="list_dir",
        description="列出目录中的文件名。",
        args_schema=ListDirInput,
        infer_schema=False,
    )


def make_grep_search(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> CrewStructuredTool:
    """正则搜索文件内容。"""

    def _grep_search(pattern: str, path: str = "") -> str:
        results = fs_mod.grep_search(base, pattern, path)
        if not results:
            out = "未找到匹配"
        else:
            lines = [f"{rel}:{ln}: {txt}" for rel, ln, txt in results[:30]]
            out = "\n".join(lines)
        _append_tool_log(
            instrument_log,
            "grep_search",
            {"pattern": pattern, "path": path},
            out,
        )
        return out

    return CrewStructuredTool.from_function(
        _grep_search,
        name="grep_search",
        description="在目录下搜索 pattern（正则）。path 为空表示整库；返回匹配行。",
        args_schema=GrepSearchInput,
        infer_schema=False,
    )


def make_glob_search(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> CrewStructuredTool:
    """glob 模式匹配文件。"""

    def _glob_search(pattern: str, path: str = "") -> str:
        results = fs_mod.glob_search(base, pattern, path)
        if not results:
            out = "未找到匹配"
        else:
            out = "\n".join(results[:30])
        _append_tool_log(
            instrument_log,
            "glob_search",
            {"pattern": pattern, "path": path},
            out,
        )
        return out

    return CrewStructuredTool.from_function(
        _glob_search,
        name="glob_search",
        description="在目录下匹配 pattern（glob）。返回文件路径列表。",
        args_schema=GlobSearchInput,
        infer_schema=False,
    )


def make_chroma_search(
    base: Path,
    collection_getter: Callable[[Path], Any | None],
    collection_name: str,
    instrument_log: list[dict[str, Any]] | None = None,
) -> CrewStructuredTool:
    """ChromaDB 语义搜索。"""

    def _chroma_search(query: str, n_results: int = 5) -> str:
        results = (
            chroma_mod.search_world(base, query, n_results)
            if collection_name == "world"
            else chroma_mod.search_ideas(base, query, n_results)
        )
        if not results:
            out = "未找到相关结果"
        else:
            parts = []
            for i, r in enumerate(results, 1):
                meta = r.get("metadata") or {}
                doc = r.get("document", "")
                kind = meta.get("kind", "unknown")
                ref_id = meta.get("ref_id", meta.get("agent_id", ""))
                parts.append(f"[{i}] kind={kind} id={ref_id}\n{doc[:300]}")
            out = "\n\n".join(parts)
        _append_tool_log(
            instrument_log,
            "chroma_search",
            {"query": query, "n_results": n_results, "collection": collection_name},
            out,
        )
        return out

    return CrewStructuredTool.from_function(
        _chroma_search,
        name="chroma_search",
        description=f"在 {collection_name} 集合中语义搜索。",
        args_schema=ChromaSearchInput,
        infer_schema=False,
    )


def npc_s_tools(base: Path, agent_id: str, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """S 类 NPC 工具集：只能访问自己的数据。"""
    _ = agent_id
    return [
        make_read_file(base, instrument_log),
        make_write_file(base, instrument_log),
        make_list_dir(base, instrument_log),
        make_grep_search(base, instrument_log),
    ]


def npc_a_tools(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """A 类 NPC 工具集。"""
    return [
        make_read_file(base, instrument_log),
        make_list_dir(base, instrument_log),
        make_glob_search(base, instrument_log),
        make_chroma_search(base, chroma_mod.get_world_collection, "world", instrument_log),
    ]


def npc_b_tools(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """B/C 类 NPC 工具集：最小。"""
    return [
        make_read_file(base, instrument_log),
        make_list_dir(base, instrument_log),
    ]


def director_tools(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """Director 工具集。"""
    return [
        make_read_file(base, instrument_log),
        make_write_file(base, instrument_log),
        make_list_dir(base, instrument_log),
        make_grep_search(base, instrument_log),
        make_glob_search(base, instrument_log),
        make_chroma_search(base, chroma_mod.get_world_collection, "world", instrument_log),
    ]


def gm_tools(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """GM 工具集。"""
    return [
        make_read_file(base, instrument_log),
        make_write_file(base, instrument_log),
        make_list_dir(base, instrument_log),
        make_chroma_search(base, chroma_mod.get_world_collection, "world", instrument_log),
    ]


def rumor_tools(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """Rumor 工具集。"""
    return [
        make_read_file(base, instrument_log),
        make_write_file(base, instrument_log),
        make_list_dir(base, instrument_log),
    ]


def summarizer_tools(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """Summarizer 工具集。"""
    return [
        make_read_file(base, instrument_log),
        make_write_file(base, instrument_log),
        make_list_dir(base, instrument_log),
        make_grep_search(base, instrument_log),
        make_chroma_search(base, chroma_mod.get_world_collection, "world", instrument_log),
    ]


def initializer_tools(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """Initializer 工具集。"""
    return [
        make_read_file(base, instrument_log),
        make_chroma_search(base, chroma_mod.get_ideas_collection, "ideas", instrument_log),
    ]


def make_list_chronicle_files(
    base: Path,
    *,
    max_files: int = 800,
    instrument_log: list[dict[str, Any]] | None = None,
) -> CrewStructuredTool:
    """递归列出 chronicle/ 下所有相对路径（有上限）。"""

    def list_chronicle_files() -> str:
        root = base / "chronicle"
        if not root.is_dir():
            out = "chronicle/ 目录不存在（尚无编年史数据）。"
            _append_tool_log(instrument_log, "list_chronicle_files", {}, out)
            return out
        files = fs_mod.list_dir_recursive(base, "chronicle")
        if not files:
            out = "(chronicle 下无文件)"
        else:
            total = len(files)
            if total > max_files:
                head = files[:max_files]
                out = (
                    "\n".join(head)
                    + f"\n\n…（共 {total} 个文件，仅列出前 {max_files} 个；请用 grep_search / glob_search 缩小范围）"
                )
            else:
                out = "\n".join(files)
        _append_tool_log(instrument_log, "list_chronicle_files", {}, out)
        return out

    return CrewStructuredTool.from_function(
        list_chronicle_files,
        name="list_chronicle_files",
        description="递归列出 chronicle/ 下所有文件的相对路径。",
        args_schema=ListChronicleFilesInput,
        infer_schema=False,
    )


def probe_tools(base: Path, instrument_log: list[dict[str, Any]] | None = None) -> list[CrewStructuredTool]:
    """探针：只读；仅磁盘（list/grep/glob/read_file），不提供语义检索。"""
    return [
        make_read_file(base, instrument_log),
        make_list_dir(base, instrument_log),
        make_list_chronicle_files(base, instrument_log=instrument_log),
        make_grep_search(base, instrument_log),
        make_glob_search(base, instrument_log),
    ]
