/**
 * DOM 事件接入层(移植自 PixiJS v8.17(MIT)`events/EventSystem.ts`,逐行对应)。
 *
 * 监听画布(及 document / window)上的 pointer / mouse / touch / wheel,把原生事件规范化成联邦事件,
 * 交给 `rootBoundary`(rootTarget = `renderer.lastObjectRendered`)做命中测试与分发;管理光标样式。
 *
 * 与 Pixi 的差别:
 * - 没有扩展系统:渲染器建好后由上层 `new EventSystem(renderer)` 再调 `init(options)`(Pixi 由渲染器的
 *   init runner 调);渲染器改分辨率时调 `resolutionChange(res)` 或直接写 `resolution`。
 * - `EventSystem.defaultEventMode` 照样记录,但 engine2d 的 Container 默认 eventMode 固定为 'passive'
 *   (不读这里),与 Pixi 在 `eventMode` 选项缺省时的结果一致。
 */
import type { PointData } from '../math/Point';
import type { RendererBase } from '../gpu/Renderer';
import type { Container, EventMode } from '../scene/Container';
import { EventBoundary } from './EventBoundary';
import { EventsTicker } from './EventTicker';
import { FederatedPointerEvent } from './FederatedPointerEvent';
import { FederatedWheelEvent } from './FederatedWheelEvent';
import type { PixiTouch } from './FederatedEvent';
import type { FederatedMouseEvent } from './FederatedMouseEvent';

const MOUSE_POINTER_ID = 1;
const TOUCH_TO_POINTER: Record<string, string> = {
  touchstart: 'pointerdown',
  touchend: 'pointerup',
  touchendoutside: 'pointerupoutside',
  touchmove: 'pointermove',
  touchcancel: 'pointercancel',
};

/** 事件系统选项(照 Pixi `EventSystemOptions`) */
export interface EventSystemOptions {
  /** 所有显示对象的默认事件模式,缺省 'passive'(见文件头:engine2d 的 Container 不读它) */
  eventMode?: EventMode;
  /** 开关各类事件 */
  eventFeatures?: Partial<EventSystemFeatures>;
}

/** 事件系统的功能开关(照 Pixi `EventSystemFeatures`) */
export interface EventSystemFeatures {
  /** 指针移动相关:pointermove / mousemove / touchmove、pointerout / mouseout、pointerover / mouseover */
  move: boolean;
  /** 全局移动事件:globalpointermove / globalmousemove / globaltouchmove */
  globalMove: boolean;
  /** 点击相关:down / up / upoutside / click / tap 各族 */
  click: boolean;
  /** 滚轮 */
  wheel: boolean;
}

/** 渲染器上 EventSystem 需要的最小形状(`RendererBase` 满足它;单测可以传假对象) */
export type EventSystemRenderer = Pick<RendererBase, 'canvas' | 'resolution' | 'lastObjectRendered'>;

export class EventSystem {
  /** 默认的事件功能开关 */
  static defaultEventFeatures: EventSystemFeatures = {
    /** 指针移动相关事件 */
    move: true,
    /** 全局移动事件 */
    globalMove: true,
    /** 点击相关事件 */
    click: true,
    /** 滚轮事件 */
    wheel: true,
  };

  private static _defaultEventMode: EventMode;

  /** 所有显示对象的默认事件模式(`init` 时由选项写入) */
  static get defaultEventMode(): EventMode {
    return this._defaultEventMode;
  }

  /**
   * 舞台的事件边界。它的 rootTarget 在每次处理事件前自动设为渲染器最近一次渲染的对象,
   * 所以场景至少渲染过一次之后才有事件。
   */
  readonly rootBoundary: EventBoundary;

  /** 设备是否支持 W3C 触摸事件 */
  readonly supportsTouchEvents = 'ontouchstart' in globalThis;

  /** 设备是否支持 W3C 指针事件 */
  readonly supportsPointerEvents = !!globalThis.PointerEvent;

  /** 是否自动 preventDefault 规范化出来的(非原生指针)事件 */
  autoPreventDefault: boolean;

  /**
   * 光标样式表:字符串当 CSS cursor 用,对象整体赋给 DOM 元素的 style,函数直接以模式名调用。
   * 缺省 `{ default: 'inherit', pointer: 'pointer' }`。
   */
  cursorStyles: Record<string, string | ((mode: string) => void) | CSSStyleDeclaration>;

