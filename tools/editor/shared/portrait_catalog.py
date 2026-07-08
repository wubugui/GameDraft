"""对话头像（立绘集）目录扫描：供场景编辑器（NPC.portraitSlug）与图对话编辑器（行节点 portrait）共用。

磁盘约定（与运行时 DialogueUI/生产管线一致）：
  public/resources/runtime/images/dialogue_portraits/<slug>/<slug>_<emotion>.png
  可选 <slug>_portrait_meta.json 携带表情中文名（expressions[].slug/label）。
"""
from __future__ import annotations

import json
from pathlib import Path

# 与生产管线约定的 9 表情（meta 缺失时的回落顺序与中文名）
PORTRAIT_EMOTIONS_FALLBACK: list[tuple[str, str]] = [
    ("calm", "平静"),
    ("angry", "愤怒"),
    ("fear", "惊恐"),
    ("cry", "哭"),
    ("sad", "悲伤"),
    ("empty_eyes", "眼神空洞"),
    ("smirk", "嬉笑"),
    ("laugh", "大笑"),
    ("zombified", "僵尸化"),
]


def portrait_sets_root(project_root: Path) -> Path:
    return project_root / "public" / "resources" / "runtime" / "images" / "dialogue_portraits"


def load_portrait_sets(project_root: Path) -> list[str]:
    """列出可选立绘集 slug：dialogue_portraits/ 下含 <slug>_<emotion>.png 的子目录名。"""
    root = portrait_sets_root(project_root)
    if not root.is_dir():
        return []
    out: list[str] = []
    for d in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not d.is_dir():
            continue
        if any(d.glob(f"{d.name}_*.png")):
            out.append(d.name)
    return out


def load_portrait_emotions(project_root: Path, slug: str) -> list[tuple[str, str]]:
    """该立绘集可选表情 (emotion, 中文label)。优先读 <slug>_portrait_meta.json 的
    expressions（含策划可读中文名），回落到固定 9 表情；两路都只保留磁盘上真实存在的图。"""
    root = portrait_sets_root(project_root) / slug
    if not root.is_dir():
        return []
    pairs: list[tuple[str, str]] = []
    meta_p = root / f"{slug}_portrait_meta.json"
    if meta_p.is_file():
        try:
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
            for e in meta.get("expressions") or []:
                if isinstance(e, dict) and isinstance(e.get("slug"), str):
                    pairs.append((e["slug"], str(e.get("label") or e["slug"])))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            pairs = []
    if not pairs:
        pairs = list(PORTRAIT_EMOTIONS_FALLBACK)
    return [(emo, label) for emo, label in pairs if (root / f"{slug}_{emo}.png").is_file()]


def portrait_image_path(project_root: Path, slug: str, emotion: str) -> Path:
    """与运行时 DialogueUI.portraitPath 同构的磁盘路径。"""
    return portrait_sets_root(project_root) / slug / f"{slug}_{emotion}.png"


def npc_portrait_slug_index(project_root: Path) -> dict[str, str]:
    """npcId → portraitSlug：扫描全部场景 JSON 的 npcs[]；同 id 多场景先见非空者优先。"""
    out: dict[str, str] = {}
    scenes = project_root / "public" / "assets" / "scenes"
    if not scenes.is_dir():
        return out
    for p in sorted(scenes.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            continue
        for npc in data.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            nid = str(npc.get("id") or "").strip()
            slug = str(npc.get("portraitSlug") or "").strip()
            if nid and slug and nid not in out:
                out[nid] = slug
    return out


def graph_context_portrait_slug(project_root: Path, graph_id: str) -> str:
    """「跟随说话NPC」在编辑器里的预览解析：找 dialogueGraphId == graph_id 的场景 NPC，
    唯一确定 portraitSlug 时返回之；找不到或多 NPC 歧义（不同 slug）返回空串。"""
    gid = (graph_id or "").strip()
    if not gid:
        return ""
    slugs: set[str] = set()
    scenes = project_root / "public" / "assets" / "scenes"
    if not scenes.is_dir():
        return ""
    for p in sorted(scenes.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            continue
        for npc in data.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            if str(npc.get("dialogueGraphId") or "").strip() != gid:
                continue
            slug = str(npc.get("portraitSlug") or "").strip()
            if slug:
                slugs.add(slug)
    return slugs.pop() if len(slugs) == 1 else ""


def player_default_portrait_slug(project_root: Path) -> str:
    """主角默认装扮配置的立绘集（编辑器预览用）：game_config.playerAvatar.portraitSlug
    显式值优先，缺省按 animManifest 动画包目录名同名推导，最后回落 player_anim。
    运行时真值由「当前生效装扮配置」决定（setPlayerAvatar 可切），此处仅作静态预览。"""
    cfg = project_root / "public" / "assets" / "data" / "game_config.json"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
        av = data.get("playerAvatar") or {}
        slug = str(av.get("portraitSlug") or "").strip()
        if slug:
            return slug
        manifest = str(av.get("animManifest") or "").strip()
        if manifest:
            import re as _re
            m = _re.search(r"/animation/([^/]+)/anim\.json", manifest)
            if m:
                return m.group(1)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        pass
    return "player_anim"
