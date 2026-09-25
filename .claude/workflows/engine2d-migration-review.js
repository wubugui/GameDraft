export const meta = {
  name: 'engine2d-migration-review',
  description: 'engine2d/RHI 迁移审查:分片审查员对照 master + Pixi 8.17 找偏差,对抗核实员复现或反驳每条发现',
  whenToUse: '审查 engine2d / RHI 迁移分支与 master 的行为偏差。args: { repo: 仓库绝对路径, master: master 只读检出绝对路径(可用 tools/ab_compare 建的 .tools/ab/A-<sha10>), slices?: 只跑这些分片 key, customSlices?: [{key, focus}] 自定分片(后续轮次), extraFocus?: 追加给每个审查员的说明 }',
  phases: [
    { title: 'Review', detail: '15 slice reviewers vs master + Pixi 8.17 reference' },
    { title: 'Verify', detail: 'adversarial verifier per finding (repro required); second vote for high/critical' },
    { title: 'Critic', detail: 'completeness critic: what was not covered' },
  ],
}

// 路径由调用方传入(本机 / 云端都能跑):Workflow({ name: 'engine2d-migration-review', args: { repo, master, slices } })
if (!args || !args.repo || !args.master) throw new Error('需要 args.repo(仓库绝对路径)与 args.master(master 只读检出绝对路径)')
const REPO = String(args.repo).replace(/\\/g, '/')
const MASTER = String(args.master).replace(/\\/g, '/')
const EXTRA = args.extraFocus ? `\n\nAdditional instructions from the caller:\n${args.extraFocus}` : ''

const PREAMBLE = `You are reviewing a core engine migration in ${REPO} (git branch claude/festive-cray-g72t2o). This is project-critical: the goal is ZERO behaviour divergence from master for everything the game uses.

Context:
- master (commit 5f5a639) renders with Pixi.js 8.17 on WebGL. A full READ-ONLY checkout of master is at ${MASTER} (use it to read master's src; never modify it; \`git show origin/master:<path>\` also works).
- This branch replaces Pixi with src/engine2d (a Pixi-8.17-API-compatible 2D layer written from scratch/ported) running on src/rendering/rhi (luma.gl, WebGPU only). Game code switched imports from 'pixi.js' to engine2d.
- Pixi reference implementation: ${REPO}/node_modules/pixi.js/lib/**/*.mjs and *.d.ts (compiled but readable). Pixi's event system is in node_modules/pixi.js/lib/events/.
- Design decisions that are NOT bugs (do not report): WebGPU only / no WebGL fallback; data formats (JSON under public/) unchanged; renderer.extract.* is async (returns Promise); filters with blendRequired throw (unused by game); Container.worldTransform reflects the current parent chain (not Pixi's last-render cache) and Culler uses current-frame transforms; horizontal edges landing exactly on y+0.5 differ by one row on the canvas (WebGL bottom-up vs WebGPU top-down rasterization); new Unity-style hierarchy API additions (setActive/components/PlayerLoop) are additive. NPC/hotspot presence was intentionally moved from container.visible to container.setActive(...) with readers switched to .present — but any semantic change that results IS in scope.
- Existing verification: tools/engine2d_parity (29 bit-exact cases, engine2d vs Pixi WebGL), tools/render_parity (176 shader-level cases; runs master's src inside THIS branch's harness, so it is only a unit-level aid, not a clean master A/B), tools/ab_compare (clean A/B: master and branch as separate checkouts with their own deps, driven identically from outside). Bugs are most likely in paths those cases do NOT exercise — look there.

Rules:
- Do NOT modify any tracked file in the repo. Scratch/repro files only under ${REPO}/tmp/review/<your-slice>/ (gitignored). Run node-side repros with: cd ${REPO} && npx vitest run tmp/review/<slice>/<file>.test.ts . In such tests you can import engine2d via relative paths (../../../src/engine2d) and Pixi via 'pixi.js' for side-by-side comparison; NullRhiDevice (src/rendering/rhi/backends/null/NullRhiDevice.ts) records GPU commands without a GPU (see src/engine2d/gpu/msaa.test.ts / prewarmPipelines.test.ts for setup). Do not launch browsers or the full test suite (other reviewers run concurrently); whole-game A/B runtime comparison is done separately by tools/ab_compare.
- Report only issues with concrete evidence: branch file:line, the corresponding Pixi or master code (path:line), a concrete failure scenario (inputs -> wrong output/behaviour), and game impact (cite game call sites under src/ that hit the path; if the game never hits it, say so and mark severity low).
- Severity: critical = crash, broken frame, or broken interaction in a common game path, or resource leak that grows per scene/frame; high = visibly wrong output / wrong behaviour in a game path; medium = edge case in a game path or small leak; low = API path the game does not use, cosmetic.
- Be precise and skeptical of your own findings: a false positive costs a fix cycle. Prefer fewer, solid findings. Also list what you checked and found equivalent (coverage), so gaps can be identified.${EXTRA}`

