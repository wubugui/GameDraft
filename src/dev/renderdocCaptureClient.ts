/** Browser side of the dev-only RenderDoc capture service. No file IO happens in the game. */
const CAPTURE_API = '/__gamedraft-api/renderdoc-capture';
const REQUEST_TIMEOUT_MS = 8_000;

export type CaptureMode = 'single' | 'burst';

export interface CaptureStatus {
  captureReady: boolean;
  state: 'idle' | 'preparing' | 'ready' | 'capturing' | 'completed' | 'failed' | 'stopped';
  completedFrames: number;
  requestedFrames: number;
  outputDir?: string;
  error?: string;
  reason?: string;
  captureSessionId?: string;
}

export interface CaptureRequest {
  mode: CaptureMode;
  frames: number;
  targetBootId: string;
  captureSessionId: string;
}

export function currentCaptureSessionId(): string | null {
  return new URLSearchParams(location.search).get('renderdocSession');
}

async function captureApi<T>(method: 'GET' | 'POST', params: Record<string, string> | object): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const query = method === 'GET' ? `?${new URLSearchParams(params as Record<string, string>)}` : '';
    const response = await fetch(`${CAPTURE_API}${query}`, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(params) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: raw || `HTTP ${response.status}` };
    }
    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? (data as { error?: unknown; reason?: unknown }).error ?? (data as { reason?: unknown }).reason
        : undefined;
      throw new Error(message ? String(message) : `HTTP ${response.status}`);
    }
    return data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('抓帧服务响应超时');
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function getCaptureStatus(targetBootId: string, captureSessionId = currentCaptureSessionId()): Promise<CaptureStatus> {
  return captureApi<CaptureStatus>('GET', {
    targetBootId,
    ...(captureSessionId ? { captureSessionId } : {}),
  });
}

export function prepareCapture(targetBootId: string): Promise<CaptureStatus & { url: string; captureSessionId: string }> {
  return captureApi('POST', { action: 'prepare', url: location.href, targetBootId });
}

export function startCapture(request: CaptureRequest): Promise<CaptureStatus> {
  return captureApi('POST', request);
}

export function stopCapture(targetBootId: string, captureSessionId: string): Promise<CaptureStatus> {
  return captureApi('POST', { action: 'stop', targetBootId, captureSessionId });
}
