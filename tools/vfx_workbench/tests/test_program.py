"""Execution modules must remain editable without mutating or discarding author data."""
import copy
import json
import subprocess
from pathlib import Path

import pytest

from tools.editor.shared.vfx_program import CONTRACT, effective_solver, new_program, program_errors
from tools.vfx_workbench.assets import new_effect, normalize_effect
from tools.vfx_workbench.bundle import node_exe


def paper():
    d = new_effect("test_program")
    e = d["emitters"][0]
    e["plate"] = {"size": [16, 16], "terminalSpeed": 90}
    e["simulation"] = new_program("plate")
    return d


def test_open_normalize_keeps_program_unknown_fields_numbers_and_inactive_parameters():
    d = paper()
    e = d["emitters"][0]
    e["simulation"]["recycle"] = {"mode": "airborne", "height": [22, 90], "future": {"x": 4}}
    e["simulation"]["future"] = [3, 2, 1]
    e["motion"] = {"gravity": 10, "stimulus": {"fear": {"player:motion": 1}, "accel": 700}}
    original = copy.deepcopy(d)
    out = normalize_effect(d)
    assert d == original
    assert out["emitters"][0]["simulation"] == e["simulation"]
    assert out["emitters"][0]["motion"] == e["motion"]
    assert type(out["emitters"][0]["simulation"]["recycle"]["height"][0]) is int


@pytest.mark.parametrize("bad", [None, [], "plate", {}, {"solver": "particle"}])
def test_invalid_program_rejected_without_mutating_document(bad):
    d = paper(); d["emitters"][0]["simulation"] = bad
    original = copy.deepcopy(d)
    with pytest.raises(ValueError, match="simulation"):
        normalize_effect(d)
    assert d == original


def test_default_programs_are_independent_and_runtime_contract_is_authority():
    a = new_program("plate"); a["influences"]["airflow"] = False
    assert new_program("plate")["influences"]["airflow"] is True
    assert set(CONTRACT["solvers"]) == {"particle", "plate", "flock"}
    assert new_effect("fresh")["emitters"][0]["simulation"] == new_program()


def test_missing_required_solver_parameters_is_not_silently_accepted():
    d = paper(); del d["emitters"][0]["plate"]
    with pytest.raises(ValueError, match="plate"):
        normalize_effect(d)


def test_stored_inactive_group_parameters_dont_forbid_particle_subemitter():
    d = paper(); e = d["emitters"][0]
    bat = json.loads((Path(__file__).resolve().parents[3] / "public/assets/data/vfx/bat_cliff.json").read_text(encoding="utf8"))
    e["behavior"] = bat["emitters"][0]["behavior"]
    e["simulation"] = new_program("particle"); e["subOnly"] = True
    out = normalize_effect(d)
    assert effective_solver(out["emitters"][0]) == "particle"
    assert out["emitters"][0]["behavior"] == e["behavior"]
    assert not program_errors(out["emitters"][0])


def test_python_and_runtime_validate_the_same_author_documents():
    """Exercise both real validators, including malformed nested values and dormant blocks."""
    node = node_exe()
    if not node:
        pytest.skip("Node unavailable")
    cases = [{}, {"simulation": None}, {"simulation": []}]
    for solver in CONTRACT["solvers"]:
        base = {"simulation": new_program(solver), "plate": {}, "behavior": {}}
        cases.append(base)
        for key, values in {
            "solver": [None, "unknown", 3], "spawnPlacement": [None, "missing"],
            "surfaceRadius": [None, True, "12", -1, 0, 12],
            "initialVelocity": [None, "missing"], "influences": [None, [], {}, {"airflow": 1}],
            "recycle": [None, [], {}, {"mode": "airborne", "height": [True, 2]}, {"mode": "airborne", "upwind": [4, 2]}],
        }.items():
            for value in values:
                d = copy.deepcopy(base); d["simulation"][key] = value; cases.append(d)
        for key in ("plate", "behavior"):
            d = copy.deepcopy(base); del d[key]; cases.append(d)
        d = copy.deepcopy(base); d["subOnly"] = True; cases.append(d)
    root = Path(__file__).resolve().parents[3]
    script = r"""
const fs = require('node:fs'), ts = require('typescript');
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(fs.readFileSync(p, 'utf8'), {
 compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, p);
const { emitterProgramErrors } = require('./src/systems/vfx/vfxProgram.ts');
process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0, 'utf8')).map(emitterProgramErrors)));
"""
    r = subprocess.run([node, "-e", script], cwd=root, input=json.dumps(cases), capture_output=True, text=True, encoding="utf8", timeout=30)
    assert r.returncode == 0, r.stderr
    actual = json.loads(r.stdout)
    for doc, runtime in zip(cases, actual, strict=True):
        assert program_errors(doc) == runtime, doc
