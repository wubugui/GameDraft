import { describe, expect, it } from 'vitest';

import BAKE from '../../../tools/scene_relight/bake_gbuffer.py?raw';
import GAME from '../../core/Game.ts?raw';
import SYS from '../../core/SceneLightingSystem.ts?raw';
import CORE from './lightingCore.glsl?raw';
import CORE3 from './shadeCore3.glsl?raw';
import MIGRATE from '../../../tools/scene_relight/migrate3.py?raw';
import PASS from './SceneLightingPass.ts?raw';
import RAWPATCH from './RawPatchRelightFilter.ts?raw';
import CHAR from './UnifiedCharacterShader.ts?raw';

/**
 * 「伪世界 final gather」这条链的机械契约。
 *
 * ## 这一版换掉了什么
 *
 * 上一版把原画的照明**拟合**成 `E_est = flat + sky·T₀ + ao·AO + src·S_local`，
 * 四个系数在单纯形上网格搜索、判据是分层解耦。那条路错在方向上：
 *
 * - `S_local`（从原画自己检测出的亮斑）对任何图都近乎自解释，在拟合里
 *   **永远压过 `sky`** —— 28 个场景里 23 个天穹系数被挤到 0，连画里根本
 *   没有灯的山口都拿到 0.75 的权重。整套天空遮蔽等于没开。
 * - 而残留指标全程漂亮（0.06–0.23）。**分数低不等于机制分对了。**
 *
 * 现在 `E` 是**积出来的**：在伪世界里做一次 final gather，射线打到表面就取
 * 那里的 HDR 原画辐射，逃逸就取天空辐射 —— 画本身就是辐射缓存。没有系数，
 * 没有判据，没有搜索。天穹遮蔽是同一趟积分的另一个投影。
 *
 * 下面钉住的都是**两处必须逐字对齐、错了却不会报错**的地方。
 */

describe('E 是积出来的，不是拟合的', () => {
  it('拟合照明系数那一套已经不在了', () => {
    // ⚠ 禁的是**定义**不是提及：模块头注释里"上一版为什么删掉"那段必须留着，
    //   否则下一个人会原样再造一遍（这条路子非常诱人 —— 它的残留指标很好看）。
    for (const gone of ['def fit_day_model(', 'def detect_painted_sources(',
                        'def bake_source_transport(', 'SOURCE_MIN_EXCESS =',
                        'ORIENT_BANDS =']) {
      expect(BAKE).not.toContain(gone);
    }
  });

  it('final gather 的入射辐射只有两种来源：命中点的画、或天空', () => {
    // 命中：在 march 里就地累加（只碰当步新命中的那一小撮，见 march_and_gather）
    expect(BAKE).toContain('acc[newly] += wcos[newly][:, None] * hdr[yi[newly], xi[newly]]');
    // 逃逸：march 之后按未被挡的掩码补上天空辐射
    // ⚠ 逃逸射线的辐射**不从画面上取** —— 它已经离开画面了。天空是烘焙期的
    //   自由输入（纯色 / equirect 贴图），见 make_sky_sampler。
    //   曾经这里写的是"取视深最远 8% 像素的均值"，那是拿画面回答一个画面
    //   回答不了的问题；室内场景更荒谬（选中的是后墙脚的地面）。
    // ⚠ 蒙特卡洛之后逃逸辐射是**逐样本方向**取的，不是一个常数向量
    expect(BAKE).toContain('rad = sky_of(dw).astype(np.float32).copy()');
    expect(BAKE).toContain('def make_sky_sampler(');
    expect(BAKE).not.toContain('def estimate_sky_radiance(');
    // ⚠ 两条必须成对。少了后一条，室外开阔地会**完全没有光**（射线全逃逸），
    //   而且不报错 —— 只是那片区域黑掉。
  });

  it('E 与天穹传输是同一趟 march 出来的', () => {
    // 分两趟算既慢又有分家的风险 —— 两者本来就是同一个积分的两个投影。
    expect(BAKE).toContain('def bake_gather(');
    // 一趟出三样：辐照度 E、余弦加权可见度、bent 方向
    expect(BAKE).toContain('return e, np.clip(vis, 0.0, 1.0), bn.astype(np.float32), vfit');
    expect(BAKE).toContain('e_ind, sky_vis, bent, vfit = bake_gather(');
    expect(BAKE).not.toContain('T = bake_transport(');
    // 防回退：4 通道纬向阶梯是被否掉的设计（同一个量存两种参数化）
    expect(BAKE).not.toContain('TRANSPORT_POWERS = ');
  });

  it('gather 的上半球方向与 sky_directions 逐位相同（解析锚点因此不变）', () => {
    // 无遮挡朝上 = 1.0、竖直 = 0.5 这两个锚点由 skyTransport.test 锁着。
    // gather 换用全球面方向集时若不复用这 48 个，锚点会悄悄漂（实测竖直
    // 从 0.48956 掉到 0.48337，越过 0.015 的容差）。
    expect(BAKE).toContain('for dw, w in sky_directions():\n        out.append((dw, w, True))');
  });
});

