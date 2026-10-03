import {
  encodeCapturePng,
  type WebGpuCapturePngWorkerRequest,
  type WebGpuCapturePngWorkerResponse,
} from './webgpuCapturePngCodec';

// Keep DOM and WebWorker lib declarations separate: the application's tsconfig
// includes DOM, while this module runs only as a module Worker.
const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WebGpuCapturePngWorkerRequest>) => void) | null;
  postMessage(message: WebGpuCapturePngWorkerResponse): void;
};

let supported = false;
try {
  const probe = new OffscreenCanvas(1, 1);
  supported = typeof probe.convertToBlob === 'function' && !!probe.getContext('2d');
} catch { /* Report unsupported capability to the owning pool. */ }

workerScope.onmessage = (event): void => {
  const { id, task } = event.data;
  void encodeCapturePng(task, { offscreen: true, ownsPixels: true }).then(
    (blob) => workerScope.postMessage({ type: 'result', id, blob }),
    (error: unknown) => workerScope.postMessage({
      type: 'error', id, message: error instanceof Error ? error.message : String(error),
    }),
  );
};

workerScope.postMessage({
  type: 'ready', supported,
  ...(!supported ? { reason: 'Worker 不支持 OffscreenCanvas 2D PNG 编码' } : {}),
});
