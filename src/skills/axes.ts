/**
 * Boardroom-specific ability axes for the agent radar chart.
 * Fixed set so the radar can compare across agents and so skill
 * uploads can validate axis names at parse time.
 *
 * Each axis ranges 0..10 in display. Skill deltas are integers
 * in [-3, 3]; the rendered value is base + sum(deltas), clamped.
 */
export const ABILITY_AXES = [
  "dissent",
  "pattern_recall",
  "rigor",
  "empathy",
  "narrative",
  "decisiveness",
] as const;

export type AbilityAxis = (typeof ABILITY_AXES)[number];

/** Default base profile for agents without an explicit one set. */
export const DEFAULT_BASE_ABILITY: Record<AbilityAxis, number> = {
  dissent: 5,
  pattern_recall: 5,
  rigor: 5,
  empathy: 5,
  narrative: 5,
  decisiveness: 5,
};

export const ABILITY_DISPLAY_MAX = 10;
export const ABILITY_DISPLAY_MIN = 0;
