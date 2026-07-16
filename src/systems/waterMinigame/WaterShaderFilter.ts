import { Filter, GlProgram, Texture } from 'pixi.js';

const VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

const FRAG = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uNormalMap;
uniform sampler2D uParams;

uniform float uTime;
uniform float uMurk;
uniform float uDarkness;
uniform float uRain;
uniform vec3 uSigma;
uniform float uMinAlpha;
uniform float uUseNormalMap;
/** 水域水底光学系数（>=0）：背景与物体像素路径均为 coefficient ×（垂直项或 RT.R），不设人为上限 */
uniform float uWaterBottomDepth;

void main(void) {
    vec2 uv = vTextureCoord;

    vec2 ripple = vec2(
        sin(uv.x * 48.0 + uTime * 1.7) * cos(uv.y * 31.0 - uTime * 1.1),
        cos(uv.y * 44.0 + uTime * 1.4) * sin(uv.x * 29.0 + uTime * 0.9)
    ) * 0.012 * (0.35 + uMurk);

    if (uUseNormalMap > 0.5) {
        vec3 n = texture(uNormalMap, uv * 2.5 + uTime * 0.03).rgb * 2.0 - 1.0;
        ripple += n.xy * 0.018;
    }

    vec2 suv = clamp(uv + ripple, vec2(0.001), vec2(0.999));
    vec4 col = texture(uTexture, suv);

    vec4 pm = texture(uParams, suv);
    float pMask = step(0.5, pm.b) * pm.a;
    float bgOpticalPath = max(uWaterBottomDepth * suv.y, 0.0001);
    float entityRelDepth = max(pm.r, 0.0);
    float entityOpticalPath = max(uWaterBottomDepth * entityRelDepth, 0.0001);
    float depthGrad = mix(bgOpticalPath, entityOpticalPath, pMask);

    vec3 absorb = exp(-uSigma * depthGrad * (1.2 + uMurk * 2.5));
    col.rgb *= absorb;

    col.rgb *= clamp(1.0 - uDarkness, 0.15, 1.0);

    float fog = uMurk * 0.35 + uRain * 0.08;
    col.rgb = mix(col.rgb, vec3(0.55, 0.62, 0.72), clamp(fog, 0.0, 0.85));

    float glowAmt = pMask * pm.g;
    col.rgb += vec3(0.82, 0.90, 1.0) * glowAmt * 0.48;

    float rainTint = uRain * 0.22;
    col.rgb = mix(col.rgb, vec3(0.72, 0.78, 0.88), rainTint);

    col.a = max(col.a, uMinAlpha);

    finalColor = col;
}
`;

let sharedProgram: GlProgram | null = null;

function program(): GlProgram {
  if (!sharedProgram) sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  return sharedProgram;
}

export class WaterShaderFilter extends Filter {
  constructor() {
    const ph = Texture.WHITE;
    super({
      glProgram: program(),
      resources: {
        waterUniforms: {
          uTime: { value: 0, type: 'f32' },
          uMurk: { value: 0.35, type: 'f32' },
          uDarkness: { value: 0, type: 'f32' },
          uRain: { value: 0, type: 'f32' },
          uSigma: { value: new Float32Array([0.9, 1.35, 1.85]), type: 'vec3<f32>' },
          uMinAlpha: { value: 0.12, type: 'f32' },
          uUseNormalMap: { value: 0, type: 'f32' },
          uWaterBottomDepth: { value: 1.0, type: 'f32' },
        },
        uNormalMap: ph.source,
        uParams: ph.source,
      },
    });
  }

  private get _u(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms?: Record<string, unknown> }>)['waterUniforms']?.uniforms;
  }

  setTime(t: number): void {
    const u = this._u;
    if (u) u['uTime'] = t;
  }

  applySurface(
    time: 'morning' | 'day' | 'night',
    weather: 'clear' | 'rain' | 'fog',
  ): void {
    const u = this._u;
    if (!u) return;

    let murk = 0.32;
    let rain = 0;
    let darkness = 0;
    if (weather === 'rain') {
      murk = 0.62;
      rain = 1;
    } else if (weather === 'fog') {
      murk = 0.88;
    }
    if (time === 'night') darkness = 0.38;
    else if (time === 'morning') darkness = 0.08;

    u['uMurk'] = murk;
    u['uRain'] = rain;
    u['uDarkness'] = darkness;

    const sig = u['uSigma'] as Float32Array;
    sig[0] = 0.85;
    sig[1] = 1.25;
    sig[2] = 1.75;
    u['uMinAlpha'] = weather === 'fog' ? 0.18 : 0.1;
  }

  setNormalTexture(tex: Texture | null): void {
    const src = tex?.source ?? Texture.WHITE.source;
    (this.resources as Record<string, unknown>)['uNormalMap'] = src;
    const u = this._u;
    if (u) u['uUseNormalMap'] = tex ? 1 : 0;
  }

  setParamsTexture(tex: Texture | null): void {
    const src = tex?.source ?? Texture.WHITE.source;
    (this.resources as Record<string, unknown>)['uParams'] = src;
  }

  /** 水域水底光学系数（>=0）；缺省 1。与背景 suv.y、参数 RT 的 R 相乘后进入贝尔定律，不做 1 上限 */
  setWaterBottomDepth(depth: number): void {
    const u = this._u;
    if (!u || !Number.isFinite(depth)) return;
    u['uWaterBottomDepth'] = Math.max(0, depth);
  }

  getDebugUniformState(): Record<string, unknown> {
    const u = this._u;
    return {
      time: u?.['uTime'],
      murk: u?.['uMurk'],
      darkness: u?.['uDarkness'],
      rain: u?.['uRain'],
      sigma: Array.from((u?.['uSigma'] as Float32Array | undefined) ?? []),
      minAlpha: u?.['uMinAlpha'],
      waterBottomDepth: u?.['uWaterBottomDepth'],
    };
  }
}
