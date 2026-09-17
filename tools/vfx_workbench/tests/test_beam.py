"""光柱（体积光）的保存闸门与 TS 权威逐字 parity。

- Python ``vfx_beam.effect_beam_errors`` 与运行时 ``vfxBeam.ts effectBeamErrors``（node 真跑）对同一批文档
  给出**完全相同**的错误列表（同序同句）——编辑器兜底不许比运行时严，也不许松；
- ``normalize_effect``：只有光柱的效果能存、键序按 types.ts、不改数值（int 不漂成 float）、不改入参、
  坏光柱 / 坏引用拒存。
"""
import copy
import json
import subprocess
from pathlib import Path

import pytest

from tools.editor.shared.vfx_beam import CONTRACT, beam_texture_refs, effect_beam_errors
from tools.editor.shared.vfx_program import effective_solver, new_program
from tools.vfx_workbench.assets import new_effect, normalize_effect
from tools.vfx_workbench.bundle import node_exe

ROOT = Path(__file__).resolve().parents[3]


def rect_beam(**over):
    b = {
        "id": "window", "mode": "3d",
        "shape3d": {"from": [0, 300, 0], "to": [180, 0, 60], "section": {"kind": "rect", "width": 120, "height": 40},
                    "spreadDeg": [12, 4], "rollDeg": 17},
        "color": [1, 0.9, 0.7], "intensity": 1,
    }
    b.update(over)
    return b


def band_beam(**over):
    b = {"id": "band", "mode": "2d", "shape2d": {"to": [60, 0], "width": [40, 160], "occludeByDepth": True},
         "color": [1, 1, 1], "intensity": 0.5}
    b.update(over)
    return b


def dust(beam="window", **over):
    e = {"id": "dust", "simulation": new_program("particle"),
         "appearance": {"image": "/x.png", "sizeWu": 4, "lit": False, "blend": "add", "beamLit": {"beam": beam}},
         "spawn": {"max": 40, "rate": 5, "shape": {"kind": "beam", "beam": beam}}}
    e.update(over)
    return e


def cases():
    out = [
        {"id": "a", "emitters": []},
        {"id": "a", "emitters": [], "beams": [rect_beam()]},
        {"id": "a", "emitters": [], "beams": [rect_beam(), band_beam()]},
        {"id": "a", "emitters": [dust()], "beams": [rect_beam()]},
        {"id": "a", "emitters": [], "beams": "nope"},
        {"id": "a", "emitters": [], "beams": [None, 3, []]},
        {"id": "a", "emitters": [], "beams": [rect_beam(), rect_beam()]},
        {"id": "a", "emitters": [dust("missing")], "beams": [rect_beam()]},
        {"id": "a", "emitters": [dust(beam="")], "beams": [rect_beam()]},
        {"id": "a", "emitters": [dust(simulation=new_program("plate"), plate={"size": [8, 8], "terminalSpeed": 90})],
         "beams": [rect_beam()]},
    ]
    bad_beams = [
        {}, {"id": "", "mode": "3d"}, {"id": "x", "mode": "volumetric", "color": [1, 1, 1], "intensity": 1},
        rect_beam(shape3d=None), rect_beam(shape3d={"to": [0, 0, 0], "section": {"kind": "rect", "width": 1, "height": 1}}),
        rect_beam(shape3d={"to": [1, 2], "from": "x", "section": {"kind": "circle"}}),
        rect_beam(shape3d={"to": [0, -100, 0], "section": {"kind": "polygon", "sides": 9, "radius": 10}}),
        rect_beam(shape3d={"to": [0, -100, 0], "section": {"kind": "polygon", "sides": 4.5, "radius": 10}}),
        rect_beam(shape3d={"to": [0, -100, 0], "section": {"kind": "polygon", "sides": 6.0, "radius": 10}}),
        rect_beam(shape3d={"to": [0, -100, 0], "section": {"kind": "rect", "width": 0, "height": True}}),
        rect_beam(shape3d={"to": [0, -100, 0], "section": {"kind": "rect", "width": 3, "height": 3}, "spreadDeg": [10, 200], "rollDeg": "x"}),
        rect_beam(color=[1.2, 0, 0]), rect_beam(color=[True, 0, 0]), rect_beam(colorEnd=None), rect_beam(intensity=30),
        rect_beam(intensity=None), rect_beam(alongCurve=[]), rect_beam(alongCurve=[[0.5, 1], [0.2, 1]]),
        rect_beam(alongCurve=[[0, 11]]), rect_beam(alongCurve=[[0, 1]] * 9), rect_beam(alongCurve=[[0, 0.2], [1, 1]]),
        rect_beam(edgeSoftness=2, thickness=-1, contactSoftWu=None), rect_beam(blend="multiply", sort="middle"),
        rect_beam(fadeIn=31, fadeOut=None), rect_beam(noise=[]), rect_beam(noise={"strength": 2, "scaleWu": 0, "velocity": [1]}),
        rect_beam(noise={"strength": 0.5, "scaleWu": 10, "velocity": [1, 2, 3]}),
        rect_beam(cookie={"image": ""}), rect_beam(cookie={"image": "/a.png", "strength": 2, "scale": [0, 1], "offset": [1], "rotationDeg": None}),
        rect_beam(pulse={"kind": "strobe", "hz": 99, "amount": -1}), rect_beam(pulse=None),
        band_beam(shape2d={"to": [0, 0], "width": [0, 0]}), band_beam(shape2d={"to": [5, 5], "from": [1], "width": [3, 3], "occludeByDepth": 1}),
        band_beam(shape2d=None),
    ]
    for b in bad_beams:
        out.append({"id": "a", "emitters": [], "beams": [b]})
    for along in (None, [0.2, 0.1], [0, 1.5], [0.1, 0.9], "x"):
        e = dust()
        e["spawn"]["shape"]["along"] = along
        out.append({"id": "a", "emitters": [e], "beams": [rect_beam()]})
    for lit in (None, [], {"beam": "window", "gain": 30}, {"beam": "window", "gain": 3}, {"gain": 1}):
        e = dust()
        e["appearance"]["beamLit"] = lit
        out.append({"id": "a", "emitters": [e], "beams": [rect_beam()]})
    return out


