"""Cross-platform dev task runner for GameDraft.

Entry point: ``python -m tools.dev <task>`` (win: dev.cmd, unix: ./dev.sh).

IMPORTANT: modules in this package must only import the standard library at
module level. ``dev bootstrap`` / ``dev install-deps`` run before any
third-party dependency exists; lazy-import oss2/yaml/etc. inside functions.
"""
