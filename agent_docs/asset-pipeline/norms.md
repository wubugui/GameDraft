---
id: asset-pipeline-norms
title: 素材管线规范
domain: asset-pipeline
type: norm
summary: 素材生产的源一致性、程序驱动 agent 裁判、目视验收义务、许可与格式红线
status: active
triggers:
  paths: ["tools/animation_pipeline/**", "tools/anim_preview/**", "public/resources/**", "public/assets/animations/**"]
  topics: [素材, 抠图, 动画, 图集, 音频, 视差, 原始素材, 归档, 素材同步, Blender, 建模, 渲染, bpy]
  tasks: [产素材, 抠图, 做动画, 处理音频, 视差分层, 环境动效, 归档原始素材, Blender 建模, Blender 渲染, Blender 导出]
last_governed: 2026-08-05
---

# 素材管线规范

适用:美术/美术衍生与音频素材的生产与再处理(抠图、动画图集、场景烘焙、场景背景重打光、
视差分层、环境动效、立绘、配音、音效)。
场景背景的时段/天气变体图属素材产物,走
[场景背景重打光工作台](mechanisms/scene-relight-tool.md)。

## 不变量

1. **源一致性**:重扣/重生成任何已上线素材,输入源必须=游戏当前实际在用的源
   (逐素材核 shipped 产物的溯源信息),禁止凭目录名猜源——错源整批白做。
2. **程序驱动、agent 裁判**:批处理由程序做;agent 只当质检裁判、异常入口与配方作者;
   程序从不单独判"通过"。
3. **量化指标不单独裁决**:抠图/摆位类质量必须目视复核(三底/棋盘格/场内 zoom);
   子 agent 自报完成不算验收。
4. **产物格式契约以运行时消费端为准**:贴图/图集每边≤2048(多帧摊网格不加大单边);
   anim.json 帧号 0 基;音频不入 ogg(Safari 不支持)。细则见
   [mechanisms/sprite-atlas-anim-contract.md](mechanisms/sprite-atlas-anim-contract.md)。
5. **许可有据**:外采素材必须核许可并记录出处;CC-BY 须在 ATTRIBUTION.md 署名。
6. **原始素材归档与同步**:定稿原始源按「一角色一文件夹」归档到 `tmp/原始素材/<中文角色名>/`
   (gitignore、本地留存),根 `README.md` 维护 中文文件夹 ↔ 英文 key ↔ `<key>_anim` bundle 的
   对应。**归档根只放定稿**——`setup.png` + 各 `<状态>.mp4`,中间版/候选/审查图/测试件一律
   不进;`animation-workbench/`(动画资源工作台维护的不可变 revision 与内容寻址对象)是**唯一
   受管例外**,其中的账本与产物禁止手工改写。此归档是不变量①的落地载体,故**必须与
   `public/resources/runtime/animation/<key>_anim/` 的上线动画长期同步**(换设定图/改动画/
   加动作都同步更新);尚未动画化的角色只放 `setup.png`。
7. **Blender 一律走 Hub,本机禁止运行 Blender**(制作人 2026-09-24 定,无例外,跨项目):
   建模 / 渲染 / 导出 / 查 .blend,只要要跑 Blender,一律提交给局域网 Hub
   `http://denghong01:8765` 的 `backend=blender`(用主机名,DHCP 会换 IP;已装 4.5.0 / 4.5.13 / 5.2.2,
   build hash 与原本机各份一致),按 `inference-hub-generation` 技能和 Hub `/guide.md` 的 Blender 一节做:
   项目打 ZIP 上传 → `POST /v1/tasks` → 产物写 `HUB_OUTPUT_DIR` → 按 file ID 下载并校 SHA256。
   **本机的任何 blender.exe 都不许启动,也不许下载新的一份或 `pip install bpy` 来绕。**
   硬拦截两层:用户级 `~/.claude/settings.json` 的 PreToolUse 门
   `scripts/agent_hooks/no_local_blender.py`(Claude 所有项目,命中即拒);本机各份 blender.exe
   已换成拒绝运行的替身(Codex 等不走 Claude 门的 agent 也跑不起来,原文件改名留在原处)。
   GameDraft 现成封装见 `artifact/Blender_阎王岭山口/hub/run_on_hub.py`。

## 过程义务

1. gitignored 生成物(立绘 PNG 等)就地修改前必须先自行备份。
2. 多素材批量改动先源级抽测、裁判通过后再批跑。
3. **偏差记录义务**:发现现实与本库文档打架或超出,收尾向 `agent_docs/_meta/inbox/`
   丢一条三行偏差记录(零门槛,格式见该目录 README)。

## 验收门

- `sh scripts/py.sh -m tools.editor.shared.asset_reference_audit . --strict` 零问题;
- `./dev.sh validate-data` 零 error;
- 所用管线自带的 QA 门产物经 agent 裁判逐项通过。

⚠ **`./dev.sh` 这个入口在 Windows 上不可用**(零启动,不是慢):等价入口与判定法见
[挑项目 Python 的入口](../meta/mechanisms/project-interpreter-entrypoint.md)。

## 红线

- 错源重处理;
- 跳过目视验收批量入库;
- 无许可来源的素材入库;
- 覆盖游戏在用文件前无备份、无返修路径;
- 原始素材归档与上线动画不同步,或在受管 `animation-workbench/` 之外塞中间版本 / 杂物;
- 在本机启动 Blender(任何版本、任何路径),或下载 Blender / 装 bpy 来绕开 Hub(不变量 7)。
