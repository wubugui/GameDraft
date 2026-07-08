# animation_pipeline — stabilized clips → game-ready sprite atlas

Turns a character's per-state stabilized videos into a **game-loadable** `atlas.png`
+ `anim.json`, gated by QA. This is the **post-processing half**; the generation
half (LibTV → download → stabilize) lives in
`tmp/libtv_animation_batch_run_20260702/run_animation_batch.py`.

Every method here was chosen by **empirical bake-off on real clips**, not by guess.
The measurements below are why each default is what it is.

## One-click

```bash
.tools/venv/bin/python -m tools.animation_pipeline.produce \
    --clips-dir <dir with idle.mp4 run.mp4 jump.mp4 crouch.mp4 lie_down.mp4 slow_walk.mp4> \
    --out       public/resources/runtime/animation/<char_id> \
    --world-w 115 --world-h 150
```

Exit 0 ⇔ all **hard** QA gates pass. Agent-flags (see below) are reported in
the output manifest (`<out>/finals.json`) for a human/VLM to adjudicate — they
do not silently block.

## Pipeline (program-driven; agent is a *called judge*, not the driver)

```
per-clip PROGRAM QA ─HARD_FAIL→ abort
        │ pass / flag
        ▼
 matte(fusion) → anchor + scale-norm → loop-select → 2K grid atlas → anim.json
        ▼
 atlas QA (≤2K, indices valid) → output manifest (finals.json verdicts + agent-flags)
```

## Proven method choices (with the numbers that justified them)

### Matting — `fusion` (BiRefNet extent + color-key edge)  · `matting.py`
Grey background is a double-edged sword: great for keying, but **holes any
grey/silver part of the character**. Bake-off (halo=bg-leak, holes=char-cut, lower=better):

| method | boy grey jacket holes | coolie grey pants holes | verdict |
|---|---|---|---|
| color-key | **2.38%** | (穿) | ❌ holes grey costumes |
| rembg u2net | 0.14% | **6.53%** | ❌ unstable |
| rembg isnet | 0.16% | 0.02% | ok (fallback) |
| BiRefNet | 0.27% | 0.08% | good |
| **fusion** | **0.10%** | **0.005%** | ✅ lowest holes, crisp edge |

BiRefNet defines the object (kills halo outside + fills grey-costume holes);
color-key supplies the crisp anti-aliased edge. Falls back to `rembg_isnet` if
torch/transformers is unavailable.

> QA note: a naive "halo %" metric can't tell grey-*costume* from grey-*background*,
> so it over-penalizes learned methods. **`holes` is the reliable signal.**

### Anchor — centroid-x + robust foot-line-y, per action, cross-state scale-norm · `pipeline.py`
Runtime pins each cell at `anchor(0.5,1)` = **bottom-centre**, so feet go to the
cell bottom, body horizontally centred. Measured jitter on a run cycle:

| anchor def | foot-line Y jitter | side X jitter |
|---|---|---|
| bbox bottom-centre (naive) | 11.85px | 10.93px |
| **centroid-x + foot-line-y** | **0.36px** | 1.08px |

Cross-state: clips are generated at ~8% different scale, so aligning feet alone
pops the head **279px** on state switch; **scale-normalising to a common standing
height + a common ground anchor → 0px**. Per-action anchor mode in `recipes.py`:
`grounded` (feet lock every frame) · `vertical` (jump: fixed takeoff line, body free
to rise) · `ground_fixed` (lie_down).

### Loop selection — self-similarity period + cleanest seam · `pipeline.py:find_loop`
Anchor-align frames, build a self-distance matrix, detect the motion period, pick
the window with the smallest first↔last seam; auto-skips the standing lead-in.
`seam_ratio = seam/adjacent < 1` ⇒ seamless (officer run **0.12**). Low-motion idle
uses an absolute seam floor, not the ratio. Non-periodic actions are bracketed
between matching standing endpoints so they loop back to rest.

### 2K atlas — budget solver · `pipeline.py:_solve_2k`
One atlas per character, **all states share a uniform grid** (runtime:
`col=idx%cols,row=idx//cols`). Solver maximises sprite scale s.t. `cols·cellW≤2048`
and `rows·cellH≤2048`. Source frames are ~800–1100px tall → **downscale is
mandatory** (a 2K sheet holds ~2 native frames). More frames ⇒ smaller sprite; the
solver makes that trade explicit. Reuses `../video_to_atlas/atlas_core.py` for the
format-faithful `anim.json`.

### QA gate — program checks + agent judge · `qa_gate.py`
- **Program (objective):** frame count, in-place displacement, edge clipping,
  atlas ≤2K [hard]; floating-fragment (connected-components), silhouette-area melt
  proxy, matte holes [flag]. Caught the real defects the old metric-only QA missed:
  detached spearhead **12.5%**, ghost-ring **17.4%** — both passed the clean re-gens.
- **Agent (semantic, `AGENT_SCHEMA`):** adjudicates flags + judges prop-held/intact,
  action-correct, identity, style, orientation. Fed the program flags so it looks
  where they point. Program never accepts alone; hard-fail never spends agent.

## Files
`recipes.py` per-action config + thresholds (tune here, not in code) ·
`matting.py` · `pipeline.py` anchor/loop/scale-norm/2K/atlas ·
`qa_gate.py` · `produce.py` CLI.

## Known refinements (logged during bring-up)
- lie_down is landscape; sharing the portrait cell wastes space → consider a
  separate atlas for it.
- x-anchor uses silhouette centroid; for prop-heavy characters (spear) it pulls a
  few px off-centre — foot-centre-x would be tighter.
- A long prop held out to one side inflates the symmetric cell width (empty other
  side) because the runtime anchor is centred.