const SLICES = [
  { key: 'scene-transform', focus: `src/engine2d/scene/Container.ts (transform/math part), src/engine2d/math/**, src/engine2d/scene/Bounds*.ts and bounds helpers. Check against Pixi scene/container/*.mjs: local transform composition (position/scale/rotation/skew/pivot/origin), updateLocalTransform dirty tracking (does changing x/y/scale/rotation/skew/pivot via every setter path — including ObservablePoint.set/copyFrom, rotation vs angle, setFromMatrix — invalidate the world-matrix version cache?), worldTransform/getGlobalTransform, toGlobal/toLocal with skipUpdate, getBounds/getLocalBounds/getFastBounds (with masks, filters with padding, invisible/inactive children, boundsArea, empty containers), width/height setters (scale derived from local bounds), sortableChildren/zIndex (stable sort, sortDirty triggers), child ops (addChild of child from another parent, addChildAt, removeChildren ranges, swapChildren, setChildIndex, reparentChild), emitted events order (added/removed/childAdded/childRemoved/destroyed) and destroy options (children/texture/textureSource/context).` },
  { key: 'hierarchy-entities', focus: `Unity-style additions and their integration with rendering and the game: src/engine2d/scene/{Container.ts (setActive/activeInHierarchy/components/world cache),Component.ts,PlayerLoop.ts}, src/engine2d/gpu/collect.ts skipping inactive nodes, EventBoundary prune, Culler, bounds skipping inactive. Then the entity presence switch: src/entities/{Npc.ts,Hotspot.ts,Player.ts,entityComponents.ts}, src/systems/InteractionSystem.ts, src/core/Game.ts readers, EmoteBubbleManager, VfxRenderer, src/data/types.ts isEmoteAnchorShown. For EVERY place on master (${MASTER}/src) that read npc/hotspot/player container.visible (grep 'container.visible' and '.visible' on entities, isVisible callbacks, emote anchors, shadows, lighting, sorting, interaction, VFX anchors, debug), verify the branch reads the equivalent predicate. Check consequences of setActive(false) vs master's visible=false: onRender callbacks and animations skipped (does anything rely on hidden NPCs still updating — e.g. SpriteEntity animation timers, shadows, lights attached to NPCs, entity lighting filters, emote bubbles, positions read via toGlobal/getBounds of hidden NPCs, zIndex sorting)? Hotspot pick-up / condition toggles round-trip. Also PlayerLoop driven by Application ticker: any cost or ordering change for the game.` },
  { key: 'collect-batch', focus: `src/engine2d/gpu/{collect.ts,Batcher.ts,batchShader.ts,blendNpm.ts} and how Sprite/Mesh/Graphics/Text produce batch data. Compare to Pixi rendering/renderers/shared/{instructions,batcher}, scene/sprite/SpritePipe, scene/mesh/MeshPipe, scene/graphics/GraphicsPipe, RenderGroupSystem/updateRenderGroupTransforms, validateRenderables. Check: visible/renderable/alpha/tint/blendMode inheritance (worldColor/worldAlpha packing, tint of parent multiplied), blend mode change breaks batch, 'inherit' blend, non-premultiplied texture blend variants, texture slot overflow (>16 textures), roundPixels, onRender invocation order/when not visible, culling interaction, sprite uv/anchor/trim/rotated frames (groupD8), texture frame updates after creation, dynamic texture swap on sprite, mesh with custom shader vs batched mesh, instruction re-use across frames when only transforms change (stale data?), sortable children order in instructions.` },
  { key: 'framebuilder-filters-masks', focus: `src/engine2d/gpu/FrameBuilder.ts (and renderTargets.ts). Compare to Pixi FilterSystem.mjs, StencilMaskPipe, AlphaMaskPipe, ColorMaskPipe, ScissorMask, RenderTargetSystem, GlobalUniformSystem. Check: projection/viewport for canvas vs render texture (y orientation, resolution, frame offset), filter pipeline (bounds computation incl. filterArea, padding, resolution 'inherit', antialias, clipToViewport, legacy filters, multiple filters ping-pong, filter on container with zero bounds / offscreen, nested filters, filter + mask, filter uniforms uInputSize/uInputPixel/uInputClamp/uOutputFrame/uGlobalFrame/uOutputTexture values exactly as Pixi WebGPU computes them), stencil masks (nested, inverse, mask removed, mask inside filter, mask on RT), sprite (alpha) masks incl. channel and inverse, color mask, pass restarts (ensureDepthStencil), clear semantics per target, render to RT inside a frame then sample it in the same frame.` },
  { key: 'renderer-resources', focus: `src/engine2d/gpu/{WebGPURenderer.ts,Renderer.ts,GpuTextures.ts,GpuBuffers.ts,Arena.ts,Pipelines.ts,createRenderer.ts}. Check render(options) semantics vs Pixi (container/target/clear/clearColor/transform/frame), rendering while another render is in progress (nested render from onRender/filters), generateTexture (frame, resolution, antialias, clearColor, region), extract (pixels/canvas/base64/texture: orientation, premultiplication un-done like Pixi, resolution, frame), texture upload (image/canvas/video/buffer sources, premultiplyAlpha/alphaMode, flipY, mipmaps autoGenerate, updateId/resourceId changes, resize, texture.source.update()), GPU resource release on texture/geometry/buffer destroy and on 'unload' (would GPU memory grow across scene switches?), buffer updates (Buffer.update / data replaced / size grows), uniform arena overflow and per-frame reuse, pipeline cache key completeness (anything affecting pipeline state missing from key => wrong reuse), background clear, resize (DPR, autoDensity, zero), destroy (removeView, device), render crash guard and device lost handling.` },
  { key: 'shader-uniforms-textures', focus: `src/engine2d/shader/** (GpuProgram WGSL parsing of structs/bindings/attributes, UniformGroup, uboLayout packing for every WGSL type: f32/i32/u32/vec2/vec3/vec4/mat2x2/mat3x3/mat4x4/arrays of those — WGSL alignment rules, isStatic/dynamic updates, uniform arrays), Geometry/Buffer (attribute formats, instancing, index formats, dynamic updates), Shader resources binding by name (textures, samplers, uniform groups, buffers, missing resources), Mesh; src/engine2d/textures/** (Texture frame/orig/trim/rotate/defaultAnchor/updateUvs, TextureSource defaults: scaleMode/addressMode/mipmaps/autoGenerateMipmaps/alphaMode/format/antialias, TextureStyle -> sampler mapping, TexturePool reuse/keying, RenderTexture.create/resize). Compare to Pixi rendering/renderers/shared/{shader,texture,buffer,geometry} and gpu/shader. Game uses many custom shaders (src/rendering/**) — confirm the uniform/texture binding paths they rely on behave like Pixi WebGPU.` },
  { key: 'graphics', focus: `src/engine2d/graphics/** vs Pixi scene/graphics/**. Enumerate the Graphics/GraphicsContext API actually used by the game (grep src/ outside engine2d for Graphics usage: rect/roundRect/circle/ellipse/poly/moveTo/lineTo/bezierCurveTo/quadraticCurveTo/arc/arcTo/closePath/fill/stroke/beginPath/clear/cut/texture/FillGradient/setStrokeStyle/setFillStyle/lineStyle legacy, stroke alignment/width/cap/join/miter, alpha, pixelLine) and check each produces the same geometry and colours as Pixi (tessellation, holes/cut, stroke joins, gradients, texture fills with matrix), bounds (getLocalBounds with stroke), containsPoint/hitArea behaviour for events, clear + redraw each frame (dynamic graphics leak? context rebuild), shared GraphicsContext between Graphics, destroy.` },
  { key: 'text-sprite-mesh', focus: `src/engine2d/text/** (Text/CanvasTextGenerator/CanvasTextMetrics/TextStyle/HTMLText, BitmapText if any), src/engine2d/sprite/** (Sprite, NineSliceSprite), src/engine2d/mesh/** vs Pixi scene/text, scene/text-html, scene/sprite, scene/sprite-nine-slice, scene/mesh. Check: text metrics & word wrap for CJK and mixed text (breakWords, whiteSpace, wordWrapWidth, lineHeight, leading, letterSpacing, align), stroke/dropShadow/fill gradient, padding/trim, resolution (auto from renderer vs explicit), font loading (text measured before webfont loaded -> re-render?), dynamic text changes (texture reuse/leak of canvas textures), anchor handling for text, text on tint, HTMLText rendering path; Sprite texture change updates bounds/uvs, anchor, width/height setters with trimmed textures; NineSlice borders & scaling; Mesh uv/vertex updates.` },
  { key: 'events-app-assets', focus: `src/engine2d/events/** vs Pixi events (TS sources in the scratchpad pixi-src dir and node_modules/pixi.js/lib/events): hit testing order (topmost first, zIndex, masks, hitArea, interactiveChildren, eventMode none/passive/auto/static/dynamic), pointer/mouse/touch/wheel mapping (clientX -> global with resolution/autoDensity/CSS scaling/canvas offset), over/out/enter/leave, pointerupoutside, capture, click detection, cursor handling, 'globalpointermove', event ordering & propagation (stopPropagation / stopImmediatePropagation), dynamic mode ticker hover. src/engine2d/app/** (Application.init options defaults, ResizePlugin resizeTo window/element + debounce via rAF, TickerPlugin priorities, autoStart/sharedTicker, destroy), src/engine2d/ticker/** (deltaTime/deltaMS/elapsedMS/speed/minFPS/maxFPS, add/addOnce/remove during tick, priority ordering, started/stop), src/engine2d/culling/**, src/engine2d/assets/** (Assets.load/add/unload/cache, parsers used by the game: images, json, fonts/webfonts, texture options, spritesheets?), src/engine2d/environment/**.` },
  { key: 'filters-builtin', focus: `src/engine2d/filters/** (Filter base class: defaults for padding/resolution/antialias/blendMode/clipToViewport, resources, glProgram/gpuProgram handling, Filter.from; default filters BlurFilter/BlurFilterPass, ColorMatrixFilter (all methods the game uses), AlphaFilter, NoiseFilter, DisplacementFilter, passthrough). Compare WGSL/behaviour with Pixi filters/defaults/**. Find every Filter subclass in the game (grep 'extends Filter' and 'new Filter(' in src/ outside engine2d) and confirm the engine2d Filter API they use (constructor options, resources, uniforms updates, apply override, enabled, padding) behaves like Pixi.` },
  { key: 'rhi', focus: `src/rendering/rhi/** (types.ts, RhiDevice.ts, RhiResourceScope.ts, graph/**, backends/luma/{LumaRhiDevice.ts,lumaMapping.ts}, backends/null/NullRhiDevice.ts). Check against luma.gl 9 WebGPU APIs in node_modules/@luma.gl: resource lifetime and deferred release (resource destroyed while referenced by a pending command list; release after submit), scopes, bindings by name (sampler auto-binding, uniform buffer offsets/alignment 256), pipeline creation (blend, stencil ops front/back, depth, colorWriteMask, topology, vertex layouts/stepMode), render pass encoding (load/store ops, stencil reference, viewport/scissor), copy/readback (bytesPerRow alignment 256, formats), texture upload (image copy, premultiply, flipY, mip generation), swapchain/canvas context (format, alphaMode, resize), MSAA (just added: resolve targets, shared color for canvas targets), device lost & error scope diagnostics, NullRhiDevice fidelity (validation mirrors luma so unit tests are meaningful). Also look for per-frame allocations/leaks in hot paths.` },
  { key: 'shaders-lighting', focus: `GLSL->WGSL ports in the lighting/character path. For each file, diff master (${MASTER}/src/...) vs branch and compare the master GLSL with the new WGSL line by line: src/rendering/lighting/{SceneLightingPass.ts,LitBackground.ts,shadowPrefix.ts,GiBouncePass.ts,lightingCore.wgsl,worldReconstruct.wgsl,wgslChunks.ts,UnifiedCharacterShader.ts}, src/rendering/{CharacterLitSprite.ts,CharacterShadingFilter.ts,charLightCommon.wgsl,charShadeCore.wgsl,EntityLightingFilter.ts,EntityShadow.ts,DepthOcclusionFilter.ts,BackgroundDebugFilter.ts}. Look for: texture y-orientation flips (WebGPU row 0 = top; master WebGL RTs are stored bottom-up), uniform layout/default values, integer vs float coords (textureLoad vs texelFetch), sampler/clamp differences, textureSampleLevel vs texture() implicit LOD, derivative/uniformity differences, precision, division by zero/NaN/pow of negative, loop bounds, #define/variant branches, alpha premultiplication, and iron rule 0 (all lighting in world space). Identify branches/parameter combos NOT covered by tools/render_parity/cases/** and reason whether they are equivalent. (Note: Game.UNIFIED_CHAR_PATH_ENABLED=false — unified character path has no consumer; lower priority.)` },
  { key: 'shaders-effects', focus: `GLSL->WGSL ports in effects: src/rendering/vfx/{vfxShaders.ts,vfxBeamShaders.ts,vfxBeamWgsl.ts,vfxBoltWgsl.ts,VfxRenderer.ts,VfxBeamView.ts,Vfx*BatchMesh.ts}, src/rendering/burn/{BurnFilters.ts,burnShade.wgsl,BurnRenderer.ts}, src/systems/waterMinigame/{WaterShaderFilter.ts,WaterParamEncodeFilter.ts}, src/rendering/{overlayBlendShader.ts,breathingOverlayMesh.ts,breathingShade.wgsl,backgroundSway.ts}, src/systems/objectExamine/contactAo.ts, src/rendering/legacy/gpuSampler.ts. For each, diff master (${MASTER}/src/...) vs branch; compare master GLSL with WGSL line by line (y orientation, uniforms/defaults, sampling, blend modes, premultiplication, instancing attributes, time uniforms), and the TS-side changes (e.g., VfxRenderer +59/-16, BurnRenderer, contactAo) for behaviour changes. Identify variants/params not covered by tools/render_parity/cases/**.` },
  { key: 'game-integration', focus: `Game-side behaviour changes. Diff master vs branch for: src/core/Game.ts (reveal gate / pipelinesReady / prewarm, diagnostics removal, renderer.init({}) vs init(undefined), freeze eventMode, scene switch/destroy flows), src/rendering/Renderer.ts, src/debug/**, src/ui/{DebugPanelUI.ts,debugHierarchySection.ts,debugHierarchyModel.ts}, src/rendering/CutsceneRenderer.ts, src/systems/SceneManager.ts, src/rendering/CanvasStage.ts, src/ui/components/UIScrollView.ts, src/systems/EmoteBubbleManager.ts, src/systems/objectExamine/critterSim.ts, src/ui/PanelSkin.ts, src/rendering/SpriteEntity.ts, src/core/CharacterLightingSystem.ts. Also mechanically verify that every other modified src file (git diff --numstat 5f5a639 HEAD -- src ':!src/engine2d' ':!src/rendering/rhi') whose change is ~1 line is ONLY an import-source swap (script it: for each such file, show the diff hunks and flag any change that is not an import line). Report any behaviour difference vs master.` },
  { key: 'api-usage-sweep', focus: `Enumerate every Pixi API the game uses on master: grep ${MASTER}/src (excluding tests) for imports from 'pixi.js' and collect all imported symbols; then for each symbol, grep usages and list members/options/events used (constructors + option bags, methods, properties, static members, event names like 'pointertap'/'added', enums/constants like UPDATE_PRIORITY/BLEND_MODES/SCALE_MODES/DOMAdapter/extensions). For each used member, verify src/engine2d implements it with the same semantics and DEFAULTS as Pixi 8.17 (e.g. Sprite anchor default, Text default style/resolution, eventMode default, TextureStyle defaults, Graphics defaults, Ticker defaults, Assets behaviour, RenderTexture.create defaults, Container.sortableChildren, cullable). Flag missing members, no-op stubs, members that throw, silently ignored options, and differing defaults. Output a table of checked members in coverage.` },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          reference: { type: 'string', description: 'Pixi or master code path:line showing expected behaviour' },
          failure_scenario: { type: 'string' },
          game_impact: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'description', 'reference', 'failure_scenario', 'game_impact'],
      },
    },
    coverage: { type: 'string', description: 'What you checked and found equivalent; what you could not check' },
  },
  required: ['findings', 'coverage'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    reproduced: { type: 'boolean' },
    repro_path: { type: 'string' },
    reasoning: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    game_hits_path: { type: 'boolean' },
    fix_suggestion: { type: 'string' },
  },
  required: ['verdict', 'reproduced', 'reasoning', 'severity', 'game_hits_path'],
}

