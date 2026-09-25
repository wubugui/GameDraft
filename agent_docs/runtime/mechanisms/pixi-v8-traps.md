---
id: pixi-v8-traps
title: Pixi v8 静默陷阱
domain: runtime
type: mechanism
summary: 一批"写法看着对、行为静默错"的引擎事实:渲染抛一次异常=整局死透(ticker 再不排帧)、没写 #version 300 es 的源按 GLSL ES 1.00 编、clear 不认 target、BindGroup 见死即自毁、滤镜容器里 screen 是临时 RT 局部坐标、解码期预乘吃掉 alpha 数据、leading 裁末行、Container 无 hitArea 恒不命中
status: active
authority:
  - src/core/AssetManager.ts
  - src/rendering/Renderer.ts
  - src/systems/objectExamine/contactAo.ts
  - src/rendering/BackgroundDebugFilter.ts
  - src/rendering/CharacterLitSprite.ts#LIT_SHADER_SCENE_TEXTURE_SLOTS
  - src/rendering/EntityShadow.ts
  - src/ui/components/UIDecor.ts
  - src/ui/InspectBox.ts
triggers:
  paths: ["src/rendering/**", "src/ui/**", "src/core/AssetManager.ts", "src/systems/objectExamine/**"]
  topics: [Pixi, pixi v8, RenderTarget, BindGroup, 预乘, hitArea, leading, 滤镜烧毁, ticker, GLSL, WebGL1, 卡死, shader 编译, 首帧卡顿, KHR_parallel_shader_compile, 滤镜容器, 临时 RT, 屏幕反推世界]
last_governed: 2026-09-23
---

## 是什么(一句话)

Pixi v8 里几条**不报错、只是行为不对**的引擎事实。每条都是现场买来的:症状离根因很远,
不知道就会往自己代码里找一整天。

> **2026-09-25 起运行时不再用 Pixi**,渲染走 [engine2d](engine2d.md)(照 Pixi 8.17 移植的同名 API,跑在 RHI / WebGPU 上)。
> 下面各条对运行时的适用性:
> - **仍然成立**(engine2d 照搬了同样的行为):渲染抛错 = 主循环死、crash guard 必须在 init 前装(Ticker / Application 照 Pixi 移植);
>   手抄槽位镜像必漏;模板字符串里不许有反引号(WGSL 源同样是模板字符串);先解绑再销毁(engine2d 绑到已销毁的纹理源当帧抛);
>   alpha 当数据的纹理按 `premultiplied-alpha` 装载(装载器照 Pixi 的解码规则);滤镜容器里 screen 是临时 RT 局部坐标;
>   uniform 组的键必须构造时声明(WGSL 缓冲布局只认构造时的键);`leading`;无 `hitArea` 的容器恒不命中;标签样式表。
> - **已失效**(只对 Pixi WebGL 成立):`#version 300 es` / GLSL ES 1.00 编译目标、`renderer.clear({target})` 与
>   `renderTarget.bind` 清屏、GlProgram 首用同步编译卡顿与 GL 预编译(engine2d 没有 WebGL,`GlProgram` 只是壳;
>   WebGPU 的对应物是管线预建 `prewarmPipelines` / `pipelinesReady`,见 vfx-rendering)。
>   渲染之外清一张 RT 仍用 `render({ container: 空容器, target, clear: true })`。
> - 编辑器(`tools/anim_preview`、`tools/parallax_editor`)仍直接跑 Pixi,整卡对它们照旧适用。

## 硬契约(照这么写,别试别的)

- **渲染路径抛一次异常 = 整局死透,所以渲染入口必须在 `app.init()` 之前套 crash guard。**
  Ticker 的 `_tick` 先把 requestId 清掉、再调 `update()`,**只有 update 正常返回才排下一帧** ——
  任何从 render 逃出来的异常都不是"掉一帧",是 `started` 仍为 true 却再没人申请 rAF,
  **主循环永久死亡**(画面定格、输入全无、在途的切场景永远悬着,只能刷页面)。
  兜错要**照旧大声报**(控制台 + dev 错误面),但绝不许逃到 ticker。
  ⚠ 装的时机是硬条件:`TickerPlugin` 在 `init` 里就把 `render` 的**函数引用**交给了 ticker,
  init 之后再覆盖实例属性,ticker 手上的还是原来那个。
