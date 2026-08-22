---
target: pixi-v8-traps
date: 2026-08-22
session: 角色阴影 shader 改造（加变半径半影抽样）
---

# 影子 shader 实际编译在 GLSL ES 1.00；GLSL 注释里的反引号会当场截断源码

- **现象①**：给 `EntityShadow.ts` 的 FRAG 加了一个常量数组
  （`const vec2 RING[8] = vec2[8](...)`）→ 控制台
  `'[]' : array constructor supported in GLSL ES 3.00 and above only` +
  `PixiJS Error: Could not initialize shader`，**整个影子 shader 起不来**（影子直接没了）。
- **根因**：源码里的 `in` / `out` / `texture()` 是 **Pixi 反向转译**过去的，本工程实际拿到的
  WebGL 上下文是 **WebGL1（GLSL ES 1.00）**。转译只管那几个关键字，**数组构造式、first-class
  数组、`const` 数组一律不转**。写 shader 时不能因为看到 ES3 语法就以为环境是 ES3。
  对策：抽样点手写展开，别用数组。
- **现象②**：修①时在 GLSL 注释里写了 `` `in/out/texture()` `` → vite 报
  `Unexpected flag t in regular expression literal`，整个模块 500。
- **根因**：那段 GLSL 是 TS **模板字符串**，注释里的反引号直接把模板提前闭合，后面的
  `/out/t` 被当成正则字面量。`tsc` 能抓（我是先改后跑才漏掉一轮），但症状离根因很远。
  规矩：**GLSL 模板字符串内的中文注释一律不许出现反引号**。

两条都是"写法看着对、行为静默错"，且第一条只有真机跑才会现——`tsc` 与 `vitest` 全绿。
