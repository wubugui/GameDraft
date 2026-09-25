/**
 * 移植自 PixiJS v8.17(MIT):filters/defaults/color-matrix/ColorMatrixFilter。
 *
 * 5×4 颜色矩阵(行主序 20 个数:每行 r,g,b,a,偏移)。着色器先反预乘、乘矩阵、按 `alpha` 与原色混合、再预乘。
 * 各预设方法的数值与 Pixi 逐个相同。与 Pixi 的差别:① engine2d 只有 WebGPU,不建 GlProgram;
 * ② tint / colorTone 读颜色分量时显式取 float32(见 toFloat32Rgb)——为的是结果与 Pixi 逐位相同。
 *
 * uniform:`uColorMatrix` 声明为 20 个 f32(布局 80 字节连续),WGSL 里是 `array<vec4<f32>, 5>`,
 * 两者字节布局相同(见 uboLayout 的数组规则)。
 */
import { Color, type ColorSource } from '../../../color/Color';
import { Filter, type FilterOptions } from '../../Filter';
import { GpuProgram } from '../../../shader/GpuProgram';
import { UniformGroup } from '../../../shader/UniformGroup';
import source from './colorMatrixFilter.wgsl';

/** 定长数组(照 Pixi `utils/types` 的 `ArrayFixed`) */
export type ArrayFixed<T, L extends number> = [T, ...Array<T>] & { length: L };

/** 5×4 颜色矩阵 */
export type ColorMatrix = ArrayFixed<number, 20>;

/**
 * Pixi 的 `Color` 把分量存在 Float32Array 里,`toArray()` 读出的是 float32 精度;engine2d 的 `Color` 存双精度。
 * 这里显式取 float32,使 tint / colorTone(及其后的叠乘)产出的矩阵与 Pixi 逐位相同。
 */
function toFloat32Rgb(color: Color): [number, number, number] {
  const [r, g, b] = color.toArray();

  return [Math.fround(r), Math.fround(g), Math.fround(b)];
}

export class ColorMatrixFilter extends Filter {
  constructor(options: FilterOptions = {}) {
    const colorMatrixUniforms = new UniformGroup({
      uColorMatrix: {
        value: [
          1, 0, 0, 0, 0,
          0, 1, 0, 0, 0,
          0, 0, 1, 0, 0,
          0, 0, 0, 1, 0,
        ],
        type: 'f32',
        size: 20,
      },
      uAlpha: {
        value: 1,
        type: 'f32',
      },
    });

    const gpuProgram = GpuProgram.from({
      vertex: {
        source,
        entryPoint: 'mainVertex',
      },
      fragment: {
        source,
        entryPoint: 'mainFragment',
      },
    });

    super({
      ...options,
      gpuProgram,
      resources: {
        colorMatrixUniforms,
      },
    });

    this.alpha = 1;
  }

  /**
   * 载入新矩阵
   * @param matrix - 5×4 矩阵
   * @param multiply - true:与当前矩阵相乘;false:直接替换
   */
  private _loadMatrix(matrix: number[], multiply = false): void {
    if (multiply) {
      const newMatrix = [...matrix];
      this._multiply(newMatrix, this.matrix, matrix);
      this.resources.colorMatrixUniforms.uniforms.uColorMatrix = newMatrix;
    } else {
      this.resources.colorMatrixUniforms.uniforms.uColorMatrix = matrix;
    }

    this.resources.colorMatrixUniforms.update();
  }

