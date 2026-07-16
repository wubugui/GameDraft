"""跨文件改名引擎(LSP textDocument/rename 的实现核)。

设计取舍(宁可拒绝,不错改):

- **只做"span 级精确替换"**:用 json_locator 拿到每个引用 token 的字节 span,
  原地替换字符串内容——不重写任何文件、不碰格式,天然满足编辑器往返契约。
  产出 LSP WorkspaceEdit(编辑器内应用、可 Cmd+Z 撤销),本模块自己不写盘。
- **安全宇宙白名单**:全局唯一且引用语义单纯的 id 才允许(物品/任务/规矩/遭遇/
  商店/长按/信号Cue/文档揭示/气味/位面/flag静态键/档案条目/scenario/信号)。
  实体类(npc/hotspot/zone/spawn/场景)有场景限定歧义与 [tag:npc:] 文本引用,
  必须走 entity_refactor 引擎(编辑器「重构」菜单)——这里直接拒绝并指路。
  场景/对话图/小游戏 id 与文件名耦合、叙事图 id 有派生信号字符串,同样拒绝。
- **文本键黑名单**:值恰好等于 id 的展示文案(itemName/text/name…)不改,
  防"短中文 id 撞台词"。
- 命中 [tag:…] 段内引用时整体放弃(转义偏移复杂,v1 不冒险)。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

try:
    from id_universes import UniverseData
    from json_locator import JsonLocator
    from refs import find_refs
except ImportError:
    from .id_universes import UniverseData
    from .json_locator import JsonLocator
    from .refs import find_refs

# 允许改名的宇宙(全局唯一、无文件名耦合、无派生字符串)
RENAMEABLE_UNIVERSES = {
    "items", "quests", "rules", "fragments", "encounters", "shops",
    "pressure_holds", "signal_cues", "documents", "smells", "planes",
    "flag_static_keys", "archive_entries", "scenarios", "narrative_signals",
    "bgm", "ambient", "sfx", "cutscenes",
}

# 拒绝时的指路文案(kind → 原因)
_REJECT_REASONS = [
    ({"actors", "emote_subjects", "scene_entities", "hotspots", "zones", "spawn_points"},
     "实体/出生点改名有场景限定歧义与 [tag:npc:] 文本引用,请走编辑器「重构」菜单(entity_refactor 引擎)"),
    ({"scenes"}, "场景 id 与文件名耦合(id==文件名契约),不支持在 IDE 里改"),
    ({"dialogue_graphs"}, "对话图 id 与文件组织耦合,且被叙事黑盒引用,不支持在 IDE 里改"),
    ({"narrative_graph_ids"}, "叙事图 id 有派生广播信号字符串(state:<图id>:<末态>),不支持自动改"),
    ({"water_minigames", "sugar_wheel_minigames", "paper_craft_minigames"},
     "小游戏实例 id 与 index.json/文件名耦合,不支持自动改"),
]

# 值恰好等于 id 的展示文案键——不视为引用(短中文 id 可能撞台词)
_TEXT_KEY_BLOCKLIST = {
    "text", "name", "label", "title", "description", "content", "prompt",
    "narrative", "annotation", "itemName", "speaker", "emote", "note",
}

_SAFE_NEW_NAME = re.compile(r'^[^"\\\x00-\x1f]+$')


@dataclass
class RenameOutcome:
    ok: bool
    message: str = ""
    # file(相对路径) → [(start_offset, end_offset, new_text)],offset 为原文本字节内区间
    edits: dict[str, list[tuple[int, int, str]]] | None = None
    ref_count: int = 0


def plan_rename(
    root: Path,
    ud: UniverseData,
    old: str,
    new: str,
    read_text=None,
    locator_of=None,
) -> RenameOutcome:
    """产出改名编辑计划(不写盘)。locator_of(path)->JsonLocator 可注入以复用缓存。"""
    old = old.strip()
    new = new.strip()
    if not old or not new or old == new:
        return RenameOutcome(False, "新旧名相同或为空")
    if not _SAFE_NEW_NAME.match(new):
        return RenameOutcome(False, "新名含引号/反斜杠/控制字符,拒绝")

    universes = {name for name, ids in ud.ids.items() if old in ids}
    if not universes:
        return RenameOutcome(False, f"「{old}」不属于任何已知 id 宇宙,无法安全改名(自由文本请手改)")
    for kinds, reason in _REJECT_REASONS:
        if universes & kinds:
            return RenameOutcome(False, reason)
    if not universes & RENAMEABLE_UNIVERSES:
        return RenameOutcome(False, f"宇宙 {sorted(universes)} 未列入可改名白名单")
    renameable_hits = universes & RENAMEABLE_UNIVERSES
    if len(renameable_hits) > 1:
        return RenameOutcome(
            False,
            f"「{old}」同时是 {sorted(renameable_hits)} 多个宇宙的 id,"
            "整串替换会跨宇宙误伤,拒绝(请先消除同名)",
        )
    # 新名不得与目标宇宙现有 id 撞车
    for uni in universes & RENAMEABLE_UNIVERSES:
        if new in ud.ids.get(uni, []):
            return RenameOutcome(False, f"「{new}」在宇宙 {uni} 已存在,改名会造成撞车")

    refs = find_refs(root, old, read_text=read_text)
    if not refs:
        return RenameOutcome(False, "找不到任何引用")
    if any(r.kind == "tag" for r in refs):
        return RenameOutcome(False, "存在 [tag:…] 文本内引用,v1 不自动改(转义偏移风险),请先手工处理 tag 再试")

    per_file: dict[str, list[tuple[int, int, str]]] = {}
    skipped_text = 0
    for r in refs:
        key = r.pointer.rsplit("/", 1)[-1]
        # kind==value 的引用按黑名单排除展示文案;kind==key(字典键定义)总是改
        if r.kind == "value":
            pkey = key if not key.isdigit() else r.pointer.rsplit("/", 2)[-2]
            if pkey in _TEXT_KEY_BLOCKLIST:
                skipped_text += 1
                continue
        path = root / r.file
        loc = locator_of(path) if locator_of else JsonLocator(
            (read_text or (lambda p: p.read_text(encoding="utf-8")))(path)
        )
        span = (loc.key_span if r.kind == "key" else loc.value_span).get(r.pointer)
        if span is None:
            return RenameOutcome(False, f"{r.file} 的 {r.pointer} 定位失败,整体放弃")
        start, end = span
        # 字符串 token 的 span 含引号;替换引号内内容
        per_file.setdefault(r.file, []).append((start + 1, end - 1, new))

    n = sum(len(v) for v in per_file.values())
    msg = f"将改写 {n} 处引用({len(per_file)} 个文件)"
    if skipped_text:
        msg += f";另有 {skipped_text} 处疑似展示文案未改(键在文本黑名单)"
    return RenameOutcome(True, msg, per_file, n)
