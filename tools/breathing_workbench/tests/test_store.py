# -*- coding: utf-8 -*-
"""呼吸图盘面:形状闸门(与运行时同口径、不改数值、未知参数原样保留 + 告警)、只许改参数与名字(烘焙产物改了拒存)、
别处改过拒写、没改不写、数值写法保真、不新建;体检(图 / 位移场在不在、大小对不对);``--check`` 与 ``--list``。
全部在临时样例工程里。"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.breathing_workbench import fixtures, store  # noqa: E402


@pytest.fixture()
def proj(tmp_path, monkeypatch):
    fixtures.build_project(tmp_path)
    monkeypatch.setattr(store, "PROJECT", tmp_path)
    monkeypatch.setattr(store, "DATA", tmp_path)
    return tmp_path


def _doc():
    return store.load_asset(fixtures.ASSET_ID)


def test_list_and_load(proj):
    rows = store.list_assets()
    assert [r["id"] for r in rows] == [fixtures.ASSET_ID]
    assert rows[0]["size"] == [fixtures.W, fixtures.H]
    assert _doc()["id"] == fixtures.ASSET_ID


def test_normalize_orders_keys_and_keeps_values(proj):
    d = _doc()
    shuffled = {k: d[k] for k in reversed(list(d))}
    norm, warn = store.normalize(shuffled, fixtures.ASSET_ID)
    assert list(norm) == [k for k in store.KEY_ORDER if k in norm]
    assert norm["params"] == {k: d["params"][k] for k in store.param_defs() if k in d["params"]}
    assert warn == []


@pytest.mark.parametrize("mutate, msg", [
    (lambda d: d.update(size=[0, 5]), "size"),
    (lambda d: d["layers"].pop("base"), "layers.base"),
    (lambda d: d["fields"].pop("width"), "fields"),
    (lambda d: d["rig"].pop("root"), "rig.root"),
    (lambda d: d["rig"]["limits"].pop("ventMm"), "rig.limits"),
    (lambda d: d["params"].update(ti="快"), "params.ti"),
    (lambda d: d.update(id="别的"), "文件名"),
])
def test_normalize_rejects_bad_shapes(proj, mutate, msg):
    d = _doc()
    mutate(d)
    with pytest.raises(ValueError, match=msg):
        store.normalize(d, fixtures.ASSET_ID)


def test_unknown_param_kept_with_warning_and_out_of_range_warned(proj):
    d = _doc()
    d["params"]["notAParam"] = 3
    d["params"]["lag"] = 9
    norm, warn = store.normalize(d, fixtures.ASSET_ID)
    assert norm["params"]["notAParam"] == 3 and norm["params"]["lag"] == 9
    assert any("notAParam" in w for w in warn) and any("超出" in w for w in warn)


def test_save_params_only_and_number_repr(proj):
    d = _doc()
    d["params"]["inflate"] = 10          # 盘上是 10.0:相等的数按盘上的表示回写
    d["params"]["lag"] = 1.5
    d["label"] = "改了名字"
    p, norm, warn, written = store.save_asset(copy.deepcopy(d), base=_doc())
    assert written
    text = p.read_text(encoding="utf-8")
    assert '"inflate": 10.0' in text and '"lag": 1.5' in text and "改了名字" in text
    assert text.endswith("\n") and "\r" not in text
    # 没改不写
    _, _, _, again = store.save_asset(json.loads(text), base=json.loads(text))
    assert again is False


@pytest.mark.parametrize("key", store.BAKED_KEYS)
def test_baked_blocks_cannot_change(proj, key):
    d = _doc()
    if key == "size":
        d["size"] = [d["size"][0] + 1, d["size"][1]]
    elif key == "layers":
        d["layers"]["body"] = "/resources/runtime/images/x.png"
    elif key == "fields":
        d["fields"]["width"] = d["fields"]["width"] + 1
    else:
        d["rig"]["pxPerMm"] = 9.0
    with pytest.raises(ValueError, match="烘焙产物"):
        store.save_asset(d, base=_doc())


def test_save_refuses_when_disk_changed_elsewhere(proj):
    base = _doc()
    other = _doc()
    other["params"]["ti"] = 4.0
    store.save_asset(other)                        # 别处先改了
    mine = copy.deepcopy(base)
    mine["params"]["te"] = 5.0
    with pytest.raises(ValueError, match="别处改过"):
        store.save_asset(mine, base=base)


def test_save_does_not_create(proj):
    d = _doc()
    d["id"] = "brand_new"
    with pytest.raises(ValueError, match="不新建"):
        store.save_asset(d)


def test_check_asset_media_and_field_size(proj):
    errs, warns = store.check_asset(fixtures.ASSET_ID)
    assert errs == [] and warns == []
    bin_path = proj / "public" / fixtures.MEDIA.lstrip("/") / "fields.bin"
    bin_path.write_bytes(bin_path.read_bytes()[:-8])
    (proj / "public" / fixtures.MEDIA.lstrip("/") / "flap.png").unlink()
    errs, _ = store.check_asset(fixtures.ASSET_ID)
    assert any("位移场大小不对" in e for e in errs) and any("layers.flap" in e for e in errs)


def test_cli_check_and_list(proj, capsys):
    from tools.breathing_workbench.__main__ import check
    lines: list[str] = []
    assert check(lines.append) == 0
    assert lines and lines[0].startswith(f"{fixtures.ASSET_ID}\t✓\t1 处在用")


def test_media_file_confined_to_public(proj):
    assert store.media_file(fixtures.MEDIA + "/base.png") is not None
    assert store.media_file("/resources/../../src/data/breathingParams.json") is None
    assert store.media_file("/assets/data/breathing/x.json") is None


def _link_dir(link: Path, target: Path) -> bool:
    """建目录链接:Windows 先试 junction(不要管理员 / 开发者模式),别的平台 symlink。建不出来返回 False。"""
    link.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        try:
            import _winapi

            _winapi.CreateJunction(str(target), str(link))
            return True
        except (ImportError, AttributeError, OSError):
            pass
    try:
        link.symlink_to(target, target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        return False


def test_media_file_through_linked_runtime_tree(proj, tmp_path_factory):
    """``public/resources/runtime`` 是指向树外的链接(worktree 的常态):图照常放行,``..`` 爬出 public 照样拒。

    2026-09-27:只按真实路径判时 junction 整个解到树外,真工程的分层图 / 位移场全 404,工作台用真数据一张图都开不了。
    """
    runtime = proj / "public" / "resources" / "runtime"
    outside = tmp_path_factory.mktemp("elsewhere") / "runtime"
    runtime.rename(outside)
    if not _link_dir(runtime, outside):
        pytest.skip("这台机器上建不了目录链接")
    got = store.media_file(fixtures.MEDIA + "/base.png")
    assert got is not None and got.is_file() and got.read_bytes() == (outside / "images/breathing" / fixtures.ASSET_ID / "base.png").read_bytes()
    assert store.media_file(fixtures.MEDIA + "/fields.bin") is not None
    assert store.check_asset(fixtures.ASSET_ID)[0] == []
    assert store.media_file("/resources/../../src/data/breathingParams.json") is None
    assert store.media_file("/resources/runtime/../../../src/data/breathingParams.json") is None
    assert store.media_file(fixtures.MEDIA + "/nope.png") is None
