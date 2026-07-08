你好，我已加载审计上下文。本轮我只做治理分析和任务拆分，不改文件。

**建议顺序**
1. `P0 broken-reference`：14 个断链，先交给 agent 批量判定“路径改名 / 文件移动 / 引用过期删除”。
2. `P1 missing-metadata`：1 个 Skill 触发条件缺失，可自动补 `when-to-use / when-not-to-use`。
3. `P1 drift-risk`：69 个规则漂移风险，需要对比当前实现后决定更新规则或标记已验证。
4. `P2 missing-lifecycle`：12 个生命周期字段缺失，可批量补 `status / owner / last verified`。

**自动处理**
- 断链中能确定的新路径直接修。
- 明显过期引用删除。
- 生命周期块统一补齐，默认 `owner: shared`，日期用本次审计日期。

**需要确认**
- 无法判断的新路径或是否仍需保留的引用。
- `drift-risk` 中规则描述和实现不一致时，确认以代码还是文档为准。

当前 `selected_references` 为空，所以还没有可引用的具体证据行号。建议先下发 `P0 broken-reference` 的只读诊断任务，生成确认清单后再执行修复。