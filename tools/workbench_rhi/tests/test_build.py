# -*- coding: utf-8 -*-
"""工作台 RHI 接入层 · 打包器：判新旧只认打包器自报的源清单；最新就一个字节不写；源一变就重打；``?raw`` 的 WGSL 打得进去。

端到端那条在临时目录里打一个小入口（引游戏的 ``burnShade.wgsl?raw`` 与 ``kelvin.ts`` + 一个临时 TS），不碰仓库。没有 node 就 skip。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.workbench_rhi import build as wbrhi  # noqa: E402

_HAS_NODE = wbrhi.node_exe() is not None and (_ROOT / "node_modules" / "vite").is_dir()


def _fake_stamp(tmp: Path, entry: Path, inputs: list[Path]) -> Path:
    out = tmp / "x.bundle.js"
    out.write_text("export {};\n", encoding="utf-8")
    recs = [{"path": str(p), "size": p.stat().st_size, "mtimeMs": p.stat().st_mtime_ns / 1e6} for p in inputs]
    wbrhi.stamp_path(out).write_text(json.dumps({"version": 1, "entry": str(entry), "builder": wbrhi._builder_digest(),
                                                  "inputs": recs}), encoding="utf-8")
    return out


def test_stale_reason_follows_the_stamp(tmp_path: Path) -> None:
    entry = tmp_path / "entry.ts"
    entry.write_text("export const a = 1;\n", encoding="utf-8")
    dep = tmp_path / "dep.wgsl"
    dep.write_text("fn f() {}\n", encoding="utf-8")
    assert wbrhi.stale_reason(entry, tmp_path / "none.js") == "还没打过"
    out = _fake_stamp(tmp_path, entry, [entry, dep])
    assert wbrhi.stale_reason(entry, out) == ""
    assert wbrhi.stale_reason(tmp_path / "other.ts", out) == "入口换了"
    dep.write_text("fn f() { let x = 1; }\n", encoding="utf-8")
    assert wbrhi.stale_reason(entry, out).startswith("源文件变了")
    out = _fake_stamp(tmp_path, entry, [entry, dep])
    dep.unlink()
    assert wbrhi.stale_reason(entry, out).startswith("源文件没了")
    out = _fake_stamp(tmp_path, entry, [entry])
    st = json.loads(wbrhi.stamp_path(out).read_text(encoding="utf-8"))
    st["builder"] = "0" * 40
    wbrhi.stamp_path(out).write_text(json.dumps(st), encoding="utf-8")
    assert wbrhi.stale_reason(entry, out) == "打包器改了"
    wbrhi.stamp_path(out).unlink()
    assert wbrhi.stale_reason(entry, out) == "没有打包戳"


def test_entry_source_and_write_if_changed(tmp_path: Path) -> None:
    at = tmp_path / "gen" / "entry.ts"
    src = wbrhi.entry_source([_ROOT / "src" / "rendering" / "lighting" / "kelvin.ts", _ROOT / "tools" / "workbench_rhi" / "workbenchRhi.ts"], at)
    assert "export * as kelvin from '" in src and "export * as workbenchRhi from '" in src and "\\" not in src
    assert wbrhi.write_if_changed(at, src) is True
    m = at.stat().st_mtime_ns
    time.sleep(0.02)
    assert wbrhi.write_if_changed(at, src) is False and at.stat().st_mtime_ns == m
    with pytest.raises(ValueError):
        wbrhi.entry_source([Path("a/kelvin.ts"), Path("b/kelvin.ts")], at)


def test_import_tree_follows_raw_imports() -> None:
    names = {p.name for p in wbrhi.import_tree([_ROOT / "src" / "rendering" / "burn" / "BurnFilters.ts"])}
    assert {"BurnFilters.ts", "burnShade.wgsl", "gpuSampler.ts"} <= names, names


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node / 仓库根没有 node_modules/vite")
def test_build_end_to_end_in_a_temp_dir(tmp_path: Path) -> None:
    wgsl = (_ROOT / "src" / "rendering" / "burn" / "burnShade.wgsl").as_posix()
    kelvin = (_ROOT / "src" / "rendering" / "lighting" / "kelvin.ts").as_posix()
    local = tmp_path / "local.ts"
    local.write_text("export const marker = 'first-build-marker';\n", encoding="utf-8")
    entry = tmp_path / "entry.ts"
    entry.write_text(f"import W from '{wgsl}?raw';\nexport const wgsl = W;\nexport * as kelvin from '{kelvin}';\n"
                     "export { marker } from './local';\n", encoding="utf-8")
    out = tmp_path / "gen" / "t.bundle.js"
    p, err = wbrhi.ensure(entry, out)
    assert p == out and not err, err
    text = out.read_text(encoding="utf-8")
    assert "fn burnSample(" in text and "kelvinToLinearRgb" in text and "first-build-marker" in text
    names = {q.name for q in wbrhi.inputs_of(out)}
    assert {"entry.ts", "local.ts", "burnShade.wgsl", "kelvin.ts", "package-lock.json"} <= names, names
    assert not list(out.parent.glob(".wbrhi-*")), "临时目录没收干净"
    # 最新：一个字节都不写
    m = out.stat().st_mtime_ns
    p, err = wbrhi.ensure(entry, out)
    assert p == out and not err and out.stat().st_mtime_ns == m
    # 源一变就重打
    time.sleep(0.02)
    local.write_text("export const marker = 'second-build-marker';\n", encoding="utf-8")
    assert wbrhi.stale_reason(entry, out).startswith("源文件变了")
    p, err = wbrhi.ensure(entry, out)
    assert not err and "second-build-marker" in out.read_text(encoding="utf-8")
    assert wbrhi.stale_reason(entry, out) == ""


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node")
def test_build_failure_keeps_the_old_bundle_and_says_why(tmp_path: Path) -> None:
    entry = tmp_path / "entry.ts"
    entry.write_text("export const ok = 'old-bundle-marker';\n", encoding="utf-8")
    out = tmp_path / "gen" / "t.bundle.js"
    p, err = wbrhi.ensure(entry, out)
    assert p == out and not err
    entry.write_text("export const = ;\n", encoding="utf-8")
    p, err = wbrhi.ensure(entry, out)
    assert p == out and "vite 打包失败" in err, (p, err)
    assert "old-bundle-marker" in out.read_text(encoding="utf-8"), "打坏了不许把旧包弄没"
    assert wbrhi.stale_reason(entry, out).startswith("源文件变了"), "打坏之后仍是过期状态（下次还会再试）"


def test_no_node_is_a_soft_failure(tmp_path: Path, monkeypatch) -> None:
    entry = tmp_path / "entry.ts"
    entry.write_text("export const ok = 1;\n", encoding="utf-8")
    monkeypatch.setattr(wbrhi, "node_exe", lambda: None)
    p, err = wbrhi.ensure(entry, tmp_path / "t.bundle.js")
    assert p is None and "找不到 node" in err
    assert os.path.exists(entry)
