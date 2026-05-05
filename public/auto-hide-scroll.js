/* ═══════════════════════════════════════════
   AUTO-HIDE SCROLL
   Hides the scrollbar on registered containers when not scrolling,
   shows it briefly while the user is scrolling. Mirrors macOS
   "Show scroll bars · When scrolling" behavior.

   Targets:
     · sidebar rooms list  (.sessions-scroll)
     · sidebar agents list (.agents-scroll)
     · chat transcript     (.chat)
   ═══════════════════════════════════════════ */
(function () {
  const SELECTORS = [".sessions-scroll", ".agents-scroll", ".chat"];
  const HIDE_DELAY = 700;

  function injectStyles() {
    if (document.getElementById("auto-hide-scroll-styles")) return;
    const sel           = SELECTORS.join(", ");
    const wkScroll      = SELECTORS.map((s) => `${s}::-webkit-scrollbar`).join(", ");
    const wkTrack       = SELECTORS.map((s) => `${s}::-webkit-scrollbar-track`).join(", ");
    const wkThumb       = SELECTORS.map((s) => `${s}::-webkit-scrollbar-thumb`).join(", ");
    const wkThumbActive = SELECTORS.map((s) => `${s}.is-scrolling::-webkit-scrollbar-thumb`).join(", ");
    const wkThumbHover  = SELECTORS.map((s) => `${s}.is-scrolling::-webkit-scrollbar-thumb:hover`).join(", ");
    const cssScrolling  = SELECTORS.map((s) => `${s}.is-scrolling`).join(", ");

    const style = document.createElement("style");
    style.id = "auto-hide-scroll-styles";
    style.textContent = `
      ${sel} {
        scrollbar-width: thin;
        scrollbar-color: transparent transparent;
        transition: scrollbar-color 0.3s ease;
      }
      ${cssScrolling} {
        scrollbar-color: var(--line-strong, #3A3A35) transparent;
      }
      ${wkScroll} {
        width: 8px;
        height: 8px;
      }
      ${wkTrack} {
        background: transparent;
      }
      ${wkThumb} {
        background: transparent;
        border-radius: 4px;
        transition: background 0.3s ease;
      }
      ${wkThumbActive} {
        background: var(--line-strong, #3A3A35);
      }
      ${wkThumbHover} {
        background: var(--text-faint, #5C5A52);
      }
    `;
    document.head.appendChild(style);
  }

  function attach(el) {
    if (el.__autoHideAttached) return;
    el.__autoHideAttached = true;
    let timer = null;
    const onScroll = () => {
      el.classList.add("is-scrolling");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove("is-scrolling"), HIDE_DELAY);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
  }

  function attachAll() {
    SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach(attach);
    });
  }

  function init() {
    injectStyles();
    attachAll();
    // Watch for late-rendered scroll containers (e.g. when tabs swap content)
    const obs = new MutationObserver(() => attachAll());
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