function describe(f) {
  return `Title: ${f.title}\nClaimed severity: ${f.severity}\nLocation: ${f.file}:${f.line ?? '?'}\nDescription: ${f.description}\nReference (expected behaviour): ${f.reference}\nFailure scenario: ${f.failure_scenario}\nGame impact: ${f.game_impact}\nSuggested fix: ${f.suggested_fix ?? ''}`
}

function verifyPrompt(f, slice, i, lens) {
  const lensText = lens === 'repro'
    ? `Your lens: REPRODUCE. Write a minimal repro under ${REPO}/tmp/review/verify-${slice}-${i}/ (vitest in node; compare engine2d against Pixi ('pixi.js') side by side where possible, or against master's code, or use NullRhiDevice to inspect recorded GPU commands). Run it. verdict=confirmed only if the repro demonstrates the divergence (reproduced=true) OR the code evidence is unambiguous and you explain why a repro is impossible in node (e.g. needs a real GPU) — then reproduced=false.`
    : `Your lens: REFUTE. Independently read the branch code, the Pixi reference and master. Try hard to show the claim is wrong (misread code, path unreachable, behaviour actually equivalent, the game never hits it, accepted design difference). Default to refuted if the evidence does not hold up. You may also write a repro under ${REPO}/tmp/review/verify-${slice}-${i}-b/.`
  return `${PREAMBLE}\n\nYou are an adversarial VERIFIER for one finding from the '${slice}' reviewer.\n\n${describe(f)}\n\n${lensText}\n\nAlso assess: does the game actually hit this path (game_hits_path, cite call sites), and what is the correct severity. If confirmed, give a precise minimal fix_suggestion consistent with Pixi 8.17 / master behaviour. Do not modify tracked repo files.`
}