- **手抄的 shader 槽位镜像必然会漏,而在渲染路径上漏一个槽位的代价是整局卡死。**
  凡是"另一处维护一份槽位/资源清单"的写法(卸载前退回占位图之类),那份清单必须与
  **创建 shader 的那一处同处维护**;分开放着,新加一个纹理槽就会漏掉,
  于是跨场景长活的对象身上还绑着已销毁的纹理 → 下一帧渲染即抛 → 见上一条。
- **编译目标按片元源码逐个决定:写了 `#version 300 es` 就是真 ES3,没写就是 GLSL ES 1.00。**
  `GlProgram` 看片元源里有没有那一行(有就剥掉再插回、按 ES3 编);没有时源码里的 `in` / `out` /
  `texture()` 是 Pixi **反向转译**到 ES 1.00 的,而转译只管那几个关键字:**数组构造式、first-class 数组、
  `const` 数组一律不转**,写了就是 `array constructor supported in GLSL ES 3.00 and above only` +
  shader 起不来(那个效果直接没了)。所以要用这些语法就在源头写 `#version 300 es`(光照/角色/燃烧/粒子
  着色器都这么做),别为一条不存在的限制手写展开;没写那一行的源才需要展开。
  这条**只有真机跑才会现**——`tsc` 与单测全绿。
- **GLSL 模板字符串里不许出现反引号**(包括中文注释里)。那段 GLSL 是 TS 模板字符串,
  一个反引号就把模板提前闭合,后面的内容被当成正则字面量解析,整个模块 500,
  而报错信息离根因极远。
- **离屏 RT 清屏走 `renderer.renderTarget.bind(rt, true, color)`,不用 `renderer.clear({target})`**
  ——WebGL 适配器忽略 target 参数,只对**当前已绑定的 FBO** 发 `gl.clear`。多张离屏 RT
  逐帧烘焙时会串台:清 A 把刚烘好的 B 抹平,而 A 自己从不被清、内容逐帧累积。
- **绑了按场景销毁的纹理的对象,卸载时必须先解绑回占位图,再销毁纹理**。BindGroup 见到
  所绑资源 `destroyed` 就把自己作废,此后读它的 resources 直接抛 —— 顺序反了不是泄漏。
  **代价不止"烧毁那个滤镜",是整局**(那一抛发生在渲染路径上,见第一条)。
  跨场景长活的对象最危险:它不在任何 unload 名单里。
- **调试链路的异常绝不能穿进玩法链路**:同一个就绪回调里,可视化那步要单独兜错并排最后,
  否则一个坏掉的调试滤镜能让整场景照明陪葬,而且默认日志不开就完全静默。
- **「alpha 当数据用」的纹理必须走 `data.alphaMode: 'premultiplied-alpha'` 装载**。
  装载器用 `createImageBitmap` 不带选项解码,浏览器默认预乘,rgb 在**解码期**就被 ×alpha,
  GL 层的 alphaMode 怎么设都救不回。那个取值的语义是"已预乘、别再动",名字反直觉。
- **挂在带滤镜的容器下的东西,shader 里不许从 screen 反推世界坐标**:Pixi 先把整棵子树渲进一张按包围盒
  对齐的临时 RT,那一趟 shader 见到的 screen 是**临时 RT 的局部坐标**,`(screen − 相机位移) / 缩放` 这类重建
  被整体平移。**`gl_Position` 不受影响 ⇒ 画面位置一直对、只有采样位置错**,误差随镜头与包围盒漂
  (实测角色光照偏 500+ wu,表现为"强度怎么调都和场景对不齐")。要世界坐标就由 CPU 每帧喂 local→世界的仿射。
  同族:`extract.pixels({target: 某 mesh})` 的隔离渲染也会把目标平移到包围盒原点,位置类取证须整舞台抽取。
- **行距一律用 `lineHeight`,禁用 `leading`**:量高公式比实际绘制矮半个 leading,
  末行被文字贴图当场裁掉,按 `text.height` 反推盒高的调用方还会把 `scrollable` 判成 false。
