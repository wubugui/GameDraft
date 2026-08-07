# 道具批产 RUNBOOK（给执行 agent 读）

## 目标
把 `props_manifest.json` 里的 73 个道具，全部产出为**可直接放进游戏场景的透明 PNG**，落在 `out/`。
至少 50 个通过质检才算完成。

## 工作目录
`/Users/dannyteng/AIWork/GameDraft/artifact/PropGen_2026-08-04`

Python 一律用项目 venv：`../../.tools/venv/bin/python`（简称 PY）

## 循环（就这一个动作，重复到干为止）

```bash
cd /Users/dannyteng/AIWork/GameDraft/artifact/PropGen_2026-08-04
PY=../../.tools/venv/bin/python
while true; do
  id=$($PY genprop.py next); [ -z "$id" ] && break
  $PY genprop.py gen "$id" --retry 3
done
$PY genprop.py status
```

`genprop.py gen` 一步做完：驱动 cursor-agent(grok) 的 GenerateImage 出绿幕图 → 绿幕抠图 → 去绿边 → 边缘颜色外扩 → 裁包围盒 → 限最大边 2048 → 质检 → 写 `logs/state.json`。

## 质检标准（脚本自动判，PASS 才算数）
- 四角完全透明
- 不透明像素占比 5%–93%（太小=主体没画出来；太大=绿幕没抠掉）
- 绿色残留 < 0.4%
- 最大边 ≤ 2048

## 卡住时怎么修（这是你要动脑的地方）

`genprop.py status` 会列出 BAD 条目。按症状处理：

| 症状 | 判断 | 处理 |
|---|---|---|
| `coverage` 极高（>0.93） | 绿幕没生成出来，模型画了实景背景 | 改该条目的 `subject`，句首补一句"背景是纯荧光绿色块"，重跑 |
| `coverage` 极低（<0.05） | 主体太小或几乎全被抠掉 | `subject` 里补"主体占满画面"，重跑 |
| `green_residue` 超标 | 物体本身被画成绿色（苔藓/绿漆太多） | 把 `subject` 里的"苔""绿"字眼换成"黑霉""水渍"，重跑 |
| `corners_transparent` false | 出图带了边框/渐变底 | `subject` 末尾补"不要边框、不要渐变背景"，重跑 |
| cursor-agent 报错/超时 | 网络或限流 | 等 30 秒重试；连续 3 次失败就跳过，记进 `logs/skipped.md` 继续下一个 |

改 `subject` 就改 `props_manifest.json` 里那一条的 `subject` 字段，然后 `$PY genprop.py gen <id> --retry 3` 重跑。
**不要改 `genprop.py` 里的 STYLE_PROMPT 风格段**——那段是校准过的，改了整批风格会漂。

## 硬约束
- 不要动 `props_manifest.json` 以外的项目文件。
- 不要把产物拷进 `public/` —— 本次只交付资产，不接进游戏。
- 不要改 `genprop.py` 的抠图阈值和风格提示词。
- 每个道具必须是**单件场景道具、45度等距、无人物、无地面投影、无文字**。

## 完成条件
`$PY genprop.py status` 显示 `done >= 50`，且 `out/` 下有对应数量的 PNG。
最后把跳过/放弃的条目写进 `logs/skipped.md`（每条一行：id + 原因）。
