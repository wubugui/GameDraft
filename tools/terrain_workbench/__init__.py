# -*- coding: utf-8 -*-
"""地形工作台：碰撞 / 可走区 / 行走面修补的**唯一作者面**（`public/resources/runtime/scenes/<id>/terrain/` 的唯一写入者）。

合成器在 `tools.character_lighting_lab.terrain_compose`（烘焙器与本工作台共用同一份）；这里只有作者面：
状态编解码、保存 / 历史 / 草稿、推给游戏（预览目录）/ 导出到游戏（资源）、与游戏的联动槽。
"""
