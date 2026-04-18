from __future__ import annotations

import json
from typing import Any

import httpx

from tools.chronicle_sim.core.llm.adapter import LLMAdapter, LLMResponse
from tools.chronicle_sim.core.llm.http_retry import run_with_http_retry


def _is_dashscope_openai_compat_base(base_url: str) -> bool:
    """阿里云百炼 OpenAI 兼容网关；仅对此类地址自动加 response_format，避免本地兼容服务 400。"""
    u = (base_url or "").lower()
    return "dashscope" in u and "compatible" in u


def _messages_contain_json_keyword(messages: list[dict[str, str]]) -> bool:
    """百炼 json_object 要求 system/user 中须出现 “json” 字样（大小写不敏感）。"""
    for m in messages or []:
        c = m.get("content")
        if isinstance(c, str) and "json" in c.lower():
            return True
    return False


def _response_format_for_kw_json_schema(json_schema: dict[str, Any]) -> dict[str, Any] | None:
    """将调用方传入的 json_schema 关键字映射为 OpenAI/百炼兼容的 response_format。"""
    if not json_schema:
        return None
    # 各 agent 仅作「要 JSON 对象」标记时常传 {"type": "object"}
    if json_schema == {"type": "object"} or (
        set(json_schema.keys()) <= {"type"} and json_schema.get("type") == "object"
    ):
        return {"type": "json_object"}
    # 已是完整 envelope（如迁移自 OpenAI strict schema）
    if json_schema.get("type") == "json_schema" and isinstance(json_schema.get("json_schema"), dict):
        return dict(json_schema)
    # 其余视为 JSON Schema 本体，按百炼/ OpenAI 嵌套一层
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "structured_output",
            "strict": True,
            "schema": json_schema,
        },
    }


def _assistant_message_to_text(message: dict[str, Any]) -> str:
    """从 choices[0].message 取助手正文；兼容 content 为空但 tool_calls / function_call 携带 JSON 的网关。"""
    msg = message or {}
    c = msg.get("content")
    s = _message_content_to_str(c)
    if (s or "").strip():
        return s
    tcs = msg.get("tool_calls")
    if isinstance(tcs, list):
        parts: list[str] = []
        for tc in tcs:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function")
            if isinstance(fn, dict):
                arg = fn.get("arguments")
                if isinstance(arg, str) and arg.strip():
                    parts.append(arg.strip())
        if parts:
            return "\n".join(parts)
    fc = msg.get("function_call")
    if isinstance(fc, dict):
        arg = fc.get("arguments")
        if isinstance(arg, str) and arg.strip():
            return arg.strip()
    for alt_key in ("parsed",):
        v = msg.get(alt_key)
        if isinstance(v, dict):
            try:
                return json.dumps(v, ensure_ascii=False)
            except (TypeError, ValueError):
                pass
        elif isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _message_content_to_str(content: Any) -> str:
    """部分网关返回 message.content 为分段列表，或 json_object 下直接返回已解析对象（dict）。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        try:
            return json.dumps(content, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(content)
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, dict):
                t = p.get("text")
                if isinstance(t, str):
                    parts.append(t)
                elif isinstance(p.get("content"), str):
                    parts.append(p["content"])
                else:
                    try:
                        parts.append(json.dumps(p, ensure_ascii=False))
                    except (TypeError, ValueError):
                        parts.append(str(p))
            elif isinstance(p, str):
                parts.append(p)
        return "".join(parts)
    return str(content)


class OpenAICompatAdapter(LLMAdapter):
    def __init__(
        self,
        base_url: str,
        api_key: str,
        default_model: str,
        timeout: float = 300.0,
        *,
        client_kwargs: dict[str, Any] | None = None,
        max_retries: int = 3,
        retry_backoff_sec: float = 1.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.default_model = default_model
        self._max_retries = max(1, int(max_retries))
        self._retry_backoff_sec = float(retry_backoff_sec)
        opts: dict[str, Any] = {
            "timeout": httpx.Timeout(
                connect=min(30.0, timeout),
                read=timeout,
                write=timeout,
                pool=min(30.0, timeout),
            ),
            "trust_env": False,
        }
        if client_kwargs:
            opts.update(client_kwargs)
        opts["trust_env"] = False
        self._client = httpx.AsyncClient(**opts)

    async def close(self) -> None:
        await self._client.aclose()

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        json_schema: dict[str, Any] | None = None,
    ) -> LLMResponse:
        mid = model or self.default_model
        body: dict[str, Any] = {
            "model": mid,
            "messages": messages,
            "temperature": temperature,
        }
        # 本地/自建 OpenAI 兼容网关常不支持或错误实现 response_format → 仅对百炼兼容 URL 启用。
        # 百炼 json_object：messages 须含 “json”；Qwen3 思考模式与结构化输出冲突 → enable_thinking=false。
        dashscope = _is_dashscope_openai_compat_base(self.base_url)
        if json_schema is not None and not dashscope:
            # 非百炼：部分兼容服务默认 max_tokens 过小会截断大 JSON，垫高上限。
            # 百炼：官方文档要求结构化输出时不要指定 max_tokens，否则易截断导致不完整 JSON
            # （见 help.aliyun.com 模型服务 JSON 模式 / 结构化输出「禁用 max_tokens」一节）。
            body.setdefault("max_tokens", 16_384)
        if dashscope and json_schema:
            rf = _response_format_for_kw_json_schema(json_schema)
            if rf is not None:
                body["response_format"] = rf
                body["enable_thinking"] = False
                if not _messages_contain_json_keyword(messages):
                    patched = list(messages)
                    if patched:
                        last = dict(patched[-1])
                        extra = "请严格输出合法 JSON（仅一个 JSON 值，无其它说明）。"
                        last["content"] = f"{last.get('content', '').rstrip()}\n\n{extra}"
                        patched[-1] = last
                        body["messages"] = patched
        key = (self.api_key or "").strip()
        headers = {"Authorization": f"Bearer {key}"} if key else {}

        async def _post() -> LLMResponse:
            r = await self._client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=body,
            )
            if not r.is_success:
                preview = (r.text or "")[:1200]
                msg = f"Client error '{r.status_code} {r.reason_phrase}' for url {r.url}"
                if preview.strip():
                    msg = f"{msg}\nResponse body (truncated): {preview}"
                raise httpx.HTTPStatusError(msg, request=r.request, response=r)
            data = r.json()
            choice = data["choices"][0]
            text = _assistant_message_to_text(choice.get("message") or {})
            usage = data.get("usage")
            return LLMResponse(text=text, raw=data, usage=usage)

        return await run_with_http_retry(
            _post,
            max_attempts=self._max_retries,
            backoff_sec=self._retry_backoff_sec,
        )
