"""生存组件的保存前门：只查将写盘的数据，跨宿主声明引用另做完整性检查。"""
from .health_validation import health_action_errors, health_config_errors, health_protection_errors, health_threat_errors, environment_fire_errors
from .wind_gust_validation import wind_gust_errors


def survival_save_errors(model, dirty):
    from .signal_refactor import CONDITION_SOURCES
    from ..validator import _walk_conditions, _validate_health_references, _narrative_registered_signal_ids
    roots = []
    for attr, (bucket, _) in CONDITION_SOURCES.items():
        if bucket not in dirty:
            continue
        value = getattr(model, attr, None)
        if attr == "scenes" and model._dirty_scene_ids and not model._dirty_scenes_all:
            value = {sid: row for sid, row in (value or {}).items() if sid in model._dirty_scene_ids}
        roots.append((bucket, value))
    if "narrative_graphs" in dirty:
        roots.append(("narrative_graphs", model.narrative_graphs))
    if "dialogue_graph_edits" in dirty:
        roots.append(("dialogue_graph_edits", model.pending_dialogue_graph_edits))
    if "dialogue_stubs" in dirty:
        roots.append(("dialogue_stubs", model.pending_dialogue_stubs))
    errors = []
    notes = {row.get("id") for row in model.system_note_rows()}
    signals = _narrative_registered_signal_ids(model)

    def note_ref(value, where):
        if value and (not isinstance(value, str) or value not in notes):
            errors.append(f"{where}: 说明卡 {value!r} 不存在")

    def check_conditions(value, where):
        if value is None:
            return
        if not isinstance(value, list):
            errors.append(f"{where}: conditions 须为数组")
            return
        issues = []
        _walk_conditions(model, issues, value, "survival", where, None)
        errors.extend(f"{issue.data_type} {issue.item_id}: {issue.message}" for issue in issues if issue.severity == "error")

    def walk(node, where):
        if isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{where}[{i}]")
            return
        if not isinstance(node, dict):
            return
        kind, params = node.get("type"), node.get("params")
        if isinstance(kind, str) and isinstance(params, dict):
            errors.extend(f"{where}: {e}" for e in health_action_errors(kind, params))
            if kind == "inflictHealthDamage":
                note_ref(params.get("deathNoteId"), where)
            if kind == "sceneWindGust":
                errors.extend(f"{where}: {e}" for e in wind_gust_errors(params))
                ambient = params.get("id")
                if ambient and (not isinstance(ambient, str) or ambient not in (model.audio_config or {}).get("ambient", {})):
                    errors.append(f"{where}: 阵风环境音 {ambient!r} 不存在")
        for key, validator in (("healthThreat", health_threat_errors), ("healthProtection", health_protection_errors)):
            if key in node:
                errors.extend(f"{where}: {e}" for e in validator(node[key]))
        threat = node.get("healthThreat")
        if isinstance(threat, dict):
            sound = threat.get("presenceSfx")
            if sound and (not isinstance(sound, str) or sound not in (model.audio_config or {}).get("sfx", {})):
                errors.append(f"{where}: 威胁存在声 {sound!r} 不存在")
            note_ref(threat.get("deathNoteId"), where)
            check_conditions(threat.get("conditions"), where)
            for key in ("enteredSignal", "repelledSignal", "leftSignal"):
                value = threat.get(key)
                if value and (not isinstance(value, str) or value not in signals):
                    errors.append(f"{where}: 威胁信号 {value!r} 未登记")
        # 配置 health.fireProtection 是全局名单；实体 fireProtection 才是半径组件。
        if "fireProtection" in node and not where.endswith(".health"):
            errors.extend(f"{where}: {e}" for e in environment_fire_errors(node["fireProtection"]))
            if isinstance(node["fireProtection"], dict):
                check_conditions(node["fireProtection"].get("conditions"), where)
        for key, value in node.items():
            walk(value, f"{where}.{key}")

    if "config" in dirty and "health" in model.game_config:
        config = model.game_config["health"]
        errors.extend(health_config_errors(config))
        if isinstance(config, dict):
            if "tetherCondition" in config:
                check_conditions([config["tetherCondition"]], "health.tetherCondition")
            if isinstance(config.get("retry"), dict):
                note_ref(config["retry"].get("firstDeathNoteId"), "health.retry")
            cue = config.get("tetherCueId")
            if cue and cue not in {row.get("id") for row in model.signal_cues}:
                errors.append(f"health.tetherCueId: 信号演出 {cue!r} 不存在")
            fire = config.get("fireProtection")
            if isinstance(fire, dict) and isinstance(fire.get("heldPropIds"), list):
                for prop in fire["heldPropIds"]:
                    if not isinstance(prop, str) or prop not in (model.prop_presets or {}):
                        errors.append(f"保护火源挂件 {prop!r} 不存在")
    for bucket, root in roots:
        walk(root, bucket)
    if "scene" in dirty:
        seen = {}
        changed = set(model.scenes) if model._dirty_scenes_all or not model._dirty_scene_ids else model._dirty_scene_ids
        for sid, scene in model.scenes.items():
            for entity in [*scene.get("npcs", []), *scene.get("hotspots", [])]:
                if sid in changed and "fireProtection" in entity and entity in scene.get("npcs", []):
                    errors.append(f"{sid}/{entity.get('id')}: 环境保护火只能挂在热点上")
                threat = entity.get("healthThreat")
                tid = threat.get("id") if isinstance(threat, dict) else None
                if not isinstance(tid, str) or not tid:
                    continue
                if tid in seen and (sid in changed or seen[tid] in changed):
                    errors.append(f"{sid}: 威胁 id {tid!r} 与 {seen[tid]} 重复")
                seen[tid] = sid
    # 声明删改会使未标脏的物品/动作悬垂；因此引用完整性覆盖全部宿主。
    if roots:
        issues = []
        _validate_health_references(model, issues)
        errors.extend(f"{issue.data_type} {issue.item_id}: {issue.message}" for issue in issues if issue.severity == "error")
    return errors