// args.customSlices: [{ key, focus }] —— 后续轮次按上一轮的缺口自定分片(给了就不用内置的 15 片)
const BASE = Array.isArray(args.customSlices) && args.customSlices.length ? args.customSlices : SLICES
const RUN = Array.isArray(args.slices) && args.slices.length ? BASE.filter((s) => args.slices.includes(s.key)) : BASE
if (!RUN.length) throw new Error(`没有匹配的分片;可选:${SLICES.map((s) => s.key).join(', ')}`)
log(`分片 ${RUN.length} 个:${RUN.map((s) => s.key).join(', ')}`)

phase('Review')
const results = await pipeline(
  RUN,
  (s) => agent(`${PREAMBLE}\n\nYOUR SLICE: ${s.key}\n${s.focus}`, { label: `review:${s.key}`, phase: 'Review', schema: FINDINGS_SCHEMA, effort: 'high' }),
  async (review, s) => {
    if (!review) return { slice: s.key, coverage: 'REVIEWER FAILED', findings: [] }
    log(`${s.key}: ${review.findings.length} finding(s)`)
    const judged = await parallel(review.findings.map((f, i) => async () => {
      const primary = await agent(verifyPrompt(f, s.key, i, 'repro'), { label: `verify:${s.key}#${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' })
      let second = null
      const sev = primary?.severity ?? f.severity
      if (primary && primary.verdict !== 'refuted' && (sev === 'critical' || sev === 'high' || primary.verdict === 'uncertain')) {
        second = await agent(verifyPrompt(f, s.key, i, 'refute'), { label: `refute:${s.key}#${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' })
      }
      let status = 'refuted'
      if (primary && primary.verdict === 'confirmed' && (!second || second.verdict !== 'refuted' || primary.reproduced)) status = 'confirmed'
      else if (primary && primary.verdict !== 'refuted' && second && second.verdict === 'confirmed') status = 'confirmed'
      else if (primary && primary.verdict !== 'refuted') status = 'uncertain'
      return { ...f, slice: s.key, idx: i, status, primary, second }
    }))
    return { slice: s.key, coverage: review.coverage, findings: judged.filter(Boolean) }
  },
)

const all = results.filter(Boolean)
const findings = all.flatMap((r) => r.findings)
const confirmed = findings.filter((f) => f.status === 'confirmed')
const uncertain = findings.filter((f) => f.status === 'uncertain')
log(`total ${findings.length}, confirmed ${confirmed.length}, uncertain ${uncertain.length}, refuted ${findings.length - confirmed.length - uncertain.length}`)

phase('Critic')
const critic = await agent(`${PREAMBLE}\n\nYou are the COMPLETENESS CRITIC for review round 1. Below are each slice reviewer's coverage notes and the list of finding titles. Identify what is MISSING: engine2d/RHI/game files or behaviours nobody examined, Pixi features used by the game that no slice checked, risky interactions between subsystems (e.g. filters + masks + RTs + MSAA, hierarchy + events, resize + DPR + events), runtime-only behaviours (timing, frame order, async resource loading, device loss, memory growth) that static review cannot establish and need a targeted runtime check. Verify your gap claims by quickly grepping. Return a prioritized list of concrete round-2 review tasks (each: focus files + what to check).\n\nCOVERAGE:\n${all.map((r) => `## ${r.slice}\n${r.coverage}`).join('\n\n')}\n\nFINDINGS:\n${findings.map((f) => `- [${f.status}] ${f.slice}: ${f.title}`).join('\n')}`, { label: 'critic', phase: 'Critic', effort: 'high' })

return { confirmed, uncertain, refuted: findings.filter((f) => f.status === 'refuted').map((f) => ({ slice: f.slice, title: f.title, why: f.primary?.reasoning?.slice(0, 400) })), coverage: all.map((r) => ({ slice: r.slice, coverage: r.coverage })), critic }
