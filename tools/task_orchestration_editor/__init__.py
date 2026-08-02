"""High-level task orchestration editor.

The package intentionally owns no persistent document format.  It reads and
patches the existing ProjectModel domains (narrative graphs, scenes, dialogue
graphs and quests), so the regular editors remain the only schema owners.
"""

from .compiler import (
    BindingRow,
    CompileError,
    CompilationPlan,
    EventBindingSpec,
    apply_compilation_plan,
    build_event_plan,
    create_flow,
    create_state,
    delete_event_spine,
    remove_event_binding,
    scan_event_bindings,
    update_flow_text,
    update_state,
)

__all__ = [
    "BindingRow",
    "CompileError",
    "CompilationPlan",
    "EventBindingSpec",
    "apply_compilation_plan",
    "build_event_plan",
    "create_flow",
    "create_state",
    "delete_event_spine",
    "remove_event_binding",
    "scan_event_bindings",
    "update_flow_text",
    "update_state",
]
