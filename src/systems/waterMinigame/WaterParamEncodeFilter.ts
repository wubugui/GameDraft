import { Filter, GlProgram } from 'pixi.js';

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
uniform float uDepth;
uniform float uGlow;

void main(void) {
    vec4 t = texture(uTexture, vTextureCoord);
    if (t.a < 0.004) discard;
    finalColor = vec4(uDepth, uGlow, 1.0, t.a);
}
`;

let sharedProgram: GlProgram | null = null;

function program(): GlProgram {
  if (!sharedProgram) sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  return sharedProgram;
}

export class WaterParamEncodeFilter extends Filter {
  constructor() {
    super({
      glProgram: program(),
      resources: {
        paramUniforms: {
          uDepth: { value: 0.5, type: 'f32' },
          uGlow: { value: 0, type: 'f32' },
        },
      },
    });
  }

  private get _u(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms?: Record<string, unknown> }>)['paramUniforms']?.uniforms;
  }

  setDepthGlow(depth: number, glow: number): void {
    const u = this._u;
    if (!u) return;
    u['uDepth'] = Number.isFinite(depth) ? Math.max(0, depth) : 0;
    u['uGlow'] = Math.max(0, Math.min(1, glow));
  }
}
