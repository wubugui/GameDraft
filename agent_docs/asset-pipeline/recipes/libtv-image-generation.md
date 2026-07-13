---
id: libtv-image-generation
title: LibTV 出图项目配方(模型选型与坑)
domain: asset-pipeline
type: recipe
summary: 本项目用 LibTV CLI 出素材的实测配方:干净 cwd 铁律、三模型选型、悠船 V8.1 三连坑、prompt 换底写法
status: active
authority:
  - tmp/libtv_animation_batch_run_20260702/run_animation_batch.py
triggers:
  topics: [LibTV, 出图, image2image, 模型选型, 洋红底]
  tasks: [生成素材图, 生成动画视频, 换背景出分层]
last_governed: 2026-07-11
---

**实测环境与日期**:2026-07-02~05,动画批产/过场插画/分层/环境动效均经此出图
(CLI 手册见用户级 skill `~/.claude/skills/libtv-cli`,本卡只记项目实测坑;批量生成规格的
在库范例 = authority 所指 tmp 脚本,若被清理则以本卡为准)。

## 环境铁律

- **必须从干净 cwd 跑**:仓库根 `.libtv` 有前人 stale group,会报"未找到节点(--group)"。
  在 scratchpad 建干净工作目录(`.libtv/project.json` 只写 projectUuid、不写 groupNodeKey,
  否则分组串味)或显式 `-p <画布uuid>`。
- 批量读取节点详情**用 Python 循环调 CLI**,bash 循环会静默丢输出。
- `model search` 不吃 `-p`。

## 模型选型(model 参数 = 模型名,不是 key)

| 模型 | 强项 | 注意 |
|---|---|---|
| nebula-ultra("Lib Navo Pro") | 一致性最好、编辑向;平滑径向 glow | 单独抠人(inverse isolate)已证伪:漂空+halo+重绘 |
| 悠船 V8.1(mj-v8.1) | 美学电影感最强,风景/大场面首选 | 见下方三连坑 |
| Seedream 4.5/5.0 | 中式题材 | 最低 2K 无 1K;径向 glow 会画成螺旋纹 |

**悠船 V8.1 三连坑**:①必须 `-s "model=悠船 V8.1"`(名字非 key);②带图参考必须
`-s modeType=image2image`(否则报"图片生成节点须为图生图模式");③必须 `-s count=4`
(schema 只允许 4,count=1 报错)——一次出 4 张,下载拼 2×2 对比挑。

## image2image 形状

`libtv upload <名> -f <图>` 建参考节点 → `libtv node create <名> -t image
-s "model=..." -s modeType=image2image -s quality=2K -s ratio=16:9 --left <参考>
--prompt <文案> --run`(阻塞 ~50s)。出图 stdout 是多帧 JSON,结果在 sd-gen-save-img URL
(count=4 时 4 个),curl 下载。

## prompt 坑(换底出分层)

要"人物之外换纯洋红底"时必须写死**"人物以外的整个背景(山/地/碑/树全部)换纯洋红"**——
只写"背景"模型会理解成只换天空。生成侧动画提示词铁律(原地/道具握持)见
[单图生视频决策](../decisions/2026-07-02-armed-locomotion-single-image-gen.md)。
