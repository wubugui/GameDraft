"""``python -m tools.dev`` argument plumbing (no side effects)."""

from __future__ import annotations

from tools.dev import __main__ as cli
from tools.dev import sync


def test_pull_forwards_the_opt_in_flags(monkeypatch):
    seen = {}
    monkeypatch.setattr(sync, "pull", lambda **kwargs: seen.update(kwargs) or 0)

    assert cli.main(["pull", "--editor", "--audio", "--git-proxy", "http://p:7"]) == 0

    assert seen == {"editor": True, "audio": True, "git_proxy": "http://p:7"}


def test_pull_defaults_leave_both_opt_ins_off(monkeypatch):
    seen = {}
    monkeypatch.setattr(sync, "pull", lambda **kwargs: seen.update(kwargs) or 0)

    assert cli.main(["pull"]) == 0

    assert seen == {"editor": False, "audio": False, "git_proxy": ""}


def test_init_audio_task_reaches_the_source_library_sync(monkeypatch):
    calls = []
    monkeypatch.setattr(sync, "init_audio", lambda: calls.append("init-audio") or 0)

    assert cli.main(["init-audio"]) == 0

    assert calls == ["init-audio"]
