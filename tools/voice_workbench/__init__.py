"""配音工作台：原始音源 → 切片 → 降噪 → 响度对齐 → 导出产物。

边界（与 tools/audio_editor 的分工，别混）：
- **本工作台是 source-centric**：管的是"从不可再生的原始录音，做出干净、音量对齐的资产"。
  它认识源库与切片，不认识 audio_config 里的 key。
- **tools/audio_editor 是 key-centric**：管的是"把某个成品挂到 audio_config 已有的 key 上"。
  它不管素材是怎么来的。

于是链路是：原始录音 → [本工作台] → 产物 wav → [audio_editor] → 挂到 key。
两边都不越界：本工作台永不写 audio_config，audio_editor 永不碰源库。

（"这个产物有没有被挂上 key"是个真问题，但答案在 key 那一侧：
``tools/editor/shared/audio_library.scan_unregistered_files`` 已经能算，
接哪儿是 audio_editor 的事，不是往这里塞一个它不该认识的概念。）

## 四层，各自只管一件事

| 层 | 文件 | 管什么 | 落在哪 |
|---|---|---|---|
| 源库 | ``library.py`` | 原始录音只进不出，记 sha | ``resources/audio_sources/`` |
| 工程 | ``project.py`` | 人的**意图**：切哪儿、叫什么、什么参数 | ``projects/<名>.json`` |
| 记账 | ``ledger.py`` | 机器的**事实**：导出成了盘上哪个文件、当时什么指纹 | ``projects/<名>.export.json`` |
| 产物 | ``render.py`` | 唯一进游戏的东西 | ``public/resources/runtime/audio/...`` |

意图与事实**必须分开存**：混在一起，每次导出都会让工程的脏态翻脏，
于是"什么都没干关闭却弹保存"——那是编辑器规范里明写的红线。

## 一条贯穿全工具的规矩

**状态是算出来的，不是手工维护的。** 界面上没有任何"已导出"复选框，
"这批要不要导"也不靠人一条条打钩——导出是一次按状态的查询（见 ``ledger`` 模块开头）。
"""