  /** 两个 5×4 矩阵相乘:out = a × b */
  private _multiply(out: number[], a: ArrayLike<number>, b: ArrayLike<number>): number[] {
    // Red Channel
    out[0] = (a[0] * b[0]) + (a[1] * b[5]) + (a[2] * b[10]) + (a[3] * b[15]);
    out[1] = (a[0] * b[1]) + (a[1] * b[6]) + (a[2] * b[11]) + (a[3] * b[16]);
    out[2] = (a[0] * b[2]) + (a[1] * b[7]) + (a[2] * b[12]) + (a[3] * b[17]);
    out[3] = (a[0] * b[3]) + (a[1] * b[8]) + (a[2] * b[13]) + (a[3] * b[18]);
    out[4] = (a[0] * b[4]) + (a[1] * b[9]) + (a[2] * b[14]) + (a[3] * b[19]) + a[4];

    // Green Channel
    out[5] = (a[5] * b[0]) + (a[6] * b[5]) + (a[7] * b[10]) + (a[8] * b[15]);
    out[6] = (a[5] * b[1]) + (a[6] * b[6]) + (a[7] * b[11]) + (a[8] * b[16]);
    out[7] = (a[5] * b[2]) + (a[6] * b[7]) + (a[7] * b[12]) + (a[8] * b[17]);
    out[8] = (a[5] * b[3]) + (a[6] * b[8]) + (a[7] * b[13]) + (a[8] * b[18]);
    out[9] = (a[5] * b[4]) + (a[6] * b[9]) + (a[7] * b[14]) + (a[8] * b[19]) + a[9];

    // Blue Channel
    out[10] = (a[10] * b[0]) + (a[11] * b[5]) + (a[12] * b[10]) + (a[13] * b[15]);
    out[11] = (a[10] * b[1]) + (a[11] * b[6]) + (a[12] * b[11]) + (a[13] * b[16]);
    out[12] = (a[10] * b[2]) + (a[11] * b[7]) + (a[12] * b[12]) + (a[13] * b[17]);
    out[13] = (a[10] * b[3]) + (a[11] * b[8]) + (a[12] * b[13]) + (a[13] * b[18]);
    out[14] = (a[10] * b[4]) + (a[11] * b[9]) + (a[12] * b[14]) + (a[13] * b[19]) + a[14];

    // Alpha Channel
    out[15] = (a[15] * b[0]) + (a[16] * b[5]) + (a[17] * b[10]) + (a[18] * b[15]);
    out[16] = (a[15] * b[1]) + (a[16] * b[6]) + (a[17] * b[11]) + (a[18] * b[16]);
    out[17] = (a[15] * b[2]) + (a[16] * b[7]) + (a[17] * b[12]) + (a[18] * b[17]);
    out[18] = (a[15] * b[3]) + (a[16] * b[8]) + (a[17] * b[13]) + (a[18] * b[18]);
    out[19] = (a[15] * b[4]) + (a[16] * b[9]) + (a[17] * b[14]) + (a[18] * b[19]) + a[19];

    return out;
  }