describe('比例基底：一个除法，没有别的', () => {
  it('base = I / E，恒等式 base·E ≡ 原画 处处成立', () => {
    expect(BAKE).toContain('base = hdr_native / np.maximum(e_native, 1e-4)');
  });

  it('**没有自发光这个概念**（2026-08-23：光都是单独打）', () => {
    // 三样东西一起删掉，它们都是同一个概念换的说法：
    //   1. emissive.png（拆出来原样加回）—— 那批像素永远不跟着灯变
    //   2. base 的上限 min(·,1)（"超过 1 就是在发光"）—— 灶口/灯笼凭空暗一截
    //   3. base[sky_mask] = 0（"天是光不是表面"）—— 室内画被挖掉一整块地面
    expect(BAKE).not.toContain("out / 'emissive.png'");
    expect(BAKE).not.toContain('emissive = np.maximum(hdr_native - base_q');
    expect(BAKE).not.toContain('np.minimum(hdr_native / np.maximum');
    expect(BAKE).not.toContain('sky_mask');
    expect(BAKE).not.toContain('base[sky_native]');
    expect(PASS).not.toContain('uEmissiveTex');
    expect(PASS).not.toContain('uBakedEmissive');
  });

  it('往返在**全图**上统计（没有需要排除的像素了）', () => {
    expect(BAKE).toContain('round_lin = from_hdr(base_q * e_native)');
    expect(BAKE).not.toContain('clamped_frac');
  });

  it('灯体自发光**不受影响**（那是手摆的灯的可见灯体，两回事）', () => {
    // 2026-08-23 真踩过：把局部变量 `emissive` 改名成 `lampEmissive` 时漏了
    // 灯体累加那一行，`ERROR: 'emissive' : undeclared identifier` ——
    // 而 tsc、全部单测、校验器**全绿**。GLSL 不进 TS 的类型系统。
    expect(PASS).toContain('vec3 lampEmissive = vec3(0.0);');
    expect(PASS).toContain('lampEmissive += B.rgb *');
    expect(PASS).toContain('fragColor = vec4(surf + lampEmissive, 1.0);');
    expect(PASS).not.toMatch(/[^a-zA-Z]emissive\s*\+=/);
  });
});

