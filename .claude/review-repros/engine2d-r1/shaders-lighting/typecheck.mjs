import fs from 'fs';
const M = './.tools/game_parity_ref/5f5a639f63a4e04e8a27991c11df7a674a09e81e/';
const files = ['src/rendering/lighting/SceneLightingPass.ts','src/rendering/lighting/LitBackground.ts','src/rendering/lighting/shadowPrefix.ts','src/rendering/lighting/GiBouncePass.ts','src/rendering/CharacterLitSprite.ts','src/rendering/CharacterShadingFilter.ts','src/rendering/EntityLightingFilter.ts','src/rendering/EntityShadow.ts','src/rendering/DepthOcclusionFilter.ts','src/rendering/BackgroundDebugFilter.ts'];
const map = {float:'f32', vec2:'vec2<f32>', vec3:'vec3<f32>', vec4:'vec4<f32>', mat3:'mat3x3<f32>', int:'i32', mat4:'mat4x4<f32>'};
const allJs = {};
for (const f of files) {
  const s = fs.readFileSync(M+f,'utf8');
  for (const m of s.matchAll(/(\w+)\s*:\s*\{\s*value:[^}]*?type:\s*'([^']+)'(?:\s*,\s*size:\s*([\w.]+))?/g)) allJs[m[1]] = (allJs[m[1]]||[]).concat([[m[2], m[3]||'1', f]]);
  for (const m of s.matchAll(/(\w+)\s*:\s*f32\(/g)) allJs[m[1]] = (allJs[m[1]]||[]).concat([['f32','1',f]]);
}
for (const f of files) {
  const s = fs.readFileSync(M+f,'utf8');
  for (const m of s.matchAll(/uniform\s+(?:highp\s+|mediump\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*;/g)) {
    const [_, t, n, arr] = m;
    if (t.startsWith('sampler')) continue;
    const js = allJs[n];
    if (!js) { console.log('NOJS', f, t, n); continue; }
    for (const [jt, sz, jf] of js) {
      if (map[t] !== jt) console.log('TYPE', f, n, 'glsl', t, arr||'', 'js', jt, sz, jf);
    }
  }
}
