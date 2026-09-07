---
id: audio-workbench-config-write
title: 音频加工台与 audio_config 的写入面
domain: editor-tools
type: mechanism
summary: 唯一一个非主编辑器却会写游戏音频配置的工具(那份 JSON 双进程共写);加工指纹只是缓存键、成品字节哈希才是身份,状态一律由磁盘反算
status: active
authority:
  - tools/audio_editor/ledger.py
  - tools/audio_editor/audio_config_io.py#key_is_writable
  - tools/audio_editor/server.py
  - public/assets/data/audio_config.json
triggers:
  paths: ["tools/audio_editor/**", "public/assets/data/audio_config.json"]
  topics: [音频加工台, audio_config, 音频台账, 指纹, 内容寻址, 双进程共写]
  tasks: [改音频加工台, 改音频配置写入, 加音频 key]
verified_by:
  - tools/audio_editor/tests/test_audio_editor.py
last_governed: 2026-09-08
---

## 是什么(一句话)

`tools/audio_editor` 是一个**独立进程的本地网页加工台**,以**项目 key 为中心**
(不是"源文件为中心的搬运工"):扫出配置里的每个音频 key,给它挂源、加工、导出,
并把结果写回 `public/assets/data/audio_config.json`。

**它是唯一一个非主编辑器、却会写游戏业务数据的工具**——那份 JSON 与主编辑器**双进程共写**。
动它之前先读 editor-tools norms 的「唯一写盘出口」与
[往返契约](../../content/mechanisms/editor-roundtrip-contract.md)、
[脏桶](save-all-dirty-buckets.md)。

## 权威源(读代码从哪进)

台账与状态推导 `tools/audio_editor/ledger.py`;配置读写 `audio_editor/audio_config_io.py`
(带字符区间的 JSON 解析器 + 只改目标键的文本级写入);服务端与 key 扫描 `audio_editor/server.py`。

## 硬契约

1. **两层身份,比较时必须写明比的是哪一层**:**加工指纹**(源字节哈希 + 规范化参数 + 输出格式)
   只是**缓存键**——"这套参数渲过没有";**成品字节哈希**才是**物理身份**。
   两层**结构性地对不上**(转码器会把自身版本戳与源元数据一起烘进成品),所以必须分开存,
   任何"这两个一样吗"的判断都要先说清是指纹还是成品哈希。导出文件名走**内容寻址**、与 key 无关。
2. **外部工具版本不进指纹**:进了的话,转码器升一次级就是**全量 key 一起跳「待更新」、重渲一遍
   换来零听感变化**。版本只作为出处证据记进 origin。
3. **状态一律由磁盘反算,台账只是缓存**:台账说"已导出"而磁盘上是别的内容 = 漂移,**以磁盘为准**。
   实测全量哈希几百个音频只要几百毫秒,**不必为性能牺牲准确性**——别把台账当真值省这一步。
4. **回收站是标记,不是删除**:素材列表上的「删除」(右键 / `Del`)只往 `trash.json` 打一个标记,
   **任何一条路径都不许删源文件**——料原样躺在盘上,回收站页签里恢复即回。两道闸:入站的
   key 必须来自实时扫描(与分配同一条规矩,不接受手写),**正被分配着的料不许收**(否则就是
   "界面上看不见、导出时仍在生效"的静默态);出站(恢复)不校验任何东西,连指向已不在盘上
   的陈年标记也照样能撤,且这类标记必须在回收站里列出来——藏起来就等于料回来那天它会
   莫名其妙不见。
5. **双进程共写 ⇒ 写入必须是"只改目标键"的最小文本改动**,不许整份重序列化:那份 JSON 主编辑器
   也在写,整份重写会把另一侧的改动与既有格式一起吞掉。

## 已知坑

- **「同一个正则同时当安全校验和命名规则」是反模式**:两者的合法集合**迟早分叉**,而分叉那天的
  表现是**某些真实数据永久不可编辑**。真实事故:一条 id 正则同时兼"防把配置拼坏"与"防 id 当
  文件名时路径穿越",于是配置里早就存在的中文 key 被判非法、永远挂不上文件;且旧实现是
  **一条坏 id 整批导出被拒**,一个中文 key 能把整批打死。**按用途各写一个判据**——写入安全只挡
  真会拼坏结构的字符,文件名安全靠"根本不用 id 当文件名"解决。
- 上一条的回归断言要用「**真实数据全集必须全部通过**」,不是几个手写样例——样例永远挑不出
  你没想到的那类真实 key,而全集断言在以后任何一次收紧时都会立刻红。

## 怎么验证

`pytest tools/audio_editor/tests/test_audio_editor.py`(含"现网配置里全部 key 都可写"的全集断言,
以及回收站那组"标记后文件必须还在盘上");
改写入面后与主编辑器**同时开着**各改一次,确认两侧改动都还在;`./dev.sh validate-data` 零 error。