def test_python_and_runtime_report_identical_beam_errors():
    node = node_exe()
    if not node:
        pytest.skip("Node unavailable")
    docs = cases()
    script = r"""
const fs = require('node:fs'), ts = require('typescript');
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(fs.readFileSync(p, 'utf8'), {
 compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true }
}).outputText, p);
const { effectBeamErrors } = require('./src/systems/vfx/vfxBeam.ts');
const { resolveEmitterProgram } = require('./src/systems/vfx/vfxProgram.ts');
const docs = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(docs.map((d) => effectBeamErrors(d, (em) => resolveEmitterProgram(em).solver))));
"""
    r = subprocess.run([node, "-e", script], cwd=ROOT, input=json.dumps(docs), capture_output=True, text=True,
                       encoding="utf8", timeout=60)
    assert r.returncode == 0, r.stderr
    runtime = json.loads(r.stdout)
    assert len(runtime) == len(docs)
    nonempty = 0
    for doc, want in zip(docs, runtime, strict=True):
        assert effect_beam_errors(doc, effective_solver) == want, json.dumps(doc, ensure_ascii=False)
        nonempty += bool(want)
    # 这批用例里真的有各种错（不是全绿的空对比）
    assert nonempty > 30


def test_beam_only_effect_saves_with_types_key_order_and_untouched_numbers():
    d = new_effect("beam_only")
    d["emitters"] = []
    beam = rect_beam(sort="depth", intensity=2, noise={"velocity": [1, 2, 3], "scaleWu": 90, "strength": 0.3})
    beam = {k: beam[k] for k in reversed(list(beam))}  # 故意乱序
    beam["future"] = {"keep": 1}
    d["beams"] = [beam]
    original = copy.deepcopy(d)
    warn = []
    out = normalize_effect(d, warn)
    assert d == original
    b = out["beams"][0]
    assert list(b) == ["id", "mode", "shape3d", "color", "intensity", "noise", "sort", "future"]
    assert list(b["shape3d"]) == ["from", "to", "section", "spreadDeg", "rollDeg"]
    assert list(b["noise"]) == ["strength", "scaleWu", "velocity"]
    assert type(b["intensity"]) is int
    assert list(out).index("beams") == list(out).index("emitters") + 1
    assert not any("什么都不会画" in w for w in warn)


def test_bad_beam_or_bad_reference_is_rejected_without_mutation():
    d = new_effect("bad")
    d["beams"] = [rect_beam(shape3d={"to": [0, -10, 0], "section": {"kind": "polygon", "sides": 12, "radius": 3}})]
    original = copy.deepcopy(d)
    with pytest.raises(ValueError, match="sides"):
        normalize_effect(d)
    assert d == original
    d2 = new_effect("bad2")
    d2["emitters"] = [dust("nope")]
    d2["beams"] = [rect_beam()]
    with pytest.raises(ValueError, match="nope"):
        normalize_effect(d2)


def test_empty_beams_array_is_stripped_and_empty_effect_warns():
    d = new_effect("empty")
    d["emitters"] = []
    d["beams"] = []
    warn = []
    out = normalize_effect(d, warn)
    assert "beams" not in out
    assert any("什么都不会画" in w for w in warn)


def test_contract_is_shared_and_texture_refs_listed():
    ts_contract = json.loads((ROOT / "src/data/vfxBeamContract.json").read_text(encoding="utf-8"))
    assert CONTRACT == ts_contract
    doc = {"beams": [rect_beam(cookie={"image": "/resources/runtime/images/vfx/lattice.png"}), band_beam()]}
    assert beam_texture_refs(doc) == ["/resources/runtime/images/vfx/lattice.png"]
