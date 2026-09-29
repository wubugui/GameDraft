# Electron RHI probe

This is the historical isolated GPU/Steam experiment. It opens the real Vite game in Electron and writes GPU, game-start, process, and screenshot evidence to `%LOCALAPPDATA%/GameDraft/electron-probe/`. The production Electron shell now lives in `src-electron/` and is built through `scripts/release.mjs`.

The checked-in dependency is Electron 38.8.6, the version used for the initial real-game run on this machine. The version actually used is recorded in each JSON report.

From the worktree root, start the game server in one terminal:

```powershell
node .\node_modules\vite\bin\vite.js --host=127.0.0.1 --port=5235 --strictPort
```

In another terminal:

```powershell
cd tools/electron_probe
npm install --no-package-lock --no-audit --no-fund
node .\run.cjs --url=http://127.0.0.1:5235/?mode=dev --auto-exit-ms=20000
```

If the Electron binary download is blocked but a compatible binary is already present, set `ELECTRON_PROBE_EXE` to its full `electron.exe` path before running `run.cjs`. The runner also recognizes this machine's cached 38.8.6 binary under `%LOCALAPPDATA%/GameDraft/electron-probe/`.

Use `--gpu-in-process` to compare the GPU architecture needed by some overlay and capture approaches. Use `--steam-app-id=<your app ID>` only with a running Steam client and a valid game entitlement; this calls `steamworks.js` initialization and its Electron overlay helper. Add `--steam-show-overlay` to ask the SDK to open the Friends dialog after the game loads; `--steam-overlay-delay-ms=15000` can defer that call for a manual setup step. The dialog call returns no success value, and steamworks.js 0.4.0 exposes no overlay-enabled query. Steam Overlay acceptance requires an OS-level screenshot showing it over the rendered game; `BrowserWindow.capturePage()` may omit it.

When `--steam-show-overlay` is used on Windows, the probe captures the whole virtual desktop 2.5 seconds after the SDK call as `*-desktop.png` in the report folder. This is a real screen capture, so it may also contain other visible windows.

For RenderDoc, launch the Electron process through RenderDoc with the same URL and compare a bounded `.rdc` replay containing this game's draw calls. A visible game or screenshot alone is not `.rdc` proof. The existing `tools/renderdoc_capture` backend remains a placeholder until a bounded frame capture path is implemented and verified.

An optional native API experiment is available: `--renderdoc-capture-ms=100` starts a 100 ms `StartFrameCapture(NULL,NULL)` / `EndFrameCapture(NULL,NULL)` span after the game loads. `--renderdoc-delay-ms=12000` controls when it starts. This uses `koffi` only when requested, requires `renderdoc.dll` already injected into the Electron **main** process, and never loads RenderDoc by itself. It writes `.rdc` files under `%LOCALAPPDATA%/GameDraft/renderdoc-captures/electron-probe/<run>/`. The report records API version, struct offsets, begin/end results, and produced files. A `.rdc` is still unverified until RenderDoc replay shows this game's GPU passes and draws rather than only Chromium D3D11 composition.

For the injected experiment, set RenderDoc's executable to the Electron binary, working directory to this probe directory, and command line to:

```text
"<absolute path to tools/electron_probe>" --url=http://127.0.0.1:5235/?mode=dev --renderdoc-capture-ms=100 --renderdoc-delay-ms=12000 --auto-exit-ms=30000 --gpu-in-process
```

The `NULL,NULL` capture pair is a wildcard. RenderDoc's header says its choice is undefined when multiple graphics APIs or windows match. A produced `.rdc` therefore does not prove it captured the WebGPU game.

### Local results, 2026-09-29

- Electron 44.4.5 opened the real game scene through this worktree's Vite server. WebGPU adapter and device creation succeeded on the NVIDIA GTX 970; the page had one game canvas and no fatal error.
- RenderDoc 1.46 injected into the Electron main process returned API 1.7.0. The optional native probe observed `IsFrameCapturing` transition from 0 to 1, `EndFrameCapture` returned 1, and it wrote a 59,095,251-byte `.rdc` outside the repository. The report is `%LOCALAPPDATA%/GameDraft/electron-probe/2026-09-29T04-08-30-646Z-28200.json`.
- Replay inspection found D3D11 Chromium composition (83 Draw calls, WebGPU shown as a shared image), with no game WebGPU/D3D12 passes. This experiment proves the native API wiring and bounded file creation, **not** usable game-frame capture.
- A final Electron 44.4.5 run with `--disable-gpu-compositing` retained WebGPU adapter/device creation but showed a black game image with only the F2 UI and FPS visible; 577 frames were dropped. Electron reported `gpu_compositing=disabled_software` and `webgpu=enabled_readback`. An independent desktop screenshot confirmed the actual window was black, not only `capturePage()` output: `%LOCALAPPDATA%/GameDraft/electron-probe/disable-gpu-compositing-desktop.png`. This configuration did not preserve a usable game display, so no RenderDoc capture was attempted for it. Report and page screenshot: `%LOCALAPPDATA%/GameDraft/electron-probe/2026-09-29T04-11-29-604Z-17240.json` and `.png`.
- Electron 44.4.5 also initialized Steamworks with test AppID 480 while the real WebGPU scene remained visible and the WebGPU device was created. Report and screenshot: `%LOCALAPPDATA%/GameDraft/electron-probe/2026-09-29T04-15-30-151Z-15920.json` and `.png`. A separate overlay attempt opened the Friends dialog as a Steam desktop window; an in-game Steam Overlay was not verified.

The probe uses a separate, cache-disabled Electron session, disables Chromium disk HTTP, V8, and GPU shader cache switches, and keeps background rendering active. Its persistent report folder is outside the worktree.
