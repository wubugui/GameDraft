"""引擎层异常体系最小骨架（P0-3 占位，P1 扩展节点级错误）。"""
from __future__ import annotations


class EngineError(Exception):
    """引擎错误基类。"""


class ValidationError(EngineError):
    """图加载 / 端口标签 / 表达式 / 配置校验通用错误。"""


class ExprSyntaxError(ValidationError):
    """表达式不在白名单 BNF 内。"""


class ExprEvalError(EngineError):
    """表达式运行期求值失败（缺引用 / 非法操作）。"""
