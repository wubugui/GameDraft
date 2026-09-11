/**
 * 三维值噪声 + curl 场，给湍流 / 游走用。纯函数、确定性（哈希格点），零分配热路径。
 *
 * curl 场是散度为零的速度场——用它当加速度扰动，粒子不会聚成团也不会被"吹散到无穷"，
 * 烟与尘埃的"打转"就是它。数学：`curl(F) = (∂Fz/∂y − ∂Fy/∂z, ∂Fx/∂z − ∂Fz/∂x, ∂Fy/∂x − ∂Fx/∂y)`，
 * 用三个相位错开的标量噪声当 F 的三个分量，中心差分求偏导。
 */

function hash3(ix: number, iy: number, iz: number, salt: number): number {
  let h = Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 值噪声，范围 [−1, 1] */
export function valueNoise3(x: number, y: number, z: number, salt = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  const c000 = hash3(ix, iy, iz, salt), c100 = hash3(ix + 1, iy, iz, salt);
  const c010 = hash3(ix, iy + 1, iz, salt), c110 = hash3(ix + 1, iy + 1, iz, salt);
  const c001 = hash3(ix, iy, iz + 1, salt), c101 = hash3(ix + 1, iy, iz + 1, salt);
  const c011 = hash3(ix, iy + 1, iz + 1, salt), c111 = hash3(ix + 1, iy + 1, iz + 1, salt);
  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return (y0 + (y1 - y0) * fz) * 2 - 1;
}

const CURL_EPS = 0.01;

/**
 * curl 噪声：输入已归一化坐标（除过尺度）与时间偏移，输出单位量级的散度零向量场，写进 `out[o..o+2]`。
 */
export function curlNoise3(x: number, y: number, z: number, t: number, out: Float32Array | number[], o = 0): void {
  const e = CURL_EPS;
  // F = (n0, n1, n2)，各自带时间偏移
  const dFz_dy = (valueNoise3(x, y + e, z, 2) - valueNoise3(x, y - e, z, 2)) / (2 * e);
  const dFy_dz = (valueNoise3(x, y, z + e + t, 1) - valueNoise3(x, y, z - e + t, 1)) / (2 * e);
  const dFx_dz = (valueNoise3(x + t, y, z + e, 0) - valueNoise3(x + t, y, z - e, 0)) / (2 * e);
  const dFz_dx = (valueNoise3(x + e, y, z, 2) - valueNoise3(x - e, y, z, 2)) / (2 * e);
  const dFy_dx = (valueNoise3(x + e, y, z + t, 1) - valueNoise3(x - e, y, z + t, 1)) / (2 * e);
  const dFx_dy = (valueNoise3(x + t, y + e, z, 0) - valueNoise3(x + t, y - e, z, 0)) / (2 * e);
  out[o] = dFz_dy - dFy_dz;
  out[o + 1] = dFx_dz - dFz_dx;
  out[o + 2] = dFy_dx - dFx_dy;
  // 值噪声梯度量级约 1..3，归一到单位量级
  const s = 0.35;
  out[o] *= s; out[o + 1] *= s; out[o + 2] *= s;
}
