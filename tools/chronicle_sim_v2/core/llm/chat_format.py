"""多轮对话拼接（供探针等模块使用，与执行后端无关）。"""


def format_chat_turns_for_task(turns: list[dict[str, str]]) -> str:
    """将 GUI 多轮 {role,content} 列表拼成单一上下文字符串。"""
    lines: list[str] = []
    for m in turns:
        role = (m.get("role") or "").strip()
        c = m.get("content") or ""
        if role == "user":
            lines.append(f"【用户】\n{c}")
        elif role == "assistant":
            lines.append(f"【助手】\n{c}")
        else:
            lines.append(f"【{role}】\n{c}")
    return "\n\n".join(lines)
