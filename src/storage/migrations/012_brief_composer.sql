-- Report composer · capture the chair's component picks alongside each
-- brief. Today every report is a fixed McKinsey-style 12-section deck;
-- the new flow has a Stage 1.5 composer that picks (a) a style spine
-- and (b) a subset of components based on the room's subject and the
-- per-director signals.
--
-- Columns:
--   spine                Renderer key. v1 ships with `boardroom-dark`
--                        only; later releases add `a16z-thesis`,
--                        `anthropic-essay`, `gartner-note`,
--                        `mckinsey-deck`, `openai-paper`. Default keeps
--                        legacy briefs renderable.
--   components_json      JSON array of { kind, order } objects. Empty
--                        array means "legacy / all 12 components" — the
--                        renderer falls back to today's static layout.
--   composer_rationale   The composer's one-line explanation, surfaced
--                        on hover of the SPINE tag in the UI. NULL when
--                        the composer was bypassed.
--   subject_type         Coarse classification the composer assigned
--                        (e.g. `investment-judgement`, `philosophical`,
--                        `option-comparison`). Used by analytics + by
--                        future "regenerate as" presets. NULL for legacy.

ALTER TABLE briefs ADD COLUMN spine              TEXT NOT NULL DEFAULT 'boardroom-dark';
ALTER TABLE briefs ADD COLUMN components_json    TEXT NOT NULL DEFAULT '[]';
ALTER TABLE briefs ADD COLUMN composer_rationale TEXT;
ALTER TABLE briefs ADD COLUMN subject_type       TEXT;
