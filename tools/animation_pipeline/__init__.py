"""Animation production pipeline: stabilized state clips -> game-ready atlas + anim.json.

Post-processing half (matting -> anchor -> loop -> 2K atlas -> QA). The generation
half is tmp/.../run_animation_batch.py. See README.md for the proven method choices.
"""
