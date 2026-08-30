# GameDraft 生产场景背景重绘预览

本目录只存放美术审阅稿，不替换、不改写 `public/resources/runtime/scenes/` 下任何现有资产，也未修改场景 JSON 引用。

## 本轮纳入：当前生产剧情实际引用

所有下列场景 JSON 的当前背景字段均为 `backgrounds[0].image = "background.png"`，运行时源图路径为：

`public/resources/runtime/scenes/<sceneId>/background.png`

| 序号 | sceneId | 当前源图 | 本轮预览图 |
|---:|---|---|---|
| 01 | teahouse | `scenes/teahouse/background.png` | `01_teahouse_redraw.png` |
| 02 | 雾津街头 | `scenes/雾津街头/background.png` | `02_雾津街头_redraw.png` |
| 03 | 码头白天 | `scenes/码头白天/background.png` | `03_码头白天_redraw.png` |
| 04 | 崖墓 | `scenes/崖墓/background.png` | `04_崖墓_redraw.png` |
| 05 | 婆子家院 | `scenes/婆子家院/background.png` | `05_婆子家院_redraw.png` |
| 06 | 河边 | `scenes/河边/background.png` | `06_河边_redraw.png` |
| 07 | 枯井土地庙 | `scenes/枯井土地庙/background.png` | `07_枯井土地庙_redraw.png` |
| 08 | 阎王岭山口 | `scenes/阎王岭山口/background.png` | `08_阎王岭山口_redraw.png` |
| 09 | 义庄 | `scenes/义庄/background.png` | `09_义庄_redraw.png` |
| 10 | 城隍庙夜 | `scenes/城隍庙夜/background.png` | `10_城隍庙夜_redraw.png` |
| 11 | 城门口 | `scenes/城门口/background.png` | `11_城门口_redraw.png` |
| 12 | 梦_夜路 | `scenes/梦_夜路/background.png` | `12_梦_夜路_redraw.png` |
| 13 | 梦_农家院 | `scenes/梦_农家院/background.png` | `13_梦_农家院_redraw.png` |
| 14 | 梦_饭屋 | `scenes/梦_饭屋/background.png` | `14_梦_饭屋_redraw.png` |
| 15 | 梦_里屋 | `scenes/梦_里屋/background.png` | `15_梦_里屋_redraw.png` |
| 16 | 梦_醒来土路 | `scenes/梦_醒来土路/background.png` | `16_梦_醒来土路_redraw.png` |
| 17 | 破屋 | `scenes/破屋/background.png` | `17_破屋_redraw.png` |
| 18 | 野道 | `scenes/野道/background.png` | `18_野道_redraw.png` |

## 本轮排除：未被生产剧情使用

- 无引用：`dev_room`、`test_scene`、`深潭水下`、`深潭绝地`。
- 未注册为当前场景 JSON：`临江崖墓挂壁小道`、`yamutongdao`。
- 旧流程或开发专用：`test_room_a`、`test_room_b`、`temple`、`temple_exterior`、`bridge_underpass`、`mountain_pass`、`dev_teahouse_alive`。
- 各场景目录里的 `legacy`、`v2/v3`、`bigscene`、`night` 等候选图不是当前 `background.png` 引用，不作为本轮源图。

## 统一重绘标准

- 民初约 1910s-1920s 的川渝重庆周边，而非泛古代、江南水乡或北方院落。
- 45°斜俯视可玩场景；保留原图出入口、路径、功能区与主要空间关系。
- 数字手绘结合克制的版画刻线；墨黑、湿蓝灰、土褐为主，暖黄与暗红只做局部叙事焦点。
- 真实市井、职业与生活痕迹先成立，异常只露一线。
- 禁止玄幻法光、发光符咒、魔法裂缝、现代物件、乱码招牌、烘焙人物和游戏 UI。
- 生成端优先 4K；如原生输出受限，审阅成品统一保证至少 2048×1152。
