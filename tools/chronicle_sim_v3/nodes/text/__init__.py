"""text 抽屉 — 模板 / 字符串 / JSON 编解码。

P1 子集：template.render / text.concat / json.encode / json.decode
"""
from __future__ import annotations

import json as _json
import re

from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}")


def _lookup(d: dict, dotted: str):
    cur = d
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


@register_node
class TemplateRender:
    spec = NodeKindSpec(
        kind="template.render",
        category="text",
        title="template.render",
        description="{{key}} / {{key.sub}} 模板替换。缺 var 抛错。",
        inputs=(PortSpec(name="vars", type="Dict"),),
        outputs=(PortSpec(name="out", type="Str"),),
        params=(Param(name="template", type="str", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        vars_ = inputs.get("vars") or {}
        template = params["template"]
        missing: list[str] = []

        def _sub(m: re.Match) -> str:
            key = m.group(1)
            v = _lookup(vars_, key)
            if v is None:
                missing.append(key)
                return ""
            if isinstance(v, (dict, list)):
                return _json.dumps(v, ensure_ascii=False)
            return str(v)

        out = _VAR_RE.sub(_sub, template)
        if missing:
            raise NodeBusinessError(
                f"template.render 缺变量: {sorted(set(missing))}",
                details={"missing": sorted(set(missing))},
            )
        return NodeOutput(values={"out": out})


@register_node
class TextConcat:
    spec = NodeKindSpec(
        kind="text.concat",
        category="text",
        title="text.concat",
        description="按 sep 拼接字符串列表。",
        inputs=(PortSpec(name="parts", type="List[Str]"),),
        outputs=(PortSpec(name="out", type="Str"),),
        params=(Param(name="sep", type="str", required=False, default=""),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        parts = inputs.get("parts") or []
        sep = params.get("sep", "")
        return NodeOutput(values={"out": sep.join(str(x) for x in parts)})


@register_node
class JsonEncode:
    spec = NodeKindSpec(
        kind="json.encode",
        category="text",
        title="json.encode",
        description="任意值 → JSON 字符串。",
        inputs=(PortSpec(name="value", type="Any"),),
        outputs=(PortSpec(name="out", type="Str"),),
        params=(
            Param(name="indent", type="int", required=False, default=0),
            Param(name="ensure_ascii", type="bool", required=False, default=False),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        value = inputs.get("value")
        indent = int(params.get("indent", 0)) or None
        ensure_ascii = bool(params.get("ensure_ascii", False))
        try:
            text = _json.dumps(value, ensure_ascii=ensure_ascii, indent=indent)
        except TypeError as e:
            raise NodeBusinessError(f"json.encode: {e}") from e
        return NodeOutput(values={"out": text})


@register_node
class JsonDecode:
    spec = NodeKindSpec(
        kind="json.decode",
        category="text",
        title="json.decode",
        description="字符串 → JSON 值。失败抛 NodeBusinessError。",
        inputs=(PortSpec(name="text", type="Str"),),
        outputs=(PortSpec(name="out", type="Json"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        text = inputs.get("text") or ""
        try:
            value = _json.loads(text)
        except _json.JSONDecodeError as e:
            raise NodeBusinessError(f"json.decode: {e}") from e
        return NodeOutput(values={"out": value})


# ============================================================================
# P2 新增：text.head / text.format / json.path
# ============================================================================


@register_node
class TextHead:
    spec = NodeKindSpec(
        kind="text.head",
        category="text",
        title="text.head",
        description="取字符串前 n 个字符（中文按字符算）。",
        inputs=(PortSpec(name="text", type="Str"),),
        outputs=(PortSpec(name="out", type="Str"),),
        params=(Param(name="n", type="int", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        n = int(params["n"])
        if n < 0:
            raise NodeBusinessError(f"text.head n 必须 >= 0：{n}")
        return NodeOutput(values={"out": str(inputs.get("text") or "")[:n]})


@register_node
class TextFormat:
    spec = NodeKindSpec(
        kind="text.format",
        category="text",
        title="text.format",
        description="Python str.format(**vars)；缺 var 抛错。",
        inputs=(PortSpec(name="vars", type="Dict"),),
        outputs=(PortSpec(name="out", type="Str"),),
        params=(Param(name="pattern", type="str", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        vars_ = inputs.get("vars") or {}
        try:
            return NodeOutput(values={"out": params["pattern"].format(**vars_)})
        except (KeyError, IndexError) as e:
            raise NodeBusinessError(f"text.format 缺变量: {e}") from e


@register_node
class JsonPath:
    spec = NodeKindSpec(
        kind="json.path",
        category="text",
        title="json.path",
        description=(
            "按 dotted path 取值：'a.b[0].c'；缺路径返回 null。"
            "数字下标必须放方括号内（'a.b[0]' 不是 'a.b.0'）。"
        ),
        inputs=(PortSpec(name="value", type="Json"),),
        outputs=(PortSpec(name="out", type="Any"),),
        params=(Param(name="path", type="str", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        path = str(params["path"]).strip()
        if not path:
            return NodeOutput(values={"out": inputs.get("value")})
        cur = inputs.get("value")
        # 简单切分：先按 '.' 切，每段处理 'name[i]' 形态
        for seg in path.split("."):
            if cur is None:
                return NodeOutput(values={"out": None})
            # 解 [i] 后缀
            name, _, rest = seg.partition("[")
            if name:
                cur = cur.get(name) if isinstance(cur, dict) else None
            while rest:
                idx_str, _, rest = rest.partition("]")
                if cur is None:
                    return NodeOutput(values={"out": None})
                try:
                    idx = int(idx_str)
                except ValueError:
                    return NodeOutput(values={"out": None})
                try:
                    cur = cur[idx]
                except (IndexError, TypeError, KeyError):
                    return NodeOutput(values={"out": None})
                if rest.startswith("["):
                    rest = rest[1:]
                else:
                    rest = ""
        return NodeOutput(values={"out": cur})
