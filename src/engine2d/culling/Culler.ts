/**
 * 视锥剔除(移植自 PixiJS v8.17(MIT):`culling/Culler`,算法逐行对应)。
 *
 * `Culler.shared.cull(container, view, skipUpdateTransform = true)` 从 `container` 往下递归:
 * - 节点 `cullable && measurable && includeInBuild` 才判:
 *   - 有 `cullArea`:把 cullArea(本地坐标)按世界变换投到屏幕,和 view 做**带变换的**矩形相交
 *     (`Rectangle.intersects(other, transform)`),不相交 = culled;
 *   - 否则取世界包围盒,完全在 view 之外(贴边也算外)= culled;
 * - 其它节点 `culled = false`;
 * - `cullableChildren` 为 false、节点已 culled、不可渲染 / 不计包围盒 / 不进收集时,**不再往下走**
 *   (子节点保留上一次的 culled 值,与 Pixi 相同)。
 *
 * 与 Pixi 的差别只在变换的"新鲜度":Pixi 在 `skipUpdateTransform = true`(缺省)时读的是**上一次渲染**
 * 留下的 worldTransform(本帧逻辑里挪过的节点要晚一帧才反映);engine2d 的 Container 的 worldTransform /
 * getBounds 任何时候都按当前父链现算,所以两个取值都得到**本帧**的结果。
 */
import { Matrix } from '../math/Matrix';
import { Rectangle } from '../math/Rectangle';
import { Bounds } from '../scene/Bounds';
import { getGlobalBounds, type Container } from '../scene/Container';

/** 有 x / y / width / height 的矩形(同 Pixi `RectangleLike`) */
export type RectangleLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const tempBounds = new Bounds();
const tempMatrix = new Matrix();
const tempRectangle = new Rectangle();

export class Culler {
  /** 共享实例 */
  static shared = new Culler();

  /**
   * 按 view 剔除 container 子树。
   * @param container 要剔除的容器(自身也参与判定)
   * @param view 可见区域(与世界变换同一坐标系,一般是 renderer.screen 或其外扩)
   * @param skipUpdateTransform 同 Pixi 的参数;engine2d 两种取值都读当前变换(见文件头)
   */
  cull(container: Container, view: RectangleLike, skipUpdateTransform = true): void {
    this._cullRecursive(container, view, skipUpdateTransform);
  }

  private _cullRecursive(container: Container, view: RectangleLike, skipUpdateTransform = true): void {
    if (container.cullable && container.measurable && container.includeInBuild) {
      if (container.cullArea) {
        tempRectangle.x = view.x;
        tempRectangle.y = view.y;
        tempRectangle.width = view.width;
        tempRectangle.height = view.height;
        const transform = skipUpdateTransform
          ? container.worldTransform
          : container.getGlobalTransform(tempMatrix, skipUpdateTransform);
        container.culled = !tempRectangle.intersects(container.cullArea, transform);
      } else {
        const bounds = getGlobalBounds(container, skipUpdateTransform, tempBounds);
        container.culled = bounds.x >= view.x + view.width
          || bounds.y >= view.y + view.height
          || bounds.x + bounds.width <= view.x
          || bounds.y + bounds.height <= view.y;
      }
    } else {
      container.culled = false;
    }

    if (
      !container.cullableChildren
      || container.culled
      || !container.renderable
      || !container.measurable
      || !container.includeInBuild
    ) return;

    for (let i = 0; i < container.children.length; i++) {
      this._cullRecursive(container.children[i], view, skipUpdateTransform);
    }
  }
}
