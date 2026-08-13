---
target: missing
date: 2026-08-10
session: 音频加工台 key 台账重构
---

现象: 库里没有 `tools/audio_editor` 这个工具的任何卡片或 paths 触发器(audit.py 对它零命中),
而它是**唯一一个非主编辑器、却会写 `public/assets/data/audio_config.json` 的东西**。这次重构把它
从「源文件为中心的搬运工」翻成「项目 key 为中心的加工台」,沉下来三条能复用的知识:
①**两层身份**——加工指纹(hash(源字节)+规范化参数+输出格式)只当缓存键,成品字节 hash 才是物理身份;
源文件与项目里那份**结构性地**对不上(ffmpeg 把版本戳与源元数据一起烘进成品),所以两层必须分字典存、
比较时必须写明比的是哪一层。②**ffmpeg 版本不进指纹**——进了的话 brew 升一次级全量 key 一起跳「待更新」,
重渲一遍换来零听感变化;它只作为出处证据记进 origin。③**状态一律由磁盘反算**,台账只是缓存,
台账说「已导出」而磁盘上是别的内容 = 漂移,以磁盘为准。
证据: `tools/audio_editor/ledger.py`(两层身份 + 五态推导)、`tools/audio_editor/audio_config_io.py`
(带字符区间的 JSON 解析器 + 只换 src 的文本级写入)、`tools/audio_editor/server.py`
(key 实时扫描 / 存量回填 / 指纹命中即 relink);77 条用例见
`tools/audio_editor/tests/test_audio_editor.py`。实测:全量 hash 240 个音频(255MB)仅 273ms,
所以「每次打开实时算全量 hash 反算真实状态」完全走得通,不必为性能牺牲准确性。
建议: 值得建一张 asset-pipeline 或 editor-tools 的机制卡「音频加工台与 audio_config 的写入面」,
并给 audit.py 补 `tools/audio_editor/**` 的触发器(至少指向 editor-roundtrip-contract 与
save-all-dirty-buckets 两张卡)——否则下一个动它的人不会知道那份 JSON 是双进程共写的。