  /** 挂根监听的 DOM 元素(缺省为渲染器的画布) */
  domElement: HTMLElement = null!;

  /** DOM 客户区坐标换到世界坐标用的分辨率 */
  resolution = 1;

  /** 所属渲染器 */
  renderer: EventSystemRenderer;

  /** 当前启用的事件功能;改 `globalMove` 会同步到 rootBoundary */
  readonly features: EventSystemFeatures;

  private _currentCursor: string | null | undefined;
  private readonly _rootPointerEvent: FederatedPointerEvent;
  private readonly _rootWheelEvent: FederatedWheelEvent;
  private _eventsAdded: boolean;

  /**
   * @param renderer - 所属渲染器
   */
  constructor(renderer: EventSystemRenderer) {
    this.renderer = renderer;
    this.rootBoundary = new EventBoundary(null);
    EventsTicker.init(this);

    this.autoPreventDefault = true;
    this._eventsAdded = false;

    this._rootPointerEvent = new FederatedPointerEvent(null!);
    this._rootWheelEvent = new FederatedWheelEvent(null!);

    this.cursorStyles = {
      default: 'inherit',
      pointer: 'pointer',
    };

    this.features = new Proxy(
      { ...EventSystem.defaultEventFeatures },
      {
        set: (target, key, value) => {
          if (key === 'globalMove') {
            this.rootBoundary.enableGlobalMoveEvents = value;
          }
          target[key as keyof EventSystemFeatures] = value;

          return true;
        },
      },
    );

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerOverOut = this._onPointerOverOut.bind(this);
    this.onWheel = this.onWheel.bind(this);
  }

  /**
   * 渲染器就绪后调用:绑定画布、取分辨率、应用选项(Pixi 里由渲染器的 init runner 调)。
   * @param options - 事件系统选项
   */
  init(options: EventSystemOptions = {}): void {
    const { canvas, resolution } = this.renderer;

    this.setTargetElement(canvas as HTMLCanvasElement);
    this.resolution = resolution;
    EventSystem._defaultEventMode = options.eventMode ?? 'passive';
    Object.assign(this.features, options.eventFeatures ?? {});
    this.rootBoundary.enableGlobalMoveEvents = this.features.globalMove;
  }

  /**
   * 渲染器分辨率变了。
   * @param resolution - 新分辨率
   */
  resolutionChange(resolution: number): void {
    this.resolution = resolution;
  }

  /** 摘掉所有监听并脱离渲染器 */
  destroy(): void {
    EventsTicker.destroy();
    this.setTargetElement(null);
    this.renderer = null!;
    this._currentCursor = null;
  }

  /**
   * 设置当前光标:可以是 CSS cursor 字符串、cursorStyles 里的键,空值回到 'default'。
   * 与当前相同则什么都不做。
   * @param mode - 光标模式
   */
  setCursor(mode: string | null | undefined): void {
    mode ||= 'default';
    let applyStyles = true;

    // OffscreenCanvas 设不了样式;但光标模式可以是函数,不能直接退出
    if (globalThis.OffscreenCanvas && (this.domElement as unknown) instanceof OffscreenCanvas) {
      applyStyles = false;
    }
    // 模式没变,直接返回
    if (this._currentCursor === mode) {
      return;
    }
    this._currentCursor = mode;
    const style = this.cursorStyles[mode];

    // 只在样式表里有这一项时处理
    if (style) {
      switch (typeof style) {
        case 'string':
          // 字符串当 CSS cursor
          if (applyStyles) {
            this.domElement.style.cursor = style;
          }
          break;
        case 'function':
          // 函数直接以模式名调用
          style(mode);
          break;
        case 'object':
          // 对象当 CSS 样式字典整体赋给 DOM 元素
          if (applyStyles) {
            Object.assign(this.domElement.style, style);
          }
          break;
      }
    } else if (applyStyles && typeof mode === 'string' && !Object.prototype.hasOwnProperty.call(this.cursorStyles, mode)) {
      // 样式表里没有这一项的字符串模式,当作 CSS cursor
      this.domElement.style.cursor = mode;
    }
  }

  /** 最近一次指针状态的全局事件实例(不监听也能读指针位置) */
  get pointer(): Readonly<FederatedPointerEvent> {
    return this._rootPointerEvent;
  }

