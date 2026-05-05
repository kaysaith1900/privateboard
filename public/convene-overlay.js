/* ═══════════════════════════════════════════
   CONVENE-A-ROOM OVERLAY
   ═══════════════════════════════════════════
   Usage:
     <link rel="stylesheet" href="convene-overlay.css">
     <script src="convene-overlay.js" defer></script>
     ... add data-convene-trigger to any element to open ...
     ... or call window.openConveneOverlay() ...
     ... or load page with #convene hash ...
*/
(function () {
  /** Tone tooltips · keep in lockstep with app.js / room-settings.js. */
  const TONE_TIPS = {
    brainstorm:
      "Co-creator. Directors stand with you and push the idea outward — yes-and a contribution, name a concrete adjacent variant (\"what if we instead…\"), borrow pieces from another director's turn into new combinations. May end with one curious question, never a defense-demanding one.",
    constructive:
      "Sympathetic interrogator. They want you to win, but only via the strongest version. Each turn picks ONE load-bearing assumption and proposes the candidate stronger version that would stand. Disagreement is allowed, but every objection comes packaged with a forward path.",
    debate:
      "Peer reviewer. Each turn opens by steelmanning your strongest claim (\"the strongest read of your point is…\") and only then attacks THAT version — naming a specific risk, demanding evidence, exposing the trade-off you're hiding. Sharp but professional. Skipping the steelman is a protocol violation.",
    "no-mercy":
      "Hostile reviewer. Default: you're wrong until proved otherwise. Points at vague terms / hand-waved mechanisms, says \"this is wrong because X\" flat — no hedge. Refuses undefined terms. Attacks the argument as half-baked / wrong, never the person. Forbidden hedge words: perhaps / maybe / could be / might.",
  };

  const MODAL_HTML = `
    <div class="convene-overlay" id="convene-overlay" role="dialog" aria-modal="true" aria-hidden="true">
      <div class="convene-modal" role="document">

        <div class="convene-classification">
          <span><span class="dot">●</span> room · setup</span>
          <span class="right">// private</span>
        </div>

        <header class="convene-head">
          <div>
            <div class="step-num">step 01 / 02 · room setup</div>
            <div class="step-title">▸ bring a question. <em>convene your board.</em></div>
          </div>
          <div class="step-track">
            <span class="step-dot current"></span>
            <span class="step-dot"></span>
          </div>
          <button type="button" class="close-btn" aria-label="Close">✕</button>
        </header>

        <div class="convene-body">

          <!-- TOPIC HERO -->
          <section class="topic-hero">
            <div class="topic-eyebrow">The Question · Most Important Field</div>
            <h2 class="topic-prompt">what's the boardroom <em>convening over</em> today?</h2>

            <div class="topic-input-wrap">
              <textarea class="topic-input" placeholder="an idea you're not sure about. a decision you keep avoiding. a theory you want stress-tested. the more specific, the sharper the room."></textarea>
            </div>

            <div class="topic-counter">
              <span><span class="accent">▸</span> <span class="char-count">0</span> / 800 chars · auto-saved</span>
              <span>shape it carefully — directors read every word</span>
            </div>

            <div class="topic-suggestions">
              <span class="suggest-label">// try:</span>
              <a href="#" class="suggest-chip">stress-test idea</a>
              <a href="#" class="suggest-chip">frame decision</a>
              <a href="#" class="suggest-chip">find the hole</a>
              <a href="#" class="suggest-chip">read with me</a>
            </div>
          </section>

          <!-- Config row -->
          <div class="config-row">

            <!-- Directors -->
            <section class="panel bracketed">
              <div class="panel-head">
                <h2>invite_directors</h2>
                <div class="panel-meta"><span class="num picked-count">3</span> picked / 2-4 rec.</div>
              </div>
              <div class="panel-body">
                <div class="directors-grid" data-directors-grid></div>
              </div>
            </section>

            <!-- Tune -->
            <section class="panel bracketed">
              <div class="panel-head">
                <h2>tune_room</h2>
                <div class="panel-meta">3 settings</div>
              </div>
              <div class="panel-body">

                <div class="config-block">
                  <div class="config-label">
                    <span>lineup</span>
                    <span class="hint"><span class="lineup-count">3</span> of 4</span>
                  </div>
                  <div class="lineup"></div>
                </div>

                <div class="config-block">
                  <div class="config-label">
                    <span>tone</span>
                    <span class="hint">how hard they push</span>
                  </div>
                  <div class="mode-grid">
                    <a href="#" class="mode-chip" data-mode="brainstorm">Brainstorm<span class="desc">yes-and</span><button type="button" class="mode-info-btn" data-mode-info="brainstorm" aria-label="What 'brainstorm' means">i</button></a>
                    <a href="#" class="mode-chip active" data-mode="constructive">Constructive<span class="desc">push & sharpen</span><button type="button" class="mode-info-btn" data-mode-info="constructive" aria-label="What 'constructive' means">i</button></a>
                    <a href="#" class="mode-chip" data-mode="debate">Debate<span class="desc">find holes</span><button type="button" class="mode-info-btn" data-mode-info="debate" aria-label="What 'debate' means">i</button></a>
                    <a href="#" class="mode-chip" data-mode="no-mercy">No Mercy<span class="desc">tear apart</span><button type="button" class="mode-info-btn" data-mode-info="no-mercy" aria-label="What 'no-mercy' means">i</button></a>
                  </div>
                </div>

                <div class="config-block">
                  <div class="config-label">
                    <span>intensity</span>
                    <span class="hint">currently: <span class="intensity-label">sharp</span></span>
                  </div>
                  <div class="temp-bar" data-intensity="sharp" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1">
                    <div class="temp-track"></div>
                    <div class="temp-thumb" style="left: 50%;"></div>
                  </div>
                  <div class="temp-labels">
                    <span data-intensity-pick="calm">calm</span>
                    <span data-intensity-pick="sharp">sharp</span>
                    <span data-intensity-pick="brutal">brutal</span>
                  </div>
                </div>

              </div>
            </section>

          </div>
        </div>

        <footer class="convene-foot">
          <div>
            <div class="readout-label">ready when you are</div>
            <div class="readout-text"><span class="readout-summary">3 directors · constructive · sharp</span></div>
            <div class="readout-meta readout-roster">
              <strong>Socrates</strong>, <strong>First Principles</strong>, <strong>Value Investor</strong> are ready to convene.
            </div>
          </div>
          <a href="#" class="convene-cta" id="convene-go">[ Convene the Boardroom ]</a>
        </footer>

      </div>
    </div>
  `;

  let overlay, modal;

  /** Caches keyed by agent id, populated when we render the directors
   *  grid. AVATARS holds avatarPath for the lineup mini-thumbs — must
   *  use the agent's actual stored path (data: URL for custom agents,
   *  /avatars/*.svg for seeds), not a guessed `avatars/${id}.svg`. */
  const NAMES = {};
  const AVATARS = {};

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /** Tone info popover · anchored under the clicked ⓘ button on a
   *  mode-chip. Shows the long-form behavioural description for that
   *  tone. Single instance lives at the bottom of <body>; an outside
   *  click or Esc dismisses. Mirrored in room-settings.js. */
  function openTonePopover(triggerBtn) {
    closeTonePopover();
    const tone = triggerBtn.getAttribute("data-mode-info");
    if (!tone || !TONE_TIPS[tone]) return;
    const pop = document.createElement("div");
    pop.id = "tone-info-popover";
    pop.className = "tone-info-popover";
    pop.innerHTML = `
      <div class="tone-info-head">${escape(tone)}</div>
      <div class="tone-info-body">${escape(TONE_TIPS[tone])}</div>
    `;
    document.body.appendChild(pop);
    const r = triggerBtn.getBoundingClientRect();
    const popH = pop.offsetHeight;
    const popW = pop.offsetWidth;
    // Prefer below the icon; flip above if it would clip the viewport.
    let top = r.bottom + 6;
    if (top + popH > window.innerHeight - 12) top = r.top - popH - 6;
    let left = r.left;
    if (left + popW > window.innerWidth - 12) left = window.innerWidth - popW - 12;
    if (left < 12) left = 12;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
    pop.dataset.anchor = tone;
  }
  function closeTonePopover() {
    const el = document.getElementById("tone-info-popover");
    if (el) el.remove();
  }
  // Outside-click dismisses (capture so it runs before chip-toggle).
  document.addEventListener("click", (e) => {
    const pop = document.getElementById("tone-info-popover");
    if (!pop) return;
    if (e.target.closest("#tone-info-popover")) return;
    if (e.target.closest("[data-mode-info]")) return;
    closeTonePopover();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("tone-info-popover")) {
      closeTonePopover();
    }
  });

  /** Render the directors grid from /api/agents (preferring the
   *  in-memory list app.js already maintains). Each row is a label
   *  with a checkbox so the picker is multi-select with no extra
   *  catalog overlay. Pre-checks the first 3 directors so a fresh
   *  convene starts with a sensible default. */
  function renderDirectorsGrid() {
    const grid = modal && modal.querySelector("[data-directors-grid]");
    if (!grid) return;
    const all = (window.app && Array.isArray(window.app.agents))
      ? window.app.agents
      : [];
    const directors = all.filter((a) => a.roleKind === "director");
    if (directors.length === 0) {
      grid.innerHTML = `<div class="directors-empty">no directors yet — head to the Agents tab to create one.</div>`;
      return;
    }

    // Pre-existing picks (e.g., re-open the overlay) take priority;
    // otherwise pre-check the first 3 directors so the room is
    // always immediately conveneable.
    const previouslyPicked = new Set(
      Array.from(grid.querySelectorAll(".director-mini.picked")).map((el) => el.dataset.pick),
    );
    const hasPrior = previouslyPicked.size > 0;

    grid.innerHTML = directors.map((a, i) => {
      NAMES[a.id] = a.name;
      AVATARS[a.id] = a.avatarPath;
      const picked = hasPrior ? previouslyPicked.has(a.id) : i < 3;
      return `
        <label class="director-mini${picked ? " picked" : ""}" data-pick="${escape(a.id)}">
          <input type="checkbox" class="director-check" data-director-check ${picked ? "checked" : ""}>
          <div class="mini-img"><img src="${escape(a.avatarPath)}" alt="" data-agent-img="${escape(a.id)}"></div>
          <div class="mini-info">
            <div class="mini-name">${escape(a.name)}</div>
            <div class="mini-role">${escape(a.roleTag || "Director")}</div>
          </div>
        </label>
      `;
    }).join("");
  }

  function open() {
    if (!overlay) return;
    renderDirectorsGrid();
    refreshReadout();
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setTimeout(() => {
      const ta = modal.querySelector(".topic-input");
      if (ta) ta.focus();
    }, 60);
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (location.hash === "#convene") {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  // Move the slider thumb + label + readout in lockstep with the chosen value.
  function setIntensity(value) {
    if (!["calm", "sharp", "brutal"].includes(value)) return;
    const bar = modal.querySelector(".temp-bar");
    if (!bar) return;
    bar.dataset.intensity = value;
    const ariaIdx = value === "calm" ? 0 : value === "sharp" ? 1 : 2;
    bar.setAttribute("aria-valuenow", String(ariaIdx));
    const thumb = bar.querySelector(".temp-thumb");
    if (thumb) {
      const left = value === "calm" ? "8%" : value === "sharp" ? "50%" : "92%";
      thumb.style.left = left;
    }
    const lbl = modal.querySelector(".intensity-label");
    if (lbl) lbl.textContent = value;
    refreshReadout();
  }

  function refreshReadout() {
    const picked = Array.from(modal.querySelectorAll(".director-mini.picked"));
    const slugs = picked.map((el) => el.dataset.pick);
    const count = slugs.length;

    modal.querySelector(".picked-count").textContent = count;
    modal.querySelector(".lineup-count").textContent = count;

    // Lineup slots: filled per pick + 1 empty if < 4. Resolve each id
    // to the agent's stored avatarPath so custom (data:) avatars render
    // alongside seeded `/avatars/*.svg` ones.
    const lineup = modal.querySelector(".lineup");
    lineup.innerHTML = slugs.map((s) => {
      const src = AVATARS[s] || `avatars/${s}.svg`;
      return `<div class="lineup-slot filled"><img src="${escape(src)}" alt=""></div>`;
    }).join("") + (count < 4 ? `<div class="lineup-slot">+</div>` : "");

    // Roster line
    const roster = modal.querySelector(".readout-roster");
    if (count === 0) {
      roster.innerHTML = "<em>no directors picked yet — pick at least 2.</em>";
    } else {
      roster.innerHTML = slugs.map((s) => `<strong>${NAMES[s] || s}</strong>`).join(", ") + " ready to convene.";
    }

    // Summary
    const mode = modal.querySelector(".mode-chip.active");
    const intensity = modal.querySelector(".temp-bar")?.dataset.intensity || "sharp";
    const summary = modal.querySelector(".readout-summary");
    summary.textContent = `${count} director${count === 1 ? "" : "s"} · ${mode ? mode.dataset.mode : "constructive"} · ${intensity}`;

    // CTA disabled if < 2
    const cta = modal.querySelector("#convene-go");
    if (count < 2) {
      cta.style.opacity = "0.45";
      cta.style.pointerEvents = "none";
    } else {
      cta.style.opacity = "";
      cta.style.pointerEvents = "";
    }
  }

  function init() {
    if (document.getElementById("convene-overlay")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = MODAL_HTML.trim();
    document.body.appendChild(wrap.firstChild);

    overlay = document.getElementById("convene-overlay");
    modal = overlay.querySelector(".convene-modal");

    // Close interactions
    overlay.querySelector(".close-btn").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("open")) close();
    });

    // Triggers anywhere on the page
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-convene-trigger]");
      if (t) {
        e.preventDefault();
        open();
      }
    });

    // Picker behavior. Capture phase so we beat the document-level
    // agent-detail listener. Two zones inside each director-mini
    // <label>:
    //   • avatar (.mini-img) → open agent detail overlay (suppress
    //     the implicit checkbox toggle a label-click would trigger)
    //   • everywhere else → let the <label>+<input checkbox> handle
    //     the toggle natively; we just mirror the state to .picked
    //     and refresh the readout.
    modal.addEventListener("click", (e) => {
      // Avatar inside a director-mini opens the agent overlay rather
      // than toggling the pick. Block the implicit label→checkbox
      // path so the click is consumed by the overlay open instead.
      const avImg = e.target.closest("[data-agent-img]");
      if (avImg) {
        e.preventDefault();
        e.stopPropagation();
        const slug = avImg.getAttribute("data-agent-img");
        if (typeof window.openAgentOverlay === "function" && slug) {
          window.openAgentOverlay(slug);
        }
        return;
      }
      // ⓘ on a tone tile · opens a popover with the full description.
      // Captured BEFORE the mode-chip handler so clicking the icon
      // doesn't also flip the active selection.
      const infoBtn = e.target.closest("[data-mode-info]");
      if (infoBtn) {
        e.preventDefault();
        e.stopPropagation();
        openTonePopover(infoBtn);
        return;
      }
      const mc = e.target.closest(".mode-chip");
      if (mc) {
        e.preventDefault();
        e.stopPropagation();
        modal.querySelectorAll(".mode-chip").forEach((c) => c.classList.remove("active"));
        mc.classList.add("active");
        refreshReadout();
        return;
      }
      // Intensity slider · click handled by pointer events (below) so the
      // drag preview can begin on the same gesture. Capture-phase clicks
      // here are now a no-op for the bar.
      if (e.target.closest(".temp-bar")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Or pick from the labels under the bar.
      const ip = e.target.closest("[data-intensity-pick]");
      if (ip) {
        e.preventDefault();
        e.stopPropagation();
        setIntensity(ip.dataset.intensityPick);
        return;
      }
    }, true);

    // Director checkbox · mirror checked state into .picked so the
    // CSS treatment + readout pick up the toggle. The label+checkbox
    // pair handles the actual state toggling natively.
    modal.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-director-check]");
      if (!cb) return;
      const card = cb.closest(".director-mini");
      if (!card) return;
      card.classList.toggle("picked", cb.checked);
      refreshReadout();
    });

    // Pointer-driven drag for the intensity slider — pointerdown begins
    // tracking, pointermove snaps to the nearest third in real time, and
    // pointerup commits. Works with mouse + touch + stylus.
    const bar = modal.querySelector(".temp-bar");
    if (bar) {
      const valueAt = (clientX) => {
        const rect = bar.getBoundingClientRect();
        if (rect.width <= 0) return "sharp";
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return ratio < 0.33 ? "calm" : ratio < 0.67 ? "sharp" : "brutal";
      };
      bar.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        bar.setPointerCapture(e.pointerId);
        bar.dataset.dragging = "1";
        setIntensity(valueAt(e.clientX));
      });
      bar.addEventListener("pointermove", (e) => {
        if (bar.dataset.dragging !== "1") return;
        setIntensity(valueAt(e.clientX));
      });
      const end = (e) => {
        if (bar.dataset.dragging !== "1") return;
        bar.dataset.dragging = "0";
        try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      bar.addEventListener("pointerup", end);
      bar.addEventListener("pointercancel", end);
    }

    // Re-enter the same outer click capture so the existing handler chain
    // continues to work for the rest of the document.
    modal.addEventListener("click", (e) => {
      const sg = e.target.closest(".suggest-chip");
      if (sg) {
        e.preventDefault();
        e.stopPropagation();
        modal.querySelector(".topic-input").focus();
        return;
      }
      if (e.target.closest("#convene-go")) {
        e.preventDefault();
        e.stopPropagation();

        const picked = Array.from(modal.querySelectorAll(".director-mini.picked"))
          .map((el) => el.dataset.pick);
        if (picked.length < 2) return;

        const ta = modal.querySelector(".topic-input");
        const subject = (ta && ta.value || "").trim();
        if (!subject) {
          alert("Type a question or topic first — the room needs something to chew on.");
          if (ta) ta.focus();
          return;
        }

        const modeEl = modal.querySelector(".mode-chip.active");
        const mode = modeEl ? (modeEl.dataset.mode || "constructive") : "constructive";

        const intensity = modal.querySelector(".temp-bar")?.dataset.intensity || "sharp";

        if (!window.app || typeof window.app.createRoom !== "function") {
          alert("App not ready — refresh and try again.");
          return;
        }

        const cta = e.target.closest("#convene-go");
        const orig = cta.textContent;
        cta.textContent = "convening…";
        cta.style.pointerEvents = "none";

        // briefStyle is not configurable from the UI — the room files a
        // single standard report format on adjourn. The server still
        // accepts a style param for backwards compat, but we never send
        // one; it defaults to the standard layout.
        window.app
          .createRoom({ subject, agentIds: picked, mode, intensity })
          .then(() => {
            close();
          })
          .catch((err) => {
            alert("Couldn't convene: " + (err && err.message ? err.message : err));
            cta.textContent = orig;
            cta.style.pointerEvents = "";
          });
      }
    }, true);

    // Char counter
    const ta = modal.querySelector(".topic-input");
    const cc = modal.querySelector(".char-count");
    ta.addEventListener("input", () => {
      cc.textContent = ta.value.length;
    });

    // Initial state
    refreshReadout();

    // Auto-open via hash
    if (location.hash === "#convene") {
      open();
    }
    window.addEventListener("hashchange", () => {
      if (location.hash === "#convene" && !overlay.classList.contains("open")) open();
    });
  }

  // Public API
  window.openConveneOverlay = function () { if (!overlay) init(); open(); };
  window.closeConveneOverlay = close;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
