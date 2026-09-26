---
target: vfx-plates-and-areas
date: 2026-09-26
session: 跑马梁常驻纸钱吹散不补回
---

现象: 卡上写"挑不到落点不许回收",但非限定区域的 afterMotion 挑不到就 kill(永久漏人口);细长多边形只占包围盒 9%,24 次撒点约一成落空;surface 出界判据用"包围盒放宽 35%+60",细带放宽后近乎整张图,吹出带子的纸永不回收。
证据: src/systems/vfx/vfxLifecycle.ts afterMotion / vfxSurface.ts pickAreaSurface(已修:挑点次数按 PlateArea.fill 放大;挑不到隐身重试;surface+多边形改为"正下方地面点离多边形 >80 wu 就淡出、补回时淡入");vfxPipeline.test.ts 两条新用例(旧码红)。
建议: 卡的硬契约补一句 surface 补回的出界判据(多边形距离 SURFACE_LOST_MARGIN + 淡出/淡入),并注明非限定区域现在也走 fade 通道。
追记(同日): 制作人审查"纸钱在视野里被边界淡掉"——最终口径改成有镜头时吹离那片地的纸只在出了画面才收回(当场补回+淡入),画面里的照飞照躺;睡着没醒的纸也走同一判据(VfxParticleLifecycle.settled)。无镜头(工作台/测试)才就地淡出。
追记2(同日): ①有镜头时"画面里看得见的不拿走"推广到所有移除(出界/掉崖),只限不限定范围的实例;②surface 补回的多边形区域改为按密度补(目标=burst,池=spawn.max,缺额每秒≤40张淡入),够数时吹走的收回备用;③"在不在那片地上":钉在物件(接触态 Shell)上的纸按自身位置判,其余按正下方地面点——原先一律按地面点,把 280 张钉在那片地里石头上的纸判成离开,补回补空了池子。④播放特效 paper_money_pass 的 simulation 块曾与其 spawn 块矛盾(surface/rest 覆盖了作者写的盒子+初速),已改回 shape/configured。
