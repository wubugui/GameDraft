"""响度测量与降噪。重活交给成熟库,本模块只负责"用对"。

- **响度**:`pyloudnorm`(ITU-R BS.1770-4 的参考实现)。峰值一样 ≠ 听感一样响——
  这批说书配音峰值齐刷刷 -4.8 dBFS,听感却比音效低 9 dB,正是这个坑。
- **降噪**:`noisereduce`(谱门限)。稳态底噪(空调/电流/房间本底)最吃这一套;
  非稳态(路过的车、椅子响)它救不了,那种只能重录或剪掉。
- **真峰**:自己算(4 倍过采样取最大)。pyloudnorm 不提供,而它只有十行:
  采样点之间的波峰能高过采样点本身,只看样本峰值会在解码/重采样后削顶。

调用口径上唯一需要动脑的地方是**单声道当双声道计**,见 `loudness_lufs`。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import pyloudnorm as pyln
from scipy import signal

#: **处理管线版本。改了本模块的算法、或改了 render.py 里的处理顺序,就必须 +1。**
#:
#: 它进渲染指纹(见 ledger.render_key),所以 +1 之后全部产物立刻变成"已过时"——
#: 那正是想要的:算法换了,盘上那些还是老算法渲的。不 +1 就会**静默**留着旧声音。
#:
#: 光靠自觉记不住,所以配了钉子:``tests/test_core.py::PipelineVersionTests``
#: 对固定输入跑完整管线并断言输出 sha 等于写死的值。改了算法那个测试必挂,
#: 挂了才会被迫回来 +1 并更新期望值。
PIPELINE_VERSION = 1

#: BS.1770 的响度块是 400ms;短于此的片段无法按标准测,退化为整段单块(见 loudness_lufs)
BLOCK_S = 0.400

#: 配音归一化的默认目标。对白锚定用的相对值,不是绝对法规——
#: 整体混音跑 -23 LUFS(ASWG-R001)时对白通常落在 -20 上下,音乐/环境再往下让。
DEFAULT_TARGET_LUFS = -20.0
#: 真峰上限:-1 dBTP 是各家规范的通行值,留 0.5 dB 给有损转码的余量
DEFAULT_TRUE_PEAK_CEILING_DB = -1.5


@lru_cache(maxsize=8)
def _meter(rate: int, block_s: float) -> "pyln.Meter":
    """按采样率缓存 Meter:它在构造时设计 K 加权滤波器,逐条新建是白烧 CPU。"""
    return pyln.Meter(rate, block_size=block_s)


def _as_2d(x: np.ndarray) -> np.ndarray:
    a = np.asarray(x, dtype=np.float64)
    return a[:, None] if a.ndim == 1 else a


def loudness_lufs(x: np.ndarray, rate: int, *, mono_as_dual: bool = True) -> float:
    """整段响度(Integrated Loudness, LUFS)。

    ``mono_as_dual``:单声道按"双声道同内容"计。**默认开,别关**——
    游戏里单声道素材是两只喇叭同时出声的,按单声道测会得出比实际听感低 3 LU 的数,
    于是单声道产物被归一化得比立体声产物响 3 dB;一批素材里混着两种就永远对不齐。

    短于一个响度块(400ms)的片段:标准没定义,退化为按整段长度当块长测,
    并在语义上视为近似值——切得这么碎的配音本来也不该拿来对齐。
    静音/空段返回 ``-inf``(不是 0、也不是 -70):调用方必须显式处理"这条没声音"。
    """
    a = _as_2d(x)
    if a.shape[0] == 0:
        return float("-inf")
    if mono_as_dual and a.shape[1] == 1:
        a = np.repeat(a, 2, axis=1)
    block = BLOCK_S
    if a.shape[0] <= int(BLOCK_S * rate):
        # pyloudnorm 要求"长度**严格大于**块长",取等也抛——短音效(UI 提示音等)必然踩到。
        # 缩到时长的九成:够短的素材本来就谈不上"整段响度",给个近似值也好过让调用方崩掉。
        block = max(a.shape[0] * 0.9 / rate, 2.0 / rate)
        if a.shape[0] <= int(block * rate):
            return float("-inf")
    value = float(_meter(rate, block).integrated_loudness(a))
    return value if math.isfinite(value) else float("-inf")


def true_peak_db(x: np.ndarray, rate: int, oversample: int = 4) -> float:
    """真峰值(dBTP):过采样后取最大绝对值。空段返回 ``-inf``。"""
    a = _as_2d(x)
    if a.shape[0] == 0:
        return float("-inf")
    up = signal.resample_poly(a, oversample, 1, axis=0) if (oversample > 1 and a.shape[0] > 8) else a
    peak = float(np.max(np.abs(up))) if up.size else 0.0
    return 20 * math.log10(peak) if peak > 0 else float("-inf")


def sample_peak_db(x: np.ndarray) -> float:
    a = np.asarray(x)
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    return 20 * math.log10(peak) if peak > 0 else float("-inf")


def apply_gain_db(x: np.ndarray, gain_db: float) -> np.ndarray:
    return np.asarray(x, dtype=np.float64) * (10 ** (gain_db / 20.0))


@dataclass(frozen=True)
class NormalizeResult:
    """归一化结果:量出来的数与实际施加的增益,都要能回看(界面上要显示,报告里要留痕)。"""

    samples: np.ndarray
    measured_lufs: float
    applied_gain_db: float
    #: 为守住真峰上限而额外让掉的量(dB,正数 = 比目标低了这么多)
    peak_limited_db: float
    out_lufs: float
    out_true_peak_db: float
    #: 限幅器实际压下的最大量(dB)与被压样本占比;没开限幅器时为 0
    limiter_reduction_db: float = 0.0
    limiter_touched_ratio: float = 0.0

    @property
    def hit_target(self) -> bool:
        return self.peak_limited_db <= 0.05


def normalize_lufs(
    x: np.ndarray,
    rate: int,
    target_lufs: float = DEFAULT_TARGET_LUFS,
    true_peak_ceiling_db: float = DEFAULT_TRUE_PEAK_CEILING_DB,
    *,
    max_gain_db: float = 24.0,
    use_limiter: bool = False,
) -> NormalizeResult:
    """把一段音频对齐到目标响度,并守住真峰上限。

    默认**只做增益,不做压缩**:悄悄改表演是配音工具最不该干的事。够不着目标时
    宁可让真峰上限把增益压回来,并如实报 ``peak_limited_db`` 让人知道差了多少。

    ``use_limiter=True`` 才启用峰值限幅——这是**显式的一步**,不是默认行为。
    什么时候需要它:素材动态太大,纯增益还没推到"听得见"就顶到上限了
    (本项目那批配音只剩 0.9 dB 余量,而它比游戏里其它音效轻 5~8 dB)。
    限幅只压超上限的瞬态,压了多少一并报出来。
    """
    a = _as_2d(x)
    measured = loudness_lufs(a, rate)
    if not math.isfinite(measured):
        return NormalizeResult(a.copy(), measured, 0.0, 0.0, measured, true_peak_db(a, rate))
    want = max(-max_gain_db, min(max_gain_db, target_lufs - measured))

    if use_limiter:
        # 先推到目标,再把冒头的瞬态压回上限内
        y = apply_gain_db(a, want)
        lim = limit_peaks(y, rate, true_peak_ceiling_db)
        out_l = loudness_lufs(lim.samples, rate)
        return NormalizeResult(
            lim.samples, measured, want,
            max(0.0, target_lufs - out_l) if math.isfinite(out_l) else 0.0,
            out_l, true_peak_db(lim.samples, rate),
            limiter_reduction_db=lim.max_reduction_db,
            limiter_touched_ratio=lim.touched_ratio,
        )

    tp = true_peak_db(a, rate)
    headroom = (true_peak_ceiling_db - tp) if math.isfinite(tp) else want
    applied = min(want, headroom)
    limited = max(0.0, want - applied)
    y = apply_gain_db(a, applied)
    return NormalizeResult(y, measured, applied, limited, loudness_lufs(y, rate), true_peak_db(y, rate))


def denoise(
    x: np.ndarray,
    rate: int,
    noise_sample: np.ndarray | None = None,
    *,
    reduction_db: float = 12.0,
    stationary: bool = True,
    n_fft: int = 2048,
) -> np.ndarray:
    """谱门限降噪(noisereduce)。形状进出一致。

    - ``noise_sample``:一段**纯底噪**。给了它效果好得多——"每次开录先录 10 秒空房间"
      就是为这个。不给则由 noisereduce 自己估(句间换气会被算进噪声,容易啃掉气声)。
    - ``reduction_db`` 是**衰减量不是清零**:清零会留下"音乐噪声"(一粒粒的金属音),
      压 12 dB 听着干净又自然,是这类工具的常规取值。
    - ``stationary=True`` 针对空调/电流这类恒定底噪;非稳态噪声开 False 更好,
      但对人声的副作用也更大——默认稳态,由调用方显式改。
    """
    import noisereduce as nr                    # 惰性导入:它会拉起 matplotlib,启动慢

    a = _as_2d(x)
    if a.shape[0] < n_fft:
        return a.copy()                          # 太短,谱估计没有意义,原样返回
    prop = float(np.clip(1.0 - 10 ** (-abs(reduction_db) / 20.0), 0.0, 1.0))
    kwargs = dict(
        y=a.T, sr=rate, stationary=stationary, prop_decrease=prop, n_fft=n_fft,
    )
    if noise_sample is not None and np.asarray(noise_sample).size >= n_fft:
        ns = _as_2d(noise_sample)
        kwargs["y_noise"] = ns.mean(axis=1) if ns.shape[1] > 1 else ns[:, 0]
    out = np.asarray(nr.reduce_noise(**kwargs), dtype=np.float64)
    out = out.T if out.ndim > 1 else out[:, None]
    if out.shape[0] < a.shape[0]:                # 极少数情况下 istft 会短一两帧
        out = np.pad(out, ((0, a.shape[0] - out.shape[0]), (0, 0)))
    return out[: a.shape[0]]


@dataclass(frozen=True)
class LimitResult:
    samples: np.ndarray
    #: 实际压下去的最大量(dB,正数)。0 = 限幅器根本没工作
    max_reduction_db: float
    #: 被压到的样本占比——超过百分之几就该怀疑"压过头了,人声开始发闷"
    touched_ratio: float


def limit_peaks(
    x: np.ndarray,
    rate: int,
    ceiling_db: float = DEFAULT_TRUE_PEAK_CEILING_DB,
    *,
    lookahead_ms: float = 5.0,
    smooth_ms: float = 20.0,
) -> LimitResult:
    """前瞻峰值限幅:只把冒头的瞬态压下去,不碰其余部分。

    **为什么需要它**:配音的动态很大(峰值比平均响度高十几 dB),想让人**听得见**就得
    整体推上去,而推到一半真峰就顶到 0 了。纯加增益的天花板由最尖的那个瞬态决定,
    往往还没到"够响"就走不动了——本项目那批说书配音就是,只剩 0.9 dB 余量。

    做法是老实的三步:算出每个采样点"最多能放多大"的增益曲线 → 前瞻取最小值
    (让增益在瞬态**到达之前**就降下来,而不是削掉波形本身) → 平滑,避免增益突变
    带来的"抽气"感。最后再与需求逐点取最小,保证绝不越过上限。

    这**不是**动态压缩(不改变整体动态观感),只对超过上限的瞬态动手。
    压了多少、压了多大比例都如实报出来:压超过几个 dB 就该怀疑素材本身有问题
    (比如混了一下碰麦),而不是继续往上推。
    """
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    a = _as_2d(x)
    if a.shape[0] == 0:
        return LimitResult(a.copy(), 0.0, 0.0)
    ceiling = 10 ** (ceiling_db / 20.0)
    # **按真峰算,不按样本峰算**:波峰藏在采样点之间,只看样本峰会让限幅器
    # 自以为守住了上限、实测却超出去(踩过:说书2 出来 +0.46 dBTP)。
    # 过采样 4 倍取包络,再折回每个原采样点,增益曲线就把内插峰一并算进去了。
    os_factor = 4
    peak = np.max(np.abs(a), axis=1)
    if a.shape[0] > 8:
        up = signal.resample_poly(a, os_factor, 1, axis=0)
        tp = np.max(np.abs(up), axis=1)
        usable = (tp.size // os_factor) * os_factor
        tp = tp[:usable].reshape(-1, os_factor).max(axis=1)
        if tp.size >= peak.size:
            peak = np.maximum(peak, tp[: peak.size])
        else:
            peak[: tp.size] = np.maximum(peak[: tp.size], tp)
    la = max(1, int(round(lookahead_ms / 1000.0 * rate)))
    desired = np.minimum(1.0, ceiling / np.maximum(peak, 1e-12))
    if float(desired.min()) >= 1.0:
        return LimitResult(a.copy(), 0.0, 0.0)          # 压根没有超标的地方
    # 前瞻:增益在瞬态到来之前就降下去
    g = minimum_filter1d(desired, size=2 * la + 1, mode="nearest")
    # 平滑:避免增益台阶(听起来像"抽了一下")
    sm = max(1, int(round(smooth_ms / 1000.0 * rate)))
    g = uniform_filter1d(g, size=sm, mode="nearest")
    # 平滑会把增益抬回去,与需求逐点取最小
    g = np.minimum(g, desired)
    y = a * g[:, None]

    # **收尾核验**:逐样本的 |x|·g ≤ 上限并不能保证**内插峰**也在上限内——
    # 增益是时变的,相邻两点用的增益不同,波峰恰好落在两点之间时会漏出去
    # (实测漏到 -1.11 dBTP,上限 -1.5)。这里实测一次真峰,超了就补一记极小的整体衰减:
    # 可证明成立,不靠"留 0.5 dB 经验余量"那种糊法。
    trim = 0.0
    actual = true_peak_db(y, rate)
    if math.isfinite(actual) and actual > ceiling_db:
        trim = actual - ceiling_db
        y = apply_gain_db(y, -trim)
    return LimitResult(
        y,
        float(-20 * math.log10(max(float(g.min()), 1e-12)) + trim),
        float(np.mean(g < 0.999)),
    )


#: 判"两声道是不是同一份内容"的相关系数门槛。0.999 以上才算——
#: 手机双麦录出来的立体声相关系数常在 0.65~0.86,那是**真的两路不同信号**
#: (房间反射 + 麦位不同),不是双份同内容。
_DUAL_MONO_CORR = 0.999


def is_dual_mono(x: np.ndarray, *, tol: float = 1e-6) -> bool:
    """两声道是否同一份内容(可以安全转单声道)。

    **不能只看"是不是立体声"就下手转单声道**:两路真的不同的信号求平均会梳状滤波,
    某些频率相消,人声听起来发闷发空。本项目那批说书配音实测相关系数只有 0.66~0.86,
    按"手机立体声都是双份同内容"的直觉转下去就废了。
    """
    a = _as_2d(x)
    if a.shape[1] < 2:
        return True
    if a.shape[0] == 0:
        return True
    if float(np.max(np.abs(a[:, 0] - a[:, 1]))) <= tol:
        return True
    if np.std(a[:, 0]) == 0 or np.std(a[:, 1]) == 0:
        return False
    return float(np.corrcoef(a[:, 0], a[:, 1])[0, 1]) >= _DUAL_MONO_CORR


def fade(x: np.ndarray, rate: int, fade_in_s: float = 0.0, fade_out_s: float = 0.0) -> np.ndarray:
    """线性淡入淡出。切片头尾几乎总要来一点——不然切口是个硬边,听起来是"咔"。"""
    y = _as_2d(x).copy()
    n = y.shape[0]
    fi = min(int(round(max(0.0, fade_in_s) * rate)), n)
    fo = min(int(round(max(0.0, fade_out_s) * rate)), max(0, n - fi))
    if fi > 0:
        y[:fi] *= np.linspace(0.0, 1.0, fi)[:, None]
    if fo > 0:
        y[n - fo:] *= np.linspace(1.0, 0.0, fo)[:, None]
    return y


def detect_speech_bounds(
    x: np.ndarray, rate: int, threshold_db: float = -45.0, pad_s: float = 0.08,
) -> tuple[int, int]:
    """首尾静音之外的 [起, 止) 帧下标(**只算不切**,切不切让调用方决定)。

    ``pad_s`` 是两头各留的余量:切到紧贴第一个音会吃掉起音,听起来像被掐了脖子。
    全段都在门限下(纯静音)返回 (0, 0)。
    """
    a = _as_2d(x)
    mono = np.abs(a.mean(axis=1))
    if mono.size == 0:
        return 0, 0
    win = max(1, int(round(0.02 * rate)))
    n = mono.size // win
    if n == 0:
        return 0, mono.size
    frames = mono[: n * win].reshape(n, win).max(axis=1)
    loud = np.nonzero(frames > 10 ** (threshold_db / 20.0))[0]
    if loud.size == 0:
        return 0, 0
    pad = int(round(pad_s * rate))
    return int(max(0, loud[0] * win - pad)), int(min(mono.size, (loud[-1] + 1) * win + pad))


#: 自动切分的默认门限。**不是 -45**:家庭录音的房间本底就在 -43~-45 dBFS
#: (本项目实测),门限压到那儿等于"全程都不算静音",整条录音会切成一段。
#: -35 是"明显比说话低、又高过房间本底"的位置。
DEFAULT_SPLIT_THRESHOLD_DB = -35.0
DEFAULT_MIN_SILENCE_S = 0.50


def split_on_silence(
    x: np.ndarray,
    rate: int,
    *,
    threshold_db: float = DEFAULT_SPLIT_THRESHOLD_DB,
    min_silence_s: float = DEFAULT_MIN_SILENCE_S,
    min_segment_s: float = 0.40,
    pad_s: float = 0.08,
) -> list[tuple[float, float]]:
    """按静音把一整条录音切成若干段,返回 [(起秒, 止秒), …]。

    给"一次录了一整段、要拆成一句一条"用的**起点建议**,不是终稿:
    停顿短于 ``min_silence_s`` 的两句会连在一起,该由人在波形上再拖一刀。
    两个参数都必须在界面上可调并即时重算——录音环境一换,合适的门限就变了。
    """
    a = _as_2d(x)
    mono = np.abs(a.mean(axis=1))
    if mono.size == 0:
        return []
    win = max(1, int(round(0.02 * rate)))
    n = mono.size // win
    if n == 0:
        return [(0.0, mono.size / rate)]
    frames = mono[: n * win].reshape(n, win).max(axis=1)
    voiced = frames > 10 ** (threshold_db / 20.0)
    min_sil = max(1, int(round(min_silence_s / 0.02)))
    segments: list[tuple[int, int]] = []
    start: int | None = None
    silence = 0
    for i, v in enumerate(voiced):
        if v:
            if start is None:
                start = i
            silence = 0
        elif start is not None:
            silence += 1
            if silence >= min_sil:
                segments.append((start, i - silence + 1))
                start = None
    if start is not None:
        segments.append((start, len(voiced)))
    pad = pad_s
    out: list[tuple[float, float]] = []
    for s, e in segments:
        t0 = max(0.0, s * win / rate - pad)
        t1 = min(mono.size / rate, e * win / rate + pad)
        if t1 - t0 >= min_segment_s:
            out.append((round(t0, 3), round(t1, 3)))
    return out
