# -*- coding: utf-8 -*-
"""燃烧系统加的两样粒子字段在粒子工作台这一侧的口径（2026-09-16；同日薄片可燃改成「绑可燃物模板」）：

* ``spawn.shape = {kind: 'external', jitter?}``：接受；jitter 可缺省、写着必须是非负数；
* ``plate.burnable = {template}``：形状（不是对象 / 没写 template）拒存；模板不存在 / 读不懂 / 是消耗燃烧 / 装不上只提醒；
  **候选面 = 校验面**：``plate_bindable_template_ids`` 与 ``plate_burnable_notes`` 零提醒的集合逐 id 相等；
  残留的旧 ``plate.flammable`` 提醒作废、不拒存、原样留着（检视器有「删掉」）；
* 两样都**保值**：不改数值、不补缺省、未知键原样——落盘形再过一次闸门逐字节不变；
* ``GET /api/burnables``：模板表（bindable / note / summary / doc / errors）；``POST /api/open_burn_workbench``：起进程的参数；
* 效果被谁按 id 引用：**可燃物模板**的 ``particles[i].effect`` 算外部引用——改名拒绝、删除要确认、模板文件一字不动；
  页面镜像的提示句（``app.js`` 的 ``extRefsFixHint``）与服务端 ``refs_fix_hint`` 逐字相同。

写盘一律在临时目录（``assets.VFX_DIR`` / ``assets.BURN_ROOT`` / ``placements.LIB_ROOT`` / ``placements.REF_ROOT`` 全指到 tmp）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.shared import burnables as bn  # noqa: E402
from tools.editor.shared import vfx_burn  # noqa: E402
from tools.vfx_workbench import assets, bundle, placements, serve  # noqa: E402


def _particle(eid: str = "flame", shape: dict | None = None, **over) -> dict:
    em = {"id": eid, "appearance": {"image": "/resources/runtime/images/vfx/dust.png", "sizeWu": 4},
          "spawn": {"max": 32, "rate": 12, "shape": shape if shape is not None else {"kind": "external"}},
          "life": {"seconds": [0.3, 0.6]}}
    em.update(over)
    return em


_NO_BINDING = object()


def _paper(burnable=_NO_BINDING, eid: str = "paper", **plate_extra) -> dict:
    plate = {"size": [16, 16], "terminalSpeed": 90}
    if burnable is not _NO_BINDING:
        plate["burnable"] = burnable
    plate.update(plate_extra)
    return {"id": eid, "simulation": {"solver": "plate", "spawnPlacement": "surface", "initialVelocity": "rest",
                                      "influences": {"sceneWind": True, "wind": False, "airflow": False, "stimulus": False},
                                      "recycle": {"mode": "none"}},
            "appearance": {"image": "/resources/runtime/images/vfx/dust.png", "sizeWu": 16},
            "spawn": {"max": 40, "burst": 40, "shape": {"kind": "area", "radius": 200}},
            "plate": plate}


#: 临时工程里的模板：两份能绑（一份写全、一份只写必填——其余取缺省）、一份消耗燃烧、一份没写真实尺寸（装不上）、一份读不懂
TEMPLATES = {
    "paper_a": {"id": "paper_a", "label": "纸 A", "image": "/resources/runtime/images/props/a.png", "widthCm": 18, "heightCm": 18.5,
                "mode": "spread", "spread": {"speedOpposed": 6, "speedConcurrent": 14}, "flameSeconds": 1.5, "emberSeconds": 1,
                "flameLength": 8, "ignitionDelay": 0.4,
                "particles": [{"effect": "burn_flame", "from": "flame", "refArea": 100}, {"effect": "burn_ash", "from": "ash"}],
                "light": {"kelvin": 1800, "intensityPerM2": 0.6}},
    "paper_min": {"id": "paper_min", "image": "/resources/runtime/images/props/b.png", "widthCm": 10, "heightCm": 12},
    "candle_a": {"id": "candle_a", "label": "蜡烛", "image": "/resources/runtime/images/props/c.png", "widthCm": 4, "heightCm": 30,
                 "mode": "consume", "particles": [{"effect": "burn_flame", "from": "flame"}]},
    "nosize": {"id": "nosize", "image": "/resources/runtime/images/props/d.png", "mode": "spread"},
}


def _write_templates(project_root: Path) -> Path:
    d = bn.burnables_dir(project_root)
    d.mkdir(parents=True, exist_ok=True)
    for tid, doc in TEMPLATES.items():
        (d / f"{tid}.json").write_bytes(bn.dumps(doc))
    (d / "broken.json").write_bytes(b"{ not json")
    return d


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(assets, "VFX_DIR", tmp_path / "vfx")
    monkeypatch.setattr(assets, "BURN_ROOT", tmp_path / "burnroot")
    monkeypatch.setattr(placements, "LIB_ROOT", tmp_path / "libroot")
    monkeypatch.setattr(placements, "REF_ROOT", tmp_path / "refroot")
    _write_templates(tmp_path / "burnroot")
    return tmp_path


# ---------------------------------------------------------------------------
# external
# ---------------------------------------------------------------------------

def test_external_shape_round_trips_byte_identical(world) -> None:
    for shape in ({"kind": "external"}, {"kind": "external", "jitter": 0}, {"kind": "external", "jitter": 2},
                  {"kind": "external", "jitter": 0.35, "future": [1, 2]}):
        doc = {"id": "fire_tongues", "emitters": [_particle(shape=dict(shape))]}
        warn: list[str] = []
        p, norm, _w = assets.save_asset(doc)
        raw = p.read_bytes()
        again = assets.normalize_effect(assets.load_asset("fire_tongues"), warn)
        assert assets.dumps(again) == raw, "落盘形再过一次闸门必须逐字节不变"
        out = norm["emitters"][0]["spawn"]["shape"]
        assert out == shape, f"不补 jitter 缺省、不改值、未知键留着：{out}"
        if "jitter" in shape:
            assert type(out["jitter"]) is type(shape["jitter"]), "int 不许漂成 float"
        assert not [w for w in warn if "external" in w], warn


@pytest.mark.parametrize("jitter", [-0.1, "1", None, True, float("inf"), float("nan")])
def test_external_jitter_must_be_a_non_negative_number(jitter) -> None:
    doc = {"id": "x", "emitters": [_particle(shape={"kind": "external", "jitter": jitter})]}
    with pytest.raises(ValueError, match="jitter"):
        assets.normalize_effect(doc)


def test_unknown_shape_kind_still_rejected() -> None:
    with pytest.raises(ValueError, match="kind 未知"):
        assets.normalize_effect({"id": "x", "emitters": [_particle(shape={"kind": "externall"})]})


def test_external_with_surface_placement_or_flock_warns() -> None:
    em = _particle(shape={"kind": "external"})
    em["simulation"] = {"solver": "particle", "spawnPlacement": "surface", "influences": {
        "sceneWind": False, "wind": False, "airflow": False, "stimulus": False}, "recycle": {"mode": "none"}}
    warn: list[str] = []
    assets.normalize_effect({"id": "x", "emitters": [em]}, warn)
    assert any("发射区域的可见表面" in w and "external" in w for w in warn), warn
    assert vfx_burn.external_shape_notes({"kind": "external"}, "flock", "shape")
    assert vfx_burn.external_shape_notes({"kind": "external"}, "particle", "shape") == []


# ---------------------------------------------------------------------------
# plate.burnable：形状闸门
# ---------------------------------------------------------------------------

def _burn_warns(warn: list[str]) -> list[str]:
    return [w for w in warn if "plate.burnable" in w]


def test_plate_burnable_round_trips_byte_identical_last_in_plate(world) -> None:
    for binding in ({"template": "paper_a"}, {"zzFuture": {"a": 1}, "template": "paper_min"}):
        doc = {"id": "paper_money_t", "emitters": [_paper(dict(binding))]}
        warn: list[str] = []
        p, norm, _w = assets.save_asset(doc)
        raw = p.read_bytes()
        again = assets.normalize_effect(assets.load_asset("paper_money_t"), warn)
        assert assets.dumps(again) == raw, "落盘形再过一次闸门必须逐字节不变"
        plate = norm["emitters"][0]["plate"]
        assert plate["burnable"] == binding, "不补缺省、不改值、未知键留着"
        assert list(plate.keys())[-1] == "burnable", "burnable 排在 plate 的最后（types.ts VfxPlateDef 键序）"
        assert list(plate["burnable"].keys())[0] == "template", "template 在前（PLATE_BURNABLE_ORDER），未知键在后"
        assert _burn_warns(warn) == [], warn


@pytest.mark.parametrize("binding", [[], None, "paper_a", 3, {}, {"template": ""}, {"template": "   "}, {"template": 3},
                                     {"template": None}])
def test_bad_plate_burnable_shapes_are_refused(world, binding) -> None:
    with pytest.raises(ValueError, match="plate.burnable"):
        assets.normalize_effect({"id": "x", "emitters": [_paper(binding)]})
    assert vfx_burn.plate_burnable_problems(binding), "闸门拒的与共享口径一致"


def test_plate_burnable_notes_name_why_the_paper_will_not_burn(world) -> None:
    def notes(tid: str) -> list[str]:
        warn: list[str] = []
        assets.normalize_effect({"id": "paper_money_t", "emitters": [_paper({"template": tid})]}, warn)
        return _burn_warns(warn)

    assert notes("paper_a") == [] and notes("paper_min") == [] and notes(" paper_a ") == [], "去空白后能绑 = 不提醒（运行时 trim）"
    assert len(notes("nope")) == 1 and "不在" in notes("nope")[0] and "发射器「paper」" in notes("nope")[0]
    assert len(notes("broken")) == 1 and "读不懂" in notes("broken")[0], "读不懂的文件不在表里"
    assert len(notes("candle_a")) == 1 and "消耗燃烧" in notes("candle_a")[0]
    assert len(notes("nosize")) == 1 and "真实尺寸" in notes("nosize")[0]


def test_notes_are_only_computed_when_a_plate_binds_a_template(world, monkeypatch) -> None:
    """没人绑模板时不读模板目录（与运行时同判据：只有 plate.burnable 才装模板）。"""
    calls: list[int] = []
    real = assets.burn_templates
    monkeypatch.setattr(assets, "burn_templates", lambda: calls.append(1) or real())
    assets.normalize_effect({"id": "x", "emitters": [_paper(), _particle()]})
    assert calls == []
    assets.normalize_effect({"id": "x", "emitters": [_paper({"template": "paper_a"})]})
    assert calls == [1]


def test_candidates_equal_the_zero_note_set(world) -> None:
    """候选面 = 校验面：检视器候选（``plate_bindable_template_ids`` / ``/api/burnables`` 的 bindable）
    与形状闸门零提醒的集合逐 id 相等——临时工程与工程真模板各验一遍。"""
    for root in (world / "burnroot", _ROOT):
        docs, errors = bn.load_all_burnables(root)
        bindable = set(vfx_burn.plate_bindable_template_ids(docs))
        probe = set(docs) | set(errors) | {"nope"}
        zero = {tid for tid in probe if not vfx_burn.plate_burnable_notes({"template": tid}, docs)}
        assert bindable == zero, (root, bindable, zero)
    assert bindable, "工程里至少有一份能绑的面燃烧模板（纸钱）"
    docs, _ = bn.load_all_burnables(world / "burnroot")
    assert set(vfx_burn.plate_bindable_template_ids(docs)) == {"paper_a", "paper_min"}


def test_legacy_flammable_warns_but_saves_untouched(world) -> None:
    legacy = {"ignitionDelay": 0.4, "burnSeconds": 3, "fireEffect": "paper_fire"}
    doc = {"id": "paper_money_t", "emitters": [_paper({"template": "paper_a"}, flammable=dict(legacy))]}
    p, norm, warn = assets.save_asset(doc)
    assert norm["emitters"][0]["plate"]["flammable"] == legacy, "作废的旧块不替作者删、不改值（检视器有「删掉」）"
    hits = [w for w in warn if "plate.flammable" in w]
    assert len(hits) == 1 and "作废" in hits[0] and "运行时不读" in hits[0], warn
    assert assets.dumps(assets.normalize_effect(assets.load_asset("paper_money_t"))) == p.read_bytes()
    # 只有旧块没有新绑定：照样能存
    _p2, norm2, warn2 = assets.save_asset({"id": "paper_old", "emitters": [_paper(flammable={})]})
    assert norm2["emitters"][0]["plate"]["flammable"] == {} and [w for w in warn2 if "plate.flammable" in w]


def test_real_paper_money_binds_a_bindable_template() -> None:
    """工程里已迁好的纸钱：绑的模板能绑、过闸门零提醒（候选里就有它）。"""
    doc = assets.load_asset("paper_money")
    if doc is None:
        pytest.skip("工程里没有 paper_money 效果")
    warn: list[str] = []
    norm = assets.normalize_effect(doc, warn)
    bound = [e["plate"]["burnable"]["template"] for e in norm["emitters"] if isinstance(e.get("plate"), dict) and "burnable" in e["plate"]]
    assert bound, "paper_money 的薄片应已绑可燃模板"
    docs, _ = bn.load_all_burnables(_ROOT)
    assert set(bound) <= set(vfx_burn.plate_bindable_template_ids(docs))
    assert _burn_warns(warn) == [] and not [w for w in warn if "flammable" in w], warn


# ---------------------------------------------------------------------------
# /api/burnables 与 /api/open_burn_workbench（真 HTTP，进程内）
# ---------------------------------------------------------------------------

@pytest.fixture()
def http(world):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def get(path):
        with urllib.request.urlopen(base + path) as r:
            return json.loads(r.read()), r.headers

    def post(path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    yield get, post
    httpd.shutdown()


def test_api_burnables_lists_every_template_with_bindable_note_summary_and_raw_doc(world, http) -> None:
    get, _post = http
    j, headers = get("/api/burnables")
    assert j["ok"] is True and "no-store" in headers.get("Cache-Control", "")
    rows = {r["id"]: r for r in j["templates"]}
    assert list(rows) == sorted(TEMPLATES), "按 id 排序、读得懂的全列（不能绑的也列：检视器要保值展示并说原因）"
    assert set(j["errors"]) == {"broken"} and "broken.json" in j["errors"]["broken"]
    docs = {tid: json.loads(bn.dumps(doc)) for tid, doc in TEMPLATES.items()}
    for tid, r in rows.items():
        assert r["doc"] == docs[tid], "原始文档原样给（页面过运行时 resolveBurnable，不在这里清洗）"
        assert r["bindable"] == (tid in vfx_burn.plate_bindable_template_ids(docs))
        assert r["summary"] == vfx_burn.plate_template_summary(docs[tid])
        assert r["label"] == r["summary"]["label"] and r["mode"] == r["summary"]["mode"]
        want_note = vfx_burn.plate_burnable_notes({"template": tid}, docs)
        assert r["note"] == (want_note[0] if want_note else ""), "不能绑的原因与形状闸门同一句"
    assert rows["paper_a"]["bindable"] and rows["paper_min"]["bindable"]
    assert not rows["candle_a"]["bindable"] and "消耗燃烧" in rows["candle_a"]["note"] and rows["candle_a"]["mode"] == "consume"
    assert not rows["nosize"]["bindable"] and "真实尺寸" in rows["nosize"]["note"]
    sa, sm = rows["paper_a"]["summary"], rows["paper_min"]["summary"]
    assert sa["defaulted"] == [] and sa["speedOpposed"] == 6 and sa["particles"] == ["burn_flame（flame）", "burn_ash（ash）"] and sa["light"]
    assert set(sm["defaulted"]) == {"ignitionDelay", "flameLength", "speedOpposed", "speedConcurrent", "flameSeconds", "emberSeconds"}
    assert sm["ignitionDelay"] == bn.DEFAULTS["ignitionDelay"] and sm["label"] == "" and sm["light"] is False


def test_api_burnables_with_no_template_dir_is_an_empty_table(tmp_path, monkeypatch, http) -> None:
    get, _post = http
    monkeypatch.setattr(assets, "BURN_ROOT", tmp_path / "nowhere")
    j, _h = get("/api/burnables")
    assert j == {"ok": True, "templates": [], "errors": {}}


def test_open_burn_workbench_spawns_a_detached_process_with_the_template(world, http, monkeypatch) -> None:
    _get, post = http
    calls: list[tuple[list, dict]] = []

    class FakePopen:
        def __init__(self, cmd, **kwargs):
            calls.append((list(cmd), dict(kwargs)))

    monkeypatch.setattr(serve.subprocess, "Popen", FakePopen)
    code, j = post("/api/open_burn_workbench", {"id": "paper_a"})
    assert code == 200 and j["ok"] is True and "paper_a" in j["message"], j
    code, j = post("/api/open_burn_workbench", {})
    assert code == 200 and j["ok"] is True
    assert [c for c, _k in calls] == [[sys.executable, "-m", "tools.burn_workbench", "--open", "paper_a"],
                                      [sys.executable, "-m", "tools.burn_workbench"]]
    for _c, kw in calls:
        assert kw["cwd"] == str(serve.ROOT) and Path(kw["cwd"]) == _ROOT, "cwd = 仓库根"
        if sys.platform == "win32":
            assert kw["creationflags"] == subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            assert "creationflags" not in kw
    # 不是模板 id 的写法（会被当成命令行参数 / 带路径分隔符）：不起进程、回错
    for bad in ("--serve", "-x", "a/b", "a b"):
        code, j = post("/api/open_burn_workbench", {"id": bad})
        assert code == 400 and j["ok"] is False, (bad, j)
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# 效果被可燃物模板按 id 引用 = 外部引用
# ---------------------------------------------------------------------------

def _ref_templates(world: Path) -> tuple[Path, bytes]:
    d = bn.burnables_dir(world / "refroot")
    d.mkdir(parents=True, exist_ok=True)
    doc = {"id": "paper_pile_t", "image": "/x.png", "widthCm": 70, "heightCm": 40,
           "particles": [{"effect": "burn_flame", "from": "flame"}, {"effect": "burn_ember", "from": "ember"},
                         {"effect": " burn_flame ", "from": "ash"}]}
    raw = bn.dumps(doc)
    (d / "paper_pile_t.json").write_bytes(raw)
    (d / "zz_broken.json").write_bytes(b"{")
    return d / "paper_pile_t.json", raw


def test_template_particles_are_external_refs_to_the_effect(world) -> None:
    tpl, _raw = _ref_templates(world)
    refs = placements.external_refs_to_effect("burn_flame")
    assert refs == [
        {"kind": "burnable", "burnable": "paper_pile_t", "file": "public/assets/data/burnables/paper_pile_t.json",
         "where": "paper_pile_t · particles[0]", "label": "可燃物模板「paper_pile_t」· particles[0]（flame）"},
        {"kind": "burnable", "burnable": "paper_pile_t", "file": "public/assets/data/burnables/paper_pile_t.json",
         "where": "paper_pile_t · particles[2]", "label": "可燃物模板「paper_pile_t」· particles[2]（ash）"},
    ], refs
    assert [r["where"] for r in placements.external_refs_to_effect("burn_ember")] == ["paper_pile_t · particles[1]"]
    assert placements.external_refs_to_effect("burn_ash") == []
    # 模板目录不进动作 / 实例引用那条深遍历：同一个文件不在两条扫描里各算一遍
    assert not [p for p in placements._ref_files() if "burnables" in p.parts], placements._ref_files()
    assert tpl.is_file()


def test_template_refs_refuse_rename_and_need_confirm_to_delete_without_touching_the_template(world) -> None:
    tpl, raw = _ref_templates(world)
    assets.save_asset({"id": "burn_flame", "emitters": [_particle()]})
    with pytest.raises(ValueError) as e:
        placements.rename_effect("burn_flame", "burn_flame2")
    msg = str(e.value)
    assert "paper_pile_t" in msg and "燃烧工作台里打开模板「paper_pile_t」改粒子" in msg and "主编辑器" not in msg, msg
    assert (world / "vfx" / "burn_flame.json").is_file() and not (world / "vfx" / "burn_flame2.json").exists()
    r = placements.delete_effect("burn_flame", with_placements=False)
    assert r["deleted"] is False and r["needConfirm"] is True and len(r["externalRefs"]) == 2
    assert (world / "vfx" / "burn_flame.json").is_file()
    r = placements.delete_effect("burn_flame", with_placements=False, confirm_external=True)
    assert r["deleted"] is True and not (world / "vfx" / "burn_flame.json").exists()
    assert tpl.read_bytes() == raw, "改名 / 删除不改引用它的模板文件（模板归燃烧工作台写）"


def test_fix_hint_mixes_main_editor_files_and_burn_workbench_templates() -> None:
    refs = [{"kind": "prop", "file": "public/assets/data/prop_presets.json"},
            {"kind": "action", "file": "public/assets/dialogues/a.json"},
            {"kind": "burnable", "burnable": "paper_pile", "file": "public/assets/data/burnables/paper_pile.json"},
            {"kind": "burnable", "burnable": "candle_red", "file": "public/assets/data/burnables/candle_red.json"},
            {"kind": "burnable", "burnable": "paper_pile", "file": "public/assets/data/burnables/paper_pile.json"}]
    assert placements.refs_fix_hint(refs) == (
        "在主编辑器里改掉 public/assets/data/prop_presets.json / public/assets/dialogues/a.json 里的这些引用、"
        "在燃烧工作台里打开模板「candle_red」/「paper_pile」改粒子")
    assert placements.refs_fix_hint(refs[2:3]) == "在燃烧工作台里打开模板「paper_pile」改粒子"


@pytest.mark.skipif(bundle.node_exe() is None, reason="没有 node")
def test_page_fix_hint_is_the_same_sentence_as_the_server() -> None:
    """页面 ``extRefsFixHint``（删除确认 / 改名拒绝的状态栏）与服务端 ``refs_fix_hint`` 逐字同句：拿 node 真跑页面那段函数。"""
    src = (_ROOT / "tools" / "vfx_workbench" / "viewer" / "app.js").read_text(encoding="utf-8")
    m = re.search(r"^function extRefsFixHint\(refs\) \{.*?^\}", src, re.S | re.M)
    assert m, "app.js 里的 extRefsFixHint 不见了"
    cases = [
        [{"kind": "burnable", "burnable": "paper_pile", "file": "public/assets/data/burnables/paper_pile.json"}],
        [{"kind": "prop", "file": "public/assets/data/prop_presets.json"},
         {"kind": "burnable", "burnable": "b", "file": "public/assets/data/burnables/b.json"},
         {"kind": "burnable", "burnable": "a", "file": "public/assets/data/burnables/a.json"},
         {"kind": "action", "file": "public/assets/data/quests.json"}],
        [{"kind": "action", "file": "public/assets/scenes/x.json"}],
    ]
    script = m.group(0) + f"\nprocess.stdout.write(JSON.stringify({json.dumps(cases, ensure_ascii=False)}.map(extRefsFixHint)));"
    r = subprocess.run([bundle.node_exe(), "-e", script], capture_output=True, timeout=60)
    assert r.returncode == 0, r.stderr.decode("utf-8", "replace")
    assert json.loads(r.stdout.decode("utf-8")) == [placements.refs_fix_hint(c) for c in cases]