describe('HDR 编解码：烘焙侧与 shader 必须同曲线', () => {
  it('from_hdr / to_hdr 两侧同曲线（逆 Reinhard，唯一的建模假设）', () => {
    // ⚠ 自发光图没了，但这条曲线仍在用：原画线性化之后要展开回 HDR 才能当
    //   辐射场喂进 final gather，否则灶口和白墙都贴在 1.0 附近、照不亮任何东西。
    expect(CORE3).toContain('vec3 sc3ToHdr(vec3 y) {');
    expect(CORE3).toContain('return y / max(vec3(1.0) - y, vec3(1.0 / 200.0));');
    // 烘焙侧的同一条曲线，分母下限同为 1/HDR_MAX。
    expect(BAKE).toContain('HDR_MAX = 200.0');
    expect(BAKE).toContain('return (lin / np.maximum(1.0 - lin, 1.0 / HDR_MAX)).astype(np.float32)');
  });

  it('辐照度与角色 GI 走对数编码（动态范围 400 倍，from_hdr 盖不住）', () => {
    expect(BAKE).toContain('def encode_log_hdr(');
    expect(BAKE).toContain(
      'v = np.log2(np.maximum(x, 1e-30) / max(scale, 1e-30)) / span + 0.5');
    // 两侧 shader 的解码都必须是同一条式子的逆。
    expect(CHAR).toContain('float a0 = uGiScale * exp2((px.r - 0.5) * uGiLogSpan);');
    expect(CORE3).toContain('return scale * exp2((px - vec3(0.5)) * span);');
    // ⚠ 对数编码吃的是**原始字节**：场景侧一度写成 sc3ToHdr(lcSrgbToLinear(...))
    //   —— 那是自发光那条曲线。混用不会报错，只是整个场景的亮度沿一条幂曲线歪掉。
    expect(PASS).toContain('vec3 giE = sc3DecodeLogHdr(texture(uIrradiance, vUv).rgb,');
    expect(PASS).not.toContain('sc3ToHdr(lcSrgbToLinear(texture(uIrradiance');
  });

  it('对数编码的往返在数值上闭合', () => {
    const SPAN = 16;
    const enc = (x: number, s: number): number =>
      Math.round(Math.min(1, Math.max(0, Math.log2(x / s) / SPAN + 0.5)) * 255);
    const dec = (u: number, s: number): number => s * 2 ** ((u / 255 - 0.5) * SPAN);
    // 中位附近应当极准；跨 ±8 档相对误差恒定在 ~4.4%（每级 16/255 档）。
    for (const [x, s] of [[1, 1], [0.05, 1], [30, 1], [200, 1], [3.7, 2.9]] as const) {
      const back = dec(enc(x, s), s);
      expect(Math.abs(back - x) / x).toBeLessThan(0.05);
    }
  });

  it('base 的对数编码：字节 0 = 精确的 0', () => {
    // 没有"字节 0 = 0"的话，极亮场景（E ~1000）里近黑像素的 base 真值低于编码
    // 下限，会被抬上来 ⇒ 本该全黑的地方发灰。实测梦_醒来土路 往返 p99 12.1/255。
    //
    // ⚠ 以前还有一步"保证 base_q ≤ base"（下调一档），那是为了让
    //   `emissive = max(I − base_q·E, 0)` 不被钳成 0。自发光删掉之后那一步没了
    //   意义 —— 就近取整误差更小，直接用。
    expect(BAKE).toContain('return decode_log_hdr(u8, scale, span) * (u8 > 0)');
    expect(BAKE).not.toContain('over = decode_base(');
    expect(PASS).toContain('* step(vec3(0.5 / 255.0), basePx);');
  });

  it('升采样在**编码域**做，与 GPU 的顺序一致', () => {
    // GPU 的线性过滤作用在纹理字节上，之后 shader 才解码。对数编码下
    // "先解码再插值" ≠ "先插值再解码"（后者是线性域的几何平均）。
    // ⚠ 烘焙若按前者算 E，据此反推的 base 就与运行时实际拿到的 E 对不上，
    //   而**往返指标测不出来**（它用烘焙自己那份 E）—— 指标全绿但画面偏一点点。
    expect(BAKE).toContain('def resize_encoded(');
    expect(BAKE).toContain('decode_log_hdr(resize_encoded(e8, scene.native), e_scale_enc, e_span)');
  });

  it('中心落在量程正中，不是拿 p99.9 当上界', () => {
    // 拿 p99.9 当 scale 踩过：典型值被推到编码量程**底部**，往返 p99 从
    // 0.56 炸到 40/255。现在中心取几何中点（比例基底取一侧对齐），
    // 于是典型值落在字节 127 附近，量程两头都用得上。
    expect(BAKE).toContain(
      'scale = hi * 2.0 ** (-span / 2.0) if one_sided else float(math.sqrt(lo * hi))');
  });
});

describe('renderRaw 装饰补丁：只吃比值，且 gi=1 时必须逐像素不变', () => {
  // 「从背景抠出、贴回原位做循环动画」的补丁（茶馆五个 fx_patron_*）。它们的像素
  // 取自已烤好光照的背景，所以**不能**走角色那条链（那条会除掉 charRefIntensity
  // 反解基底，对这类像素是错的）。但它们必须跟着重打光变，否则调低 gi 时背景暗了
  // 而补丁不变，会明显浮起来（实测 gi 1.0→0.15：背景 42.6→16.1，补丁 56.3→55.4）。

  it('比值只取**反射**那一份，不含自发光', () => {
    // 背景像素若含自发光（灶口、灯笼），把它算进比值会凭空提亮补丁 ——
    // 补丁是反射体，没有自己的自发光。
    expect(RAWPATCH).toContain('vec3 refl = max(lit - emis, vec3(0.0));');
    expect(RAWPATCH).toContain('vec3 den = base * E;');
    expect(RAWPATCH).toContain('ratio = (refl + vec3(K)) / (den + vec3(K));');
  });

  it('三张原生图取**同一个纹素**（否则 gi=1 时也会变亮）', () => {
    // 各自做线性过滤会拿到邻居的混合，而 `blend(f(x)) ≠ f(blend(x))` ——
    // 实测那样让补丁在 gi=1 时亮 0.2%–4.7%，梯度陡处最明显。
    // E 是 work 分辨率的、pass 那边就是过滤采的，所以这里也过滤采，
    // 但采在纹素中心，与 pass 用同一个采样点。
    expect(RAWPATCH).toContain('ivec2 tc = clamp(ivec2(uv * vec2(sz)), ivec2(0), sz - ivec2(1));');
    expect(RAWPATCH).toContain('vec2 cuv = (vec2(tc) + vec2(0.5)) / vec2(sz);');
    expect(RAWPATCH).toContain('texelFetch(uBase, tc, 0)');
    expect(RAWPATCH).toContain('texelFetch(uEmissiveTex, tc, 0)');
    expect(RAWPATCH).toContain('texelFetch(uRadiance, tc, 0)');
    expect(RAWPATCH).toContain('texture(uIrradiance, cuv)');
  });

  it('与背景共用同一组显示变换', () => {
    // 分家的话补丁色调会和背景对不上 —— 那正是 renderRaw 当初要躲开的毛病。
    expect(RAWPATCH).toContain('lcDisplayTransform(hdr * ratio, uEv, uTonemap, uWhiteBalance,');
    expect(SYS).toContain('for (const f of this.rawPatchFilters) f.applyParams(def);');
  });

  it('挂在 renderRaw 分支上，拿不到载荷时回落到"什么都不挂"', () => {
    expect(GAME).toContain('const relight = this.sceneLighting.createRawPatchFilter();');
    expect(GAME).toContain('npc.container.filters = relight ? [relight] : [];');
  });
});

