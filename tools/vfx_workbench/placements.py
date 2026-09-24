# -*- coding: utf-8 -*-
"""粒子工作台这一侧的**布置库**读写（``public/assets/data/vfx_placements.json``）。

形状、键序、查询一律用共享模块 ``tools/editor/shared/vfx_placements.py``（主编辑器 / 校验器 / 本台
同一份，不各写一套路径）；这里只加**工作台才有的三件事**：

* **写盘**：``normalize_library`` 形状闸门 + 语义检查 + 原子写（``tools.atomic_io.retry_transient``，
  与 ``assets.atomic_write`` 同一条就位法）。**本工作台是这份文件唯一的写入者**——主编辑器只读
  （画布上显示区域、实例候选、校验），没有脏桶、不进 Save All。两个写入者的下场是互删。
* **语义检查只否决本次真改了的那几份**（editor-tools norms 不变量 9：否决面只罩将写盘的脏域）：
  场景不存在 / 时段键不是该场景的外观键 —— 盘上原样没动的那份降成 warning（场景被主编辑器删了，
  不能因此把整个库锁死、一个布置都存不了）；效果不存在一律 warning（可能正要去新建）。
* **效果改名 / 删除连带布置**：改名 = 布置里引用旧 id 的一起改（先写库再改名，改名失败回滚库）；
  删除 = 先列出全库所有引用它的布置，作者确认"连布置一起删"才动（先写库再删文件，删失败回滚库）。
* **布置库之外按效果 id 的引用只读、只列不改**（``external_refs_to_effect``）：挂件预设 ``prop_presets.json``
  的粒子挂载 ``particles[i].effect`` / ``states[*].particles[i].effect``（契约 v3 取代旧 ``vfx``）、
  数据里 ``playVfx`` / ``playPropVfx`` 动作的 ``effect`` 参数（后者常在挂件预设状态的 ``onEnterActions`` 里）、
  可燃物模板 ``assets/data/burnables/<id>.json`` 的 ``particles[i].effect``（燃烧粒子）。那些文件归主编辑器 / 燃烧工作台写，
  本台一个字节都不碰——删除要作者看着清单明确确认，改名在它们还在时一律拒绝并说去哪里改。
  ⚠ 2026-09-14 之前只看布置库：火把 ember 态的 ``incense_smoke`` 没有任何布置，左栏说"游戏里不会出现"、
  删除确认说"全库没有布置引用它"，删完火把的余烟从此静默消失。
* **布置库之外按实例 id 的引用同样只读、只列不改**（``external_refs_to_instance``）：``playVfx`` / ``stopVfx`` /
  ``setVfxState`` 的 ``instanceId`` 与条件叶 ``vfx``。删布置 / 改 id 前给页面列清单（运行时找不到实例整步跳过、
  条件恒为假，都是"什么都没发生"）；主编辑器校验器对同一类引用有"没摆在布置库任何地方"的兜底告警。

路径可重定向（``LIB_ROOT``，照 ``assets.VFX_DIR`` 的做法）：pytest 与 ``--selftest`` 一律指到临时目录，
**自检绝不许写真实的 vfx_placements.json**。
"""
from __future__ import annotations

import json
import os
import copy
from pathlib import Path
from typing import Any

from tools.atomic_io import retry_transient
from tools.editor.shared import burnables as _burnables
from tools.editor.shared import vfx_placements as vp
from tools.vfx_workbench import assets

ROOT = Path(__file__).resolve().parents[2]
#: 布置库所在的"工程根"。测试 / 自检改它（整个库文件落到 ``<LIB_ROOT>/public/assets/data/``），
#: 场景 JSON / game_config 仍读真工程（那两样本台只读）。
LIB_ROOT: Path = ROOT
#: 扫"布置库之外按 id 引用效果"的工程根（只读）。测试改它指到临时工程。
REF_ROOT: Path = ROOT
SCENES_JSON = ROOT / "public" / "assets" / "scenes"
GAME_CONFIG = ROOT / "public" / "assets" / "data" / "game_config.json"


def lib_path() -> Path:
    return vp.library_path(LIB_ROOT)


