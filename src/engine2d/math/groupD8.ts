/** 二面体群 D8(纹理 90° 旋转 / 镜像),照 Pixi `groupD8` 的必要子集 */
const ux = [1, 1, 0, -1, -1, -1, 0, 1, 1, 1, 0, -1, -1, -1, 0, 1];
const uy = [0, 1, 1, 1, 0, -1, -1, -1, 0, 1, 1, 1, 0, -1, -1, -1];
const vx = [0, -1, -1, -1, 0, 1, 1, 1, 0, 1, 1, 1, 0, -1, -1, -1];
const vy = [1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, 1, 1, 1, 0, -1];
const cayley: number[][] = [];
for (let i = 0; i < 16; i++) {
  const row: number[] = [];
  cayley.push(row);
  for (let j = 0; j < 16; j++) {
    const _ux = Math.sign(ux[i] * ux[j] + vx[i] * uy[j]);
    const _uy = Math.sign(uy[i] * ux[j] + vy[i] * uy[j]);
    const _vx = Math.sign(ux[i] * vx[j] + vx[i] * vy[j]);
    const _vy = Math.sign(uy[i] * vx[j] + vy[i] * vy[j]);
    for (let k = 0; k < 16; k++) {
      if (ux[k] === _ux && uy[k] === _uy && vx[k] === _vx && vy[k] === _vy) {
        row.push(k);
        break;
      }
    }
  }
}

export const groupD8 = {
  E: 0, SE: 1, S: 2, SW: 3, W: 4, NW: 5, N: 6, NE: 7,
  MIRROR_VERTICAL: 8, MAIN_DIAGONAL: 10, MIRROR_HORIZONTAL: 12, REVERSE_DIAGONAL: 14,
  uX: (i: number): number => ux[i],
  uY: (i: number): number => uy[i],
  vX: (i: number): number => vx[i],
  vY: (i: number): number => vy[i],
  inv: (r: number): number => (r & 8 ? r & 15 : -r & 7),
  add: (second: number, first: number): number => cayley[second][first],
  isVertical: (r: number): boolean => (r & 3) === 2,
};
