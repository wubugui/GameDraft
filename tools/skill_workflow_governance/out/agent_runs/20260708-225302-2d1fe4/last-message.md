当前 `selectedRefs=[]`，所以我按 `governance://workpacks` 和 `governance://audit/stats` 排序：66 个资产、96 个问题，其中 `warn=84`，优先处理会阻断引用正确性的包。

**执行顺序**

1. **P0 断链修复包**：`governance://workpack/broken-reference`
   范围：14 个问题 / 9 个资产。先做，因为断链会影响 Skill、README、脚本说明的可信度。
   Agent 任务：按文件分组检查“改名 / 移动 / 删除”；能确定新路径的自动改；明显废弃的引用删除；无法判断的产出确认清单。
   涉及文件包括 `.cursor/skills/animation-production/SKILL.md`、`.cursor/skills/debug-panel-extension/SKILL.md`、`tools/filter_tool/README.md` 等。

2. **P1 Skill 触发条件补齐包**：`governance://workpack/missing-metadata`
   范围：1 个问题 / 1 个资产。建议紧跟 P0，因为它只影响 `.cursor/skills/animation-production/SKILL.md`，且该文件也在断链包里，可以合并处理。
   Agent 任务：补 `when-to-use / when-not-to-use`，不改正文语义。

3. **P1 规则漂移复核包**：`governance://workpack/drift-risk`
   范围：69 个问题 / 12 个资产。数量最大，但不是机械修复，必须对比当前实现。
   Agent 任务：逐个 Skill 对比引用代码/文档；过时则更新规则；仍正确则标记已验证。
   先从与 P0 重叠的 `.cursor/skills/debug-panel-extension/SKILL.md` 开始，再处理 `.cursor/skills/add-game-action/SKILL.md`、`.cursor/skills/gameplay-iteration/SKILL.md` 等。

4. **P2 生命周期元数据补齐包**：`governance://workpack/missing-lifecycle`
   范围：12 个问题 / 12 个资产。最后做，因为是标准化治理字段，不应抢在内容正确性前面。
   Agent 任务：批量插入统一生命周期块，默认 `owner=shared`，`last_verified=2026-07-08`。

**自动处理**

- P0 中可解析到唯一现存路径的断链。
- P1 `missing-metadata` 的标准触发条件补齐。
- P2 生命周期块批量补齐。
- Drift-risk 中“内容仍正确”的标记已验证。

**需要确认**

- P0 中无法判断是移动、删除还是废弃的引用。
- Drift-risk 中涉及行为语义变化的 Skill 规则更新。
- 任何会删除大段规则正文的补丁。

**建议交给 Agent 的第一批任务**

使用 `governance.run_agent`，参数建议：

```json
{
  "runMode": "fix",
  "prompt": "governance.workpack.broken-reference + governance.workpack.missing-metadata",
  "resources": [
    "governance://workpack/broken-reference",
    "governance://workpack/missing-metadata"
  ],
  "expected": "修复确定性断链；补 animation-production 的触发条件；输出无法判断清单；完成后运行 governance.scan"
}
```

这一步需要用户批准，因为 `governance.run_agent` 会启动进程，后续 `governance.apply_patch` 写文件也需要批准。