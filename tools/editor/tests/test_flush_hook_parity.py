"""Save All flush 钩子 parity 护栏（2026-07-18 动画面板漏保存实锤的机制化）。

主窗 Save All 经鸭子协议 getattr(inst, "flush_to_model") 逐面板收集未保存编辑
（main_window.py::_flush_editors_to_model），钩子缺失不是错误而是静默跳过。
实锤案例：anim_editor 自建成起持有 _dirty / has_unsaved_changes 却无
flush_to_model，改帧率/refSpeed 后 Save All 零 diff（机制卡
agent_docs/editor-tools/mechanisms/mainwindow-editor-hooks.md 明文警告过此风险
但无机械护栏——本测试即该护栏）。

规则：main_window.py rows 注册的每个编辑器类，凡持有本地脏态标记——
_dirty 属性（含 MRO 内工具侧基类的源码赋值）、has_unsaved_changes() 或
has_pending_changes() 方法——必须同时实现 flush_to_model，缺失即失败并列出
面板名。确有替代保存通路的面板走显式豁免清单 + 理由 + 钉死锚点，不静默放过。

不触发检测的无 flush 面板（Map / 气味Profile 即改即 mark_dirty 直写模型，
Actions 注册表面板无本地暂存）本护栏不管——它们没有"本地脏了但收不走"的敞口。
"""
from __future__ import annotations

import ast
import importlib
import inspect
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MAIN_WINDOW = REPO / "tools" / "editor" / "main_window.py"

# 显式豁免：类名 -> {reason, pin}。只收"确有替代保存通路"的面板。
# pin 是 main_window.py 源码里必须仍然存在的锚点正则——替代通路被删掉时
# 豁免自动失效，护栏重新咬合。
FLUSH_EXEMPT: dict[str, dict[str, str]] = {
    # Timeline 走专用 pending 协议：_flush_editors_to_model 开头 isinstance
    # 特判，Save All 前经 confirm_apply_or_discard 弹窗把未 Apply 修改走
    # _apply() 落模型或明确丢弃——不经 flush_to_model，但不会静默丢。
    "TimelineEditor": {
        "reason": "pending 协议特判（confirm_apply_or_discard→_apply），"
                  "见 main_window._flush_editors_to_model",
        "pin": r"isinstance\(inst,\s*TimelineEditor\)\s*and\s*"
               r"inst\.has_pending_changes\(\)",
    },
}

# self._dirty 赋值/注解（不误匹配 self._dirty_map 等带后缀名）。
_DIRTY_ASSIGN = re.compile(r"self\._dirty\s*[:=]")


def _registered_editor_classes() -> list[tuple[str, type]]:
    """解析 _populate_tabs 的 rows 字面量 → [(页签名, 类对象)]。

    钉在 rows 清单上：新编辑器注册进 rows 即自动入围本护栏，
    _GAME_BROWSER_SENTINEL 等非 editors 包的占位条目跳过。
    """
    tree = ast.parse(MAIN_WINDOW.read_text(encoding="utf-8"))
    imports: dict[str, str] = {}
    row_entries: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            module = (f"tools.editor.{node.module}" if node.level == 1
                      else node.module)
            if ".editors" in module:
                for alias in node.names:
                    imports[alias.asname or alias.name] = module
        if (isinstance(node, ast.AnnAssign)
                and isinstance(node.target, ast.Name)
                and node.target.id == "rows"
                and isinstance(node.value, ast.List)):
            for elt in node.value.elts:
                if not (isinstance(elt, ast.Tuple) and len(elt.elts) == 3):
                    continue
                label_node, cls_node = elt.elts[1], elt.elts[2]
                if (isinstance(label_node, ast.Constant)
                        and isinstance(cls_node, ast.Name)):
                    row_entries.append((str(label_node.value), cls_node.id))
    assert row_entries, "未能从 main_window._populate_tabs 解析出 rows 清单——解析器需跟进源码结构"

    out: list[tuple[str, type]] = []
    for label, cls_name in row_entries:
        module = imports.get(cls_name)
        if module is None:  # _GAME_BROWSER_SENTINEL 等非编辑器条目
            continue
        out.append((label, getattr(importlib.import_module(module), cls_name)))
    assert len(out) >= 25, (
        f"仅解析出 {len(out)} 个注册编辑器类（当前实际 30 个）——rows 解析很可能失效，"
        "护栏不允许空转"
    )
    return out