  /**
   * domElement 上的 pointerdown。
   * @param nativeEvent - 原生 mouse / pointer / touch 事件
   */
  private _onPointerDown(nativeEvent: MouseEvent | PointerEvent | TouchEvent): void {
    if (!this.features.click) return;
    this.rootBoundary.rootTarget = this.renderer.lastObjectRendered as Container;

    const events = this._normalizeToPointerData(nativeEvent);

    // 原生指针事件不必 preventDefault;规范化出来的事件在安卓原生浏览器上可能有 mousedown/touchstart
    // 双发的问题,仍要阻止。events 至少有一个,且指针类型相同。
    if (this.autoPreventDefault && (events[0] as unknown as PixiPointerEvent).isNormalized) {
      const cancelable = nativeEvent.cancelable || !('cancelable' in nativeEvent);

      if (cancelable) {
        nativeEvent.preventDefault();
      }
    }

    for (let i = 0, j = events.length; i < j; i++) {
      const nativeEvent = events[i];
      const federatedEvent = this._bootstrapEvent(this._rootPointerEvent, nativeEvent);

      this.rootBoundary.mapEvent(federatedEvent);
    }

    this.setCursor(this.rootBoundary.cursor);
  }

  /**
   * domElement(实际挂在 document)上的 pointermove。
   * @param nativeEvent - 原生 mouse / pointer / touch 事件
   */
  private _onPointerMove(nativeEvent: MouseEvent | PointerEvent | TouchEvent): void {
    if (!this.features.move) return;
    this.rootBoundary.rootTarget = this.renderer.lastObjectRendered as Container;

    EventsTicker.pointerMoved();

    const normalizedEvents = this._normalizeToPointerData(nativeEvent);

    for (let i = 0, j = normalizedEvents.length; i < j; i++) {
      const event = this._bootstrapEvent(this._rootPointerEvent, normalizedEvents[i]);

      this.rootBoundary.mapEvent(event);
    }

    this.setCursor(this.rootBoundary.cursor);
  }

  /**
   * pointerup(挂在 window 上;目标不是 domElement 时映射成 pointerupoutside)。
   * @param nativeEvent - 原生 mouse / pointer / touch 事件
   */
  private _onPointerUp(nativeEvent: MouseEvent | PointerEvent | TouchEvent): void {
    if (!this.features.click) return;
    this.rootBoundary.rootTarget = this.renderer.lastObjectRendered as Container;

    let target = nativeEvent.target;

    // 在 shadow DOM 里时用 composedPath 取真正的目标
    if (nativeEvent.composedPath && nativeEvent.composedPath().length > 0) {
      target = nativeEvent.composedPath()[0];
    }

    const outside = target !== this.domElement ? 'outside' : '';
    const normalizedEvents = this._normalizeToPointerData(nativeEvent);

    for (let i = 0, j = normalizedEvents.length; i < j; i++) {
      const event = this._bootstrapEvent(this._rootPointerEvent, normalizedEvents[i]);

      event.type += outside;

      this.rootBoundary.mapEvent(event);
    }

    this.setCursor(this.rootBoundary.cursor);
  }

  /**
   * domElement 上的 pointerover / pointerleave(或 mouseover / mouseout)。
   * @param nativeEvent - 原生 mouse / pointer / touch 事件
   */
  private _onPointerOverOut(nativeEvent: MouseEvent | PointerEvent | TouchEvent): void {
    if (!this.features.click) return;
    this.rootBoundary.rootTarget = this.renderer.lastObjectRendered as Container;

    const normalizedEvents = this._normalizeToPointerData(nativeEvent);

    for (let i = 0, j = normalizedEvents.length; i < j; i++) {
      const event = this._bootstrapEvent(this._rootPointerEvent, normalizedEvents[i]);

      this.rootBoundary.mapEvent(event);
    }

    this.setCursor(this.rootBoundary.cursor);
  }

  /**
   * domElement 上的 wheel(passive)。
   * @param nativeEvent - 原生滚轮事件
   */
  protected onWheel(nativeEvent: WheelEvent): void {
    if (!this.features.wheel) return;
    const wheelEvent = this.normalizeWheelEvent(nativeEvent);

    this.rootBoundary.rootTarget = this.renderer.lastObjectRendered as Container;
    this.rootBoundary.mapEvent(wheelEvent);
  }

  /**
   * 设置 domElement 并绑定监听;传 null 解绑全部。缺省就是渲染器的画布,一般不必调。
   * @param element - 新的 DOM 元素,或 null
   */
  setTargetElement(element: HTMLElement | null): void {
    this._removeEvents();
    this.domElement = element!;
    EventsTicker.domElement = element!;
    this._addEvents();
  }