- **「子件 `eventMode:'none'` + 容器 `static`」的按钮必须给容器补 `hitArea`**:
  命中测试只认 `hitArea` 或 `containsPoint`,普通 Container 两样都没有 → 恒判不中。
  症状是那个出口**从来没被点开过**(而旁边填充过的 ✕ 一直好使)。

## 已知坑

- **`TextureSource.destroy()` 连带销毁 `style`,style 销毁发 `change` → 含它的 BindGroup 自毁**。着色器资源里放了
  `source.style`(WGSL 独立采样器)就多了一条自毁路径,WebGL 下同样整帧抛。一律用 `samplerOf(source)` 取不死的共享采样器
  (见 pixi-shader-wgsl-port;`gpuSampler.test.ts` 有对照组证明这条路径真实存在)。

- **uniform 组的键必须在构造时声明**:构造后才往 `uniforms` 上挂的新键,WebGL 侧 `generateUniformsSync` 按 `uniforms`
  遍历、却从 `uniformStructures` 取类型——同步函数若在挂键之后生成就每帧抛 `reading 'type'`(渲染路径抛异常,见第一条),
  若在之前生成则新键永远传不上去(静默恒为缺省);WebGPU 侧缓冲布局里也没有它。setter 只许改已声明的键
  (实例:F2 背景调试滤镜的地面场三个键,2026-09-25 补声明)。
- **WebGPU 渲染器在一次 `render()` 之外没有命令编码器**:`renderTarget.bind(...)` 当场抛;`renderer.clear({target})`
  在首次 render 之前也抛,且单独提交时用的是上一个目标的视口。渲染之外要清一张 RT,就 `render({container: 空容器, target, clear: true})`。

- **(仅 Pixi WebGL:编辑器 / master 对照侧;运行时的对应物见 engine2d 卡「管线预建」)GlProgram 第一次被用来画东西时才编译,而且同步等链接结果**(`generateProgram` 里直接 `getProgramParameter(LINK_STATUS)`)。
  Windows 上 ANGLE → D3D11 的 FXC 编大 shader 是秒级的:拼了大循环 / 循环里采纹理的 shader 能到 10 s 级,
  主线程整个停住,症状是"某个东西第一次出现时卡死几秒、之后再也不卡"。游戏预览窗口带 `--disable-gpu-shader-disk-cache`,
  每次开窗口重来。对策:① 不可达的分支别拼进 shader(编译器照样展开);② 开局用 `KHR_parallel_shader_compile`
  后台编(主线程只轮询)并在遮罩下经 `renderer.shader.bind(shader, true)` 交给 Pixi——同源同上下文命中 ANGLE 程序缓存,
  交接只要几十 ms(master 上的 `GlProgramWarmup` 就是这么做的,本分支已删)。量它:包 `WebGL2RenderingContext.prototype.getProgramParameter` 计时。

- `Sprite` 的子节点不渲染:bounds / visible / renderable 全正常、shader 编译通过、
  恒色调试 shader 也零像素;改挂成**兄弟节点**立刻显示。
- `renderer.extract.pixels` 不过 filter、但过 mesh 自定义 shader ——
  filter 时代拿它取证拿到的是未着色像素(会得出全套无效结论);且它自身会改变绑定态,
  探针只能放帧尾,否则会把上面那条 clear 的 bug 掩盖掉。
- 标签页 `document.visibilityState === 'hidden'` 时 rAF 被暂停,读运行时 uniform 会看到
  全是初值、逐帧驱动调用 0 次 —— **不是 bug**,是测量陷阱。
- **挂了标签样式表的文本,正文里字面写的尖括号串就是真标签**:引擎会把那一段整个吞掉,
  其后的字被无声染色且永不闭合。所以样式表**必须按串开关**(这一串确实含标记、且没有裸尖括号
  才挂),不能给每个文本对象无条件挂上。另:量文字宽高的那一侧必须与渲染侧同口径,
  否则量歪一路错到整列排版。

## 怎么验证

`renderer.extract.pixels(rt)` 统计非零像素数,是判断"滤镜没效果"卡在**烘焙**还是**合成**
的最快切口(注意上面的绑定态副作用)。UI 类的命中 / 排版问题走取景台全分辨率截图,
见 [ui-panel-skin](ui-panel-skin.md) 的验证节。
