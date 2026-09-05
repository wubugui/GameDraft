"""磁盘上还没有、只活在 LSP overlay 里的文件（编辑器刚新建、还没 Save All 的场景）
必须参与一切枚举：宇宙 / 候选 / 查引用 / 全局搜索 / 状态自述 / schema 重算。

此前 `read_text` 只决定"怎么读"，而"读哪些"全部来自磁盘 glob——新场景对整个语言大脑
不存在，直到有人想起去保存；编辑器明明已经把它推过来了。顺带钉死 Windows 上的
file URI 往返：旧写法把盘符与反斜杠整串塞进 netloc，server 端解回来是 `.`，
所有 overlay 挤在同一个键上、一条都对不上磁盘路径。
"""
from __future__ import annotations

import json
import urllib.parse
from pathlib import Path

from tools.json_lang.id_universes import collect_id_universes, iter_content_files
from tools.json_lang.lsp_server import Server, _overlay_key, _path_to_uri, _uri_to_path
from tools.json_lang.refs import find_refs
from tools.json_lang.search import find_text


def _root(tmp_path: Path) -> Path:
    scenes = tmp_path / "public/assets/scenes"
    scenes.mkdir(parents=True)
    (tmp_path / "public/assets/data").mkdir(parents=True)
    (tmp_path / "public/assets/dialogues/graphs").mkdir(parents=True)
    (scenes / "老街.json").write_text(
        json.dumps({"id": "老街", "name": "老街", "spawnPoints": {"east": {}}}, ensure_ascii=False),
        encoding="utf-8",
    )
    return tmp_path


def _overlay(root: Path) -> tuple[Path, str]:
    p = root / "public/assets/scenes/新街.json"
    text = json.dumps(
        {"id": "新街", "name": "刚建的街", "spawnPoints": {"north": {}},
         "npcs": [{"id": "npc_更夫", "name": "更夫", "x": 1, "y": 1}]},
        ensure_ascii=False,
    )
    return p, text


def _reader(p: Path, text: str):
    return lambda path: text if _overlay_key(path) == _overlay_key(p) else path.read_text(encoding="utf-8")


def test_iter_content_files_unions_overlay_only_paths(tmp_path):
    root = _root(tmp_path)
    p, _ = _overlay(root)
    files = iter_content_files(root, extra_paths=[p])
    assert p in files, "overlay-only 文件没被枚举到"
    assert root / "public/assets/scenes/老街.json" in files
    assert len(files) == 2
    # 不命中任何内容模式 / 不在 root 之下的 extra 一律忽略，不炸
    junk = [root / "README.md", Path(tmp_path.anchor) / "elsewhere" / "x.json"]
    assert iter_content_files(root, extra_paths=junk) == [root / "public/assets/scenes/老街.json"]


def test_iter_content_files_does_not_double_count_case_variants(tmp_path):
    """overlay 的路径来自编辑器 / VS Code 的 URI，盘符大小写可能与 glob 不同——同一个文件不能扫两遍。"""
    root = _root(tmp_path)
    on_disk = root / "public/assets/scenes/老街.json"
    if not on_disk.drive:
        return  # POSIX 区分大小写，没有这个问题
    variant = Path(on_disk.drive.lower() + str(on_disk)[len(on_disk.drive):])
    assert len(iter_content_files(root, extra_paths=[variant])) == 1


def test_universes_include_unsaved_scene(tmp_path):
    root = _root(tmp_path)
    p, text = _overlay(root)
    ud = collect_id_universes(root, read_text=_reader(p, text), extra_paths=[p])
    assert "新街" in ud.ids["scenes"]
    assert ud.labels["scenes"]["新街"] == "刚建的街"
    every_id = {i for ids in ud.ids.values() for i in ids}
    assert "npc_更夫" in every_id, "新场景里的实体也要进宇宙"
    # 不传 extra_paths = 旧行为：磁盘没有就不存在
    assert "新街" not in collect_id_universes(root, read_text=_reader(p, text)).ids["scenes"]


def test_refs_and_search_see_unsaved_scene(tmp_path):
    root = _root(tmp_path)
    p, text = _overlay(root)
    read = _reader(p, text)
    refs = find_refs(root, "npc_更夫", read_text=read, extra_paths=[p])
    assert any(r.file.endswith("新街.json") for r in refs)
    hits = find_text(root, "刚建的街", read_text=read, extra_paths=[p])
    assert hits.total == 1 and hits.hits[0].file.endswith("新街.json")
    assert find_text(root, "刚建的街", read_text=read).total == 0


def test_server_overlay_flows_into_every_query(tmp_path):
    root = _root(tmp_path)
    p, text = _overlay(root)
    s = Server()
    s.root = root
    assert "新街" not in s.ud().ids["scenes"]
    s.set_overlay(p, text)
    assert "新街" in s.ud().ids["scenes"], "didOpen 之后宇宙要立刻看见新场景"
    assert any(c["id"] == "新街" for c in s.gd_candidates({"universe": "scenes"}))
    assert any(h["file"].endswith("新街.json") for h in s.gd_search({"query": "刚建的街"})["hits"])
    assert s.gd_status({})["files"] == 2
    assert any(r.file.endswith("新街.json") for r in s.refs_of("npc_更夫"))
    s.drop_overlay(p)
    assert "新街" not in s.ud().ids["scenes"], "didClose 之后它就不在了（磁盘上本来就没有）"


def test_file_uri_round_trips_on_this_platform(tmp_path):
    p = (tmp_path / "public/assets/scenes/x.json").resolve()
    back = _uri_to_path(_path_to_uri(p))
    assert back is not None and _overlay_key(back) == _overlay_key(p)
    # 旧客户端的形态（整条本地路径 quote 进 netloc）仍然要认
    legacy = "file://" + urllib.parse.quote(str(p))
    assert _overlay_key(_uri_to_path(legacy)) == _overlay_key(p)
    if p.drive:
        # VS Code 发的形态：小写盘符 + 百分号编码的冒号
        std = p.as_uri()
        vscode = "file:///" + p.drive[0].lower() + "%3A" + std[len("file:///") + 2:]
        assert _overlay_key(_uri_to_path(vscode)) == _overlay_key(p)
