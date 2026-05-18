/* ─────────────── App auto-update controller ───────────────
   Renderer side of the Electron auto-updater flow. The
   main process (electron/main.ts) pushes every state
   transition over the `updater:state` IPC channel; the
   preload bridge surfaces it as
   `window.privateboard.updater.{onState,getState,…}`.

   Lifecycle:
     1. On script load (browser fallback or pre-Electron build),
        the IPC bridge is absent · we no-op.
     2. In Electron, we `getState()` to rehydrate (covers refresh
        / devtools reload that lands after `update-available`
        already fired) and subscribe via `onState`.
     3. On every non-idle state, the overlay opens (or stays
        open) and paints the matching subtree. The user's
        "Later"/"Hide" button only closes the modal — it does
        NOT cancel the download; clicking the dock icon or
        waiting for the next 4-hour re-check re-opens it.
*/

(function () {
  "use strict";

  const bridge = (typeof window !== "undefined" && window.privateboard && window.privateboard.updater) || null;
  if (!bridge) return; // Browser preview / non-Electron build · do nothing.

  let overlayEl = null;
  let lastState = null;
  let userDismissed = false; // Cleared whenever a NEW state arrives.
  let appVersion = ""; // Resolved once via window.privateboard.getAppVersion().

  function $(sel, root) { return (root || document).querySelector(sel); }

  function applyI18n() {
    if (!overlayEl) return;
    const I18n = window.I18n;
    overlayEl.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      let val = null;
      if (I18n && typeof I18n.t === "function") {
        val = I18n.t(key);
        if (val === key) val = null;
      }
      if (val) el.textContent = val;
    });
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "0 MB";
    const mb = n / (1024 * 1024);
    if (mb < 10) return mb.toFixed(1) + " MB";
    return Math.round(mb) + " MB";
  }
  function fmtRate(bps) {
    if (!Number.isFinite(bps) || bps <= 0) return "—";
    const mb = bps / (1024 * 1024);
    if (mb >= 1) return mb.toFixed(1) + " MB/s";
    const kb = bps / 1024;
    return Math.max(1, Math.round(kb)) + " KB/s";
  }

  function currentVersion() {
    // Resolved lazily at init via `window.privateboard.getAppVersion()`.
    // If the IPC roundtrip hasn't landed yet (race against the first
    // `update-available` event), the version delta degrades to just
    // "→ v0.1.23" until the next state event re-paints.
    return appVersion;
  }

  function setStateClass(kind) {
    if (!overlayEl) return;
    overlayEl.classList.remove(
      "state-available",
      "state-downloading",
      "state-ready",
      "state-error",
    );
    if (kind === "available" || kind === "downloading" || kind === "ready" || kind === "error") {
      overlayEl.classList.add("state-" + kind);
    }
  }

  function openModal() {
    if (!overlayEl) return;
    if (overlayEl.classList.contains("open")) return;
    overlayEl.classList.add("open");
    overlayEl.setAttribute("aria-hidden", "false");
    document.body.classList.add("upd-locked");
  }
  function closeModal() {
    if (!overlayEl) return;
    overlayEl.classList.remove("open");
    overlayEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("upd-locked");
  }

  function paint(state) {
    if (!overlayEl || !state) return;
    const from = currentVersion();
    const to = state.version ? ("v" + state.version) : "";
    overlayEl.querySelectorAll("[data-upd-from-version], [data-upd-from-version-d], [data-upd-from-version-r]").forEach((el) => {
      el.textContent = from ? ("v" + from.replace(/^v/, "")) : "";
      el.style.display = from ? "" : "none";
    });
    overlayEl.querySelectorAll("[data-upd-to-version], [data-upd-to-version-d], [data-upd-to-version-r]").forEach((el) => {
      el.textContent = to;
    });

    if (state.kind === "downloading") {
      const pct = Math.max(0, Math.min(100, Math.round(state.percent || 0)));
      const pctEl = $("[data-upd-pct]", overlayEl);
      if (pctEl) pctEl.textContent = pct + "%";
      const bar = $("[data-upd-bar]", overlayEl);
      if (bar) {
        bar.classList.remove("indeterminate");
        const span = bar.querySelector("span");
        if (span) span.style.width = pct + "%";
      }
      const bytes = $("[data-upd-bytes]", overlayEl);
      if (bytes) {
        bytes.textContent = fmtBytes(state.transferred) + " / " + fmtBytes(state.total);
      }
      const rate = $("[data-upd-rate]", overlayEl);
      if (rate) rate.textContent = fmtRate(state.bytesPerSecond);
    }

    if (state.kind === "error") {
      const errEl = $("[data-upd-error-message]", overlayEl);
      if (errEl) errEl.textContent = state.message || "—";
    }

    setStateClass(state.kind);
  }

  function shouldAutoOpenFor(state) {
    if (!state) return false;
    if (state.kind === "available") return true;   // First prompt on launch.
    if (state.kind === "ready") return true;       // Always surface the restart prompt.
    if (state.kind === "downloading") return false; // User asked to hide · don't pop it back.
    if (state.kind === "error") return false;       // Errors don't steal focus.
    return false;
  }

  function applyState(state) {
    if (!state || state.kind === "idle") {
      // Idle (no update / cleared) · keep modal closed.
      lastState = state || { kind: "idle" };
      return;
    }
    const isNewKind = !lastState || lastState.kind !== state.kind;
    if (isNewKind) userDismissed = false; // A new transition re-prompts.
    lastState = state;
    paint(state);
    if (overlayEl.classList.contains("open")) {
      // Already open — repaint in place; downloading→ready transitions
      // flow without the modal flickering.
      return;
    }
    if (!userDismissed && shouldAutoOpenFor(state)) openModal();
  }

  function wireEvents() {
    overlayEl.addEventListener("click", (e) => {
      const close = e.target.closest("[data-upd-close], [data-upd-dismiss]");
      if (close) {
        e.preventDefault();
        userDismissed = true;
        closeModal();
        bridge.dismiss();
        return;
      }
      const dl = e.target.closest("[data-upd-download]");
      if (dl) {
        e.preventDefault();
        // Optimistic switch to the downloading state so the user sees
        // the progress card immediately; the first real
        // `download-progress` event will replace the indeterminate
        // sweep with a percentage.
        const v = (lastState && lastState.kind === "available") ? lastState.version : "";
        applyState({ kind: "downloading", version: v, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
        const bar = $("[data-upd-bar]", overlayEl);
        if (bar) bar.classList.add("indeterminate");
        bridge.startDownload();
        return;
      }
      const inst = e.target.closest("[data-upd-install]");
      if (inst) {
        e.preventDefault();
        // Disable the button to prevent a double-click between the
        // IPC roundtrip and the actual app quit.
        inst.setAttribute("disabled", "true");
        bridge.installNow();
        return;
      }
    });
    document.addEventListener("keydown", (e) => {
      if (!overlayEl.classList.contains("open")) return;
      if (e.key !== "Escape") return;
      // Escape never installs · only dismisses. During a download or
      // ready state, this is the same as the "Hide"/"Later" button.
      e.preventDefault();
      userDismissed = true;
      closeModal();
      bridge.dismiss();
    });
    document.addEventListener("boardroom:locale", applyI18n);
  }

  function init() {
    overlayEl = document.getElementById("upd-overlay");
    if (!overlayEl) return;
    applyI18n();
    wireEvents();
    // Dev preview · expose state injection so the modal can be auditioned
    // without a packaged build + real GitHub release. From devtools:
    //   __updaterDev.show({ kind: "available", version: "0.1.99" })
    //   __updaterDev.show({ kind: "downloading", version: "0.1.99",
    //                       percent: 42, transferred: 5_300_000,
    //                       total: 12_500_000, bytesPerSecond: 850_000 })
    //   __updaterDev.show({ kind: "ready", version: "0.1.99" })
    //   __updaterDev.show({ kind: "error", message: "Could not connect" })
    //   __updaterDev.close()
    window.__updaterDev = {
      show: (s) => { userDismissed = false; applyState(s); openModal(); },
      close: () => { userDismissed = false; closeModal(); },
    };
    // Resolve the app version once · used for the "v_old → v_new"
    // version delta in the modal header.
    if (typeof window.privateboard.getAppVersion === "function") {
      window.privateboard.getAppVersion().then((v) => {
        appVersion = v || "";
        if (lastState && lastState.kind !== "idle") paint(lastState);
      }).catch(() => {});
    }
    bridge.onState((s) => applyState(s));
    // Re-hydrate · covers the case where update-available already
    // fired before this script's defer-run completed.
    bridge.getState().then((s) => { if (s) applyState(s); }).catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
