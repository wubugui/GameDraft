---
id: libtv-image-generation
title: LibTV 出图项目配方(模型选型与坑)
domain: asset-pipeline
type: recipe
summary: 本项目用 LibTV CLI 出素材的实测配方:禁生成透明底(灰底优先/洋红可)、干净 cwd 铁律、三模型选型、悠船 V8.1 三连坑、prompt 换底写法
status: active
authority:
  - tmp/libtv_animation_batch_run_20260702/run_animation_batch.py
triggers:
  topics: [LibTV, 出图, image2image, 模型选型, 洋红底, 灰底, 透明底, 生成底色, 串行提交, 并行槽, 2020057, 1K, Seedream]
  tasks: [生成素材图, 生成动画视频, 换背景出分层]
last_governed: 2026-07-11
---

**实测环境与日期**:2026-07-02~05,动画批产/过场插画/分层/环境动效均经此出图
(CLI 手册见用户级 skill `~/.claude/skills/libtv-cli`,本卡只记项目实测坑;批量生成规格的
在库范例 = authority 所指 tmp 脚本,若被清理则以本卡为准)。

## 生成底色铁律(最高优先,一切素材出图适用)

- **绝对禁止让模型直接生成透明底(alpha/PNG 透明)**——模型出的"透明底"边缘脏、
  半透飞边、镂空不可控,回收不了。生成必须落在**纯色实底**上,透明交给本地抠图管线做。
- **底色首选中性灰(摄影棚灰底)**:配 `fusion`(BiRefNet 定范围 + color-key 给利边,见
  [抠图路线](../mechanisms/matting-toolbox.md))抠得最干净,且灰是中性色不会像洋红那样在
  毛发/浅色边缘染出彩色 halo(despill 难)。**洋红/纯色底也可**(走
  [纯色底色键配方](colorkey-matting.md)),但毛发/浅色主体优先灰底。
- prompt 里写死"人物/主体置于纯灰色背景上、背景纯净无杂物",**不要**写"透明背景/transparent"。

## 环境铁律

- **必须从干净 cwd 跑**:仓库根 `.libtv` 有前人 stale group,会报"未找到节点(--group)"。
  在 scratchpad 建干净工作目录(`.libtv/project.json` 只写 projectUuid、不写 groupNodeKey,
  否则分组串味)或显式 `-p <画布uuid>`。
- 批量读取节点详情**用 Python 循环调 CLI**,bash 循环会静默丢输出。
- `model search` 不吃 `-p`。

## 生成并发铁律(批产必守,2026-07-14 动物批产实测)

- **生图并行槽 = 1,严格串行提交**。一次 `--run` 若撞并行上限(错误码 **2020057**「已达到
  可并行生图的任务数量上限」),该节点会留一个 loading/prog=3 的**僵尸任务占着唯一槽**;
  即使 `delete` 掉节点,服务端任务也不撤,实测 **~15~18 分钟**才超时释放,期间后续任何生成
  全被顶回。**CLI 无取消命令**(`libtv --help` 无 task/cancel/stop)——所以绝不能让 `--run`
  撞上限、绝不并发。
- **被工具层"拒绝"的 `--run` 有时服务端仍已提交并出图**(实测被拒的 count=2 调用真出了 2 张),
  会额外制造僵尸/串味——拒绝 ≠ 没提交,拒后要核实服务端状态。
- **批产必须逐个串行**:写一个串行驱动(撞 busy 就等 ~30s 重试、绝不并发提交),别用 bash 并行铺。

## 模型选型(model 参数 = 模型名,不是 key)

| 模型 | 强项 | 注意 |
|---|---|---|
| nebula-ultra("Lib Navo Pro") | 一致性最好、编辑向;平滑径向 glow | 单独抠人(inverse isolate)已证伪:漂空+halo+重绘 |
| 悠船 V8.1(mj-v8.1) | 美学电影感最强,风景/大场面首选 | 见下方三连坑 |
| Seedream 5.0 Pro(doubao-seedream-5-0-pro) | 中式题材;**支持 1K**(schema `quality.enum=["1K","2K"]`,出素材可用 1K) | 径向 glow 会画成螺旋纹 |
| Seedream 4.5 / 早期 5.0 | 中式题材 | 最低 2K 无 1K(旧"最低2K"仅指这批;拿不准先 `libtv model "<名>"` 看 quality enum) |

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
