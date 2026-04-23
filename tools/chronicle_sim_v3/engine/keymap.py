"""key ↔ Path 双向映射（RFC v3-engine.md §5.6）。

设计原则：
- 节点只见 key（如 `chronicle.events:week=3`），从不拼路径
- 所有持久化 IO 走 `key_to_path` / `path_to_key`
- key 形态：
  - 静态：`world.setting`
  - 单参数：`world.agent:<aid>`
  - 多参数：`chronicle.beliefs:week=3,agent_id=npc_guan`
  - 通配：`chronicle.events:week=*`

`<run>` 由调用方传入；本模块不做 IO，只做纯字符串 ↔ Path 转换。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

from tools.chronicle_sim_v3.engine.errors import ValidationError


# --- key 解析 ---


_BASE_RE = re.compile(r"^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)(?::(.*))?$")


def parse_key(key: str) -> tuple[str, dict[str, str]]:
    """解析 key 为 (base, params)。

    - `world.agent:npc_guan` → ('world.agent', {'_': 'npc_guan'})
    - `chronicle.events:week=3` → ('chronicle.events', {'week': '3'})
    - `chronicle.beliefs:week=3,agent_id=A` → ('chronicle.beliefs',
                                              {'week': '3', 'agent_id': 'A'})
    - `world.setting` → ('world.setting', {})
    """
    m = _BASE_RE.match(key)
    if not m:
        raise ValidationError(f"非法 key 格式: {key!r}")
    base, raw = m.group(1), m.group(2)
    if not raw:
        return base, {}
    params: dict[str, str] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            k, _, v = part.partition("=")
            params[k.strip()] = v.strip()
        else:
            # 单参形式：world.agent:npc_guan → 用 '_' 占位
            params["_"] = part
    return base, params


def _week_dir(week: int | str) -> str:
    return f"week_{int(week):03d}"


# 注册：base → handler；handler 返回 Path（相对 run_dir）。
# 列出型 key（如 world.agents）返回的是其『基准目录』；scan_keys 用此目录扩展。

_LISTING_BASES: set[str] = set()  # 标记『列表型』key（一对多）


def _path_world_setting(_: dict[str, str]) -> Path:
    return Path("world/setting.json")


def _path_world_pillars(_: dict[str, str]) -> Path:
    return Path("world/pillars.json")


def _path_world_anchors(_: dict[str, str]) -> Path:
    return Path("world/anchors.json")


def _path_world_edges(_: dict[str, str]) -> Path:
    return Path("world/edges.json")


def _path_world_agents(_: dict[str, str]) -> Path:
    return Path("world/agents")


_LISTING_BASES.add("world.agents")


def _path_world_agent(p: dict[str, str]) -> Path:
    aid = p.get("_") or p.get("id") or p.get("agent_id")
    if not aid:
        raise ValidationError("world.agent 需要单参 <aid> 或 id=<aid>")
    return Path(f"world/agents/{aid}.json")


def _path_world_factions(_: dict[str, str]) -> Path:
    return Path("world/factions")


_LISTING_BASES.add("world.factions")


def _path_world_faction(p: dict[str, str]) -> Path:
    fid = p.get("_") or p.get("id")
    if not fid:
        raise ValidationError("world.faction 需要单参 <fid> 或 id=<fid>")
    return Path(f"world/factions/{fid}.json")


def _path_world_locations(_: dict[str, str]) -> Path:
    return Path("world/locations")


_LISTING_BASES.add("world.locations")


def _path_world_location(p: dict[str, str]) -> Path:
    lid = p.get("_") or p.get("id")
    if not lid:
        raise ValidationError("world.location 需要单参 <lid> 或 id=<lid>")
    return Path(f"world/locations/{lid}.json")


# chronicle


def _path_chronicle_events(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/events")


_LISTING_BASES.add("chronicle.events")


def _path_chronicle_event(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/events/{p['id']}.json")


def _path_chronicle_intents(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/intents")


_LISTING_BASES.add("chronicle.intents")


def _path_chronicle_intent(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/intents/{p['id']}.json")


def _path_chronicle_drafts(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/drafts")


_LISTING_BASES.add("chronicle.drafts")


def _path_chronicle_draft(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/drafts/{p['id']}.json")


def _path_chronicle_rumors(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/rumors.json")


def _path_chronicle_summary(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/summary.md")


def _path_chronicle_observation(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/observation.json")


def _path_chronicle_public_digest(p: dict[str, str]) -> Path:
    return Path(f"chronicle/{_week_dir(p['week'])}/public_digest.json")


def _path_chronicle_beliefs(p: dict[str, str]) -> Path:
    return Path(
        f"chronicle/{_week_dir(p['week'])}/beliefs/{p['agent_id']}.json"
    )


def _path_chronicle_intent_outcome(p: dict[str, str]) -> Path:
    return Path(
        f"chronicle/{_week_dir(p['week'])}/intent_outcomes/{p['agent_id']}.json"
    )


def _path_chronicle_month(p: dict[str, str]) -> Path:
    return Path(f"chronicle/month_{int(p['n']):02d}.md")


def _path_chronicle_weeks(_: dict[str, str]) -> Path:
    return Path("chronicle")


_LISTING_BASES.add("chronicle.weeks")


# ideas / config


def _path_ideas_list(_: dict[str, str]) -> Path:
    return Path("ideas/manifest.json")


def _path_ideas_entry(p: dict[str, str]) -> Path:
    iid = p.get("id") or p.get("_")
    if not iid:
        raise ValidationError("ideas.entry 需要 id=<x>")
    return Path(f"ideas/{iid}.md")


def _path_config_llm(_: dict[str, str]) -> Path:
    return Path("config/llm.yaml")


def _path_config_cook(_: dict[str, str]) -> Path:
    return Path("config/cook.yaml")


def _path_config_providers(_: dict[str, str]) -> Path:
    return Path("config/providers.yaml")


def _path_config_agents(_: dict[str, str]) -> Path:
    return Path("config/agents.yaml")


_HANDLERS: dict[str, callable] = {
    "world.setting": _path_world_setting,
    "world.pillars": _path_world_pillars,
    "world.anchors": _path_world_anchors,
    "world.edges": _path_world_edges,
    "world.agents": _path_world_agents,
    "world.agent": _path_world_agent,
    "world.factions": _path_world_factions,
    "world.faction": _path_world_faction,
    "world.locations": _path_world_locations,
    "world.location": _path_world_location,
    "chronicle.events": _path_chronicle_events,
    "chronicle.event": _path_chronicle_event,
    "chronicle.intents": _path_chronicle_intents,
    "chronicle.intent": _path_chronicle_intent,
    "chronicle.drafts": _path_chronicle_drafts,
    "chronicle.draft": _path_chronicle_draft,
    "chronicle.rumors": _path_chronicle_rumors,
    "chronicle.summary": _path_chronicle_summary,
    "chronicle.observation": _path_chronicle_observation,
    "chronicle.public_digest": _path_chronicle_public_digest,
    "chronicle.beliefs": _path_chronicle_beliefs,
    "chronicle.intent_outcome": _path_chronicle_intent_outcome,
    "chronicle.month": _path_chronicle_month,
    "chronicle.weeks": _path_chronicle_weeks,
    "ideas.list": _path_ideas_list,
    "ideas.entry": _path_ideas_entry,
    "config.llm": _path_config_llm,
    "config.cook": _path_config_cook,
    "config.providers": _path_config_providers,
    "config.agents": _path_config_agents,
}


def is_listing_key(key: str) -> bool:
    base, _ = parse_key(key)
    return base in _LISTING_BASES


def key_to_path(key: str, run_dir: Path) -> Path:
    """key → 绝对路径。列表型 key 返回的是基准目录，单条型返回具体文件。"""
    base, params = parse_key(key)
    h = _HANDLERS.get(base)
    if h is None:
        raise ValidationError(f"未知 key base: {base!r} in {key!r}")
    rel = h(params)
    return (Path(run_dir) / rel).resolve()


def is_text_key(key: str) -> bool:
    """summary.md / month.md / ideas.entry → text；其余 json。"""
    base, _ = parse_key(key)
    return base in {"chronicle.summary", "chronicle.month", "ideas.entry"}


def scan_keys(prefix: str, run_dir: Path) -> list[str]:
    """扫描磁盘列出某个『列表型 base』下所有具体 key。

    支持：
    - `world.agents` → [`world.agent:npc_guan`, ...]
    - `world.factions` / `world.locations` 同
    - `chronicle.events:week=3` → [`chronicle.event:week=3,id=X`, ...]
    - `chronicle.intents:week=3` / `chronicle.drafts:week=3` 同
    - `chronicle.weeks` → [`chronicle.events:week=N`, ...] 已知周列表（这里返回 week 数）
    """
    base, params = parse_key(prefix)
    run_dir = Path(run_dir)
    if base == "world.agents":
        d = run_dir / "world" / "agents"
        if not d.is_dir():
            return []
        return sorted(f"world.agent:{p.stem}" for p in d.glob("*.json"))
    if base == "world.factions":
        d = run_dir / "world" / "factions"
        if not d.is_dir():
            return []
        return sorted(f"world.faction:{p.stem}" for p in d.glob("*.json"))
    if base == "world.locations":
        d = run_dir / "world" / "locations"
        if not d.is_dir():
            return []
        return sorted(f"world.location:{p.stem}" for p in d.glob("*.json"))
    if base == "chronicle.events":
        week = params.get("week")
        if week is None:
            raise ValidationError("chronicle.events scan 需要 week 参数")
        d = run_dir / "chronicle" / _week_dir(week) / "events"
        if not d.is_dir():
            return []
        return sorted(
            f"chronicle.event:week={int(week)},id={p.stem}" for p in d.glob("*.json")
        )
    if base == "chronicle.intents":
        week = params.get("week")
        d = run_dir / "chronicle" / _week_dir(week) / "intents"
        if not d.is_dir():
            return []
        return sorted(
            f"chronicle.intent:week={int(week)},id={p.stem}" for p in d.glob("*.json")
        )
    if base == "chronicle.drafts":
        week = params.get("week")
        d = run_dir / "chronicle" / _week_dir(week) / "drafts"
        if not d.is_dir():
            return []
        return sorted(
            f"chronicle.draft:week={int(week)},id={p.stem}" for p in d.glob("*.json")
        )
    if base == "chronicle.weeks":
        d = run_dir / "chronicle"
        if not d.is_dir():
            return []
        out: list[str] = []
        for p in sorted(d.glob("week_*")):
            try:
                n = int(p.name.split("_")[1])
                out.append(f"week={n}")
            except (IndexError, ValueError):
                continue
        return out
    raise ValidationError(f"scan_keys 不支持: {prefix!r}")


_PATH_HANDLERS: list[tuple[re.Pattern, callable]] = [
    (re.compile(r"^world/setting\.json$"), lambda m: "world.setting"),
    (re.compile(r"^world/pillars\.json$"), lambda m: "world.pillars"),
    (re.compile(r"^world/anchors\.json$"), lambda m: "world.anchors"),
    (re.compile(r"^world/edges\.json$"), lambda m: "world.edges"),
    (re.compile(r"^world/agents/(?P<aid>[^/]+)\.json$"),
     lambda m: f"world.agent:{m.group('aid')}"),
    (re.compile(r"^world/factions/(?P<fid>[^/]+)\.json$"),
     lambda m: f"world.faction:{m.group('fid')}"),
    (re.compile(r"^world/locations/(?P<lid>[^/]+)\.json$"),
     lambda m: f"world.location:{m.group('lid')}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/events/(?P<id>[^/]+)\.json$"),
     lambda m: f"chronicle.event:week={int(m.group('w'))},id={m.group('id')}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/intents/(?P<id>[^/]+)\.json$"),
     lambda m: f"chronicle.intent:week={int(m.group('w'))},id={m.group('id')}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/drafts/(?P<id>[^/]+)\.json$"),
     lambda m: f"chronicle.draft:week={int(m.group('w'))},id={m.group('id')}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/rumors\.json$"),
     lambda m: f"chronicle.rumors:week={int(m.group('w'))}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/summary\.md$"),
     lambda m: f"chronicle.summary:week={int(m.group('w'))}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/observation\.json$"),
     lambda m: f"chronicle.observation:week={int(m.group('w'))}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/public_digest\.json$"),
     lambda m: f"chronicle.public_digest:week={int(m.group('w'))}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/beliefs/(?P<aid>[^/]+)\.json$"),
     lambda m: f"chronicle.beliefs:week={int(m.group('w'))},agent_id={m.group('aid')}"),
    (re.compile(r"^chronicle/week_(?P<w>\d+)/intent_outcomes/(?P<aid>[^/]+)\.json$"),
     lambda m: f"chronicle.intent_outcome:week={int(m.group('w'))},agent_id={m.group('aid')}"),
    (re.compile(r"^chronicle/month_(?P<n>\d+)\.md$"),
     lambda m: f"chronicle.month:n={int(m.group('n'))}"),
    (re.compile(r"^ideas/manifest\.json$"), lambda m: "ideas.list"),
    (re.compile(r"^ideas/(?P<iid>[^/]+)\.md$"),
     lambda m: f"ideas.entry:id={m.group('iid')}"),
    (re.compile(r"^config/llm\.yaml$"), lambda m: "config.llm"),
    (re.compile(r"^config/cook\.yaml$"), lambda m: "config.cook"),
    (re.compile(r"^config/providers\.yaml$"), lambda m: "config.providers"),
    (re.compile(r"^config/agents\.yaml$"), lambda m: "config.agents"),
]


def path_to_key(path: Path, run_dir: Path) -> str:
    """绝对路径 → key（path 必须在 run_dir 内）。"""
    p = Path(path).resolve()
    rd = Path(run_dir).resolve()
    try:
        rel = p.relative_to(rd).as_posix()
    except ValueError as e:
        raise ValidationError(f"path 不在 run_dir 内: {p}") from e
    for pat, fn in _PATH_HANDLERS:
        m = pat.match(rel)
        if m:
            return fn(m)
    raise ValidationError(f"path 无对应 key: {rel}")
