/* ─────────────── Voice-mode onboarding overlay ───────────────
   Promo overlay that appears when the user clicks the voice
   toggle on the new-room composer without any voice-provider
   key configured. The click handler in app.js calls
   window.openVoiceOnboarding(); the CTA inside the overlay
   routes onward into the user-settings panel scrolled to the
   MiniMax key row.

   Theme rotation: each open cycles through the four themed
   previews (eastwood / regent / atrium / nintendo) using a
   localStorage counter so repeat-opens never feel static.
*/

(function () {
  "use strict";

  const STORAGE_KEY = "boardroom.vonb.themeIdx";
  const THEME_LABELS = {
    eastwood: { name: "Brainstorm", deck: "soil + grass · open ground" },
    regent:   { name: "Constructive", deck: "graphite marble · executive" },
    atrium:   { name: "Research", deck: "light marble · scholarly" },
    nintendo: { name: "Critique", deck: "burgundy carpet · formal" },
  };

  let overlayEl = null;
  let bannerEl = null;
  let labelEl = null;
  let wired = false;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function readThemes() {
    const tpl = document.getElementById("vonb-themes");
    if (!tpl || !tpl.content) return [];
    return Array.from(tpl.content.querySelectorAll(".voice-room-preview"));
  }

  function nextThemeIdx(themes) {
    let idx = 0;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      idx = raw == null ? 0 : (parseInt(raw, 10) || 0);
    } catch (e) {}
    const n = Math.max(1, themes.length);
    const cur = ((idx % n) + n) % n;
    try { localStorage.setItem(STORAGE_KEY, String((cur + 1) % n)); } catch (e) {}
    return cur;
  }

  function applyI18n() {
    if (!overlayEl) return;
    const I18n = window.I18n;
    overlayEl.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      let val = null;
      if (I18n && typeof I18n.t === "function") {
        val = I18n.t(key);
        if (val === key) val = null; // missing-key fallback
      }
      if (val) el.textContent = val;
    });
  }

  function refreshLabel(themeKey) {
    if (!labelEl) return;
    const I18n = window.I18n;
    const meta = THEME_LABELS[themeKey] || { name: themeKey, deck: "" };
    // i18n keys: vonb_theme_<key>_name / vonb_theme_<key>_deck. Fall back
    // to the hardcoded English labels if no translation registered.
    let name = meta.name;
    let deck = meta.deck;
    if (I18n && typeof I18n.t === "function") {
      const nk = "vonb_theme_" + themeKey + "_name";
      const dk = "vonb_theme_" + themeKey + "_deck";
      const nv = I18n.t(nk);
      const dv = I18n.t(dk);
      if (nv && nv !== nk) name = nv;
      if (dv && dv !== dk) deck = dv;
    }
    labelEl.innerHTML =
      '<span class="v-name"></span><span class="v-deck"></span>';
    labelEl.querySelector(".v-name").textContent = name;
    labelEl.querySelector(".v-deck").textContent = deck;
  }

  // Live-3D mount cleanup handle · set when `window.mountVoice3dBanner`
  // returns a stop fn. Cleared on close so WebGL is released and the
  // next legitimate mount (real voice room) gets a fresh state.
  let stop3d = null;

  function mountPreview() {
    if (!bannerEl) return;
    // Tear down any prior mount before re-mounting · happens if the
    // user closes + reopens the overlay rapidly.
    if (stop3d) { try { stop3d(); } catch (e) {} stop3d = null; }
    // Theme name + deck show the brainstorm tone (the scene the
    // mount renders). Internal key is "eastwood" (legacy alias) →
    // THEME_LABELS resolves it to { name: "Brainstorm", deck: ... }.
    refreshLabel("eastwood");

    // Two-stage progressive enhancement:
    // 1. Try the LIVE Three.js scene (same scene as marketing
    //    homepage). User can drag-orbit; speakers rotate every 4 s.
    // 2. WebGL unavailable / reduced-motion / module fails → fall
    //    back to the static 3D poster.
    // 3. Poster file missing → onerror gradient placeholder.
    bannerEl.innerHTML = '<div class="vonb-banner-stage" data-vonb-banner-stage></div>';
    const stage = bannerEl.querySelector("[data-vonb-banner-stage]");
    if (stage && typeof window.mountVoice3dBanner === "function") {
      const stop = window.mountVoice3dBanner(stage);
      if (stop) { stop3d = stop; return; }
    }
    // Poster fallback.
    bannerEl.innerHTML =
      '<picture class="vonb-banner-pic">' +
        '<source srcset="home-3d-poster.webp" type="image/webp">' +
        '<img src="home-3d-poster.jpg" alt="" loading="lazy" decoding="async"' +
        ' onerror="this.style.display=\'none\'; this.parentElement.parentElement.classList.add(\'vonb-banner-missing\');">' +
      '</picture>';
  }

  function wireEvents() {
    if (wired) return;
    wired = true;
    overlayEl.addEventListener("click", (e) => {
      const closer = e.target.closest("[data-vonb-close]");
      if (closer) { e.preventDefault(); window.closeVoiceOnboarding(); return; }
      const cta = e.target.closest("[data-vonb-cta]");
      if (cta) {
        e.preventDefault();
        window.closeVoiceOnboarding();
        if (typeof window.openUserSettings === "function") {
          window.openUserSettings({ section: "keys", focusProvider: "minimax" });
        }
      }
    });
    document.addEventListener("keydown", (e) => {
      if (!overlayEl.classList.contains("open")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        window.closeVoiceOnboarding();
      }
    });
  }

  window.openVoiceOnboarding = function () {
    overlayEl = document.getElementById("vonb-overlay");
    if (!overlayEl) return;
    bannerEl = overlayEl.querySelector("[data-vonb-banner]");
    labelEl = overlayEl.querySelector("[data-vonb-theme-label]");
    wireEvents();
    applyI18n();
    mountPreview();
    overlayEl.classList.add("open");
    overlayEl.setAttribute("aria-hidden", "false");
    document.body.classList.add("vonb-locked");
    // Focus the CTA for keyboard users.
    const cta = overlayEl.querySelector("[data-vonb-cta]");
    if (cta) setTimeout(() => cta.focus(), 0);
  };

  window.closeVoiceOnboarding = function () {
    if (!overlayEl) return;
    // Tear down the live 3D scene (if mounted) before hiding the
    // overlay · frees WebGL context and lets the next mount (real
    // voice room) get a clean start. No-op when the fallback poster
    // path was used.
    if (stop3d) { try { stop3d(); } catch (e) {} stop3d = null; }
    overlayEl.classList.remove("open");
    overlayEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("vonb-locked");
  };
})();
