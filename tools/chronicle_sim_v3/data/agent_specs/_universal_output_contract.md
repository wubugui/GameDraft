# 通用输出契约

本文件由 ClineBackend 自动注入 `.clinerules/03_output_contract.md`。
spec 中 `[output] contract` 字段非空时优先于本文件。

## 共性规则（所有 agent）

1. 如果 OutputSpec.kind 是 `json_object` / `json_array`：
   - 直接输出合法 JSON；从首字符 `{` 或 `[` 起，末字符 `}` 或 `]` 止
   - 禁止 Markdown 代码围栏（` ``` `）
   - 禁止前言 / 后记 / 注释 / 单引号 key
   - 字段类型严格：列表必须是 JSON Array（含一项也写 `["x"]`），数字必须是 number 而非字符串
   - 中文 / unicode 不要 escape

2. 如果 OutputSpec.kind 是 `text`：
   - 直接输出 Markdown / 纯文本
   - 不要在开头/末尾加 `---` 或代码围栏

3. 如果 OutputSpec.kind 是 `jsonl`：
   - 每行一个合法 JSON 对象
   - say 类用 `{"type":"say","text":"..."}`；最终结果用 `{"final":...}`

## ACT 模式（Cline CLI）

- stdout 常被 attempt_completion 截断为摘要
- 完整产物**必须**用 write_to_file 落到 cwd 的约定文件名（json_object 时为 `agent_output.json`）
- attempt_completion 只能写一句话；禁止用摘要冒充已输出 JSON

## 风格

- 语气：民国川渝市井底色（本项目设定）
- 禁止：修仙词（修炼 / 境界 / 法力 / 灵根 / 系统面板）/ 网络梗 / 中英夹杂 / 现代术语
- 不写自检过程；不输出「让我检查」「现在我来」这类元叙事

## 错误兜底

- 缺信息时不要编造具体人名 / 地名
- 用泛称（「某客栈」「江北一带」）而非捏造 id
- intent_text / summary 等字段无信息时给出低风险表述（「观望」「打听消息」），而非空字符串