def _tool_mro_source(cls: type) -> str:
    """拼接类及其工具侧基类（tools.* 模块）的源码；Qt/标准库基类不看。"""
    parts: list[str] = []
    for base in cls.__mro__:
        if not getattr(base, "__module__", "").startswith("tools."):
            continue
        try:
            parts.append(inspect.getsource(base))
        except (OSError, TypeError):
            pass
    return "\n".join(parts)


def _dirty_markers(cls: type) -> list[str]:
    markers: list[str] = []
    if _DIRTY_ASSIGN.search(_tool_mro_source(cls)):
        markers.append("_dirty 属性")
    if callable(getattr(cls, "has_unsaved_changes", None)):
        markers.append("has_unsaved_changes()")
    if callable(getattr(cls, "has_pending_changes", None)):
        markers.append("has_pending_changes()")
    return markers


def _has_flush(cls: type) -> bool:
    return callable(getattr(cls, "flush_to_model", None))


def test_dirty_panels_implement_flush_to_model() -> None:
    offenders: list[str] = []
    for label, cls in _registered_editor_classes():
        markers = _dirty_markers(cls)
        if not markers or _has_flush(cls) or cls.__name__ in FLUSH_EXEMPT:
            continue
        offenders.append(f"「{label}」{cls.__name__}（脏态标记：{', '.join(markers)}）")
    assert not offenders, (
        "以下面板持有本地脏态却未实现 flush_to_model——Save All 鸭子协议会静默跳过，"
        "面板内未保存编辑落不了盘（anim_editor 实锤模式）。补 flush_to_model，"
        "或确有替代保存通路时进 FLUSH_EXEMPT 写明理由与钉死锚点：\n"
        + "\n".join(offenders)
    )


def test_detection_anchored_on_anim_editor() -> None:
    """防检测空转：实锤案例 AnimEditor 必须仍被识别为脏态面板且已带 flush。

    若 anim_editor 改名脏态标记导致本断言失败，说明检测启发式需要同步跟进，
    不允许护栏在无声中失去咬合。
    """
    by_name = {cls.__name__: cls for _, cls in _registered_editor_classes()}
    anim = by_name.get("AnimEditor")
    assert anim is not None, "AnimEditor 不在 rows 注册清单——确认是否真的下线了动画面板"
    assert _dirty_markers(anim), (
        "AnimEditor 未被脏态检测命中——检测启发式已失效（空转），需同步其脏态标记命名"
    )
    assert _has_flush(anim), (
        "AnimEditor 缺 flush_to_model——2026-07-18 修复被回退，动画面板 Save All 又会零 diff"
    )


def test_exemptions_are_current() -> None:
    """豁免清单保鲜：条目必须仍注册、仍命中脏态、仍无 flush、锚点仍在。"""
    by_name = {cls.__name__: cls for _, cls in _registered_editor_classes()}
    main_src = MAIN_WINDOW.read_text(encoding="utf-8")
    stale: list[str] = []
    for name, entry in FLUSH_EXEMPT.items():
        cls = by_name.get(name)
        if cls is None:
            stale.append(f"{name}: 已不在 rows 注册清单，删除豁免")
            continue
        if not _dirty_markers(cls):
            stale.append(f"{name}: 已无脏态标记，豁免多余，删除")
        if _has_flush(cls):
            stale.append(f"{name}: 已实现 flush_to_model，豁免多余，删除")
        if not re.search(entry["pin"], main_src):
            stale.append(
                f"{name}: 钉死锚点在 main_window.py 里消失——替代保存通路"
                f"（{entry['reason']}）可能已被移除，豁免不再安全"
            )
    assert not stale, "豁免清单过期：\n" + "\n".join(stale)
