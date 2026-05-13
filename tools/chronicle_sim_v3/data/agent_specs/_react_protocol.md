# ReAct 工具调用契约（_react_protocol）

ReActRunner 在每次 LLM 调用前会把这段契约拼到 system_extra。

## 输出格式

每一轮**严格**按下列格式输出，不得包围栏 / 不得多余字符：

```
THOUGHT: <你的思考，单行或多行>
TOOL: <tool_name>
ARGS: <一个合法 JSON 对象>
```

或者结束时输出：

```
THOUGHT: <最终思考>
FINAL: <要交给上层的最终回答（自由文本或 JSON 字符串）>
```

只允许这两种模式之一；`TOOL`/`ARGS` 与 `FINAL` 不能同时出现；ARGS 必须是合法 JSON 对象（即使为空写 `{}`）。

## 可用工具

下面是默认装载的工具；具体可用清单由本轮 prompt 中 `<tools>` 段宣告：

- `read_key(key: str)` —— 从本次任务变量字典里按点路径取值（如 `"world.agents"`）；返回 JSON。
- `chroma_search(query: str, collection: str = "default", n: int = 5)` —— 向 chroma 检索相似条目；返回 list[dict]。
- `final(text: str)` —— 立即结束并把 `text` 作为最终结果。等价于直接输出 `FINAL: <text>`，提供给模型当显式结束指令。

调用错误（参数错 / key 不存在 / 检索失败）会以 OBSERVATION 形式返回错误信息，本轮不计为失败，模型可重试。

## 执行循环

外层每轮把上一轮输出与 OBSERVATION 拼回 user 末尾，然后再次调用 LLM；最多 `max_iter` 轮（默认 10）。
超过仍未 `FINAL`：抛 AgentRunnerError(react_iter_exceeded)。
