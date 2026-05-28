/* ═══════════════════════════════════════════════════════════════════
   core-avatars.js · canonical 3D-avatar configs for the chair +
   seven core seeded directors.

   ── Why this exists ─────────────────────────────────────────────────
   The voice-3d.js scene (`buildDirectorFigure`) builds a director
   figure from their `member.avatar3d` config when one is present,
   and falls back to a deterministic RNG-driven default otherwise.
   The marketing homepage's CAST (`home-3d-mock.js`), the onboarding
   storyline's banner (`voice-3d-banner.js`), and the in-app voice
   room itself all populate this `member.avatar3d` field — but the
   marketing + onboarding paths previously sent CAST entries with NO
   avatar3d, so they rendered randomised faces that didn't match the
   actual chair / director look the user sees in-app or on the
   product backend (`src/seed/chair.ts` + `src/seed/directors.ts`).

   This file is the single shared frontend source of truth · classic-
   script so it can be loaded ahead of the classic-script consumers
   without a module dance. Backend (TypeScript) carries the same
   constants in `src/seed/*.ts` — keep them in sync by hand.

   ── How consumers use it ────────────────────────────────────────────
     // After CAST is defined:
     if (window.PB_CORE_AVATARS) {
       for (const m of CAST) {
         const cfg = window.PB_CORE_AVATARS[m.id];
         if (cfg) m.avatar3d = cfg;
       }
     }
   That's it · `voice-3d.js` does the rest of the rigging.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  if (root.PB_CORE_AVATARS) return; // idempotent · safe to load twice
  root.PB_CORE_AVATARS = {
    // Chair · the canonical 杨天真 portrait.
    chair: {
      model: "classic", hairStyle: "glasses", outfitStyle: "casual",
      accessory: "glasses",
      skin: "#f7d7b8", hair: "#6f4e37", brow: "#7a3b28", outfit: "#d8392b",
      browStyle: "default", tieStyle: "none",
    },
    socrates: {
      model: "classic", hairStyle: "street", outfitStyle: "street",
      accessory: "glasses",
      skin: "#e0ac69", hair: "#4a3526", brow: "#241c16", outfit: "#7a5a3b",
      browStyle: "default", tieStyle: "none",
    },
    "first-principles": {
      model: "glasses", hairStyle: "royal", outfitStyle: "classic",
      accessory: "none",
      skin: "#e0ac69", hair: "#6e6e6e", brow: "#3a2a1e", outfit: "#1a1a1a",
      browStyle: "default", tieStyle: "xmas",
      tie: "#d8392b", eye: "#0d0d0d",
    },
    "value-investor": {
      model: "casual", hairStyle: "classic", outfitStyle: "casual",
      accessory: "none",
      skin: "#f7d7b8", hair: "#8d6a45", brow: "#7a3b28", outfit: "#6b3f4a",
      browStyle: "default", tieStyle: "none",
    },
    historian: {
      model: "glasses", hairStyle: "classic", outfitStyle: "classic",
      accessory: "shades",
      skin: "#ffe0bd", hair: "#6f4e37", brow: "#6f4e37", outfit: "#e0b400",
      browStyle: "default", tieStyle: "none",
    },
    "user-empathy": {
      model: "classic", hairStyle: "glasses", outfitStyle: "street",
      accessory: "glasses",
      skin: "#f7d7b8", hair: "#6f4e37", brow: "#6f4e37", outfit: "#0fb5b5",
      browStyle: "default", tieStyle: "none",
    },
    "long-horizon": {
      model: "classic", hairStyle: "none", outfitStyle: "casual",
      accessory: "none",
      skin: "#f7d7b8", hair: "#3a3a3a", brow: "#3a3a3a", outfit: "#3f4a6b",
      browStyle: "royal", tieStyle: "none",
    },
    phenomenologist: {
      model: "glasses", hairStyle: "classic", outfitStyle: "classic",
      accessory: "glasses",
      skin: "#8d5524", hair: "#b08d57", brow: "#e8cf9a", outfit: "#7a4a52",
      browStyle: "default", tieStyle: "royal",
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
