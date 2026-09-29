// Native RenderDoc API 1.7.0 experiment, called ONLY by --renderdoc-capture-ms.
// Layout follows RenderDoc v1.46 portable renderdoc_app.h (RENDERDOC_API_1_7_0).
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative, resolve, isAbsolute } = require('node:path');

const API_VERSION = 10700;
const API_FIELDS = [
  'GetAPIVersion', 'SetCaptureOptionU32', 'SetCaptureOptionF32',
  'GetCaptureOptionU32', 'GetCaptureOptionF32', 'SetFocusToggleKeys',
  'SetCaptureKeys', 'GetOverlayBits', 'MaskOverlayBits', 'RemoveHooks',
  'UnloadCrashHandler', 'SetCaptureFilePathTemplate', 'GetCaptureFilePathTemplate',
  'GetNumCaptures', 'GetCapture', 'TriggerCapture', 'IsTargetControlConnected',
  'LaunchReplayUI', 'SetActiveWindow', 'StartFrameCapture', 'IsFrameCapturing',
  'EndFrameCapture', 'TriggerMultiFrameCapture', 'SetCaptureFileComments',
  'DiscardFrameCapture', 'ShowReplayUI', 'SetCaptureTitle',
  'SetObjectAnnotation', 'SetCommandAnnotation',
];

function captureFiles(dir) {
  return readdirSync(dir).filter(name => name.toLowerCase().endsWith('.rdc')).map(name => {
    const path = join(dir, name);
    return { path, bytes: statSync(path).size };
  });
}

function outsideProject(path) {
  const project = resolve(__dirname, '..', '..');
  const rel = relative(project, resolve(path));
  return rel.startsWith('..') || isAbsolute(rel);
}

