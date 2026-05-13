"""在单次 LLM 调用周围临时移除常见密钥环境变量，避免 LiteLLM 兜底读取宿主机配置。"""
from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

# 与 OpenAI/Anthropic/Azure/Gemini/LiteLLM 常见读取项对齐；可按需扩充。
_KEYS_TO_MASK: tuple[str, ...] = (
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT",
    "ANTHROPIC_API_KEY",
    "AZURE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "COHERE_API_KEY",
    "HUGGINGFACE_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "TOGETHER_API_KEY",
    "GROQ_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "DASHSCOPE_API_KEY",
)


@contextmanager
def isolated_llm_env() -> Iterator[None]:
    backup: dict[str, str | None] = {}
    try:
        for k in _KEYS_TO_MASK:
            if k in os.environ:
                backup[k] = os.environ.pop(k)
        yield
    finally:
        for k, v in backup.items():
            if v is not None:
                os.environ[k] = v