  /** 亮度:0 全黑,1 不变 */
  brightness(b: number, multiply: boolean): void {
    const matrix = [
      b, 0, 0, 0, 0,
      0, b, 0, 0, 0,
      0, 0, b, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 乘一个颜色 */
  tint(color: ColorSource, multiply?: boolean): void {
    const [r, g, b] = toFloat32Rgb(Color.shared.setValue(color));
    const matrix = [
      r, 0, 0, 0, 0,
      0, g, 0, 0, 0,
      0, 0, b, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 灰度 */
  greyscale(scale: number, multiply: boolean): void {
    const matrix = [
      scale, scale, scale, 0, 0,
      scale, scale, scale, 0, 0,
      scale, scale, scale, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** greyscale 的别名 */
  grayscale(scale: number, multiply: boolean): void {
    this.greyscale(scale, multiply);
  }

  /** 黑白 */
  blackAndWhite(multiply: boolean): void {
    const matrix = [
      0.3, 0.6, 0.1, 0, 0,
      0.3, 0.6, 0.1, 0, 0,
      0.3, 0.6, 0.1, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 色相旋转(度) */
  hue(rotation: number, multiply: boolean): void {
    rotation = ((rotation || 0) / 180) * Math.PI;

    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const sqrt = Math.sqrt;

    const w = 1 / 3;
    const sqrW = sqrt(w);

    const a00 = cosR + ((1.0 - cosR) * w);
    const a01 = (w * (1.0 - cosR)) - (sqrW * sinR);
    const a02 = (w * (1.0 - cosR)) + (sqrW * sinR);

    const a10 = (w * (1.0 - cosR)) + (sqrW * sinR);
    const a11 = cosR + (w * (1.0 - cosR));
    const a12 = (w * (1.0 - cosR)) - (sqrW * sinR);

    const a20 = (w * (1.0 - cosR)) - (sqrW * sinR);
    const a21 = (w * (1.0 - cosR)) + (sqrW * sinR);
    const a22 = cosR + (w * (1.0 - cosR));

    const matrix = [
      a00, a01, a02, 0, 0,
      a10, a11, a12, 0, 0,
      a20, a21, a22, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 对比度 */
  contrast(amount: number, multiply: boolean): void {
    const v = (amount || 0) + 1;
    const o = -0.5 * (v - 1);

    const matrix = [
      v, 0, 0, 0, o,
      0, v, 0, 0, o,
      0, 0, v, 0, o,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 饱和度 */
  saturate(amount = 0, multiply?: boolean): void {
    const x = ((amount * 2) / 3) + 1;
    const y = ((x - 1) * -0.5);

    const matrix = [
      x, y, y, 0, 0,
      y, x, y, 0, 0,
      y, y, x, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 去饱和 */
  desaturate(): void {
    this.saturate(-1);
  }

  /** 反色 */
  negative(multiply: boolean): void {
    const matrix = [
      -1, 0, 0, 1, 0,
      0, -1, 0, 1, 0,
      0, 0, -1, 1, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 怀旧 */
  sepia(multiply: boolean): void {
    const matrix = [
      0.393, 0.7689999, 0.18899999, 0, 0,
      0.349, 0.6859999, 0.16799999, 0, 0,
      0.272, 0.5339999, 0.13099999, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 特艺七彩 */
  technicolor(multiply: boolean): void {
    const matrix = [
      1.9125277891456083, -0.8545344976951645, -0.09155508482755585, 0, 0.046249425232852304,
      -0.3087833385928097, 1.7658908555458428, -0.10601743074722245, 0, -0.2758903984886823,
      -0.231103377548616, -0.7501899197440212, 1.847597816108189, 0, 0.12137623870388682,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 宝丽来 */
  polaroid(multiply: boolean): void {
    const matrix = [
      1.438, -0.062, -0.062, 0, 0,
      -0.122, 1.378, -0.122, 0, 0,
      -0.016, -0.016, 1.483, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 红蓝互换 */
  toBGR(multiply: boolean): void {
    const matrix = [
      0, 0, 1, 0, 0,
      0, 1, 0, 0, 0,
      1, 0, 0, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 柯达克罗姆 */
  kodachrome(multiply: boolean): void {
    const matrix = [
      1.1285582396593525, -0.3967382283601348, -0.03992559172921793, 0, 0.24991995145868634,
      -0.16404339962244616, 1.0835251566291304, -0.05498805115633132, 0, 0.09698983488904393,
      -0.16786010706155763, -0.5603416277695248, 1.6014850761964943, 0, 0.13972481597886063,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 棕褐 */
  browni(multiply: boolean): void {
    const matrix = [
      0.5997023498159715, 0.34553243048391263, -0.2708298674538042, 0, 0.1860075629647401,
      -0.037703249837783157, 0.8609577587992641, 0.15059552388459913, 0, -0.14497417640467167,
      0.24113635128153335, -0.07441037908422492, 0.44972182064877153, 0, -0.029655197167024642,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 复古 */
  vintage(multiply: boolean): void {
    const matrix = [
      0.6279345635605994, 0.3202183420819367, -0.03965408211312453, 0, 0.037848179746251466,
      0.02578397704808868, 0.6441188644374771, 0.03259127616149294, 0, 0.029265996770472907,
      0.0466055556782719, -0.0851232987247891, 0.5241648018700465, 0, 0.020232119953863904,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 双色调 */
  colorTone(desaturation: number, toned: number, lightColor: ColorSource, darkColor: ColorSource, multiply: boolean): void {
    desaturation ||= 0.2;
    toned ||= 0.15;
    lightColor ||= 0xFFE580;
    darkColor ||= 0x338000;

    const temp = Color.shared;
    const [lR, lG, lB] = toFloat32Rgb(temp.setValue(lightColor));
    const [dR, dG, dB] = toFloat32Rgb(temp.setValue(darkColor));

    const matrix = [
      0.3, 0.59, 0.11, 0, 0,
      lR, lG, lB, desaturation, 0,
      dR, dG, dB, toned, 0,
      lR - dR, lG - dG, lB - dB, 0, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 夜色 */
  night(intensity: number, multiply: boolean): void {
    intensity ||= 0.1;

    const matrix = [
      intensity * (-2.0), -intensity, 0, 0, 0,
      -intensity, 0, intensity, 0, 0,
      0, intensity, intensity * 2.0, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 捕食者热感 */
  predator(amount: number, multiply: boolean): void {
    const matrix = [
      // row 1
      11.224130630493164 * amount,
      -4.794486999511719 * amount,
      -2.8746118545532227 * amount,
      0 * amount,
      0.40342438220977783 * amount,
      // row 2
      -3.6330697536468506 * amount,
      9.193157196044922 * amount,
      -2.951810836791992 * amount,
      0 * amount,
      -1.316135048866272 * amount,
      // row 3
      -3.2184197902679443 * amount,
      -4.2375030517578125 * amount,
      7.476448059082031 * amount,
      0 * amount,
      0.8044459223747253 * amount,
      // row 4
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** LSD */
  lsd(multiply: boolean): void {
    const matrix = [
      2, -0.4, 0.5, 0, 0,
      -0.5, 2, -0.4, 0, 0,
      -0.4, -0.5, 3, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, multiply);
  }

  /** 复位成单位矩阵 */
  reset(): void {
    const matrix = [
      1, 0, 0, 0, 0,
      0, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 1, 0,
    ];

    this._loadMatrix(matrix, false);
  }

  /** 当前的 5×4 矩阵 */
  get matrix(): ColorMatrix {
    return this.resources.colorMatrixUniforms.uniforms.uColorMatrix;
  }

  set matrix(value: ColorMatrix) {
    this.resources.colorMatrixUniforms.uniforms.uColorMatrix = value;
  }

  /** 与原色的混合比例:0 = 原色,1 = 全用矩阵结果 */
  get alpha(): number {
    return this.resources.colorMatrixUniforms.uniforms.uAlpha;
  }

  set alpha(value: number) {
    this.resources.colorMatrixUniforms.uniforms.uAlpha = value;
  }
}
