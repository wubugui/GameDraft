# 渲染层架构

## 模块结构

```
rendering/
  Renderer.ts         # 核心：PixiJS Application，管理各层 Container
  Camera.ts           # 视口：控制 worldContainer 位移/缩放
  SpriteEntity.ts     # 实体基类：Container+Sprite，动画，Player/NPC 继承
  CutsceneRenderer.ts # 演出：淡入淡出/标题/对话/表情，封装 PixiJS 操作
  PlaceholderFactory.ts # 占位：无资源时的占位图
  filter/             # 可选：后处理管线
    WorldFilterPipeline.ts  # 管理 worldContainer.filters
    FilterLoader.ts         # 从 JSON 加载 Filter（当前仅 ColorMatrixFilter）
    types.ts
```

## 依赖关系

```
                    Game
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   Renderer      Camera      CutsceneRenderer
        │             │             │
        │    worldContainer ◄───────┘
        │             │
        ├─────────────┼───────────────┬──────────────┐
        ▼             ▼               ▼              ▼
  backgroundLayer  entityLayer  foregroundLayer  filter/
        │             │               │              │
        │             ▼               │         WorldFilterPipeline
        │       SpriteEntity          │         FilterLoader (JSON)
        │       (Player,NPC)          │
        ▼             ▼               ▼
   SceneManager 添加内容到各层
```

## 职责划分

| 模块 | 职责 |
|------|------|
| Renderer | 持有 PixiJS app，创建并管理 backgroundLayer/entityLayer/foregroundLayer/cutsceneOverlay/uiLayer，暴露 worldFilterPipeline |
| Camera | 控制 worldContainer 的 x/y/scale，跟随目标、边界限制 |
| SpriteEntity | 带动画的精灵，Player/NPC 继承，放入 entityLayer |
| CutsceneRenderer | 演出相关渲染（淡入淡出、标题、对话、表情），不直接持有一点 PixiJS，通过 Renderer/Camera 操作 |
| PlaceholderFactory | 创建占位用 Graphics/Texture |
| filter/ | WorldFilterPipeline 管理 filters 栈；FilterLoader 从 JSON 创建 Filter 实例 |

## 滤镜实现方式

- **非硬编码**：滤镜参数来自 `assets/data/filters/*.json`
- **FilterLoader**：根据 JSON 创建 PixiJS `ColorMatrixFilter`，可扩展支持其他 Filter 类型
- **WorldFilterPipeline**：接受任意 `Filter[]`，当前主要用于 ColorMatrix 氛围效果