  /** 在 domElement 上注册监听 */
  private _addEvents(): void {
    if (this._eventsAdded || !this.domElement) {
      return;
    }

    EventsTicker.addTickerListener();

    const style = this.domElement.style as CrossCSSStyleDeclaration;

    if (style) {
      if ((globalThis.navigator as unknown as { msPointerEnabled?: boolean }).msPointerEnabled) {
        style.msContentZooming = 'none';
        style.msTouchAction = 'none';
      } else if (this.supportsPointerEvents) {
        style.touchAction = 'none';
      }
    }

    // 这些先加:指针事件被规范化时,触发顺序与未规范化的一致(先指针事件,再 mouse / touch)
    if (this.supportsPointerEvents) {
      globalThis.document.addEventListener('pointermove', this._onPointerMove, true);
      this.domElement.addEventListener('pointerdown', this._onPointerDown, true);
      // pointerout 在 pointerup(触摸)与 pointercancel 时也会触发,那两个已另外处理;
      // 这里只关心 pointerleave
      this.domElement.addEventListener('pointerleave', this._onPointerOverOut, true);
      this.domElement.addEventListener('pointerover', this._onPointerOverOut, true);
      globalThis.addEventListener('pointerup', this._onPointerUp, true);
    } else {
      globalThis.document.addEventListener('mousemove', this._onPointerMove, true);
      this.domElement.addEventListener('mousedown', this._onPointerDown, true);
      this.domElement.addEventListener('mouseout', this._onPointerOverOut, true);
      this.domElement.addEventListener('mouseover', this._onPointerOverOut, true);
      globalThis.addEventListener('mouseup', this._onPointerUp, true);

      if (this.supportsTouchEvents) {
        this.domElement.addEventListener('touchstart', this._onPointerDown, true);
        this.domElement.addEventListener('touchend', this._onPointerUp, true);
        this.domElement.addEventListener('touchmove', this._onPointerMove, true);
      }
    }

    this.domElement.addEventListener('wheel', this.onWheel, {
      passive: true,
      capture: true,
    });

    this._eventsAdded = true;
  }

  /** 从 domElement 上注销监听 */
  private _removeEvents(): void {
    if (!this._eventsAdded || !this.domElement) {
      return;
    }

    EventsTicker.removeTickerListener();

    const style = this.domElement.style as CrossCSSStyleDeclaration;

    // OffscreenCanvas 没有 style,先判断
    if (style) {
      if ((globalThis.navigator as unknown as { msPointerEnabled?: boolean }).msPointerEnabled) {
        style.msContentZooming = '';
        style.msTouchAction = '';
      } else if (this.supportsPointerEvents) {
        style.touchAction = '';
      }
    }

    if (this.supportsPointerEvents) {
      globalThis.document.removeEventListener('pointermove', this._onPointerMove, true);
      this.domElement.removeEventListener('pointerdown', this._onPointerDown, true);
      this.domElement.removeEventListener('pointerleave', this._onPointerOverOut, true);
      this.domElement.removeEventListener('pointerover', this._onPointerOverOut, true);
      globalThis.removeEventListener('pointerup', this._onPointerUp, true);
    } else {
      globalThis.document.removeEventListener('mousemove', this._onPointerMove, true);
      this.domElement.removeEventListener('mousedown', this._onPointerDown, true);
      this.domElement.removeEventListener('mouseout', this._onPointerOverOut, true);
      this.domElement.removeEventListener('mouseover', this._onPointerOverOut, true);
      globalThis.removeEventListener('mouseup', this._onPointerUp, true);

      if (this.supportsTouchEvents) {
        this.domElement.removeEventListener('touchstart', this._onPointerDown, true);
        this.domElement.removeEventListener('touchend', this._onPointerUp, true);
        this.domElement.removeEventListener('touchmove', this._onPointerMove, true);
      }
    }

    this.domElement.removeEventListener('wheel', this.onWheel, true);

    this.domElement = null!;
    this._eventsAdded = false;
  }

