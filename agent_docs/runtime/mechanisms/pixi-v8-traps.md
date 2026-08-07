---
id: pixi-v8-traps
title: Pixi v8 静默陷阱
domain: runtime
type: mechanism
summary: 六条"写法看着对、行为静默错"的引擎事实:clear 不认 target、BindGroup 见死即自毁、解码期预乘吃掉 alpha 数据、leading 裁末行、Container 无 hitArea 恒不命中、Sprite 子节点不渲染
status: active
authority:
  - src/core/AssetManager.ts
  - src/systems/objectExamine/contactAo.ts
  - src/rendering/BackgroundDebugFilter.ts
  - src/rendering/CharacterLitSprite.ts
  - src/ui/components/UIDecor.ts
  - src/ui/InspectBox.ts
triggers:
  paths: ["src/rendering/**", "src/ui/**", "src/core/AssetManager.ts", "src/systems/objectExamine/**"]
  topics: [Pixi, pixi v8, RenderTarget, BindGroup, 预乘, hitArea, leading, 滤镜烧毁]
last_governed: 2026-08-05
---

## 是什么(一句话)

Pixi v8 里几条**不报错、只是行为不对**的引擎事实。每条都是现场买来的:症状离根因很远,
不知道就会往自己代码里找一整天。

## 硬契约(照这么写,别试别的)

- **离屏 RT 清屏走 `renderer.renderTarget.bind(rt, true, color)`,不用 `renderer.clear({target})`**
  ——WebGL 适配器忽略 target 参数,只对**当前已绑定的 FBO** 发 `gl.clear`。多张离屏 RT
  逐帧烘焙时会串台:清 A 把刚烘好的 B 抹平,而 A 自己从不被清、内容逐帧累积。
- **绑了按场景销毁的纹理的对象,卸载时必须先解绑回占位图,再销毁纹理**。BindGroup 见到
  所绑资源 `destroyed` 就把自己作废,此后读它的 resources 直接抛 —— 顺序反了不是泄漏,
  是把那个滤镜**永久烧毁**。跨场景长活的对象最危险:它不在任何 unload 名单里。
- **调试链路的异常绝不能穿进玩法链路**:同一个就绪回调里,可视化那步要单独兜错并排最后,
  否则一个坏掉的调试滤镜能让整场景照明陪葬,而且默认日志不开就完全静默。
- **「alpha 当数据用」的纹理必须走 `data.alphaMode: 'premultiplied-alpha'` 装载**。
  装载器用 `createImageBitmap` 不带选项解码,浏览器默认预乘,rgb 在**解码期**就被 ×alpha,
  GL 层的 alphaMode 怎么设都救不回。那个取值的语义是"已预乘、别再动",名字反直觉。
- **行距一律用 `lineHeight`,禁用 `leading`**:量高公式比实际绘制矮半个 leading,
  末行被文字贴图当场裁掉,按 `text.height` 反推盒高的调用方还会把 `scrollable` 判成 false。
- **「子件 `eventMode:'none'` + 容器 `static`」的按钮必须给容器补 `hitArea`**:
  命中测试只认 `hitArea` 或 `containsPoint`,普通 Container 两样都没有 → 恒判不中。
  症状是那个出口**从来没被点开过**(而旁边填充过的 ✕ 一直好使)。

## 已知坑

- `Sprite` 的子节点不渲染:bounds / visible / renderable 全正常、shader 编译通过、
  恒色调试 shader 也零像素;改挂成**兄弟节点**立刻显示。
- `renderer.extract.pixels` 不过 filter、但过 mesh 自定义 shader ——
  filter 时代拿它取证拿到的是未着色像素(会得出全套无效结论);且它自身会改变绑定态,
  探针只能放帧尾,否则会把上面那条 clear 的 bug 掩盖掉。
- 标签页 `document.visibilityState === 'hidden'` 时 rAF 被暂停,读运行时 uniform 会看到
  全是初值、逐帧驱动调用 0 次 —— **不是 bug**,是测量陷阱。

## 怎么验证

`renderer.extract.pixels(rt)` 统计非零像素数,是判断"滤镜没效果"卡在**烘焙**还是**合成**
的最快切口(注意上面的绑定态副作用)。UI 类的命中 / 排版问题走取景台全分辨率截图,
见 [ui-panel-skin](ui-panel-skin.md) 的验证节。
