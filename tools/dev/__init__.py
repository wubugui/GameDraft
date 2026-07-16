"""Dev task runner for GameDraft.

Entry point: ``python -m tools.dev <task>`` or ``./dev.sh <task>``.

IMPORTANT: modules in this package must only import the standard library at
module level. ``dev bootstrap`` / ``dev install-deps`` run before any
third-party dependency exists; lazy-import oss2/yaml/etc. inside functions.
"""