  /**
   * DOM 客户区坐标 → 引擎的全局坐标:按 domElement 的显示矩形(CSS 缩放、偏移)与分辨率换算。
   * @param point - 输出点
   * @param x - 客户区 x
   * @param y - 客户区 y
   */
  mapPositionToPoint(point: PointData, x: number, y: number): void {
    const rect = this.domElement.isConnected
      ? this.domElement.getBoundingClientRect()
      : {
        x: 0,
        y: 0,
        width: (this.domElement as unknown as { width: number }).width,
        height: (this.domElement as unknown as { height: number }).height,
        left: 0,
        top: 0,
      };

    const resolutionMultiplier = 1.0 / this.resolution;

    point.x = (x - rect.left) * ((this.domElement as unknown as { width: number }).width / rect.width) * resolutionMultiplier;
    point.y = (y - rect.top) * ((this.domElement as unknown as { height: number }).height / rect.height) * resolutionMultiplier;
  }

  /**
   * 把原生事件补齐成指针事件的数据。
   * @param event - 原生 touch / mouse / pointer 事件
   * @returns 指针或鼠标事件得到一个;触摸事件按 changedTouches 得到多个
   */
  private _normalizeToPointerData(event: TouchEvent | MouseEvent | PointerEvent): PointerEvent[] {
    const normalizedEvents: Array<PointerEvent | PixiTouch> = [];

    if (this.supportsTouchEvents && event instanceof TouchEvent) {
      for (let i = 0, li = event.changedTouches.length; i < li; i++) {
        const touch = event.changedTouches[i] as PixiTouch;

        if (typeof touch.button === 'undefined') touch.button = 0;
        if (typeof touch.buttons === 'undefined') touch.buttons = 1;
        if (typeof touch.isPrimary === 'undefined') {
          touch.isPrimary = event.touches.length === 1 && event.type === 'touchstart';
        }
        if (typeof touch.width === 'undefined') touch.width = touch.radiusX || 1;
        if (typeof touch.height === 'undefined') touch.height = touch.radiusY || 1;
        if (typeof touch.tiltX === 'undefined') touch.tiltX = 0;
        if (typeof touch.tiltY === 'undefined') touch.tiltY = 0;
        if (typeof touch.pointerType === 'undefined') touch.pointerType = 'touch';
        if (typeof touch.pointerId === 'undefined') touch.pointerId = touch.identifier || 0;
        if (typeof touch.pressure === 'undefined') touch.pressure = touch.force || 0.5;
        if (typeof touch.twist === 'undefined') touch.twist = 0;
        if (typeof touch.tangentialPressure === 'undefined') touch.tangentialPressure = 0;
        // layerX/Y 不是标准,Pixi 仍按旧做法补上
        if (typeof touch.layerX === 'undefined') touch.layerX = touch.offsetX = touch.clientX;
        if (typeof touch.layerY === 'undefined') touch.layerY = touch.offsetY = touch.clientY;

        // 标记已规范化
        touch.isNormalized = true;
        touch.type = event.type;

        // 修饰键在 TouchEvent 上,不在单个 Touch 上
        touch.altKey ??= event.altKey;
        touch.ctrlKey ??= event.ctrlKey;
        touch.metaKey ??= event.metaKey;
        touch.shiftKey ??= event.shiftKey;

        normalizedEvents.push(touch);
      }
    } else if (
      // PointerEvent 是 MouseEvent 的子类
      !(globalThis as { MouseEvent?: unknown }).MouseEvent
      || (event instanceof MouseEvent && (!this.supportsPointerEvents || !(event instanceof globalThis.PointerEvent)))
    ) {
      const tempEvent = event as PixiPointerEvent;

      if (typeof tempEvent.isPrimary === 'undefined') tempEvent.isPrimary = true;
      if (typeof tempEvent.width === 'undefined') tempEvent.width = 1;
      if (typeof tempEvent.height === 'undefined') tempEvent.height = 1;
      if (typeof tempEvent.tiltX === 'undefined') tempEvent.tiltX = 0;
      if (typeof tempEvent.tiltY === 'undefined') tempEvent.tiltY = 0;
      if (typeof tempEvent.pointerType === 'undefined') tempEvent.pointerType = 'mouse';
      if (typeof tempEvent.pointerId === 'undefined') tempEvent.pointerId = MOUSE_POINTER_ID;
      if (typeof tempEvent.pressure === 'undefined') tempEvent.pressure = 0.5;
      if (typeof tempEvent.twist === 'undefined') tempEvent.twist = 0;
      if (typeof tempEvent.tangentialPressure === 'undefined') tempEvent.tangentialPressure = 0;

      // 标记已规范化
      tempEvent.isNormalized = true;

      normalizedEvents.push(tempEvent);
    } else {
      normalizedEvents.push(event as PointerEvent);
    }

    return normalizedEvents as PointerEvent[];
  }

