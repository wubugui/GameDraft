"""LLM 子系统错误体系（RFC v3-llm.md §10.1）。"""
from __future__ import annotations


class LLMError(Exception):
    """所有 LLM 错误的基类。"""


class LLMConfigError(LLMError):
    """llm.yaml 加载 / api_key_ref 解析 / 路由配置不一致等。"""


class LLMRouteError(LLMError):
    """逻辑模型 id 找不到 / 物理 model 未注册。"""


class LLMTimeoutError(LLMError):
    """单次调用超时。"""


class LLMNetworkError(LLMError):
    """网络层错误（DNS / connect / read）。"""


class LLMRateLimitError(LLMError):
    """命中后端限流（429 等）。"""


class LLMAuthError(LLMError):
    """4xx 鉴权失败。"""


class LLMServerError(LLMError):
    """5xx 服务端错误。"""


class LLMBadRequestError(LLMError):
    """4xx 非鉴权错误（参数 / 模型不可用）。"""


class LLMBackendCrashError(LLMError):
    """子进程异常退出（Cline libuv 崩溃等）。"""


class LLMOutputParseError(LLMError):
    """OutputSpec.kind 与实际返回不符，json 解析失败。"""


class LLMCancelledError(LLMError):
    """显式取消，永不重试。"""


# 错误 → tag 映射，与 retry.retry_on / no_retry_on 对齐
ERROR_TAGS: dict[type[LLMError], str] = {
    LLMTimeoutError: "timeout",
    LLMNetworkError: "network",
    LLMRateLimitError: "rate_limit",
    LLMServerError: "server_5xx",
    LLMAuthError: "auth_error",
    LLMBadRequestError: "bad_request",
    LLMBackendCrashError: "cline_libuv_crash",
    LLMOutputParseError: "output_parse",
    LLMCancelledError: "cancelled",
    LLMConfigError: "config",
    LLMRouteError: "route",
}


def classify(err: LLMError) -> str:
    return ERROR_TAGS.get(type(err), "unknown")
