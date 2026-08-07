---
id: object-examine-scene
title: 物件检视场景(物理单位制 + 伪形体)
domain: runtime
type: mechanism
summary: 一张静帧撑起的可看场景;长度类参数一律真实单位并由实例声明物理标尺,alpha 只给边界、形体要另烘高度场
status: active
authority:
  - src/systems/objectExamine/types.ts
  - src/systems/objectExamine/ObjectExamineScene.ts
  - src/systems/objectExamine/contactAo.ts
  - src/systems/objectExamine/crawlField.ts#sampleCrawlHeight
  - src/systems/objectExamine/critterSim.ts
  - tools/editor/validator.py
triggers:
  paths: ["src/systems/objectExamine/**", "public/assets/data/object_examine/**"]
  topics: [物件检视, objectExamine, 接触AO, 爬虫, 高度场, 物理单位, 厘米]
last_governed: 2026-08-05
---

## 是什么(一句话)

把一张静帧贴图撑成"可以凑近看"的小场景:接触 AO、氛围层(尘/云影/蝇)、爬虫仿真,
全部在同一份伪形体模型上跑。

## 权威源(读代码从哪进)

`types.ts` 的实例/表现结构与单位换算函数 → `ObjectExamineScene.ts` 装配 →
`contactAo.ts`(离屏 RT 烘 mask + AO)/ `crawlField.ts`(导航场与高度场)/ `critterSim.ts`(仿真)。

## 硬契约(违反即 bug)

- **可度量的表现参数一律用真实单位(cm、cm/s),长度不许用贴图像素或无量纲倍率表达**。
  每个实例用 `presentation.physicalWidthCm` 声明**唯一物理标尺**(`pixelsPerCm = texW / 它`),
  离屏 mask 的分辨率也按每厘米纹素定、不按源图像素定。否则同一份配置换张分辨率不同的图
  观感就变(实测:高分辨率图上"半径 1"的接触阴影只有 2 屏幕像素,肉眼没有)。
  真正无量纲的(浓淡 / 密度 / 个数 / 秒数 / 归一化落点)才留裸数值;
  镜头抖动属**观察者**不属物件空间,不换算。旧的像素倍率字段由 `validator.py` 报 error。
- **alpha 只给边界,形体要另烘高度场**——只有剪影的世界里,虫子就是"匀速直线穿贴纸"。
  **不能直接拿亮度当高度**(深色袍读成凹陷、苍白皮肤读成鼓包);须拆成
  "离边内距开方成宏观穹顶" + "亮度高通给微观衣褶"。
- **剪影边高度骤降为 0**,有限差分在那里给出悬崖级梯度,**必须夹取**,否则贴边的爬虫被弹飞。
- **地形/沟壑影响的量纲要看接入点**:对"有目标朝向的"加角度、对"直接积分 heading 的"
  乘角速度×dt。混用会让效果弱到等于没生效——而且看起来像"参数调小了",不像 bug。
- **"随机方向 + 固定偏移出生"的过场型实体必须按穿越方向实算到边界的距离**(再加一个身长余量)。
  用长边比例当偏移,在非正方画面上会让横穿刚出边就入画甚至直接生在画面内,竖穿则远在画外
  要爬几秒才进来——观众看到的是"方向根本不随机"。
- 离屏 RT 逐帧烘焙的清屏纪律见 [pixi-v8-traps](pixi-v8-traps.md),这套是它的重灾区。

## 已知坑

- 爬虫的跨面 / 半身遮挡未做(需要真正的分层深度),别当缺陷重报。

## 怎么验证

真机 A/B 看**分布量**而不是单帧:形体生效看头段 scale 的取值个数与速度变异系数,
AO 生效看"对画面影响百分比"从近零抬起来,出生分布看横竖穿计数与离屏距离。
改数据后 `./dev.sh validate-data`(旧单位字段直接 error)。
