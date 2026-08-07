---
id: optional-asset-probe
title: 可选资源存在性探测(content-type 判据)
domain: runtime
type: mechanism
summary: 本仓库 dev server 上文件不存在不是 404 而是 200+HTML;可选 sidecar 一律走 loadOptionalJson,判据看 content-type 不看状态码
status: active
authority:
  - src/core/AssetManager.ts#loadOptionalJson
triggers:
  paths: ["src/core/AssetManager.ts", "vite.config.ts"]
  tasks: [加可选资源, 加 sidecar, 逐包配置, 资源加载排错]
  topics: [可选资源, sidecar, content-type, SPA fallback, 404, DEV 红条]
last_governed: 2026-08-05
---

## 是什么(一句话)

"这个资源可有可无"的加载形状(动画挂点 sidecar、逐包配置、旁注等)在本仓库的正确探测方式。

## 权威源(读代码从哪进)

`AssetManager.loadOptionalJson`(缺失即返回 null、零噪声,函数头注释含实测证据)。

## 硬契约(违反即 bug)

- **判据是 content-type,不是状态码**:本仓库 Vite dev server 的 SPA fallback 对任何匹配不到的
  路径回 **200 + index.html**,`res.ok` 那套常识写法直接失效(放行 → `.json()` 撞 `<!DOCTYPE` 抛错)。
  静态托管下真 404 也照样被挡住,两种部署都成立。
- **可选资源一律走既有的可选加载入口**,不要在调用点自己 fetch+try/catch:失败不入缓存,
  每实例化一个实体重来一次,DEV 红条会按实体数刷屏。

## 已知坑

- 症状"每进一个场景刷一屏 `[json] 加载失败 … Unexpected token '<'`"= 某处用 `res.ok` 探可选资源;
  报错次数 = 该场景实体数(未命中缓存)。

## 怎么验证

给一个**没有**该 sidecar 的包走一遍加载:DEV 红条零新增、控制台无 JSON 解析错;
再给一个有的包,确认内容正常读到且进缓存。