def is_real_library() -> bool:
    """当前指着的是不是工程里那份真库（自检用它自证没写真库）。"""
    try:
        return lib_path().resolve() == vp.library_path(ROOT).resolve()
    except OSError:
        return lib_path() == vp.library_path(ROOT)


def load() -> tuple[dict, str]:
    """``(文档, 错误)``：不存在 = 空库无错；读不懂 = 空库 + 错误（调用方据此**拒绝覆盖**）。"""
    return vp.load_library(LIB_ROOT)


# ---------------------------------------------------------------------------
# 场景 / 时段外观（只读工程）
# ---------------------------------------------------------------------------

def day_night_phases() -> list[dict]:
    """``game_config.dayNight.phases``（给人看的名字 + base 该切到哪个真实时段）。读不到 = 空表。"""
    try:
        cfg = json.loads(GAME_CONFIG.read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return []
    dn = cfg.get("dayNight") if isinstance(cfg, dict) else None
    ph = dn.get("phases") if isinstance(dn, dict) else None
    return [p for p in ph if isinstance(p, dict) and p.get("id")] if isinstance(ph, list) else []


def scene_doc(scene_id: str) -> dict | None:
    """场景 JSON（不存在 / 读不懂 = None）。id 带路径分隔符一律当不存在。"""
    sid = str(scene_id or "")
    if not sid or any(c in sid for c in '/\\:*?"<>|') or sid.startswith("."):
        return None
    p = SCENES_JSON / f"{sid}.json"
    if not p.is_file():
        return None
    try:
        doc = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _first_bg(layers: Any) -> str:
    if isinstance(layers, list) and layers and isinstance(layers[0], dict):
        img = layers[0].get("image")
        if isinstance(img, str) and img.strip():
            return img
    return ""


def scene_phases(data: dict, dn_phases: list[dict] | None = None) -> list[dict]:
    """一个场景的全部时段外观：``[{key, label, background, timePhase}]``，base（``key=''``）在前。

    与运行时 ``resolveSceneAppearance`` 同口径：**没开 ``dayNight.enabled`` 时变体整套不生效**，只有 base；
    变体没写 ``backgrounds`` 时用顶层背景（外观键照样是它自己——布置分份按键，不按图）。

    ``timePhase`` = 「让游戏切到这个时段」时发的**真实时段 id**：变体 = 它自己；base = 该场景没单列外观的
    第一个时段（按 game_config 顺序、优先 ``daylight: true``）；没开日夜 / 每个时段都单列了外观 = 空串
    （切时段不会让游戏换到这套外观，按钮置灰）。
    """
    dn = dn_phases if dn_phases is not None else day_night_phases()
    base_bg = _first_bg(data.get("backgrounds")) or "background.png"
    on = isinstance(data.get("dayNight"), dict) and data["dayNight"].get("enabled") is True
    tv = data.get("timeVariants") if on and isinstance(data.get("timeVariants"), dict) else {}
    rest = [p for p in dn if str(p.get("id")) not in tv]
    day = [p for p in rest if p.get("daylight") is True]
    base_tp = str((day or rest or [{}])[0].get("id") or "") if on else ""
    out = [{"key": vp.BASE, "label": vp.phase_label(vp.BASE, data, dn), "background": base_bg, "timePhase": base_tp}]
    for key, v in tv.items():
        key = str(key)
        if not key.strip():
            continue
        bg = _first_bg((v or {}).get("backgrounds") if isinstance(v, dict) else None) or base_bg
        out.append({"key": key, "label": vp.phase_label(key, data, dn), "background": bg, "timePhase": key})
    return out


# ---------------------------------------------------------------------------
# 引用（效果 → 布置）
# ---------------------------------------------------------------------------

def refs_to_effect(lib: dict, effect_id: str) -> list[dict]:
    """全库里引用某效果的布置：``[{sceneId, phase, id}]``（按库序）。"""
    return [{"sceneId": sid, "phase": ph, "id": str(row.get("id") or "")}
            for sid, ph, _i, row in vp.iter_rows(lib) if str(row.get("effect") or "") == effect_id]


#: 扫 ``playVfx`` 动作时跳过的：本台自己写的两样（效果目录 / 布置库）、归档与备份（运行时不读，列出来只会误拦改名）、
#: 可燃物模板目录（模板里没有动作也没有实例引用；它按 ``particles[i].effect`` 引用效果由 ``_burnable_template_refs``
#: 单独扫——深遍历不挑容器，别让同一个文件在两条扫描里各算一遍）
_REF_SKIP_DIRS = ("vfx", "archive", "burnables")


def _read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return None


def _rel_ref(p: Path) -> str:
    try:
        return p.relative_to(REF_ROOT).as_posix()
    except ValueError:
        return p.as_posix()


def _prop_preset_refs(effect_id: str) -> list[dict]:
    """挂件预设的粒子挂载（契约 v3，按 id 直接 ``playVfx``）：顶层 ``particles[i].effect`` 与
    ``states[*].particles[i].effect``。旧 ``vfx`` 字段运行时不读，不算引用（校验器对它报 error）。"""
    p = REF_ROOT / "public" / "assets" / "data" / "prop_presets.json"
    doc = _read_json(p)
    if not isinstance(doc, dict):
        return []
    out: list[dict] = []
    rel = _rel_ref(p)

    def hits(lst: Any) -> list[int]:
        if not isinstance(lst, list):
            return []
        return [i for i, m in enumerate(lst)
                if isinstance(m, dict) and isinstance(m.get("effect"), str) and m["effect"].strip() == effect_id]

    for pid, pre in doc.items():
        if not isinstance(pre, dict):
            continue
        for i in hits(pre.get("particles")):
            where = f"particles[{i}]"
            out.append({"kind": "prop", "file": rel, "where": f"{pid} · {where}", "label": f"挂件预设「{pid}」· {where}"})
        states = pre.get("states")
        if isinstance(states, dict):
            for sid, st in states.items():
                for i in hits(st.get("particles") if isinstance(st, dict) else None):
                    where = f"states.{sid}.particles[{i}]"
                    out.append({"kind": "prop", "file": rel, "where": f"{pid} · {where}",
                                "label": f"挂件预设「{pid}」· {where}"})
    return out


#: 按 ``effect`` 参数引用效果资产的动作：``playVfx``（临时实例）、``playPropVfx``（手持挂件上播，常住挂件预设
#: ``states[*].onEnterActions`` 与风吹灭块 ``blowout`` / ``states[*].blowout`` 的 ``onEmberActions`` / ``onOutActions``
#: 里——``prop_presets.json`` 在 ``_ref_files`` 里、深遍历不挑容器，照样扫到）
_EFFECT_ACTIONS = ("playVfx", "playPropVfx")


def _walk_play_vfx(node: Any, path: str, effect_id: str, out: list[tuple[str, str]]) -> None:
    if isinstance(node, dict):
        t = node.get("type")
        if t in _EFFECT_ACTIONS:
            params = node.get("params") if isinstance(node.get("params"), dict) else node
            if str(params.get("effect") or "").strip() == effect_id:
                out.append((str(t), path or "(根)"))
        for k, v in node.items():
            if isinstance(v, (dict, list)):
                _walk_play_vfx(v, f"{path}.{k}" if path else str(k), effect_id, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if isinstance(v, (dict, list)):
                _walk_play_vfx(v, f"{path}[{i}]", effect_id, out)


def _ref_files() -> list[Path]:
    """扫按 id 引用的数据文件：整个 ``assets/data``、``assets/dialogues``、``assets/scenes`` 的 JSON 一共两三 MB，
    逐个读一遍就是全部真相，不另维护一张"哪些文件有动作"的表（那张表必漂）。效果引用与实例引用共用这一份。"""
    base = REF_ROOT / "public" / "assets"
    files: list[Path] = []
    for sub in ("data", "dialogues", "scenes"):
        d = base / sub
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*.json")):
            parts = p.relative_to(d).parts
            if sub == "data" and (parts[0] in _REF_SKIP_DIRS or p.name == "vfx_placements.json"):
                continue
            if ".bak" in p.name:
                continue
            files.append(p)
    return files


def _action_refs(effect_id: str) -> list[dict]:
    """数据里 ``playVfx``（临时实例那一档）/ ``playPropVfx``（挂件上播）动作的 ``effect`` 参数：
    对话图 / 演出 / 任务 / 遭遇 / 场景热区 / 挂件预设状态的进入动作……``action`` = 哪条动作。"""
    out: list[dict] = []
    for p in _ref_files():
        doc = _read_json(p)
        if not isinstance(doc, (dict, list)):
            continue
        hits: list[tuple[str, str]] = []
        _walk_play_vfx(doc, "", effect_id, hits)
        rel = _rel_ref(p)
        for t, h in hits:
            out.append({"kind": "action", "action": t, "file": rel, "where": h, "label": f"{t} 动作 · {rel} · {h}"})
    return out


def _burnable_template_refs(effect_id: str) -> list[dict]:
    """**可燃物模板**按 id 用它当燃烧粒子（``public/assets/data/burnables/<模板 id>.json`` 的 ``particles[i].effect``，
    2026-09-16 模板化；取代旧的薄片 ``plate.flammable.fireEffect``）。

    模板归燃烧工作台写，本台一个字节都不碰：改名 / 删除只动效果文件，模板那边会静默指空（烧起来不再冒火苗 / 火星 / 灰）。
    所以与挂件预设同待遇——列出来、改名拒绝、删除要确认；去**燃烧工作台里打开那份模板**改粒子。
    ``from`` 取不到（形状坏）时照样算引用（运行时按 effect 装）；读不懂的模板文件跳过（主校验器另报）。
    扫 ``REF_ROOT`` 下的模板目录（与挂件预设 / 动作同一个根；测试指到临时工程）。"""
    out: list[dict] = []
    d = _burnables.burnables_dir(REF_ROOT)
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        doc = _read_json(p)
        parts = doc.get("particles") if isinstance(doc, dict) and isinstance(doc.get("particles"), list) else []
        rel = _rel_ref(p)
        for i, slot in enumerate(parts):
            if not (isinstance(slot, dict) and isinstance(slot.get("effect"), str) and slot["effect"].strip() == effect_id):
                continue
            where = f"particles[{i}]"
            src = slot.get("from")
            out.append({"kind": "burnable", "burnable": p.stem, "file": rel, "where": f"{p.stem} · {where}",
                        "label": f"可燃物模板「{p.stem}」· {where}" + (f"（{src}）" if isinstance(src, str) and src else "")})
    return out


def external_refs_to_effect(effect_id: str) -> list[dict]:
    """布置库之外按 id 引用这个效果的地方：``[{kind, file, where, label}]``（``kind`` = ``prop`` / ``action`` / ``burnable``）。

    **只读**：本台不在改名 / 删除时顺手改这些地方（挂件预设 / 动作归主编辑器写；可燃物模板的粒子
    要作者在燃烧工作台里打开那份模板改）。给删除确认与改名拒绝列清单用，也给左栏「这个效果还布置在」说"不是没人用"。
    """
    eid = str(effect_id or "").strip()
    if not eid:
        return []
    return _prop_preset_refs(eid) + _action_refs(eid) + _burnable_template_refs(eid)


def refs_fix_hint(refs: list[dict]) -> str:
    """去哪改这些引用（给人看）：挂件预设 / 动作 → 主编辑器里的文件；可燃物模板的粒子 → 燃烧工作台里打开那份模板。"""
    parts: list[str] = []
    files = sorted({r["file"] for r in refs if r.get("kind") != "burnable"})
    if files:
        parts.append(f"在主编辑器里改掉 {' / '.join(files)} 里的这些引用")
    tids = sorted({str(r.get("burnable") or "") for r in refs if r.get("kind") == "burnable"})
    if tids:
        parts.append(f"在燃烧工作台里打开模板{'/'.join(f'「{t}」' for t in tids)}改粒子")
    return "、".join(parts)


#: 按 ``instanceId`` 指向场景里摆好的实例的三条动作（``emitVfxField`` 不指实例）
_INSTANCE_ACTIONS = ("playVfx", "stopVfx", "setVfxState")


def _walk_instance_refs(node: Any, path: str, instance_id: str, out: list[tuple[str, str]]) -> None:
    if isinstance(node, dict):
        t = node.get("type")
        if t in _INSTANCE_ACTIONS:
            params = node.get("params") if isinstance(node.get("params"), dict) else node
            if str(params.get("instanceId") or "").strip() == instance_id:
                out.append((str(t), path or "(根)"))
        # 条件叶 ``{vfx: 实例 id, vfxState}``（与校验器 / evaluateGraphCondition 同口径：vfx 是字符串才是叶子——
        # 挂件预设的 ``vfx`` 是效果 id 列表，场景 JSON 残留的 ``vfx`` 是数组，都不算）
        vid = node.get("vfx")
        if isinstance(vid, str) and vid.strip() == instance_id:
            out.append(("condition", path or "(根)"))
        for k, v in node.items():
            if isinstance(v, (dict, list)):
                _walk_instance_refs(v, f"{path}.{k}" if path else str(k), instance_id, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if isinstance(v, (dict, list)):
                _walk_instance_refs(v, f"{path}[{i}]", instance_id, out)


def external_refs_to_instance(instance_id: str) -> list[dict]:
    """布置库之外按**实例 id** 引用一条布置的地方：``[{file, path, kind}]``，
    ``kind`` = ``playVfx`` / ``stopVfx`` / ``setVfxState``（动作的 ``instanceId``）或 ``condition``（条件叶 ``vfx``）。

    **只读**，扫的文件与 ``external_refs_to_effect`` 同一份（``_ref_files``）。给删布置 / 改 id 前列清单用：
    实例 id 是场景作用域，这里不做跨场景解析——删的这个 id 在库里别处还摆着时要不要问由页面判断。
    运行时找不到实例只 warn 一句整步跳过、条件叶恒为假，画面上都是"什么都没发生"。
    """
    iid = str(instance_id or "").strip()
    if not iid:
        return []
    out: list[dict] = []
    for p in _ref_files():
        doc = _read_json(p)
        if not isinstance(doc, (dict, list)):
            continue
        hits: list[tuple[str, str]] = []
        _walk_instance_refs(doc, "", iid, hits)
        rel = _rel_ref(p)
        out.extend({"file": rel, "path": where, "kind": kind} for kind, where in hits)
    return out


def external_refs_text(refs: list[dict]) -> str:
    """给人看的一行：动作那条的 label 里已经带着文件，挂件那条补上文件名（作者要知道去主编辑器改哪个）。"""
    return "；".join(r["label"] if r.get("kind") == "action" else f"{r['label']}（{r['file']}）" for r in refs)


def _copy(lib: dict) -> dict:
    return json.loads(json.dumps(lib, ensure_ascii=False))


def rename_effect_refs(lib: dict, old: str, new: str) -> tuple[dict, int]:
    """返回 ``(新库, 改了几条)``；不改入参。"""
    out = _copy(lib)
    n = 0
    for _sid, _ph, _i, row in vp.iter_rows(out):
        if str(row.get("effect") or "") == old:
            row["effect"] = new
            n += 1
    return out, n


def remove_effect_refs(lib: dict, effect_id: str) -> tuple[dict, int]:
    """删掉全库引用某效果的布置，返回 ``(新库, 删了几条)``；删空的份 / 场景一起剥掉（没配 = 没有）。"""
    out = _copy(lib)
    n = 0
    for sid in list((out.get("scenes") or {}).keys()):
        for ph in vp.phases_in_library(out, sid):
            rows = vp.rows_for(out, sid, ph)
            keep = [r for r in rows if str(r.get("effect") or "") != effect_id]
            if len(keep) != len(rows):
                n += len(rows) - len(keep)
                out = vp.set_rows(out, sid, ph, keep)
    return out, n


# ---------------------------------------------------------------------------
# 语义检查 + 写盘
# ---------------------------------------------------------------------------

def _entry_changed(new: dict, old: dict, sid: str, ph: str) -> bool:
    return json.dumps(vp.rows_for(new, sid, ph), ensure_ascii=False) != \
        json.dumps(vp.rows_for(old, sid, ph), ensure_ascii=False)


def semantic_check(norm: dict, baseline: dict | None = None) -> tuple[list[str], list[str]]:
    """``(errors, warnings)``。``norm`` 必须已过 ``normalize_library``。

    ``baseline`` = 盘上现在那份：**没变的份**里的场景 / 时段问题只告警（否决面只罩本次写盘真改了的份）；
    ``None`` = 全当新写（``--check`` 传自己作 baseline，于是全是 warning）。
    """
    errors: list[str] = []
    warns: list[str] = []
    base = baseline if isinstance(baseline, dict) else vp.empty_library()
    known = {r["id"] for r in assets.list_assets() if not r.get("error")}
    for sid in (norm.get("scenes") or {}):
        sc = scene_doc(sid)
        keys = vp.scene_phase_keys(sc) if sc is not None else []
        if sc is None and vp.surfaces_for(norm, sid):
            changed = json.dumps(vp.surfaces_for(norm, sid), ensure_ascii=False) !=                 json.dumps(vp.surfaces_for(base, sid), ensure_ascii=False)
            (errors if changed else warns).append(f"{sid} · 表面材质区：场景「{sid}」不存在（场景 JSON 找不到）")
        on = bool(sc) and isinstance(sc.get("dayNight"), dict) and sc["dayNight"].get("enabled") is True
        for ph in vp.phases_in_library(norm, sid):
            where = f"{sid} · {ph or '基底'}"
            bucket = errors if _entry_changed(norm, base, sid, ph) else warns
            if sc is None:
                bucket.append(f"{where}：场景「{sid}」不存在（场景 JSON 找不到）")
            elif ph not in keys:
                bucket.append(f"{where}：「{ph}」不是这个场景的时段外观（它的 timeVariants 里没有这个键）——运行时永远取不到这一份")
            elif ph and not on:
                warns.append(f"{where}：场景没开 dayNight.enabled，时段外观整套不生效——这一份运行时永远取不到")
            for row in vp.rows_for(norm, sid, ph):
                eff = str(row.get("effect") or "")
                if eff and eff not in known:
                    warns.append(f"{where} · {row.get('id')}：效果「{eff}」不存在（assets/data/vfx/ 里没有），游戏里会跳过这条")
    return errors, warns


def validate(doc: Any, baseline: dict | None = None) -> tuple[dict, list[str]]:
    """形状闸门 + 语义检查。有 error 抛 ``ValueError``（一次列全），否则返回 ``(落盘形, warnings)``。"""
    norm = vp.normalize_library(doc)
    errors, warns = semantic_check(norm, baseline)
    if errors:
        raise ValueError("布置库有问题，没存：" + "；".join(errors))
    return norm, warns


def _write(data: bytes) -> Path:
    p = lib_path()
    assets.atomic_write(p, data)
    return p


@assets.serialized_write
def save(doc: Any) -> tuple[Path, dict, list[str]]:
    """离线整库导入 / 测试初始化。UI 不调用本函数，只能走 save_changes。"""
    disk, err = load()
    if err:
        raise ValueError(f"盘上的布置库读不懂，不覆盖它（先手工修好）：{err}")
    norm, warns = validate(doc, disk)
    return _write(vp.dumps(norm)), norm, warns


def normalize_changes(doc: Any) -> dict:
    """显式修改的场景 × 外观（及场景的表面材质区、库顶层的全局缺省表面材质）；空数组 / 空对象表示清空，缺席表示未编辑。"""
    if not isinstance(doc, dict) or not isinstance(doc.get("scenes"), dict):
        raise ValueError("需要 changes.scenes；旧版整库保存已停用，请刷新工作台")
    out: dict = {"scenes": {}}
    if "defaultSurface" in doc:
        ds = doc["defaultSurface"]
        out["defaultSurface"] = vp.normalize_default_surface(ds) if ds else {}
    for sid, ent in doc["scenes"].items():
        if not isinstance(ent, dict) or set(ent) - {"base", "variants", "surfaces"}:
            raise ValueError(f"{sid}：修改范围只能包含 base / variants / surfaces")
        normalized = vp.normalize_library({"scenes": {sid: ent}})
        target: dict = {}
        if "base" in ent:
            target["base"] = vp.rows_for(normalized, sid, "")
        if "variants" in ent:
            target["variants"] = {ph: vp.rows_for(normalized, sid, ph) for ph in ent["variants"]}
        if "surfaces" in ent:
            target["surfaces"] = vp.surfaces_for(normalized, sid)
        if target:
            out["scenes"][sid] = target
    return out


_SAVE_CHANGES_LOCK = assets.WRITE_LOCK


def save_changes(changes: Any, base: Any = assets.UNCHECKED_BASE) -> tuple[Path, dict, list[str]]:
    """UI 保存入口：只接收实际修改的份，未编辑场景从磁盘原样保留。"""
    patch = normalize_changes(changes)
    if base is not assets.UNCHECKED_BASE and (not isinstance(base, dict) or not isinstance(base.get("scenes"), dict)):
        raise ValueError("布置保存基线无效，请重新载入布置库")
    with _SAVE_CHANGES_LOCK:
        disk, err = load()
        if err:
            raise ValueError(f"盘上的布置库读不懂，不覆盖它：{err}")
        if base is not assets.UNCHECKED_BASE:
            if "defaultSurface" in patch:
                cur_ds = disk.get("defaultSurface") or {}
                if cur_ds != (base.get("defaultSurface") or {}) and cur_ds != patch["defaultSurface"]:
                    raise ValueError("全局缺省表面材质已被外部修改，未覆盖磁盘；页面改动仍保留，请先核对")
            for sid, ent in patch["scenes"].items():
                scopes = ([('', ent['base'])] if 'base' in ent else []) + list(ent.get('variants', {}).items())
                for phase, rows in scopes:
                    current = vp.rows_for(disk, sid, phase)
                    if current != vp.rows_for(base, sid, phase) and current != rows:
                        raise ValueError(f"{sid} · {phase or '基底'} 的布置已被外部修改，未覆盖磁盘；页面改动仍保留，请先核对")
                if "surfaces" in ent:
                    current = vp.surfaces_for(disk, sid)
                    if current != vp.surfaces_for(base, sid) and current != ent["surfaces"]:
                        raise ValueError(f"{sid} 的表面材质区已被外部修改，未覆盖磁盘；页面改动仍保留，请先核对")
        # 逐份走 set_rows：空表 = 删掉那一份（不留空壳）、被改的场景条目键序同闸门——
        # 原地赋值时给只有 variants 的场景加 base 会排在 variants 后面，盘上那份就不再是归一化不动点
        merged = copy.deepcopy(disk)
        if "defaultSurface" in patch:
            merged = vp.set_default_surface(merged, patch["defaultSurface"] or None)
        for sid, ent in patch["scenes"].items():
            if "base" in ent:
                merged = vp.set_rows(merged, sid, vp.BASE, ent["base"])
            for ph, rows in ent.get("variants", {}).items():
                merged = vp.set_rows(merged, sid, ph, rows)
            if "surfaces" in ent:
                merged = vp.set_surfaces(merged, sid, ent["surfaces"])
        # 校验全库引用，但不拿全库归一化结果重写未编辑的份。
        _norm, warns = validate(merged, disk)
        if merged == disk:
            return lib_path(), disk, warns
        return _write(vp.dumps(merged)), merged, warns


def _snapshot() -> bytes | None:
    p = lib_path()
    try:
        return p.read_bytes() if p.is_file() else None
    except OSError:
        return None


def _restore(snap: bytes | None) -> None:
    p = lib_path()
    if snap is None:
        if p.exists():
            retry_transient(os.unlink, p)
    else:
        assets.atomic_write(p, snap)


@assets.serialized_write
def rename_effect(old: str, new: str) -> dict:
    """效果改名，布置里引用旧 id 的一起改。**先写库再改名**；改名失败把库原字节写回。

    返回 ``{path, placementsChanged, placements}``；失败抛异常，异常文字如实写库是回滚了还是停在半截。
    """
    src, dst = assets.asset_path(old), assets.asset_path(new)
    if not src.is_file():
        raise FileNotFoundError(f"效果 {old!r} 不存在")
    if dst.exists():
        raise FileExistsError(f"效果 {new!r} 已存在")
    # 布置库之外还有按 id 引用它的（挂件预设 / playVfx）：本台不写那些文件，改名 = 让它们静默指空——拒绝，说清去哪改
    ext = external_refs_to_effect(old)
    if ext:
        raise ValueError(f"「{old}」还被 {len(ext)} 处按 id 引用（改名不改这些地方，改名会让它们指空）："
                         f"{external_refs_text(ext)}——先{refs_fix_hint(ext)}再改名")
    lib, err = load()
    if err:
        raise ValueError(f"布置库读不懂，改名会漏掉布置里的引用（先修好库）：{err}")
    new_lib, n = rename_effect_refs(lib, old, new)
    snap = _snapshot()
    if n:
        _write(vp.dumps(vp.normalize_library(new_lib)))
    try:
        path = assets.rename_asset(old, new)
    except Exception as e:
        if not n:
            raise
        try:
            _restore(snap)
        except Exception as e2:  # noqa: BLE001 — 回滚也失败：如实报半截状态
            raise RuntimeError(
                f"改名失败（{type(e).__name__}: {e}），而且布置库回滚也失败（{type(e2).__name__}: {e2}）："
                f"布置库里 {n} 条已经改成引用「{new}」，效果文件仍叫「{old}」——手工把其中一边改回来") from e
        raise RuntimeError(f"改名失败（{type(e).__name__}: {e}）；布置库已回滚，什么都没变") from e
    return {"path": path, "placementsChanged": n, "placements": load()[0]}


@assets.serialized_write
def delete_effect(effect_id: str, with_placements: bool, confirm_external: bool = False) -> dict:
    """删效果。全库有布置引用它而 ``with_placements`` 为假，或布置库之外还有按 id 引用它的
    （挂件预设 / playVfx，``external_refs_to_effect``）而 ``confirm_external`` 为假 → 不删，
    返回 ``needConfirm`` + 两份引用清单。外部引用**只列不改**：删完它们指空，由作者去主编辑器改。

    确认后：**先写库（删掉那些布置）再删文件**；删文件失败把库原字节写回。
    返回 ``{deleted, needConfirm, refs, externalRefs, placementsRemoved, placements}``。
    """
    p = assets.asset_path(effect_id)
    lib, err = load()
    if err:
        raise ValueError(f"布置库读不懂，查不了谁在用「{effect_id}」（先修好库再删）：{err}")
    refs = refs_to_effect(lib, effect_id)
    ext = external_refs_to_effect(effect_id)
    if (refs and not with_placements) or (ext and not confirm_external):
        return {"deleted": False, "needConfirm": True, "refs": refs, "externalRefs": ext, "placementsRemoved": 0,
                "placements": lib}
    if not p.is_file():
        return {"deleted": False, "needConfirm": False, "refs": refs, "externalRefs": ext, "placementsRemoved": 0,
                "placements": lib}
    new_lib, n = remove_effect_refs(lib, effect_id)
    snap = _snapshot()
    if n:
        _write(vp.dumps(vp.normalize_library(new_lib)))
    try:
        deleted = assets.delete_asset(effect_id)
    except Exception as e:
        if not n:
            raise
        try:
            _restore(snap)
        except Exception as e2:  # noqa: BLE001
            raise RuntimeError(
                f"删效果失败（{type(e).__name__}: {e}），而且布置库回滚也失败（{type(e2).__name__}: {e2}）："
                f"布置库里引用「{effect_id}」的 {n} 条已经删掉，效果文件还在") from e
        raise RuntimeError(f"删效果失败（{type(e).__name__}: {e}）；布置库已回滚，什么都没变") from e
    return {"deleted": deleted, "needConfirm": False, "refs": refs, "externalRefs": ext, "placementsRemoved": n,
            "placements": load()[0]}


def check_report() -> tuple[bool, list[str]]:
    """``--check`` 用：``(是否通过, 输出行)``。盘上那份作 baseline ⇒ 场景 / 时段问题只告警，形状错才算失败。"""
    lines: list[str] = []
    doc, err = load()
    name = "vfx_placements.json"
    if err:
        return False, [f"{name}\t✗ {err}"]
    if not lib_path().is_file():
        return True, [f"{name}\t✓（不存在 = 没有任何布置）"]
    try:
        norm = vp.normalize_library(doc)
    except ValueError as e:
        return False, [f"{name}\t✗ 形状闸门：{e}"]
    _errs, warns = semantic_check(norm, norm)
    n_rows = sum(1 for _ in vp.iter_rows(norm))
    drift = vp.dumps(norm) != lib_path().read_bytes()
    lines.append(f"{name}\t✓ {len(norm.get('scenes') or {})} 个场景 · {n_rows} 条布置"
                 + ("（⚠ 盘上字节不是归一化形：下次保存会重排）" if drift else ""))
    lines.extend(f"\t⚠ {w}" for w in warns)
    return True, lines
