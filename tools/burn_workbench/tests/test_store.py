# -*- coding: utf-8 -*-
"""盘面读写：保存往返字节稳定、数值表示保真、基线冲突拒写、尺寸必填、改名跟着改所有引用处（一次事务、只动那几个值的字节、
确认之后被改过就拒绝、失败回滚）、删除有引用就拒绝、``--check``。全部在临时样例工程里，真库一个字节不碰。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.burn_workbench import fixtures, store  # noqa: E402
from tools.editor.shared import burnables as B    # noqa: E402

SCENE_REL = f"public/assets/scenes/{fixtures.SCENE}.json"
PRESETS_REL = "public/assets/data/prop_presets.json"
PLATE_REL = "public/assets/data/vfx/zz_paper_money.json"


@pytest.fixture()
def proj(tmp_path, monkeypatch):
    fixtures.build_project(tmp_path)
    monkeypatch.setattr(store, "PROJECT", tmp_path)
    monkeypatch.setattr(store, "DATA", tmp_path)
    return tmp_path


def _asset_bytes(root: Path, bid: str) -> bytes:
    return (B.burnables_dir(root) / f"{bid}.json").read_bytes()


def _snapshot(root: Path) -> dict[str, bytes]:
    base = root / "public"
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(base.rglob("*.json"))}


# ---------------------------------------------------------------------------- 清单 / 保存

def test_list_and_load(proj):
    rows = {r["id"]: r for r in store.list_assets()}
    assert set(rows) == {"paper_pile", "candle_red", "zz_loose"}
    assert rows["candle_red"]["mode"] == "consume" and not rows["paper_pile"]["idMismatch"]
    assert rows["paper_pile"]["widthCm"] == 136.36 and rows["paper_pile"]["heightCm"] == 90.91
    (B.burnables_dir(proj) / "broken.json").write_bytes(b"{not json")
    rows = {r["id"]: r for r in store.list_assets()}
    assert "error" in rows["broken"], "坏文件也要列出来（别让一个坏文件藏起整批）"


def test_save_unchanged_writes_nothing_and_roundtrip_is_byte_stable(proj):
    before = _asset_bytes(proj, "paper_pile")
    doc = store.load_asset("paper_pile")
    p, norm, _w, written = store.save_asset(json.loads(json.dumps(doc)), doc)
    assert written is False and _asset_bytes(proj, "paper_pile") == before
    doc2 = store.load_asset("paper_pile")
    doc2["label"] = "改过"
    _p, _n, _w, written = store.save_asset(doc2, store.load_asset("paper_pile"))
    assert written
    once = _asset_bytes(proj, "paper_pile")
    _p, _n, _w, written = store.save_asset(store.load_asset("paper_pile"), store.load_asset("paper_pile"))
    assert written is False and _asset_bytes(proj, "paper_pile") == once
    assert once.endswith(b"\n") and b"\r\n" not in once


def test_js_number_repr_does_not_drift_on_save(proj):
    """页面是 JS：盘上 12.0 进页面再回来是 12。改别的字段时，相等的数按盘上表示回写。"""
    assert b'"intensityPerM2": 12.0' in _asset_bytes(proj, "paper_pile")
    doc = json.loads(json.dumps(store.load_asset("paper_pile")))
    doc["light"]["intensityPerM2"] = 12          # JS 往返后的样子
    doc["flameSeconds"] = 2                      # 真改了的
    _p, norm, _w, written = store.save_asset(doc, store.load_asset("paper_pile"))
    raw = _asset_bytes(proj, "paper_pile")
    assert written and b'"intensityPerM2": 12.0' in raw and b'"flameSeconds": 2,' in raw
    assert isinstance(json.loads(raw)["gridCells"], int)


def test_save_key_order_follows_shared_gate(proj):
    doc = {"orientation": "ground", "mode": "spread", "grip": {"v": 1, "u": 0.5}, "heightCm": 10, "image": fixtures.PAPER_IMG,
           "widthCm": 20, "id": "zz_order", "zzUnknown": 1}
    store.atomic_write(store.asset_path("zz_order"), B.dumps(doc))
    store.save_asset(dict(doc, label="x"), store.load_asset("zz_order"))
    saved = json.loads(_asset_bytes(proj, "zz_order"))
    assert list(saved.keys()) == ["id", "label", "image", "widthCm", "heightCm", "grip", "mode", "orientation", "zzUnknown"], list(saved)
    assert list(saved["grip"].keys()) == ["u", "v"]


def test_save_refuses_when_disk_changed_elsewhere(proj):
    base = store.load_asset("paper_pile")
    other = dict(base, label="别处改的")
    store.save_asset(other)
    mine = dict(base, flameSeconds=9)
    with pytest.raises(ValueError, match="别处"):
        store.save_asset(mine, base)
    assert json.loads(_asset_bytes(proj, "paper_pile"))["label"] == "别处改的"


def test_shape_gate_rejects_and_size_is_required(proj):
    doc = store.load_asset("paper_pile")
    with pytest.raises(ValueError):
        store.save_asset(dict(doc, gridCells=32.5), doc)
    with pytest.raises(ValueError):
        store.save_asset(dict(doc, id="bad id"), doc)
    with pytest.raises(ValueError, match="widthCm"):
        store.save_asset({k: v for k, v in doc.items() if k != "widthCm"}, doc)
    with pytest.raises(ValueError, match="heightCm"):
        store.save_asset(dict(doc, heightCm=0), doc)
    with pytest.raises(ValueError, match="grip"):
        store.save_asset(dict(doc, grip={"u": 0.5, "v": 1.5}), doc)
    with pytest.raises(ValueError):
        store.asset_path("../escape")
    assert _asset_bytes(proj, "paper_pile") == B.dumps(fixtures.paper_doc())


def test_create_requires_size_and_orders_keys(proj):
    with pytest.raises(FileExistsError):
        store.create_asset("paper_pile", fixtures.PAPER_IMG, width_cm=10, height_cm=10)
    with pytest.raises(ValueError, match="widthCm"):
        store.create_asset("zz_nosize", fixtures.PAPER_IMG)
    assert not (B.burnables_dir(proj) / "zz_nosize.json").exists(), "缺尺寸一个字节都不写"
    p, norm = store.create_asset("新纸", fixtures.PAPER_IMG, "新的", "consume", "upright", 30, 20.5)
    assert norm == {"id": "新纸", "label": "新的", "image": fixtures.PAPER_IMG, "widthCm": 30, "heightCm": 20.5, "mode": "consume", "orientation": "upright"}
    assert list(json.loads(p.read_bytes())) == ["id", "label", "image", "widthCm", "heightCm", "mode", "orientation"]


def test_duplicate_takes_working_copy_and_leaves_source(proj):
    before = _asset_bytes(proj, "paper_pile")
    working = dict(store.load_asset("paper_pile"), label="页面上的")
    _p, norm = store.duplicate_asset("paper_pile", "paper_copy", working)
    assert norm["id"] == "paper_copy" and norm["label"] == "页面上的"
    assert _asset_bytes(proj, "paper_pile") == before
    with pytest.raises(FileExistsError):
        store.duplicate_asset("paper_pile", "candle_red")


def test_aspect_deviation():
    assert store.aspect_deviation(136.36, 90.91, 96, 64) < 0.001
    assert abs(store.aspect_deviation(30, 30, 96, 64) - 1 / 3) < 1e-9
    assert store.aspect_deviation(None, 1, 1, 1) is None and store.aspect_deviation(1, 1, 0, 1) is None


# ---------------------------------------------------------------------------- 用在哪

def test_template_refs_cover_every_host_kind(proj):
    refs = store.template_refs("paper_pile")
    kinds = sorted((r["kind"], r.get("entity") or r.get("effect") or "") for r in refs)
    assert kinds == [("hotspot", "hs_paper"), ("hotspot", "hs_paper2"), ("npc", "npc_paper"), ("plate", "zz_paper_money")], kinds
    refs = store.template_refs("candle_red")
    kinds = sorted((r["kind"], r.get("entity") or r.get("prop") or "") for r in refs)
    assert kinds == [("hotspot", "hs_candle"), ("prop", "zz_incense_prop"), ("spawn", "zz_thrown_candle")], kinds
    assert store.template_refs("zz_loose") == []


# ---------------------------------------------------------------------------- JSON 文本区间

def test_string_value_spans_exact_and_only_the_wanted_paths():
    text = '{\n  "a\\"b": [1, {"burnable": {"template": "x\\u0041", "note": "template"}}],\n  "template": "x", "e": []\n}'
    spans = store.string_value_spans(text, [("a\"b", 1, "burnable", "template"), ("nope",)])
    assert set(spans) == {("a\"b", 1, "burnable", "template")}
    a, b = spans[("a\"b", 1, "burnable", "template")]
    assert text[a:b] == '"x\\u0041"'
    with pytest.raises(ValueError):
        store.string_value_spans('{"a": [1, 2', [("a",)])
    with pytest.raises(ValueError):
        store.string_value_spans('{"a": 1} x', [("a",)])


# ---------------------------------------------------------------------------- 改名

def test_rename_plan_lists_files_and_changes_nothing(proj):
    before = _snapshot(proj)
    plan = store.rename_plan("candle_red", "蜡烛_新")
    assert sorted((f["file"], f["count"]) for f in plan["files"]) == [
        (PRESETS_REL, 1), (fixtures.CUTSCENE_REL, 1), (SCENE_REL, 1)]
    assert set(plan["expect"]) == {PRESETS_REL, fixtures.CUTSCENE_REL, SCENE_REL, "public/assets/data/burnables/candle_red.json"}
    assert len(plan["refs"]) == 3
    assert _snapshot(proj) == before, "改名清单一个字节不写"
    with pytest.raises(FileExistsError):
        store.rename_plan("candle_red", "paper_pile")
    with pytest.raises(FileNotFoundError):
        store.rename_plan("nope", "nope2")


def test_rename_rewrites_only_the_template_values_byte_exact(proj):
    before = _snapshot(proj)
    plan = store.rename_plan("candle_red", "蜡烛_新")
    r = store.rename_asset("candle_red", "蜡烛_新", plan["expect"])
    assert r["refsChanged"] == 3 and sorted(r["files"]) == sorted(f["file"] for f in plan["files"])
    after = _snapshot(proj)
    # 场景 / 挂件预设：ensure_ascii=False + LF，只差那一个值
    for rel in (SCENE_REL, PRESETS_REL):
        assert after[rel] == before[rel].replace(b'"template": "candle_red"', '"template": "蜡烛_新"'.encode("utf-8")), rel
    # 故意 ensure_ascii + CRLF 的演出文件：照它的风格转义、CRLF 保住
    esc = json.dumps("蜡烛_新", ensure_ascii=True).encode("ascii")
    assert after[fixtures.CUTSCENE_REL] == before[fixtures.CUTSCENE_REL].replace(b'"template": "candle_red"', b'"template": ' + esc)
    assert b"\r\n" in after[fixtures.CUTSCENE_REL] and after[fixtures.CUTSCENE_REL].isascii()
    # 模板文件换名、id 跟着换，其余不动
    assert "public/assets/data/burnables/candle_red.json" not in after
    new_doc = json.loads(after["public/assets/data/burnables/蜡烛_新.json"])
    assert new_doc == dict(fixtures.candle_doc(), id="蜡烛_新")
    # 其余文件逐字节不变
    touched = set(r["files"]) | {"public/assets/data/burnables/candle_red.json", "public/assets/data/burnables/蜡烛_新.json"}
    assert {k: v for k, v in after.items() if k not in touched} == {k: v for k, v in before.items() if k not in touched}
    assert [x["template"] for x in B.scan_template_refs(proj) if x["template"] in ("candle_red", "蜡烛_新")] == ["蜡烛_新"] * 3


def test_rename_refuses_when_a_ref_file_changed_after_the_plan(proj):
    plan = store.rename_plan("paper_pile", "paper_x")
    sp = proj / SCENE_REL
    raw = sp.read_bytes()
    assert b'"worldWidth": 1600' in raw
    sp.write_bytes(raw.replace(b'"worldWidth": 1600', b'"worldWidth": 1601'))
    before = _snapshot(proj)
    with pytest.raises(ValueError, match=r"确认之后被别处改过：public/assets/scenes/zz_burn_room\.json"):
        store.rename_asset("paper_pile", "paper_x", plan["expect"])
    assert _snapshot(proj) == before, "拒绝时一个字节不写"


def test_rename_refuses_when_a_new_ref_file_appears(proj):
    plan = store.rename_plan("paper_pile", "paper_x")
    extra = proj / "public" / "assets" / "data" / "zz_more.json"
    extra.write_bytes(json.dumps({"x": {"id": "e1", "burnable": {"template": "paper_pile"}}}).encode("utf-8"))
    before = _snapshot(proj)
    with pytest.raises(ValueError, match="多出了引用它的文件：public/assets/data/zz_more.json"):
        store.rename_asset("paper_pile", "paper_x", plan["expect"])
    assert _snapshot(proj) == before


def test_rename_refuses_when_template_file_changed_after_the_plan(proj):
    plan = store.rename_plan("paper_pile", "paper_x")
    store.save_asset(dict(store.load_asset("paper_pile"), label="别处改的"))
    with pytest.raises(ValueError, match="burnables/paper_pile.json"):
        store.rename_asset("paper_pile", "paper_x", plan["expect"])
    assert (B.burnables_dir(proj) / "paper_pile.json").exists() and not (B.burnables_dir(proj) / "paper_x.json").exists()


def test_rename_rolls_back_every_file_when_a_step_fails(proj, monkeypatch):
    before = _snapshot(proj)
    real_retry = store.retry_transient

    def boom(op, *a, **k):
        if op is os.unlink and a and Path(a[0]).name == "paper_pile.json":
            raise OSError("被占用")
        return real_retry(op, *a, **k)

    monkeypatch.setattr(store, "retry_transient", boom)
    with pytest.raises(RuntimeError, match="已回滚"):
        store.rename_asset("paper_pile", "paper_y")
    monkeypatch.setattr(store, "retry_transient", real_retry)
    assert _snapshot(proj) == before, "场景 / 粒子效果的引用写回原样，新模板文件删掉"


def test_rename_rolls_back_when_a_middle_ref_write_fails(proj, monkeypatch):
    before = _snapshot(proj)
    real_write = store.atomic_write
    calls = {"n": 0}

    def flaky(path, data):
        # 写的顺序：新模板 → 粒子效果（已写成）→ 场景（这一下炸）；回滚要把粒子效果写回原样
        calls["n"] += 1
        if Path(path).name == f"{fixtures.SCENE}.json" and calls["n"] == 3:
            raise OSError("磁盘满")
        return real_write(path, data)

    monkeypatch.setattr(store, "atomic_write", flaky)
    with pytest.raises(RuntimeError, match="已回滚"):
        store.rename_asset("paper_pile", "paper_z")
    monkeypatch.setattr(store, "atomic_write", real_write)
    assert calls["n"] == 4, calls
    assert _snapshot(proj) == before


def test_rename_refusals(proj):
    with pytest.raises(FileExistsError):
        store.rename_asset("paper_pile", "candle_red")
    with pytest.raises(FileNotFoundError):
        store.rename_asset("nope", "nope2")
    with pytest.raises(ValueError):
        store.rename_asset("paper_pile", "bad id")
    with pytest.raises(ValueError):
        store.rename_asset("paper_pile", "paper_pile")
    with pytest.raises(ValueError, match="确认单"):
        store.rename_asset("paper_pile", "paper_q", expect="x")


def test_rename_without_refs_only_moves_the_template(proj):
    before = _snapshot(proj)
    plan = store.rename_plan("zz_loose", "zz_loose2")
    assert plan["files"] == [] and plan["refs"] == []
    r = store.rename_asset("zz_loose", "zz_loose2", plan["expect"])
    assert r["refsChanged"] == 0 and r["files"] == []
    after = _snapshot(proj)
    assert set(before) ^ set(after) == {"public/assets/data/burnables/zz_loose.json", "public/assets/data/burnables/zz_loose2.json"}


# ---------------------------------------------------------------------------- 删除

def test_delete_refuses_while_referenced(proj):
    before = _snapshot(proj)
    r = store.delete_asset("paper_pile")
    assert r["deleted"] is False and len(r["refs"]) == 4
    assert _snapshot(proj) == before


def test_delete_unreferenced(proj):
    r = store.delete_asset("zz_loose")
    assert r == {"deleted": True, "refs": []}
    assert not (B.burnables_dir(proj) / "zz_loose.json").exists()
    assert store.delete_asset("zz_loose") == {"deleted": False, "refs": []}


# ---------------------------------------------------------------------------- --check

def _check(capsys) -> tuple[int, str]:
    from tools.burn_workbench import __main__ as cli
    lines: list[str] = []
    n = cli.check(out=lines.append)
    return n, "\n".join(lines)


def test_check_passes_on_fixture_and_reports_problems(proj, capsys):
    n, out = _check(capsys)
    assert n == 0, out
    assert "7 处宿主引用模板" in out
    # 尺寸宽高比偏了：只警告
    doc = store.load_asset("zz_loose")
    store.save_asset(dict(doc, widthCm=30, heightCm=30))
    n, out = _check(capsys)
    assert n == 0 and "宽高比与图" in out, out
    # 引用了不存在的模板
    sp = proj / SCENE_REL
    sp.write_bytes(sp.read_bytes().replace(b'"template": "candle_red"', b'"template": "ghost"'))
    n, out = _check(capsys)
    assert n == 1 and "模板「ghost」不存在" in out, out
    sp.write_bytes(sp.read_bytes().replace(b'"template": "ghost"', b'"template": "candle_red"'))
    # 粒子薄片绑了消耗燃烧模板
    pp = proj / PLATE_REL
    pp.write_bytes(pp.read_bytes().replace(b'"template": "paper_pile"', b'"template": "candle_red"'))
    n, out = _check(capsys)
    assert n == 1 and "只能绑面燃烧模板" in out, out
    pp.write_bytes(pp.read_bytes().replace(b'"template": "candle_red"', b'"template": "paper_pile"'))
    # 图不在 / 粒子效果不在 / 形状坏
    store.save_asset(dict(store.load_asset("zz_loose"), image="/resources/runtime/images/zz_burn/nope.png",
                          particles=[{"effect": "ghost_fx", "from": "flame"}]))
    (B.burnables_dir(proj) / "zz_bad.json").write_bytes(B.dumps({"id": "zz_bad", "image": fixtures.PAPER_IMG, "mode": "spread"}))
    n, out = _check(capsys)
    assert n == 3 and "图不存在" in out and "ghost_fx" in out and "zz_bad\t✗" in out, out


def test_check_cli_exit_code(proj, monkeypatch, capsys):
    from tools.burn_workbench import __main__ as cli
    monkeypatch.setattr(sys, "argv", ["burn_workbench", "--check"])
    assert cli.main() == 0
    (B.burnables_dir(proj) / "zz_bad.json").write_bytes(B.dumps({"id": "zz_bad", "image": fixtures.PAPER_IMG}))
    assert cli.main() == 1
    monkeypatch.setattr(sys, "argv", ["burn_workbench", "--list"])
    assert cli.main() == 0
    out = capsys.readouterr().out
    assert "paper_pile\t纸钱堆\tspread\t136.36×90.91 cm" in out and "4 处在用" in out
