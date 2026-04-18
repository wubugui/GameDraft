from __future__ import annotations


class IsolationError(RuntimeError):
    pass


def assert_same_owner(caller_id: str, memory_owner_id: str) -> None:
    if caller_id != memory_owner_id:
        raise IsolationError(f"跨 agent 读记忆: caller={caller_id} owner={memory_owner_id}")


def assert_belief_holder(caller_id: str, holder_id: str) -> None:
    if caller_id != holder_id:
        raise IsolationError(f"跨 agent 写 belief: caller={caller_id} holder={holder_id}")
