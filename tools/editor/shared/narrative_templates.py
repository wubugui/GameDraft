"""叙事状态机模板（archetype）引擎：编辑器专用，运行时永不加载。

一个模板 = 一张被标记为模板的叙事作曲骨架 + 一组带类型的参数声明。作曲/quest/对话桩里
用 ``{{name}}`` 占位符标洞；盖章（stamp）= 把每个占位符替换成策划填的真值，产出一份**真**作曲
（并入 narrative_graphs）、一条镜像 quest（并入 quests）、以及可选的空白对话图桩文件。

为什么单独一个文件（``public/assets/data/narrative_templates.json``）而不是塞进
narrative_graphs.json：运行时 ``compileNarrativeGraphs`` 会把 ``compositions[]`` 里每一条都当活图
注册进状态机；带 ``{{taskId}}`` 的模板不是能跑的图，一旦被注册就会污染运行时、strict 校验也会把
``{{...}}`` 当坏引用报一堆。物理隔离 = 运行时与内容校验器永远看不到占位符。

信号命名铁律：模板内所有内部信号写成 ``{{taskId}}__accepted`` 形式；盖章后 emit 端（对话桩的
emitNarrativeSignal 动作）与 listen 端（作曲 transition.signal）由同一次替换生成，**天然不可能对不上**。

核心函数：
- ``normalize_templates_file`` —— 容错归一模板文件（编辑器往返保真的输入清洗）。
- ``iter_placeholders`` / ``substitute`` —— 占位符扫描 / 深度替换（纯 JSON 变换）。
- ``validate_template`` / ``validate_templates_file`` —— 占位符感知校验（声明/使用/未知）。
- ``extract_template`` —— 从一张现成作曲反抽出模板（把 sample 值换成 ``{{name}}``）。
- ``stamp_template`` —— 盖章：替换 + 撞名检测 + 产出真数据 + 对话桩规格。
"""
from __future__ import annotations

import copy
import re
from typing import Any

SCHEMA_VERSION = 1

# 占位符 token：``{{ name }}``，name 为标识符（字母/数字/下划线/中文，首字符非数字）。
# 字符集必须与参数名校验（validate_template 的 template.param.name）保持同一口径：
# 表单里起得出的名字，替换引擎就必须认得——否则抽取造出的洞盖章时填不上（历史 bug）。
PLACEHOLDER_NAME_RE = re.compile(r"^[A-Za-z_一-鿿][A-Za-z0-9_一-鿿]*$")
PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_一-鿿][A-Za-z0-9_一-鿿]*)\s*\}\}")

# 参数类型 → web 侧选择器 kind（IdRefSelector/枚举下拉/自由文本）。
# identifier/text 用自由输入；其余用带类型选择器（值域受约束，禁手打）。
PARAM_TYPES: dict[str, str] = {
    "identifier": "自由标识符（信号/图/作曲前缀，字母/数字/下划线/中文）",
    "text": "自由文案（标题/描述/台词）",
    "number": "数字",
    "boolean": "布尔",
    "planeRef": "位面引用",
    "dialogueRef": "对话图引用",
    "minigameRef": "小游戏引用",
    "sceneRef": "场景引用",
    "npcRef": "场景 NPC 引用",
    "hotspotRef": "场景热点引用",
    "zoneRef": "场景 Zone 引用",
    "questRef": "任务引用",
    "cutsceneRef": "过场引用",
    "scenarioRef": "Scenario 引用",
}

# 引用型参数 → authoring catalog 里的候选字段名（web 侧据此挑选择器数据源）。
REF_PARAM_CATALOG_KEY: dict[str, str] = {
    "planeRef": "planeIds",
    "dialogueRef": "dialogueGraphIds",
    "minigameRef": "minigameIds",
    "sceneRef": "sceneIds",
    "npcRef": "sceneNpcRefs",
    "hotspotRef": "sceneHotspotRefs",
    "zoneRef": "zoneRefs",
    "questRef": "questIds",
    "cutsceneRef": "cutsceneIds",
    "scenarioRef": "scenarioIds",
}

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_一-鿿][\w一-鿿]*$")


