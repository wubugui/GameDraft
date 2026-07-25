// ============================================================================
// 角色着色核心 —— 唯一真相源(single source of truth)。
//
// 运行时(src/rendering/CharacterShadingFilter.ts 的 FRAG)与灯光实验室
// (tools/character_lighting_lab/viewer/app.js 的 CHAR_FS / CHAR3D_FS)三处 shader
// **共用这一份**:运行时经 vite `?raw` 注入,实验室经 serve.py 端点注入到 COMMON。
// 任何角色着色迭代(尤其 E 的颜色/明暗分离)只改此文件,三处自动对齐——**禁止在任一处
// 内联重写这段逻辑**,否则实验室预览与游戏漂移、在实验室调出的参数到游戏里就是错的。
//
// 依赖:调用方 shader 里已定义 srgb2lin()（运行时 FRAG 与实验室 COMMON 均已定义)。
// ============================================================================

// E 分解 + albedo × E。
//   albSrgb  角色 albedo(sRGB,直通图集像素;sprite 本身是着色后的 color)
//   E        场景辐照度(RGB,probe/RT gather;已含太阳等累加)
//   eChroma  E 色度权重:0=只借场景明暗(luma)、角色保留自己颜色不被场景色染;1=完整彩色 E
//   beta     曝光(已 pow,即 2^β)
// 返回:**线性域** col(未 lin2srgb、未乘实验室 pgain、未 clamp——由各调用方按自身上下文处理)。
vec3 shadeCharacterLinear(vec3 albSrgb, vec3 E, float eChroma, float beta) {
  float lumaE = dot(E, vec3(0.2126, 0.7152, 0.0722));
  E = mix(vec3(lumaE), E, eChroma);   // sprite 缺的是明暗、颜色自带 → 默认只借明暗
  return srgb2lin(albSrgb) * E / 3.14159265 * beta;
}