  /**
   * 规范化原生滚轮事件。返回的是共享实例,不跨原生事件保留。
   * @param nativeEvent - 画布上的原生滚轮事件
   */
  protected normalizeWheelEvent(nativeEvent: WheelEvent): FederatedWheelEvent {
    const event = this._rootWheelEvent;

    this._transferMouseData(event, nativeEvent);

    // Firefox 上鼠标滚轮触发的 WheelEvent,先读 deltaMode 再读 delta 会得到 DOM_DELTA_LINE,
    // 后读(或其他浏览器任意顺序)得到 DOM_DELTA_PIXEL;所以 deltaMode 放在 delta 之后读。
    // 见 https://github.com/pixijs/pixijs/issues/8970
    event.deltaX = nativeEvent.deltaX;
    event.deltaY = nativeEvent.deltaY;
    event.deltaZ = nativeEvent.deltaZ;
    event.deltaMode = nativeEvent.deltaMode;

    this.mapPositionToPoint(event.screen, nativeEvent.clientX, nativeEvent.clientY);
    event.global.copyFrom(event.screen);
    event.offset.copyFrom(event.screen);

    event.nativeEvent = nativeEvent;
    event.type = nativeEvent.type;

    return event;
  }

  /**
   * 把原生事件写进根指针联邦事件。
   * @param event - 根联邦事件
   * @param nativeEvent - 规范化后的原生事件
   */
  private _bootstrapEvent(event: FederatedPointerEvent, nativeEvent: PointerEvent): FederatedPointerEvent {
    event.originalEvent = null!;
    event.nativeEvent = nativeEvent;

    event.pointerId = nativeEvent.pointerId;
    event.width = nativeEvent.width;
    event.height = nativeEvent.height;
    event.isPrimary = nativeEvent.isPrimary;
    event.pointerType = nativeEvent.pointerType;
    event.pressure = nativeEvent.pressure;
    event.tangentialPressure = nativeEvent.tangentialPressure;
    event.tiltX = nativeEvent.tiltX;
    event.tiltY = nativeEvent.tiltY;
    event.twist = nativeEvent.twist;
    this._transferMouseData(event, nativeEvent);

    this.mapPositionToPoint(event.screen, nativeEvent.clientX, nativeEvent.clientY);
    event.global.copyFrom(event.screen); // 顶层 global = screen
    event.offset.copyFrom(event.screen); // EventBoundary 会按自己的 rootTarget 重算

    event.isTrusted = nativeEvent.isTrusted;
    if (event.type === 'pointerleave') {
      event.type = 'pointerout';
    }
    if (event.type.startsWith('mouse')) {
      event.type = event.type.replace('mouse', 'pointer');
    }
    if (event.type.startsWith('touch')) {
      event.type = TOUCH_TO_POINTER[event.type] || event.type;
    }

    return event;
  }

  /**
   * 把基础与鼠标数据从原生事件搬到联邦事件。
   * @param event - 联邦事件
   * @param nativeEvent - 原生事件
   */
  private _transferMouseData(event: FederatedMouseEvent, nativeEvent: MouseEvent): void {
    event.isTrusted = nativeEvent.isTrusted;
    event.srcElement = nativeEvent.srcElement!;
    event.timeStamp = performance.now();
    event.type = nativeEvent.type;

    event.altKey = nativeEvent.altKey;
    event.button = nativeEvent.button;
    event.buttons = nativeEvent.buttons;
    event.client.x = nativeEvent.clientX;
    event.client.y = nativeEvent.clientY;
    event.ctrlKey = nativeEvent.ctrlKey;
    event.metaKey = nativeEvent.metaKey;
    event.movement.x = nativeEvent.movementX;
    event.movement.y = nativeEvent.movementY;
    event.page.x = nativeEvent.pageX;
    event.page.y = nativeEvent.pageY;
    event.relatedTarget = null!;
    event.shiftKey = nativeEvent.shiftKey;
  }
}

interface CrossCSSStyleDeclaration extends CSSStyleDeclaration {
  msContentZooming: string;
  msTouchAction: string;
}

interface PixiPointerEvent extends PointerEvent {
  isPrimary: boolean;
  width: number;
  height: number;
  tiltX: number;
  tiltY: number;
  pointerType: string;
  pointerId: number;
  pressure: number;
  twist: number;
  tangentialPressure: number;
  isNormalized: boolean;
  type: string;
}