# --------------------------------------------------------------------------- #
# 归一 / 清洗
# --------------------------------------------------------------------------- #
def _as_str(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def normalize_param(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    name = _as_str(raw.get("name"))
    if not name:
        return None
    ptype = _as_str(raw.get("type")) or "text"
    if ptype not in PARAM_TYPES:
        ptype = "text"
    out: dict[str, Any] = {"name": name, "type": ptype}
    label = _as_str(raw.get("label"))
    if label:
        out["label"] = label
    if raw.get("required"):
        out["required"] = True
    if "default" in raw and raw.get("default") not in (None, ""):
        out["default"] = raw["default"]
    note = _as_str(raw.get("note"))
    if note:
        out["note"] = note
    return out


def normalize_template(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    tid = _as_str(raw.get("id"))
    if not tid:
        return None
    out: dict[str, Any] = {"id": tid}
    label = _as_str(raw.get("label"))
    if label:
        out["label"] = label
    desc = _as_str(raw.get("description"))
    if desc:
        out["description"] = desc
    params: list[dict[str, Any]] = []
    seen: set[str] = set()
    for p in raw.get("params") or []:
        np = normalize_param(p)
        if np and np["name"] not in seen:
            seen.add(np["name"])
            params.append(np)
    out["params"] = params
    signals = raw.get("signals")
    if isinstance(signals, list) and signals:
        norm_sigs: list[dict[str, Any]] = []
        for s in signals:
            if not isinstance(s, dict):
                continue
            sid = _as_str(s.get("id"))
            if not sid:
                continue
            row: dict[str, Any] = {"id": sid}
            slabel = _as_str(s.get("label"))
            if slabel:
                row["label"] = slabel
            snotes = _as_str(s.get("notes"))
            if snotes:
                row["notes"] = snotes
            norm_sigs.append(row)
        if norm_sigs:
            out["signals"] = norm_sigs
    comp = raw.get("composition")
    out["composition"] = comp if isinstance(comp, dict) else {}
    quest = raw.get("quest")
    if isinstance(quest, dict) and quest:
        out["quest"] = quest
    stubs = raw.get("dialogueStubs")
    if isinstance(stubs, list) and stubs:
        norm_stubs: list[dict[str, Any]] = []
        for st in stubs:
            if not isinstance(st, dict):
                continue
            gid = _as_str(st.get("id"))
            if not gid:
                continue
            row = {"id": gid}
            title = _as_str(st.get("title"))
            if title:
                row["title"] = title
            emit = _as_str(st.get("emitSignal"))
            if emit:
                row["emitSignal"] = emit
            norm_stubs.append(row)
        if norm_stubs:
            out["dialogueStubs"] = norm_stubs
    req = raw.get("requiredEntities")
    if isinstance(req, list) and req:
        norm_req: list[dict[str, Any]] = []
        for r in req:
            if not isinstance(r, dict):
                continue
            kind = _as_str(r.get("kind"))
            note = _as_str(r.get("note"))
            if not kind and not note:
                continue
            row = {}
            if kind:
                row["kind"] = kind
            if note:
                row["note"] = note
            norm_req.append(row)
        if norm_req:
            out["requiredEntities"] = norm_req
    return out


def normalize_templates_file(value: Any) -> dict[str, Any]:
    """容错归一为 ``{schemaVersion, templates:[...]}``（缺失/损坏 → 空表）。"""
    templates_raw: Any = []
    if isinstance(value, dict):
        templates_raw = value.get("templates")
    elif isinstance(value, list):
        templates_raw = value
    out_templates: list[dict[str, Any]] = []
    seen: set[str] = set()
    if isinstance(templates_raw, list):
        for t in templates_raw:
            nt = normalize_template(t)
            if nt and nt["id"] not in seen:
                seen.add(nt["id"])
                out_templates.append(nt)
    return {"schemaVersion": SCHEMA_VERSION, "templates": out_templates}


# --------------------------------------------------------------------------- #
# 占位符扫描 / 替换
# --------------------------------------------------------------------------- #
def iter_placeholders(obj: Any) -> set[str]:
    """收集一段 JSON 树内所有 ``{{name}}`` 占位符名字（含 dict key 与 value）。"""
    found: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, str):
            found.update(PLACEHOLDER_RE.findall(node))
        elif isinstance(node, dict):
            for k, v in node.items():
                if isinstance(k, str):
                    found.update(PLACEHOLDER_RE.findall(k))
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(obj)
    return found


def _substitute_str(text: str, values: dict[str, Any], unknown: set[str]) -> Any:
    """替换一个字符串里的占位符。

    - 整串恰为 ``{{name}}`` 且值非字符串（数字/布尔/数组/对象）→ 返回该原生值（保类型）。
    - 否则按子串替换，值转成字符串拼接。
    - 未声明的占位符原样保留并登记进 ``unknown``。
    """
    m = PLACEHOLDER_RE.fullmatch(text.strip())
    if m and m.group(1) in values:
        val = values[m.group(1)]
        if not isinstance(val, str):
            return val
        return val

    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in values:
            v = values[name]
            return v if isinstance(v, str) else _json_scalar_to_str(v)
        unknown.add(name)
        return match.group(0)

    return PLACEHOLDER_RE.sub(repl, text)


def _json_scalar_to_str(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def substitute(obj: Any, values: dict[str, Any]) -> tuple[Any, set[str]]:
    """深度替换 JSON 树内所有占位符。返回 ``(结果, 未知占位符集)``。"""
    unknown: set[str] = set()

    def walk(node: Any) -> Any:
        if isinstance(node, str):
            return _substitute_str(node, values, unknown)
        if isinstance(node, dict):
            out: dict[str, Any] = {}
            for k, v in node.items():
                nk = _substitute_str(k, values, unknown) if isinstance(k, str) else k
                # dict key 必须是字符串；若替换出非字符串（不该发生）则回退原样
                out[nk if isinstance(nk, str) else k] = walk(v)
            return out
        if isinstance(node, list):
            return [walk(item) for item in node]
        return node

    return walk(obj), unknown


# --------------------------------------------------------------------------- #
# 校验（占位符感知）
# --------------------------------------------------------------------------- #
def _issue(severity: str, code: str, message: str, template_id: str = "") -> dict[str, Any]:
    row = {"severity": severity, "code": code, "message": message}
    if template_id:
        row["itemId"] = template_id
    return row


def validate_template(tpl: dict[str, Any]) -> list[dict[str, Any]]:
    """单模板校验：参数声明与占位符使用是否一致。warning 级为主。"""
    issues: list[dict[str, Any]] = []
    tid = _as_str(tpl.get("id"))
    if not tid:
        issues.append(_issue("error", "template.id.missing", "模板缺少 id"))
        return issues
    if not _IDENTIFIER_RE.match(tid):
        issues.append(_issue("warning", "template.id.style", f"模板 id「{tid}」建议用标识符风格", tid))

    declared = {_as_str(p.get("name")) for p in tpl.get("params") or [] if isinstance(p, dict)}
    declared.discard("")

    # 参数名必须是替换引擎认得的占位符名（否则抽取造出的 {{洞}} 永远填不上）——error 拦保存。
    for name in sorted(declared):
        if not PLACEHOLDER_NAME_RE.match(name):
            issues.append(_issue(
                "error", "template.param.name",
                f"模板「{tid}」参数名「{name}」不合法：只能用字母/数字/下划线/中文，首字符非数字，"
                "不能含空格或标点（替换引擎认不出这种占位符）", tid,
            ))

    comp = tpl.get("composition")
    if not isinstance(comp, dict) or not comp:
        issues.append(_issue("error", "template.composition.missing", f"模板「{tid}」没有 composition 骨架", tid))
        used: set[str] = set()
    else:
        used = iter_placeholders(comp)
    used |= iter_placeholders(tpl.get("signals") or [])
    used |= iter_placeholders(tpl.get("quest") or {})
    used |= iter_placeholders(tpl.get("dialogueStubs") or [])

    for name in sorted(used - declared):
        # error 拦保存：未声明的占位符盖章时永远填不上，字面 {{name}} 会泄漏进运行时数据
        # ——占位符物理隔离是模板系统硬契约（曾只 warning，2026-07-17 审查 W-E5/P-F9 升级）。
        issues.append(_issue(
            "error", "template.param.undeclared",
            f"模板「{tid}」用了占位符 {{{{{name}}}}} 但没在 params 里声明（盖章会把字面占位符泄漏进运行时数据）", tid,
        ))
    for name in sorted(declared - used):
        issues.append(_issue(
            "warning", "template.param.unused",
            f"模板「{tid}」声明了参数「{name}」但骨架里没用到", tid,
        ))

    # taskId 约定：若声明了 taskId，建议信号都以它为前缀（不强制，warning）。
    if "taskId" in declared and isinstance(tpl.get("signals"), list):
        for s in tpl["signals"]:
            sid = _as_str(s.get("id")) if isinstance(s, dict) else ""
            if sid and "{{taskId}}" not in sid and "{{ taskId }}" not in sid:
                issues.append(_issue(
                    "warning", "template.signal.prefix",
                    f"模板「{tid}」信号「{sid}」未以 {{{{taskId}}}} 前缀，盖章后可能与其它任务撞名", tid,
                ))
    return issues


def validate_templates_file(data: Any) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    # 撞名检测走原始输入（normalize 会静默去重，故必须在归一前扫描）。
    raw_templates: Any = data.get("templates") if isinstance(data, dict) else data
    seen: set[str] = set()
    if isinstance(raw_templates, list):
        for t in raw_templates:
            if not isinstance(t, dict):
                continue
            tid = _as_str(t.get("id"))
            if tid and tid in seen:
                issues.append(_issue("error", "template.id.duplicate", f"模板 id「{tid}」重复（归一时会丢弃后者）", tid))
            if tid:
                seen.add(tid)
    for tpl in normalize_templates_file(data)["templates"]:
        issues.extend(validate_template(tpl))
    return issues


# --------------------------------------------------------------------------- #
# 从现成作曲反抽模板
# --------------------------------------------------------------------------- #
def _replace_sample_in_tree(obj: Any, sample: str, token: str) -> Any:
    """把 JSON 树内所有 ``sample`` 子串换成 ``token``（值与 key 都换）。"""
    if isinstance(obj, str):
        return obj.replace(sample, token)
    if isinstance(obj, dict):
        return {
            (k.replace(sample, token) if isinstance(k, str) else k): _replace_sample_in_tree(v, sample, token)
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_replace_sample_in_tree(item, sample, token) for item in obj]
    return obj


def extract_template(
    composition: dict[str, Any],
    param_specs: list[dict[str, Any]],
    *,
    template_id: str,
    label: str = "",
    description: str = "",
    signals: list[dict[str, Any]] | None = None,
    quest: dict[str, Any] | None = None,
    dialogue_stubs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """从一张现成作曲反抽出模板：把每个 param 的 ``sample`` 值换成 ``{{name}}``。

    round-trip 不变式：``stamp(extract(comp, specs), {p.name: p.sample})`` 应还原出 ``comp``
    （在 sample 互不为子串、且未与占位符语法冲突时）。sample 越长越先替换，减少部分命中。
    """
    comp_copy = copy.deepcopy(composition)
    sigs_copy = copy.deepcopy(signals) if signals else []
    quest_copy = copy.deepcopy(quest) if quest else None
    stubs_copy = copy.deepcopy(dialogue_stubs) if dialogue_stubs else None

    specs_with_sample = [
        p for p in param_specs
        if isinstance(p, dict) and _as_str(p.get("name")) and "sample" in p and _as_str(p.get("sample"))
    ]
    # 长 sample 优先，避免 "淹尸活" 先被 "淹尸" 吃掉。
    for p in sorted(specs_with_sample, key=lambda x: len(_as_str(x.get("sample"))), reverse=True):
        name = _as_str(p["name"])
        sample = _as_str(p["sample"])
        token = f"{{{{{name}}}}}"
        comp_copy = _replace_sample_in_tree(comp_copy, sample, token)
        sigs_copy = _replace_sample_in_tree(sigs_copy, sample, token)
        if quest_copy is not None:
            quest_copy = _replace_sample_in_tree(quest_copy, sample, token)
        if stubs_copy is not None:
            stubs_copy = _replace_sample_in_tree(stubs_copy, sample, token)

    out_params: list[dict[str, Any]] = []
    for p in param_specs:
        np = normalize_param(p)
        if np:
            out_params.append(np)

    tpl: dict[str, Any] = {
        "id": _as_str(template_id),
        "params": out_params,
        "composition": comp_copy,
    }
    if label:
        tpl["label"] = label
    if description:
        tpl["description"] = description
    if sigs_copy:
        tpl["signals"] = sigs_copy
    if quest_copy is not None:
        tpl["quest"] = quest_copy
    if stubs_copy is not None:
        tpl["dialogueStubs"] = stubs_copy
    return normalize_template(tpl)


# --------------------------------------------------------------------------- #
# 盖章（stamp）
# --------------------------------------------------------------------------- #
def _default_for(param: dict[str, Any]) -> Any:
    if "default" in param:
        return param["default"]
    return "" if param.get("type") not in ("number", "boolean") else (0 if param["type"] == "number" else False)


def resolve_values(tpl: dict[str, Any], provided: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """把策划填的值与参数默认值合并，产出替换字典 + 必填缺失错误。"""
    values: dict[str, Any] = {}
    errors: list[dict[str, Any]] = []
    tid = _as_str(tpl.get("id"))
    for p in tpl.get("params") or []:
        if not isinstance(p, dict):
            continue
        name = _as_str(p.get("name"))
        if not name:
            continue
        if name in provided and provided[name] not in (None, ""):
            values[name] = provided[name]
        elif "default" in p and p.get("default") not in (None, ""):
            values[name] = p["default"]
        elif p.get("required"):
            errors.append(_issue("error", "stamp.param.required", f"缺少必填参数「{name}」", tid))
        else:
            values[name] = _default_for(p)
    # identifier 型参数格式校验（信号/id 安全）
    for p in tpl.get("params") or []:
        if not isinstance(p, dict) or p.get("type") != "identifier":
            continue
        name = _as_str(p.get("name"))
        val = values.get(name)
        if isinstance(val, str) and val and not _IDENTIFIER_RE.match(val):
            errors.append(_issue(
                "error", "stamp.param.identifier",
                f"参数「{name}」值「{val}」不是合法标识符（仅字母/数字/下划线/中文，首字符非数字）", tid,
            ))
    return values, errors


def _composition_signal_ids(comp: dict[str, Any]) -> set[str]:
    """作曲 mainGraph transition 监听的信号集（listen 端）。"""
    ids: set[str] = set()
    main = comp.get("mainGraph")
    if isinstance(main, dict):
        for tr in main.get("transitions") or []:
            if isinstance(tr, dict):
                sig = _as_str(tr.get("signal"))
                if sig:
                    ids.add(sig)
    return ids


def _composition_emit_sources(comp: dict[str, Any]) -> set[str]:
    """作曲内各 blackbox element 声明的 meta.emits（emit 端契约）。"""
    ids: set[str] = set()
    for el in comp.get("elements") or []:
        if not isinstance(el, dict):
            continue
        meta = el.get("meta")
        if not isinstance(meta, dict):
            continue
        for sig in meta.get("emits") or []:
            s = _as_str(sig)
            if s:
                ids.add(s)
    return ids


# 对话图 id 即文件名（graphs/<id>.json）：禁路径分隔符 / 上跳 / 隐藏文件，防写出目录外
# 或写进 glob("*.json") 扫不到的子目录（黑洞文件）。
_UNSAFE_DIALOGUE_ID_RE = re.compile(r"[/\\]|\.\.")


def _dialogue_id_error(gid: str) -> str | None:
    if not gid:
        return "对话图 id 为空"
    if _UNSAFE_DIALOGUE_ID_RE.search(gid) or gid.startswith("."):
        return f"对话图 id「{gid}」不合法：不能含 / \\ .. 或以 . 开头（它会成为文件名）"
    return None


def stamp_template(
    tpl: dict[str, Any],
    provided_values: dict[str, Any],
    *,
    existing_composition_ids: set[str] | None = None,
    existing_quest_ids: set[str] | None = None,
    existing_dialogue_ids: set[str] | None = None,
    existing_signal_ids: set[str] | None = None,
    generate_dialogue_stubs: bool = False,
) -> dict[str, Any]:
    """盖章：占位符替换 → 撞名检测 → 产出真作曲 / 信号 / quest / 对话桩规格。

    返回 ``{ok, errors, warnings, compositionId, composition, signals, questId, quest,
    dialogueStubs:[{id, graph, exists}], requiredEntities}``。撞名 = error（不覆盖已有内容）。
    ``existing_signal_ids``：全项目已注册/已发出的信号集；模板**声明**的新信号与之重名
    = error（两单任务共用一个信号会互相串线推进）。
    """
    existing_comp = existing_composition_ids or set()
    existing_quest = existing_quest_ids or set()
    existing_dlg = existing_dialogue_ids or set()
    existing_sig = existing_signal_ids or set()

    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    tid = _as_str(tpl.get("id"))

    values, verr = resolve_values(tpl, provided_values)
    errors.extend(verr)

    comp_src = tpl.get("composition")
    if not isinstance(comp_src, dict) or not comp_src:
        errors.append(_issue("error", "stamp.composition.missing", f"模板「{tid}」没有作曲骨架", tid))
        return {"ok": False, "errors": errors, "warnings": warnings}

    composition, unknown_c = substitute(comp_src, values)
    signals_src = tpl.get("signals") or []
    signals, unknown_s = substitute(signals_src, values)
    quest_src = tpl.get("quest")
    quest = None
    unknown_q: set[str] = set()
    if isinstance(quest_src, dict) and quest_src:
        quest, unknown_q = substitute(quest_src, values)
    stubs_src = tpl.get("dialogueStubs") or []
    stub_specs, unknown_d = substitute(stubs_src, values)
    req_src = tpl.get("requiredEntities") or []
    required_entities, _unknown_r = substitute(req_src, values)

    for name in sorted(unknown_c | unknown_s | unknown_q | unknown_d):
        # error 禁盖章：没有值的占位符会把字面 {{name}} 盖进 narrative/quest/对话桩
        # （运行时当活数据注册、strict 校验爆红）——物理隔离硬契约（2026-07-17 升级）。
        errors.append(_issue(
            "error", "stamp.placeholder.unknown",
            f"占位符 {{{{{name}}}}} 没有对应参数值，禁止盖章（会把字面占位符泄漏进运行时数据）", tid,
        ))

    comp_id = _as_str(composition.get("id")) if isinstance(composition, dict) else ""
    if not comp_id:
        errors.append(_issue("error", "stamp.composition.id", "盖章后作曲缺少 id（检查模板 composition.id 占位符）", tid))
    elif comp_id in existing_comp:
        errors.append(_issue("error", "stamp.collision.composition", f"作曲 id「{comp_id}」已存在，换个 taskId", tid))

    used_signals = _composition_signal_ids(composition) if isinstance(composition, dict) else set()

    # 模板声明的新信号与既有信号重名 = error（禁止：会与别的任务串线互相触发）。
    for sig_row in signals:
        sid = _as_str(sig_row.get("id")) if isinstance(sig_row, dict) else ""
        if sid and sid in existing_sig:
            errors.append(_issue(
                "error", "stamp.collision.signal",
                f"信号「{sid}」已存在于项目中，禁止重名（会与既有任务串线）；换个 taskId", tid,
            ))

    quest_id = ""
    if quest is not None:
        quest_id = _as_str(quest.get("id"))
        if not quest_id:
            errors.append(_issue("error", "stamp.quest.id", "盖章后 quest 缺少 id", tid))
        elif quest_id in existing_quest:
            errors.append(_issue("error", "stamp.collision.quest", f"任务 id「{quest_id}」已存在", tid))

    dialogue_stubs: list[dict[str, Any]] = []
    for spec in stub_specs:
        if not isinstance(spec, dict):
            continue
        gid = _as_str(spec.get("id"))
        if not gid:
            continue
        bad = _dialogue_id_error(gid)
        if bad:
            errors.append(_issue("error", "stamp.dialogue.badId", bad, tid))
            continue
        exists = gid in existing_dlg
        graph = _build_dialogue_stub(gid, _as_str(spec.get("title")), _as_str(spec.get("emitSignal")))
        dialogue_stubs.append({
            "id": gid,
            "title": _as_str(spec.get("title")),
            "emitSignal": _as_str(spec.get("emitSignal")),
            "exists": exists,
            "graph": graph,
        })
        if exists and generate_dialogue_stubs:
            warnings.append(_issue(
                "warning", "stamp.dialogue.exists",
                f"对话图「{gid}」已存在，不会覆盖；请确认它 emit 了对应信号", tid,
            ))

    # 断链自检：作曲 transition 监听的信号，是否有 emit 来源。
    # emit 端契约 = 作曲内各 blackbox 的 meta.emits ∪ 生成的对话桩 emitSignal。
    emit_sources = _composition_emit_sources(composition) if isinstance(composition, dict) else set()
    emit_sources |= {_as_str(s.get("emitSignal")) for s in dialogue_stubs}
    emit_sources.discard("")
    for sig in sorted(used_signals):
        if sig not in emit_sources:
            warnings.append(_issue(
                "warning", "stamp.signal.noemit",
                f"信号「{sig}」在作曲里被监听，但没有 blackbox 声明 emit 它——检查模板 element.meta.emits", tid,
            ))

    ok = not errors
    return {
        "ok": ok,
        "errors": errors,
        "warnings": warnings,
        "values": values,
        "compositionId": comp_id,
        "composition": composition,
        "signals": signals,
        "questId": quest_id,
        "quest": quest,
        "dialogueStubs": dialogue_stubs,
        "requiredEntities": required_entities,
    }


def _build_dialogue_stub(graph_id: str, title: str, emit_signal: str) -> dict[str, Any]:
    """产出一份最小可运行的空白对话图桩：一行占位对白 → runActions 发信号（若给了信号）。

    与 ``public/assets/dialogues/graphs/*.json`` schema 对齐（schemaVersion/id/entry/meta/nodes）。
    烘进 emit 动作 = 保证该对话图发出的信号与作曲监听的信号严格一致。
    """
    nodes: dict[str, Any] = {
        "root": {
            "type": "line",
            "speaker": {"kind": "literal", "name": "旁白"},
            "text": "（占位对白，待策划填写。）",
        },
    }
    if emit_signal:
        nodes["root"]["next"] = "emit"
        nodes["emit"] = {
            "type": "runActions",
            "actions": [
                {
                    "type": "emitNarrativeSignal",
                    "params": {
                        "signal": emit_signal,
                        "sourceType": "dialogue",
                        "sourceId": graph_id,
                    },
                },
            ],
        }
    return {
        "schemaVersion": 1,
        "id": graph_id,
        "entry": "root",
        "meta": {"title": title or graph_id},
        "nodes": nodes,
    }