async function capture({ durationMs, outputDir, onProgress = () => {} }) {
  const result = {
    requested: true, durationMs, apiRequested: '1.7.0',
    injected: false, captureStarted: false, captureEnded: false,
    rdcProduced: false, gameDrawsVerified: false,
    outputDir: resolve(outputDir),
  };
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return { ...result, status: 'unsupported', reason: 'This FFI probe is Windows x64 only' };
  }
  if (!outsideProject(outputDir)) {
    return { ...result, status: 'error', reason: 'RenderDoc output must be outside the worktree' };
  }
  let koffi;
  try { koffi = require('koffi'); }
  catch (error) { return { ...result, status: 'unavailable', reason: `koffi unavailable: ${error}` }; }

  try {
    const kernel = koffi.load('kernel32.dll');
    const GetModuleHandleA = kernel.func('void * __stdcall GetModuleHandleA(const char *moduleName)');
    const GetModuleFileNameA = kernel.func('uint32_t __stdcall GetModuleFileNameA(void *module, _Out_ char *filename, uint32_t size)');
    const handle = GetModuleHandleA('renderdoc.dll');
    if (!handle) return { ...result, status: 'not_injected', reason: 'renderdoc.dll is not loaded in the Electron main process' };
    result.injected = true;
    const moduleName = Buffer.alloc(4096);
    const moduleNameLen = GetModuleFileNameA(handle, moduleName, moduleName.length);
    if (!moduleNameLen || moduleNameLen >= moduleName.length) throw new Error('GetModuleFileNameA failed for injected renderdoc.dll');
    result.injectedModulePath = moduleName.toString('utf8', 0, moduleNameLen);
    const headerPath = join(resolve(result.injectedModulePath, '..'), 'renderdoc_app.h');
    if (existsSync(headerPath)) {
      const header = readFileSync(headerPath);
      result.headerSha256 = createHash('sha256').update(header).digest('hex');
      if (!header.toString('utf8').includes('eRENDERDOC_API_Version_1_7_0 = 10700')) {
        throw new Error('Injected RenderDoc header does not declare API 1.7.0');
      }
    }
    onProgress('renderdoc-injected', { module: result.injectedModulePath, headerSha256: result.headerSha256 || null });

    // GetModuleHandle above ensures this DLL was already injected. Loading the
    // same absolute path here only obtains Koffi's function handle.
    const renderdoc = koffi.load(result.injectedModulePath);
    const GetAPI = renderdoc.func('int __cdecl RENDERDOC_GetAPI(int version, _Out_ void **api)');
    const apiOut = [null];
    result.getApiReturn = GetAPI(API_VERSION, apiOut);
    if (result.getApiReturn !== 1 || !apiOut[0]) {
      return { ...result, status: 'unsupported', reason: 'Injected RenderDoc does not expose API 1.7.0' };
    }
    const ApiStruct = koffi.struct('RENDERDOC_API_1_7_0_Probe', Object.fromEntries(API_FIELDS.map(name => [name, 'void *'])));
    if (koffi.sizeof(ApiStruct) !== API_FIELDS.length * 8) throw new Error('Unexpected RenderDoc API struct size');
    // v1.46 renderdoc_app.h, zero-based pointer indices 19/20/21.
    const offsets = {
      StartFrameCapture: koffi.offsetof(ApiStruct, 'StartFrameCapture'),
      IsFrameCapturing: koffi.offsetof(ApiStruct, 'IsFrameCapturing'),
      EndFrameCapture: koffi.offsetof(ApiStruct, 'EndFrameCapture'),
    };
    if (offsets.StartFrameCapture !== 19 * 8 || offsets.IsFrameCapturing !== 20 * 8 || offsets.EndFrameCapture !== 21 * 8) {
      throw new Error(`RenderDoc API struct offset mismatch: ${JSON.stringify(offsets)}`);
    }
    result.apiOffsets = offsets;
    const api = koffi.decode(apiOut[0], ApiStruct);
    for (const name of ['GetAPIVersion', 'SetCaptureFilePathTemplate', 'GetNumCaptures', 'StartFrameCapture', 'IsFrameCapturing', 'EndFrameCapture']) {
      if (!api[name]) throw new Error(`RenderDoc API pointer ${name} is null`);
    }
    const GetVersion = koffi.proto('void __cdecl ProbeGetAPIVersion(_Out_ int *major, _Out_ int *minor, _Out_ int *patch)');
    const SetTemplate = koffi.proto('void __cdecl ProbeSetCaptureFilePathTemplate(const char *pathTemplate)');
    const GetNum = koffi.proto('uint32_t __cdecl ProbeGetNumCaptures(void)');
    const Start = koffi.proto('void __cdecl ProbeStartFrameCapture(void *device, void *window)');
    const IsCapturing = koffi.proto('uint32_t __cdecl ProbeIsFrameCapturing(void)');
    const End = koffi.proto('uint32_t __cdecl ProbeEndFrameCapture(void *device, void *window)');
    const major = [0], minor = [0], patch = [0];
    koffi.call(api.GetAPIVersion, GetVersion, major, minor, patch);
    result.apiVersion = `${major[0]}.${minor[0]}.${patch[0]}`;
    if (major[0] !== 1 || minor[0] !== 7) throw new Error(`Unexpected RenderDoc API version ${result.apiVersion}`);
    mkdirSync(outputDir, { recursive: true });
    const pathTemplate = join(outputDir, 'frame');
    koffi.call(api.SetCaptureFilePathTemplate, SetTemplate, pathTemplate);
    result.pathTemplate = pathTemplate;
    result.capturesBefore = koffi.call(api.GetNumCaptures, GetNum);
    result.isFrameCapturingBeforeStart = koffi.call(api.IsFrameCapturing, IsCapturing);
    if (result.isFrameCapturingBeforeStart !== 0) {
      return { ...result, status: 'busy', reason: 'RenderDoc was already capturing; overlapping Start is unsafe' };
    }
    onProgress('renderdoc-start-frame-capture', { durationMs, capturesBefore: result.capturesBefore });
    koffi.call(api.StartFrameCapture, Start, null, null);
    result.isFrameCapturingAfterStart = koffi.call(api.IsFrameCapturing, IsCapturing);
    result.captureStarted = result.isFrameCapturingAfterStart === 1;
    if (!result.captureStarted) {
      return { ...result, status: 'no_active_capture', reason: 'StartFrameCapture found no matching graphics API/window' };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, durationMs));
    result.isFrameCapturingBeforeEnd = koffi.call(api.IsFrameCapturing, IsCapturing);
    if (result.isFrameCapturingBeforeEnd !== 1) {
      return { ...result, status: 'capture_lost', reason: 'Capture ended externally before the probe could call EndFrameCapture' };
    }
    result.endFrameCaptureReturn = koffi.call(api.EndFrameCapture, End, null, null);
    result.captureEnded = result.endFrameCaptureReturn === 1;
    result.capturesAfter = koffi.call(api.GetNumCaptures, GetNum);
    onProgress('renderdoc-end-frame-capture', {
      started: result.captureStarted, endReturn: result.endFrameCaptureReturn, capturesAfter: result.capturesAfter,
    });
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    result.files = captureFiles(outputDir);
    result.rdcProduced = result.files.length > 0;
    result.status = result.rdcProduced ? 'rdc_created_unverified' : 'no_rdc';
    return result;
  } catch (error) {
    return { ...result, status: 'error', reason: String(error?.stack || error) };
  }
}

module.exports = { capture };
