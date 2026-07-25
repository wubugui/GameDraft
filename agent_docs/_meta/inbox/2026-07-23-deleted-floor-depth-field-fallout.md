---
target: asset-pipeline
date: 2026-07-23
session: 废除 floor_depth_A/B 后的下游残留清点(烘焙前体检)
---

现象: `export_scene_depth` 不再写 `floor_depth_A/B` 之后,三处下游仍在读它,且**全部是静默失败**:
①`serve.py` 的 `/api/export_depth` 末尾 `return {'ok': True, 'floor_A': cfg['shader']['floor_depth_A']}`
——KeyError 被外层 except 吞成「导出失败」,于是**每一次深度导出都假报错**(viewer 只看 `ok`,
那个值根本没人用);②`tools/lightvolume_lab`(character_lighting_lab 的前身实验,语义门已被移植走)
的 `floorDepthAt(gy)=floorA*sy+floorB` 会变 NaN,画面静默错;③`tools/anim_preview/dist-remote/`
里那份**已构建产物**仍带 `uFloorA/uFloorB` 老滤镜。

证据: `grep -rn floor_depth tools/ src/` —— `src/` 只剩注释(干净),真读它的就上面三处。①在**烘焙主路径上**,
不修就是一喊烘就满屏假失败。修法:①改回 `depth_per_sy`(遮挡唯一还用的 shader 参数,`export_scene_depth`
确实写);②`floorDepthAt` 加非有限值即抛,提示改用 character_lighting_lab;③是 dist 产物,重构建即消。

建议: 卡里记一条**废字段下线清单法**——删导出字段时必须同时 `grep` 三类下游:服务端 API 的回包字段、
旁支实验工具、**已构建的 dist 产物**;前两类会把 KeyError/undefined 吞成"看起来只是失败/画面怪",
比直接崩更难查。另记:主编辑器 `scene_editor.py` 里有 8 处提示文案 + 2 处 docs 仍指向**已删除的**
`tools/scene_depth_editor`(叫用户去开一个不存在的菜单项),同批已改为「角色照明实验室」——
删工具时同样要连提示文案一起扫。
