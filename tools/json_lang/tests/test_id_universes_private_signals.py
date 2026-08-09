"""私有信号在 LSP 补全列表里必须与全局信号分得开。

补全列表是作者挑信号的第一现场。私有信号（`signals[].scope == 'private'`）只投递给
发射方 owner 拥有的 wrapper 图，挂在无实体上下文的容器上发就是**当场丢弃**
（不回落成全局广播）——两者在列表里长得一样，选错了要等跑起来才发现。

宇宙（id 面）刻意**不拆**：私有与全局同一命名空间、不得重名，拆成两个宇宙会让
schema 那边的 enum 少掉一半，把合法写法判成悬垂。差别只写进旁注（enumDescriptions），
与 `planes` 的「常态(无位面)」、`actors` 的「玩家(运行时魔法名)」是同一种做法。
"""
from __future__ import annotations

import json
from pathlib import Path

from tools.json_lang.id_universes import collect_id_universes

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _universes(tmp_path: Path, signals: list) -> tuple[list[str], dict[str, str]]:
    """只摆一份 narrative_graphs.json 的假工程：别的宇宙缺席就是空，不影响本题。"""
    data_dir = tmp_path / "public/assets/data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "narrative_graphs.json").write_text(
        json.dumps({"signals": signals}, ensure_ascii=False), encoding="utf-8",
    )
    ud = collect_id_universes(tmp_path)
    return ud.ids["narrative_signals"], ud.labels.get("narrative_signals", {})


def test_private_signals_are_marked_in_the_completion_list(tmp_path: Path):
    ids, labels = _universes(tmp_path, [
        {"id": "sig_box_taken", "label": "箱子被拿了", "scope": "private"},
        {"id": "sig_chapter_done", "label": "这一章完了"},
    ])
    assert ids == ["sig_box_taken", "sig_chapter_done"], "id 宇宙不许因作用域而缩水"
    assert labels["sig_box_taken"].startswith("[私有]")
    assert "箱子被拿了" in labels["sig_box_taken"], "作者写的中文名不能被标记顶掉"
    assert "私有" not in labels["sig_chapter_done"]


def test_a_private_signal_without_a_label_still_shows_the_mark(tmp_path: Path):
    """没写中文名的私有信号最容易漏：`_ids_and_labels` 对空 label 根本不建条目，
    不专门补一条，它在补全列表里与全局信号一模一样。"""
    _, labels = _universes(tmp_path, [{"id": "sig_bare", "scope": "private"}])
    assert "[私有]" in labels["sig_bare"]
    assert "wrapper" in labels["sig_bare"], "光标一个「私有」等于没解释，得说清投递面"


def test_global_and_junk_scopes_are_never_marked(tmp_path: Path):
    """误标比不标更坏：作者会以为"只推自己那一个"，实际一发推倒全部同名监听。"""
    ids, labels = _universes(tmp_path, [
        {"id": "sig_explicit_global", "label": "全局", "scope": "global"},
        {"id": "sig_case", "label": "大小写", "scope": "Private"},
        {"id": "sig_null", "label": "空作用域", "scope": None},
        {"id": "sig_none", "label": "没这一栏"},
    ])
    assert len(ids) == 4
    assert not any("私有" in text for text in labels.values()), labels


def test_the_real_project_keeps_its_signal_universe_intact():
    """真实工程当前没有任何私有信号：这一改不许动到既有的 121 条旁注。"""
    ud = collect_id_universes(_PROJECT_ROOT)
    ng = json.loads(
        (_PROJECT_ROOT / "public/assets/data/narrative_graphs.json").read_text(encoding="utf-8")
    )
    private = {
        str(row.get("id") or "").strip()
        for row in ng.get("signals") or []
        if isinstance(row, dict) and str(row.get("scope") or "").strip() == "private"
    }
    marked = {sid for sid, text in ud.labels.get("narrative_signals", {}).items() if "[私有]" in text}
    assert marked == private - {""}
    assert len(ud.ids["narrative_signals"]) == len(ng.get("signals") or [])
