"""Explicit VFX execution configuration. Enum/default authority is the runtime JSON contract.

Validation mirrors vfxProgram.emitterProgramErrors; parity is verified with the same fixtures.
This module never modifies documents or writes files.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "src/data/vfxSimulationContract.json").read_text(encoding="utf-8"))


def effective_solver(emitter: dict) -> str:
    program = emitter.get("simulation")
    if isinstance(program, dict):
        return program.get("solver", "")
    return "flock" if emitter.get("behavior") else "plate" if emitter.get("plate") else "particle"


def new_program(solver: str = "particle") -> dict:
    return copy.deepcopy(CONTRACT["newPrograms"][solver])


def program_errors(emitter: dict) -> list[str]:
    if "simulation" not in emitter:
        return []
    p = emitter["simulation"]
    if not isinstance(p, dict):
        return ["simulation 必须为对象"]
    errors = []
    solver = p.get("solver")
    if solver not in CONTRACT["solvers"]:
        errors.append("simulation.solver 无效")
    if p.get("spawnPlacement") not in CONTRACT["spawnPlacements"]:
        errors.append("simulation.spawnPlacement 无效")
    radius = p.get("surfaceRadius")
    if "surfaceRadius" in p and not (isinstance(radius, (int, float)) and not isinstance(radius, bool) and math.isfinite(radius) and radius > 0):
        errors.append("simulation.surfaceRadius 必须为正数")
    if "initialVelocity" in p and p["initialVelocity"] not in CONTRACT["initialVelocities"]:
        errors.append("simulation.initialVelocity 无效")
    inf = p.get("influences") if isinstance(p.get("influences"), dict) else {}
    for k in CONTRACT["influenceKeys"]:
        if not isinstance(inf.get(k), bool):
            errors.append(f"simulation.influences.{k} 必须为布尔")
    for k in CONTRACT["optionalInfluenceKeys"]:
        if k in inf and not isinstance(inf[k], bool):
            errors.append(f"simulation.influences.{k} 必须为布尔")
    recycle = p.get("recycle") if isinstance(p.get("recycle"), dict) else {}
    if recycle.get("mode") not in CONTRACT["recycleModes"]:
        errors.append("simulation.recycle.mode 无效")
    for k in ("height", "upwind"):
        if k not in recycle:
            continue
        v = recycle[k]
        if not (isinstance(v, list) and len(v) == 2
                and all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) and n >= 0 for n in v)
                and v[0] <= v[1]):
            errors.append(f"simulation.recycle.{k} 必须为非负递增区间")
    if solver == "plate" and not isinstance(emitter.get("plate"), dict):
        errors.append("薄片求解器缺少 plate 参数")
    if solver == "flock" and not isinstance(emitter.get("behavior"), dict):
        errors.append("群体求解器缺少 behavior 参数")
    if solver == "flock" and (emitter.get("subOnly") or p.get("spawnPlacement") != "shape" or recycle.get("mode") != "none"):
        errors.append("群体由巢管理出生与返回，不能作为子发射器或使用表面铺撒 / 补回")
    if solver == "flock" and any(inf.get(k) for k in ("sceneWind", "wind", "airflow")):
        errors.append("群体运动模型不支持物理风输入；使用群体刺激响应")
    if solver == "flock" and inf.get("contact"):
        errors.append("群体运动模型不支持接触冲量；使用群体刺激响应")
    return errors
