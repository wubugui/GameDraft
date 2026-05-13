"""random 抽屉 — 确定性随机数。

P1: rng.from_seed
P2 新增：random.bernoulli / weighted_sample / shuffle / choice
"""
from __future__ import annotations

import hashlib
import random as _random

from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


@register_node
class RngFromSeed:
    spec = NodeKindSpec(
        kind="rng.from_seed",
        category="random",
        title="rng.from_seed",
        description=(
            "由 (run_id, key) 派生确定性 seed（int），后续 random.* 节点接此种子。"
        ),
        inputs=(),
        outputs=(PortSpec(name="seed", type="Seed"),),
        params=(Param(name="key", type="str", required=True),),
        version="1",
        deterministic=True,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        key = str(params["key"])
        run_id = getattr(ctx, "run_id", "")
        material = f"{run_id}|{key}".encode("utf-8")
        seed = int.from_bytes(hashlib.sha256(material).digest()[:8], "big")
        return NodeOutput(values={"seed": seed})


def _rng_from_seed(seed: int) -> "_random.Random":
    import random as _random

    return _random.Random(int(seed))


@register_node
class RandomBernoulli:
    spec = NodeKindSpec(
        kind="random.bernoulli",
        category="random",
        title="random.bernoulli",
        description="伯努利采样：以概率 p 返回 True。",
        inputs=(PortSpec(name="seed", type="Seed"),),
        outputs=(PortSpec(name="out", type="Bool"),),
        params=(Param(name="p", type="float", required=True),),
        version="1",
        deterministic=True,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        p = float(params["p"])
        if not (0.0 <= p <= 1.0):
            raise NodeBusinessError(f"random.bernoulli p ∈ [0,1]，得到 {p}")
        return NodeOutput(values={"out": _rng_from_seed(inputs["seed"]).random() < p})


@register_node
class RandomWeightedSample:
    spec = NodeKindSpec(
        kind="random.weighted_sample",
        category="random",
        title="random.weighted_sample",
        description=(
            "按权重抽样 k 个；items_with_weights 每项含 'weight' 字段。"
            "replace=False（默认）= 不放回。"
        ),
        inputs=(
            PortSpec(name="seed", type="Seed"),
            PortSpec(name="items_with_weights", type="List[Json]"),
        ),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        params=(
            Param(name="k", type="int", required=True),
            Param(name="replace", type="bool", required=False, default=False),
        ),
        version="1",
        deterministic=True,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = list(inputs.get("items_with_weights") or [])
        k = int(params["k"])
        replace = bool(params.get("replace", False))
        if k < 0:
            raise NodeBusinessError(f"random.weighted_sample k 必须 >= 0：{k}")
        if not items or k == 0:
            return NodeOutput(values={"out": []})
        weights = [max(0.0, float(it.get("weight", 0.0))) for it in items]
        if sum(weights) <= 0:
            raise NodeBusinessError("random.weighted_sample 权重总和 <= 0")
        rng = _rng_from_seed(inputs["seed"])
        if replace:
            return NodeOutput(values={"out": rng.choices(items, weights=weights, k=k)})
        # 不放回：逐次按当前权重取
        out: list = []
        idxs = list(range(len(items)))
        cur_w = list(weights)
        for _ in range(min(k, len(items))):
            tot = sum(cur_w)
            if tot <= 0:
                break
            r = rng.random() * tot
            acc = 0.0
            chosen = idxs[0]
            for i in idxs:
                acc += cur_w[i]
                if r <= acc:
                    chosen = i
                    break
            out.append(items[chosen])
            cur_w[chosen] = 0.0
        return NodeOutput(values={"out": out})


@register_node
class RandomShuffle:
    spec = NodeKindSpec(
        kind="random.shuffle",
        category="random",
        title="random.shuffle",
        description="确定性洗牌（基于 seed）。",
        inputs=(
            PortSpec(name="seed", type="Seed"),
            PortSpec(name="list", type="List[Any]"),
        ),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        version="1",
        deterministic=True,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = list(inputs.get("list") or [])
        rng = _rng_from_seed(inputs["seed"])
        rng.shuffle(items)
        return NodeOutput(values={"out": items})


@register_node
class RandomChoice:
    spec = NodeKindSpec(
        kind="random.choice",
        category="random",
        title="random.choice",
        description="均匀随机选一项。空列表抛错。",
        inputs=(
            PortSpec(name="seed", type="Seed"),
            PortSpec(name="list", type="List[Any]"),
        ),
        outputs=(PortSpec(name="out", type="Any"),),
        version="1",
        deterministic=True,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = inputs.get("list") or []
        if not items:
            raise NodeBusinessError("random.choice 空列表")
        return NodeOutput(values={"out": _rng_from_seed(inputs["seed"]).choice(items)})
