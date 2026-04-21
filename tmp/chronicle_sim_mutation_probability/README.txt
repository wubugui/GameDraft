mutation_probability_distribution.png
  Heatmap: x=round_idx, y=remaining_llm (max_rounds=12, max_llm=32).
  Formula in code: p_round = sin(pi * round_idx/(max_rounds+1));
  if round_idx <= max_rounds//2: p_mut = p_round;
  else: p_mut = p_round * (remaining_llm / max_llm).
  Right panel: line slices for several remaining_llm; vertical dashed = half max_rounds.
