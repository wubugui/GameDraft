# 滤镜工具

Python + PIL 实现，与游戏 ColorMatrix 格式一致。输出 JSON 供游戏 FilterLoader 加载。

## 安装

```bash
pip install numpy Pillow
```

## 运行

```bash
python -m tools.filter_tool
```

或从项目根目录：`npm run filter-tool`

## 使用

1. 加载图片：选择场景或背景图
2. 预制：内置（还原、夜晚、黄昏、阴天、复古）+ 自定义
3. 添加预制：调节参数后输入名称，点击「添加当前为预制」，保存到 `tools/filter_tool/custom_presets.json`
4. 参数：亮度、对比度、饱和度、色相
5. 保存：输入滤镜 ID，写入 `public/assets/data/filters/{id}.json`

## 格式

与游戏 FilterLoader 一致：`{ "id", "matrix": [20个数], "alpha": 1 }`
