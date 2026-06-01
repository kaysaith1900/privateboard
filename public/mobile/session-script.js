/* ═══════════════════════════════════════════════════════════════════
   session-script.js · the offline, scripted boardroom discussion that
   drives the mobile voice-room prototype. No backend, no SSE — just a
   cast + an ordered list of turns. The shell's driver sequences
   thinking → speaking → next and feeds the 3D stage + caption band.
   ═══════════════════════════════════════════════════════════════════ */

// Cast · chair + 6 directors, identical ids/portraits to home-3d-mock.js
// so PB_CORE_AVATARS decorates them with the canonical seeded looks.
export const CAST = [
  { id: "chair",            name: "Chair",            avatarPath: "/avatars/3d/chair.png",            roleKind: "chair" },
  { id: "socrates",         name: "Socrates",         avatarPath: "/avatars/3d/socrates.png",         roleKind: "director" },
  { id: "first-principles", name: "First Principles", avatarPath: "/avatars/3d/first-principles.png", roleKind: "director" },
  { id: "value-investor",   name: "Value Investor",   avatarPath: "/avatars/3d/value-investor.png",   roleKind: "director" },
  { id: "user-empathy",     name: "User-Empathy",     avatarPath: "/avatars/3d/user-empathy.png",     roleKind: "director" },
  { id: "long-horizon",     name: "Long Horizon",     avatarPath: "/avatars/3d/long-horizon.png",     roleKind: "director" },
  { id: "phenomenologist",  name: "Phenomenologist",  avatarPath: "/avatars/3d/phenomenologist.png",  roleKind: "director" },
];

export const SESSION = {
  mode: "brainstorm",
  title: "Ship mobile now?",
  round: 2,
  // Each turn: who speaks, how long they "think" before speaking, and
  // the line. Speaking duration is derived from text length in the driver.
  turns: [
    { speakerId: "chair",            thinkMs: 600,  text: "Today's question — do we ship the iOS app this quarter, or hold for the native voice room?" },
    { speakerId: "first-principles", thinkMs: 1100, text: "Strip it down. What does shipping actually cost us if the voice room feels like a website stuffed in a frame?" },
    { speakerId: "user-empathy",     thinkMs: 900,  text: "Picture day one: someone opens it one-handed on the subway. If the caption doesn't track who's talking, they close it in ten seconds." },
    { speakerId: "value-investor",   thinkMs: 1200, text: "Every category that shipped a responsive wrapper first got out-shipped by the team that went native second. The base rate is not kind." },
    { speakerId: "long-horizon",     thinkMs: 1000, text: "And the wrapper's constraints become ours for two years. The native camera work is the moat — do it once, properly." },
    { speakerId: "socrates",         thinkMs: 1300, text: "Then the real question isn't now-or-later. It's whether a voice room can feel native on a phone at all. Have we actually proven that?" },
    { speakerId: "phenomenologist",  thinkMs: 800,  text: "Notice the room agreed on “native” in under a minute — nobody asked what native costs the three of us who'd have to build it." },
    { speakerId: "chair",            thinkMs: 700,  text: "Fair. So we prototype the hardest part — the voice stage — before we commit a whole quarter to it." },
  ],
};
