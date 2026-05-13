"""Stub backend：确定性占位。

策略：
- chat：根据 spec_ref + canonical_hash(vars) + system + user 生成稳定回复
  - text 模式：返回 "[stub<ref>] ..." 字符串
  - json_object 模式：返回 {"ok": true, "echo": "...", "seed": "..."}
  - json_array 模式：返回 [{"ok": true, ...}]
  - jsonl 模式：返回 say + final 两行
- embed：每个 text → 固定 dim=8 的 hash 派生向量（稳定可重现）

不依赖网络；CI 主用。
"""
from __future__ import annotations

import hashlib
import json
import struct

from tools.chronicle_sim_v3.engine.canonical import canonical_hash
from tools.chronicle_sim_v3.llm.backend.base import (
    BackendObserver,
    BackendResult,
    CancelToken,
    NullObserver,
)
from tools.chronicle_sim_v3.llm.types import OutputSpec, Prompt, ResolvedModel


_FIXED_DIM = 8


class StubBackend:
    name = "stub"

    def __init__(self, fixed_seed: int = 42) -> None:
        self.fixed_seed = fixed_seed

    async def invoke(
        self,
        resolved: ResolvedModel,
        prompt: Prompt,
        rendered_system: str,
        rendered_user: str,
        output: OutputSpec,
        timeout_sec: int,
        cancel: CancelToken,
        observer: BackendObserver | None = None,
    ) -> BackendResult:
        observer = observer or NullObserver()
        seed = canonical_hash({
            "spec": prompt.spec_ref,
            "vars": prompt.vars,
            "sys": rendered_system,
            "usr": rendered_user,
            "fixed_seed": self.fixed_seed,
            "physical": resolved.physical,
        })[:16]
        observer.on_phase("stub.invoke", {"seed": seed})
        kind = output.kind
        if kind == "text":
            text = f"[stub:{resolved.physical}] seed={seed} prompt={rendered_user[:60]!r}"
        elif kind == "json_object":
            obj = {
                "ok": True,
                "seed": seed,
                "spec": prompt.spec_ref,
                "echo": rendered_user[:200],
            }
            text = json.dumps(obj, ensure_ascii=False)
        elif kind == "json_array":
            text = json.dumps(
                [{"ok": True, "seed": seed, "echo": rendered_user[:120]}],
                ensure_ascii=False,
            )
        elif kind == "jsonl":
            lines = [
                json.dumps({"type": "say", "text": f"[stub] {rendered_user[:60]}"}, ensure_ascii=False),
                json.dumps({"final": {"ok": True, "seed": seed}}, ensure_ascii=False),
            ]
            text = "\n".join(lines)
        else:
            text = f"[stub:unknown_kind={kind}]"
        return BackendResult(
            text=text,
            tool_log=[],
            exit_code=0,
            timings={"exec_ms": 0},
            tokens_in=max(1, len(rendered_user) // 4),
            tokens_out=max(1, len(text) // 4),
        )


class StubEmbedBackend:
    name = "stub_embed"

    def __init__(self, fixed_seed: int = 42) -> None:
        self.fixed_seed = fixed_seed

    async def invoke(
        self,
        resolved: ResolvedModel,
        texts: list[str],
        timeout_sec: int,
        cancel: CancelToken,
    ) -> list[list[float]]:
        out: list[list[float]] = []
        for t in texts:
            digest = hashlib.sha256(
                f"{self.fixed_seed}|{resolved.route_hash}|{t}".encode("utf-8")
            ).digest()
            vec: list[float] = []
            for i in range(_FIXED_DIM):
                chunk = digest[i * 4 : i * 4 + 4]
                # 映射到 [-1, 1]
                v = struct.unpack(">I", chunk)[0] / 0xFFFFFFFF
                vec.append(v * 2 - 1)
            out.append(vec)
        return out
