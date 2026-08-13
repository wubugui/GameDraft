---
target: missing
date: 2026-08-10
session: 音频加工台 key 台账重构
---

现象: 工具里一条 `AUDIO_ID_RE = ^[A-Za-z0-9_-]{1,80}$` 同时兼了两件互不相干的事——防把 audio_config.json
拼坏、防 id 当导出文件名时路径穿越。而线上 audio_config 的 ambient 区**已经有 8 个中文 id**
(海边/野外鸟叫/阴风/夜晚蛐蛐叫/人声闹市/中文人声闹市/赌场背景声/闹市),于是这 8 个 key 被判 invalid_id、
永远挂不上文件,而且旧实现是「一条坏 id 整批导出被拒」,一个中文 key 能把整批打死。
证据: `python3 -c "import server; print(server.validate_audio_id('海边'))"`(旧版)→ 返回错误串;
`public/assets/data/audio_config.json` 的 ambient 区含上述 8 个中文键;新版把它拆成两个函数——
`audio_config_io.key_is_writable()`(只挡控制字符/引号/反斜杠,中文与空格放行)与工具自己生成的
内容寻址文件名(`<stem>_<hash8><ext>`,与 id 再无关系),护栏
`tools/audio_editor/tests/test_audio_editor.py::KeyWritabilityTests::test_real_config_keys_are_all_writable`
(直接断言清单里 180 个 key 全部可写,以后再收紧就会红)。
建议: 值得升一条通则——**「同一个正则同时当安全校验和命名规则」是反模式**:两者的合法集合迟早分叉,
而分叉那天表现为「某些真实数据永久不可编辑」。判据要按用途各写一个,并且用「真实数据全集必须全部通过」
当回归断言(比列举几个手写样例强得多)。
