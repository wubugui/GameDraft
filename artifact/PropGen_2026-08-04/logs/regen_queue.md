# 收尾返工队列（主队列跑完后统一处理）

共性问题：模型见到"红漆/黄纸/红烛/铜"就画高饱和鲜色，跳出灰褐基调。
统一修法：在 subject 里写死"颜色已褪成暗XX，整体低饱和，不要鲜艳"。

| id | 问题 | subject 追加 |
|---|---|---|
| teahouse_kerosene_lamp | 灯被点亮了+金光高饱和 | 灯是熄灭的，不发光、不要光晕；铜件是发暗的旧黄铜，低饱和 |
| teahouse_tea_stove_kettle | 砖橙红、壶泛紫 | 砖是灰青色不是红砖；铜壶是发暗的旧铜色，不要紫红反光 |
| temple_candle_stand_pair | 红烛过鲜 | 红烛已褪成暗紫红，蜡面积灰，低饱和 |
| temple_broken_drum | 红漆过鲜 | 红漆已褪成暗褐红、大面积剥落露灰木 |
| temple_merit_box | 红漆过鲜 | 红漆几乎掉光只剩暗褐残迹 |
| teahouse_bamboo_recliner | 竹条亮黄 | 竹料已发暗、泛灰黄油光，不要鲜黄 |
| street_notice_board | 黄纸过亮 | 纸张是灰黄褪色发霉，不要鲜黄 |
| temple_prayer_flag_bundle | 布条过艳 | 布条颜色全部褪成灰白灰褐，几乎看不出原色 |
| yizhuang_lime_jar_set | 石灰画成白球 | 罐里是松散的白色粉末堆，不是块状不是球状 |

## 第二批（提示词收紧前出的，需返工）

已在 genprop.py 的 STYLE_PROMPT 补了三条：立体等距强制、禁地面底盘、禁一切类文字笔画。
以下条目是在补之前出的，需删掉 out/ 里的成品后重跑：

| id | 问题 |
|---|---|
| ritual_bronze_mirror_stand | 接近正视，非45度等距 |
| ritual_coffin_nail_set | 平摊俯视静物，无立体感 |
| ritual_glutinous_rice_tray | 接近正视 |
| ritual_mugwort_smoker | 接近正视 |
| ritual_peach_wood_sword | 平躺特写 + 剑身有伪汉字 + 红布过鲜 |
| ritual_realgar_wine_jar | 接近正视 |
| ritual_cinnabar_mortar | 朱砂画成鲜红血浆，过艳且像血 |
| ritual_broken_compass | 盘面有清晰刻字 |
| ritual_black_dog_blood_jar | 符纸带字 |
| ritual_geomancer_case | 卷纸带字 |
| ritual_seven_star_stones | 带了一整块草地底 |
| ritual_talisman_brick_stack | 符纸带字 |