describe('默认状态：gi = 1 ⇒ 画面就是原画', () => {
  it('迁移器写 gi=1、解析光写 0', () => {
    expect(MIGRATE).toContain("'gi': 1.0,");
    // 解析天光/环境缺省必须是 0：给非零会和 gi=1 叠成双份照明。
    expect(MIGRATE).toMatch(/'intensity': 0\.0,[\s\S]{0,200}'profile': 0\.0,/);
  });

  it('场景缺省 1，角色缺省**跟随场景**', () => {
    expect(PASS).toContain('u.uGi = def.gi ?? 1;');
    // ⚠ 角色不能写死 1：真机验过，把 gi 调到 0.3 时背景暗了、角色纹丝不动。
    expect(CHAR).toContain("num('uCharGi', def.charGi ?? def.gi ?? 1);");
  });

  it('显示变换换到 reinhard 基线（pass 现在输出真 HDR）', () => {
    // ⚠ 这条不是调参，是被迫的：v3 的 pass 输出 `to_hdr` 展开后的真 HDR（量程到
    //   200），而 27 个场景写的是 `tonemap: 'none'` —— 那会整片过曝到全白。
    //   `reinhard` 恰好是 `x/(1+x)` = `from_hdr` 的正向，于是 ev=0 + reinhard
    //   精确还原原画，那 27 个场景的画面与迁移前**完全一样**。
    expect(MIGRATE).toContain("DISPLAY_BASELINE = {'ev': 0.0, 'tonemap': 'reinhard'}");
    expect(MIGRATE).toContain("block['display'] = {**block['display'], **DISPLAY_BASELINE}");
    // reinhard 必须真的是 x/(1+x)，否则上面那条恒等就不成立。
    expect(CORE).toContain('return x / (1.0 + x);');
  });

  it('迁移器不再自动写"画里的灯"，且清掉上一版写的', () => {
    expect(MIGRATE).not.toContain('def painted_lights(');
    expect(MIGRATE).toContain("if not str(lt.get('id', '')).startswith('painted_')");
  });

  it('「总辐照 E」视图含烘焙 GI', () => {
    // 未重打光的场景 sky/sun/lamp 全是 0，照明整个来自 GI。漏掉它这个视图
    // 会显示一片黑而画面明明是亮的 —— 那种工具比没有还坏。
    expect(CORE3).toContain('return skyE + sunE + lampE + gi;');
    // ⚠ 13 号「越界指示」里的 E **刻意不含 gi**：gi=1 时 E 就是原画自己的
    //   辐照度，灶口附近合法地超过 4（teahouse 实测 5.19% 的像素）。那一档
    //   要抓的是"灯的量纲填错"，含进 gi 就变成一直喊狼来了。
    expect(CORE3).toContain('vec3 E = skyE + sunE + lampE;');
  });

  it('角色吃的是同一份烘焙 GI（否则未重打光的场景里角色全黑）', () => {
    // v2 的 placeholder 正是这么把角色挡在门外的（27 个场景摆灯零响应）。
    expect(CHAR).toContain('vec3 lin = sc3Shade(alb, skyE + ambientE, sunE + lampE, giE);');
    expect(BAKE).toContain("+ ['local_ao', 'gi_r', 'gi_g', 'gi_b']");
  });
});
