---
id: asset-pipeline-norms
title: 素材管线规范
domain: asset-pipeline
type: norm
summary: 素材生产的源一致性、程序驱动 agent 裁判、目视验收义务、许可与格式红线
status: active
triggers:
  paths: ["tools/animation_pipeline/**", "tools/anim_preview/**", "public/resources/**", "public/assets/animations/**"]
  topics: [素材, 抠图, 动画, 图集, 音频, 视差, 原始素材, 归档, 素材同步]
  tasks: [产素材, 抠图, 做动画, 处理音频, 视差分层, 环境动效, 归档原始素材]
last_governed: 2026-07-11
---

# 素材管线规范

适用:美术/音频素材生产与再处理(抠图、动画图集、视差分层、环境动效、立绘、配音、音效)。

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
6. **原始素材归档与同步**:每个角色的定稿原始源按「一角色一文件夹」归档到
   `tmp/原始素材/<中文角色名>/`(gitignore 忽略、本地留存;文件夹**用中文角色名**,如 `土狗`/`画皮`):
   **只放定稿**——`setup.png`(原始设定图)+ 各 `<状态>.mp4`(全部定稿动画视频);
   中间版/候选/审查图/测试件一律不进。根目录 `README.md` 维护 中文文件夹 ↔ 英文 key ↔
   `<key>_anim` bundle 的对应,供同步核对。此归档是不变量①「源一致性」的落地载体——
   重扣/重生成从这里取权威源,故**必须与 `public/resources/runtime/animation/<key>_anim/`
   的上线动画长期同步**:换设定图 / 改动画 / 加动作,归档同步更新;尚未动画化的角色只放 `setup.png`。
   `animation-workbench/` 是唯一受管例外:它由动画资源工作台维护,用于保存不可变 revision、
   内容寻址对象、人工审查和检查点,不算归档根目录杂物;禁止手工改写其中的账本或产物。

## 过程义务

1. gitignored 生成物(立绘 PNG 等)就地修改前必须先自行备份。
2. 多素材批量改动先源级抽测、裁判通过后再批跑。
3. **偏差记录义务**:发现现实与本库文档打架或超出,收尾向 `agent_docs/_meta/inbox/`
   丢一条三行偏差记录(零门槛,格式见该目录 README)。

## 验收门

- `python -m tools.editor.shared.asset_reference_audit . --strict` 零问题;
- `./dev.sh validate-data` 零 error;
- 所用管线自带的 QA 门产物经 agent 裁判逐项通过。

## 红线

- 错源重处理;
- 跳过目视验收批量入库;
- 无许可来源的素材入库;
- 覆盖游戏在用文件前无备份、无返修路径;
- 原始素材归档与上线动画不同步,或在受管 `animation-workbench/` 之外塞中间版本 / 杂物。
