/// <reference types="vite/client" />

/** 编辑器内嵌 WebEngine 关闭窗口时不会触发 pagehide，由 Qt 侧主动调用 */
interface Window {
  __gameDestroy?: () => void;
}

/** 以 ?raw 后缀读 .ts 源码（几何 parity 测试用：把两份手工镜像的常量拿出来逐项比对）。 */
declare module '*.ts?raw' {
  const src: string;
  export default src;
}
