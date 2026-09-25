/**
 * 在 Worker 里 fetch + 解码图片(移植自 PixiJS v8.17(MIT):`assets/loader/workers/WorkerManager`
 * 与两段内联 worker 源码 `checkImageBitmap.worker` / `loadImageBitmap.worker`,逐字对应)。
 *
 * ⚠ worker 里的解码参数必须与主线程路径(`loadTextures.ts` 的 `loadImageBitmap`)完全相同:
 * 只有 `alphaMode === 'premultiplied-alpha'` 时用 `{ premultiplyAlpha: 'none' }`,其余一律不带选项
 * (浏览器缺省 = 解码期预乘)。
 */

const CHECK_WORKER_CODE = `(function () {
    'use strict';

    const WHITE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    async function checkImageBitmap() {
      try {
        if (typeof createImageBitmap !== "function") return false;
        const response = await fetch(WHITE_PNG);
        const imageBlob = await response.blob();
        const imageBitmap = await createImageBitmap(imageBlob);
        return imageBitmap.width === 1 && imageBitmap.height === 1;
      } catch (_e) {
        return false;
      }
    }
    void checkImageBitmap().then((result) => {
      self.postMessage(result);
    });

})();
`;

const LOAD_WORKER_CODE = `(function () {
    'use strict';

    async function loadImageBitmap(url, alphaMode) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(\`[WorkerManager.loadImageBitmap] Failed to fetch \${url}: \${response.status} \${response.statusText}\`);
      }
      const imageBlob = await response.blob();
      return alphaMode === "premultiplied-alpha" ? createImageBitmap(imageBlob, { premultiplyAlpha: "none" }) : createImageBitmap(imageBlob);
    }
    self.onmessage = async (event) => {
      try {
        const imageBitmap = await loadImageBitmap(event.data.data[0], event.data.data[1]);
        self.postMessage({
          data: imageBitmap,
          uuid: event.data.uuid,
          id: event.data.id
        }, [imageBitmap]);
      } catch (e) {
        self.postMessage({
          error: e,
          uuid: event.data.uuid,
          id: event.data.id
        });
      }
    };

})();
`;

/** 一段内联 worker 源码的实例工厂(同 Pixi 的 `_virtual/*.worker`:源码转 blob URL,共用一个 URL) */
class InlineWorker {
  private _url: string | null = null;

  constructor(private readonly _code: string) {}

  create(): Worker {
    if (!this._url) {
      this._url = URL.createObjectURL(new Blob([this._code], { type: 'application/javascript' }));
    }
    return new Worker(this._url);
  }

  revokeObjectURL(): void {
    if (this._url) {
      URL.revokeObjectURL(this._url);
      this._url = null;
    }
  }
}

const checkWorker = new InlineWorker(CHECK_WORKER_CODE);
const loadWorker = new InlineWorker(LOAD_WORKER_CODE);

interface QueuedTask {
  id: string;
  arguments: unknown[];
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface WorkerResult {
  uuid: number;
  data?: unknown;
  error?: unknown;
}

let UUID = 0;
let MAX_WORKERS: number | undefined;

class WorkerManagerClass {
  private _initialized = false;
  private _createdWorkers = 0;
  private _isImageBitmapSupported?: Promise<boolean>;
  private readonly _workerPool: Worker[] = [];
  private readonly _queue: QueuedTask[] = [];
  private _resolveHash: Record<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }> = {};

  /** 当前环境的 worker 里能不能用 createImageBitmap(起一个 worker 试一次,结果缓存) */
  isImageBitmapSupported(): Promise<boolean> {
    if (this._isImageBitmapSupported !== undefined) return this._isImageBitmapSupported;
    this._isImageBitmapSupported = new Promise((resolve) => {
      const worker = checkWorker.create();
      worker.addEventListener('message', (event: MessageEvent<boolean>) => {
        worker.terminate();
        checkWorker.revokeObjectURL();
        resolve(event.data);
      });
    });
    return this._isImageBitmapSupported;
  }

  /** 在 worker 里载一张图为 ImageBitmap(只把 alphaMode 传过去,决定解码期是否预乘) */
  loadImageBitmap(src: string, asset?: { data?: { alphaMode?: string } }): Promise<ImageBitmap> {
    return this._run('loadImageBitmap', [src, asset?.data?.alphaMode]) as Promise<ImageBitmap>;
  }

  private async _initWorkers(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
  }

  private _getWorker(): Worker | undefined {
    if (MAX_WORKERS === undefined) {
      MAX_WORKERS = navigator.hardwareConcurrency || 4;
    }
    let worker = this._workerPool.pop();
    if (!worker && this._createdWorkers < MAX_WORKERS) {
      this._createdWorkers++;
      worker = loadWorker.create();
      worker.addEventListener('message', (event: MessageEvent<WorkerResult>) => {
        this._complete(event.data);
        this._returnWorker(event.target as Worker);
        this._next();
      });
    }
    return worker;
  }

  private _returnWorker(worker: Worker): void {
    this._workerPool.push(worker);
  }

  private _complete(data: WorkerResult): void {
    if (!this._resolveHash[data.uuid]) return;
    if (data.error !== undefined) {
      this._resolveHash[data.uuid].reject(data.error);
    } else {
      this._resolveHash[data.uuid].resolve(data.data);
    }
    delete this._resolveHash[data.uuid];
  }

  private async _run(id: string, args: unknown[]): Promise<unknown> {
    await this._initWorkers();
    const promise = new Promise((resolve, reject) => {
      this._queue.push({ id, arguments: args, resolve, reject });
    });
    this._next();
    return promise;
  }

  private _next(): void {
    if (!this._queue.length) return;
    const worker = this._getWorker();
    if (!worker) return;
    const toDo = this._queue.pop()!;
    const id = toDo.id;
    this._resolveHash[UUID] = { resolve: toDo.resolve, reject: toDo.reject };
    worker.postMessage({
      data: toDo.arguments,
      uuid: UUID++,
      id,
    });
  }

  /** 终止全部 worker,拒绝全部在途请求,清空队列 */
  reset(): void {
    this._workerPool.forEach((worker) => worker.terminate());
    this._workerPool.length = 0;
    Object.values(this._resolveHash).forEach(({ reject }) => {
      reject?.(new Error('WorkerManager has been reset before completion'));
    });
    this._resolveHash = {};
    this._queue.length = 0;
    this._initialized = false;
    this._createdWorkers = 0;
  }
}

/** 全局 worker 池(同 Pixi `WorkerManager`) */
export const WorkerManager = new WorkerManagerClass();
