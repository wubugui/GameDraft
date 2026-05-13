/// <reference types="vite/client" />

/** 编辑器内嵌 WebEngine 关闭窗口时不会触发 pagehide，由 Qt 侧主动调用 */
interface Window {
  __gameDestroy?: () => void;
}
