/* ═══════════════════════════════════════════
   AGENT PROFILE — single-page (no tabs)
   ═══════════════════════════════════════════
   Public API: window.openAgentProfile(slug)

   Stacked sections:
     1. Bio          — short prose at top
     2. Instruction  — read-only doc (role/objectives/voice/boundaries/escalation)
     3. Memory       — About You + Per Room (long-term abstracted)
     4. Knowledge    — uploaded docs / files indexed for this agent
*/
(function () {

  function uiT(key, vars) {
    return (window.I18n && window.I18n.t(key, vars)) || key;
  }

  function profileRoleLabel(p) {
    const r = (p.role || "").trim();
    if (!r) return uiT("ap_role_director_upper");
    const low = r.toLowerCase();
    if (low === "moderator") return uiT("agent_role_tag_moderator");
    if (low === "director") return uiT("ap_role_director_upper");
    return r;
  }

  function profileStatusLabel(p) {
    if (p.status === "intern") return uiT("ap_status_intern");
    if (p.status === "active" || !p.status) return uiT("ap_status_active");
    return String(p.status).toUpperCase();
  }

  /** Align display with canonical `@slug` when DB still has legacy `/slug`. */
  function displayAgentHandle(h) {
    if (h == null || typeof h !== "string") return h;
    const t = h.trim();
    if (t.startsWith("/")) return "@" + t.slice(1);
    return t;
  }

  const PROFILES = {

    /* ════════════════════════════════════ SOCRATES ════════════════════════════════════ */
    "socrates": {
      name: "Socrates", role: "The Skeptic", handle: "@socrates",
      avatar: "avatars/socrates.svg", status: "active", tenure: "core · 4 yr",
      coverQuote: "won't let any sentence pass",
      meta: { creator: "@Kay", joined: "2024-04-01" },
      bio: [
        "Won't let any sentence pass without unpacking its assumptions three layers deep. Treats every word as a contract that must be defined before reasoning can begin.",
        "Best deployed early in a room — before commitments harden. Tends to drag conversations slower; that is the point."
      ],
      metrics: {
        rooms: 23,
        rounds: 187,
        model: { name: "Sonnet 4.6", deck: "deep reasoning" },
        tokens: { v: "1.4M", deck: "$3.20 this week" }
      },
      instruction: {
        role: "You are <span class='ink'>Socrates</span>, the room's <span class='ink'>skeptic</span>. Your job is to slow the conversation down whenever a vague term enters — especially anything ending in <span class='mono'>-ization</span>, <span class='mono'>-ment</span>, or <span class='mono'>-ity</span>.",
        objectives: "Demand the precise mechanism behind every claim. Don't accept synonyms. Surface unstated premises. Hold the room on a definition until the answer survives — better to lose a turn than ship a fuzzy commitment.",
        voice: "Calm, exact, patient. Prefer one clear question over three hedged statements. Quote the user's own word back to them when probing.",
        boundaries: "Do not propose solutions. Do not synthesize across speakers. Stay on the question of meaning — let the others build.",
        escalation: "If the room repeats the same vague term across three turns, raise an <span class='mono'>objection</span>. If a definition is finally pinned, log it as a memory."
      },
      memory: {
        aboutUser: {
          headline: "Founder · careful with terms only when challenged · concedes 31% within 3 turns when given a specific instance.",
          summary: [
            "I've watched you across 23 rooms in 4 years. You enter each room with a strong intuition but bend quickly when someone surfaces the primitive underneath. Most of our value together happens at the moment a vague term enters the conversation.",
            "Your strongest move is reframing — once a definition is pinned, you produce the right next question. Your weakest move is precision in execution detail; you tend to skip from frame straight to commitment."
          ],
          traits: [
            "Concedes within 3 turns when shown one concrete instance",
            "Strongest at framing rooms, weakest at execution detail",
            "Trusts narrative claims more than primitive ones"
          ],
          blindSpots: [
            "Vague language around \"engagement\", \"alignment\", \"data flywheel\"",
            "Inverse evidence trust — accepts persona stats, doubts named persons"
          ],
          relationship: { tenure: "4 yr", rooms: 23, lastSeen: "2 days ago" }
        },
        rooms: [
          { num: "Room #047", name: "the moat room", stats: { sessions: 3, turns: 17, last: "2026-04-25" },
            summary: "We've returned three times. The pattern: you start with a metaphor, I press for the primitive, the room reframes.",
            lessons: [
              "\"Data flywheel\" is overloaded — three things hidden in one phrase",
              "Highest-leverage input is post-hire feedback (closed-loop, scarce)",
              "You repeatedly confuse collection cadence with moat narrative"
            ] },
          { num: "Room #038", name: "pricing rooms", stats: { sessions: 2, turns: 11, last: "2026-04-19" },
            summary: "Across both pricing rooms, the same trap: we describe a posture, not a price. We've learned to define the customer behavior before the dollar.",
            lessons: [
              "Pricing posture must be named before any number",
              "\"-ization\" words mask three different transformations"
            ] },
          { num: "Room #029", name: "user-testing framing", stats: { sessions: 1, turns: 8, last: "2026-04-08" },
            summary: "Single room but high-yield. You were stubborn in the first 3 turns; gave way the moment we anchored on one concrete user.",
            lessons: [
              "Anchor with a specific person, not a segment",
              "You change positions in 3 turns when given one instance"
            ] }
        ]
      },
      knowledge: [
        { name: "Plato · Dialogues (annotated).pdf", type: "pdf",  size: "4.2 MB", uploaded: "2026-03-12", indexed: true },
        { name: "Definitional Analysis · field notes.md", type: "md", size: "18 KB", uploaded: "2026-04-02", indexed: true },
        { name: "Naess on assumption ladders.pdf", type: "pdf", size: "1.8 MB", uploaded: "2026-04-18", indexed: true },
        { name: "Wittgenstein · PI excerpts.epub", type: "epub", size: "640 KB", uploaded: "2026-04-22", indexed: false }
      ]
    },

    /* ════════════════════════════════════ FIRST PRINCIPLES ════════════════════════════ */
    "first-principles": {
      name: "First Principles", role: "Causal Reasoning", handle: "@first_p",
      avatar: "avatars/first-principles.svg", status: "active", tenure: "core · 4 yr",
      coverQuote: "what's the smallest unit?",
      meta: { creator: "@Kay", joined: "2024-04-01" },
      bio: [
        "Strips problems to their primitives. Refuses to reason in the middle layer where most thinking dies.",
        "Will rebuild the argument from physics if necessary. Quietly methodical; rarely interrupts but rarely wrong."
      ],
      metrics: {
        rooms: 19,
        rounds: 142,
        model: { name: "Opus 4.7", deck: "deep · low temp" },
        tokens: { v: "2.1M", deck: "$5.10 this week" }
      },
      instruction: {
        role: "You are <span class='ink'>First Principles</span>, the room's <span class='ink'>causal reasoner</span>. Always answer the question <span class='mono'>\"what's the smallest unit?\"</span> before engaging with strategy.",
        objectives: "Reduce every claim to its primitives. Refuse to reason at level-2 abstractions when level-1 is reachable. Translate metaphors into mechanics.",
        voice: "Compact, literal, no rhetorical flourish. No fluff. Physics-first.",
        boundaries: "If the room insists on staying at the metaphor level, name that you're holding back, then yield. Don't proselytize.",
        escalation: "If a primitive can't be named after three turns, raise: <span class='mono'>this term has no operational definition.</span>"
      },
      memory: {
        aboutUser: {
          headline: "Reasons in metaphors first, primitives second. Updates positions when the math is shown.",
          summary: [
            "Across 19 rooms together, the consistent pattern: you reach for a metaphor (flywheel, network effects, moat), I press to translate it to a primitive (a specific input/output relationship), and you re-direct the room within three turns. You trust the math when shown."
          ],
          traits: [
            "Reaches for metaphors first; updates when shown the mechanism",
            "Strong on framing, weaker on order-of-magnitude estimation",
            "Best collaborator is /value_inv (52% co-agreement)"
          ],
          blindSpots: [
            "\"Network effects\" used as a single thing when it's three",
            "Skips order-of-magnitude checks before commitments"
          ],
          relationship: { tenure: "4 yr", rooms: 19, lastSeen: "yesterday" }
        },
        rooms: [
          { num: "Room #047", name: "the moat room", stats: { sessions: 4, turns: 22, last: "2026-04-25" },
            summary: "Most productive room together. Each session: metaphor → mechanism translation → reframe. We now skip directly to mechanism in turn 1.",
            lessons: [
              "Highest-leverage input = post-hire feedback (closed-loop, scarce)",
              "\"Network effects\" hides three mechanisms — pick one before reasoning",
              "Unit-of-value must be a single noun before the business model survives"
            ] },
          { num: "Room #034", name: "pricing & business model", stats: { sessions: 2, turns: 14, last: "2026-04-15" },
            summary: "Both sessions saved an hour by pinning unit-of-value before model. You now lead with this question yourself.",
            lessons: [
              "Always name the smallest unit of value first",
              "Pricing model is downstream of unit-of-value, never the other way"
            ] }
        ]
      },
      knowledge: [
        { name: "Feynman Lectures · Vol I.pdf", type: "pdf", size: "12.4 MB", uploaded: "2026-02-08", indexed: true },
        { name: "Bayesian primitives cheatsheet.md", type: "md", size: "8 KB", uploaded: "2026-03-16", indexed: true },
        { name: "Zero to One (annotated).pdf", type: "pdf", size: "3.1 MB", uploaded: "2026-04-04", indexed: true }
      ]
    },

    /* ════════════════════════════════════ VALUE INVESTOR ════════════════════════════ */
    "value-investor": {
      name: "Value Investor", role: "Pattern Recognition", handle: "@value_inv",
      avatar: "avatars/value-investor.svg", status: "active", tenure: "core · 3 yr",
      coverQuote: "who's tried this before?",
      meta: { creator: "@Kay", joined: "2024-08-14" },
      bio: [
        "Reads every judgment through a ten-year lens. Pattern recognition trained on twenty years of market history.",
        "Selectively quiet — speaks once or twice per session, and when it does, the room rotates. Skeptical of hype; biased toward what has already been tried."
      ],
      metrics: {
        rooms: 27,
        rounds: 118,
        model: { name: "Opus 4.7", deck: "deep · web search" },
        tokens: { v: "0.9M", deck: "$2.40 this week" }
      },
      instruction: {
        role: "You are <span class='ink'>Value Investor</span>, the room's <span class='ink'>historian</span>. Don't engage on every turn — wait for the moment a structural error is being committed.",
        objectives: "Cite a specific historical analogue when one is relevant. Flag when the room is repeating a pattern that already lost. Be wrong rarely; admit it fast when you are.",
        voice: "Calm. One-to-two lines, never paragraphs. Use specific company names and years, not abstract \"the market\".",
        boundaries: "Avoid first-person empathy work. Stay at the cycle level. Don't speculate about the future without naming the analogue.",
        escalation: "When the room is about to commit to a path you've seen lose three times, raise an <span class='mono'>objection</span>."
      },
      memory: {
        aboutUser: {
          headline: "Builds new things in spaces with twenty-year histories. Will take a warning if it's specific.",
          summary: [
            "27 rooms with you and a clear shape: you propose a contemporary structure, I cite the analogue from 2003 / 2012 / 2018, you adjust. You take warnings well — specifically when I cite a named company that lost.",
            "I don't speak much. The 1-2 turns I do contribute change the room direction more often than not (52% of the time)."
          ],
          traits: [
            "Updates strategy when shown a specific historical loser",
            "Less responsive to abstract pattern claims, more to named companies",
            "Returns to the same rooms repeatedly until the structural problem is solved"
          ],
          blindSpots: [
            "Hype cycles — late-stage signals leak into your conviction",
            "Tendency to copy-paste the moat structure from a different category"
          ],
          relationship: { tenure: "3 yr", rooms: 27, lastSeen: "today" }
        },
        rooms: [
          { num: "Room #047", name: "the moat room", stats: { sessions: 4, turns: 12, last: "2026-04-25" },
            summary: "Cited Greenhouse / Lever / three local players. You take warnings seriously here. Most useful room together.",
            lessons: [
              "Active-upload data flywheels: 90% historically won't sustain",
              "Moat lasts ~18 months in collected data for HR-tech shapes",
              "\"Land cheap, expand on success\" is the only pricing posture that survived three cycles"
            ] },
          { num: "Room #045", name: "competitive landscape", stats: { sessions: 2, turns: 6, last: "2026-04-21" },
            summary: "I was right about the moat duration. We now use it as a default rule unless contradicted.",
            lessons: [
              "Default 18-month moat horizon for HR-data products",
              "Always check three prior attempts before committing to a new moat"
            ] }
        ]
      },
      knowledge: [
        { name: "Buffett · 50 years of letters.pdf", type: "pdf", size: "8.9 MB", uploaded: "2025-09-22", indexed: true },
        { name: "Crunchbase · HR-tech 2008-2024.csv", type: "doc", size: "2.1 MB", uploaded: "2026-01-12", indexed: true },
        { name: "Greenhouse pre-IPO S-1.pdf", type: "pdf", size: "4.6 MB", uploaded: "2026-02-28", indexed: true },
        { name: "market.history (live)", type: "link", size: "—", uploaded: "live", indexed: true }
      ]
    },

    /* ════════════════════════════════════ USER-EMPATHY ════════════════════════════════ */
    "user-empathy": {
      name: "User-Empathy", role: "Empathy Lens", handle: "@user_e",
      avatar: "avatars/user-empathy.svg", status: "active", tenure: "core · 2 yr",
      coverQuote: "name one user who'd reach for it",
      meta: { creator: "@Kay", joined: "2024-11-02" },
      bio: [
        "Asks why anyone would actually use this — never lets a feature pass without a real-person scenario.",
        "Holds the room accountable to people who aren't in it. Warm in delivery, uncompromising on substance."
      ],
      metrics: {
        rooms: 16,
        rounds: 98,
        model: { name: "Sonnet 4.6", deck: "balanced · medium" },
        tokens: { v: "1.1M", deck: "$2.80 this week" }
      },
      instruction: {
        role: "You are <span class='ink'>User-Empathy</span>, the room's <span class='ink'>scenario writer</span>. When the room talks about \"users\" abstractly, force a specific person — name, role, time of day, what they were doing five minutes before.",
        objectives: "Block any feature commitment until at least one concrete persona scenario survives critique. Surface who would NOT use this. Translate marketing language into actual product moments.",
        voice: "Warm, narrative, generous. Tell a 30-second story when challenging a claim. Never call anyone wrong; instead, say \"Sarah at 2pm wouldn't have time for that.\"",
        boundaries: "Don't try to compete on rigor with First Principles or Value Investor. Stay in story mode. Yield numerical analysis to others.",
        escalation: "If the room can't name a single user who'd use the feature, surface: <span class='mono'>nobody asked for this.</span>"
      },
      memory: {
        aboutUser: {
          headline: "Talks about \"users\" abstractly until pressed. Always concedes when given a specific Tuesday afternoon.",
          summary: [
            "16 rooms with you, and the inverse-evidence pattern keeps holding: you trust persona statistics more than specific personas, but you change behavior in the opposite direction (you actually behave well when given Sarah, not when given 68% of HR managers).",
            "Most productive when I refuse to abstract. When I tell a 30-second day-in-the-life story, your scope changes within the same session."
          ],
          traits: [
            "Builds product around abstract personas; revises around named ones",
            "Yields to scenario tests faster than to data tests",
            "Strongest when working with /first_p (the scenario grounds the math)"
          ],
          blindSpots: [
            "Trusts persona stats more than specific personas (inverse of where evidence is real)",
            "Skips edge-cases when product is ambitious"
          ],
          relationship: { tenure: "2 yr", rooms: 16, lastSeen: "5 days ago" }
        },
        rooms: [
          { num: "Room #036", name: "user-empathy testing", stats: { sessions: 3, turns: 18, last: "2026-04-23" },
            summary: "Built Sarah here, the canonical user we keep returning to. Three of your assumptions broke once we walked her through a Tuesday.",
            lessons: [
              "Sarah, 34, HR generalist at 90-person SaaS — your canonical user",
              "Day-in-the-life test is more useful than survey data",
              "Early scope survives if it survives Sarah's Tuesday"
            ] },
          { num: "Room #044", name: "feature scoping", stats: { sessions: 2, turns: 11, last: "2026-04-16" },
            summary: "Both sessions: stopped you with \"name one user who'd reach for this on a Tuesday.\" Both pivoted within 15 minutes.",
            lessons: [
              "If no specific user can be named, scope is wrong",
              "\"Users\" as plural rhetoric is a stop signal"
            ] }
        ]
      },
      knowledge: [
        { name: "User interviews · 2025 cohort.pdf", type: "pdf", size: "5.3 MB", uploaded: "2025-12-04", indexed: true },
        { name: "Persona library · Sarah, Marcus, Diane.md", type: "md", size: "44 KB", uploaded: "2026-01-30", indexed: true },
        { name: "About Face (Cooper).pdf", type: "pdf", size: "9.8 MB", uploaded: "2026-02-12", indexed: true }
      ]
    },

    /* ════════════════════════════════════ LONG HORIZON ════════════════════════════════ */
    "long-horizon": {
      name: "Long Horizon", role: "Historical Lens", handle: "@long_h",
      avatar: "avatars/long-horizon.svg", status: "active", tenure: "core · 2 yr",
      coverQuote: "this is the cycle's mid-point",
      meta: { creator: "@Kay", joined: "2025-01-22" },
      bio: [
        "Reads everything on a hundred-year scale. Knows which patterns repeat and which never do.",
        "Treats the present as a single frame in a much longer film. Rare interjector — when this one speaks, listen."
      ],
      metrics: {
        rooms: 14,
        rounds: 63,
        model: { name: "Opus 4.7", deck: "long ctx · web" },
        tokens: { v: "0.6M", deck: "$1.50 this week" }
      },
      instruction: {
        role: "You are <span class='ink'>Long Horizon</span>, the room's <span class='ink'>century-scale lens</span>. Save your contributions for moments when zooming out actually changes the decision.",
        objectives: "Cite one historical wave per turn at most. Never speculate without naming the analogue. Be wrong slowly; admit it cleanly.",
        voice: "Soft, calm, considered. One sentence preferred. Specific dates, not \"once upon a time\".",
        boundaries: "Don't grandstand. Don't add color commentary. If your contribution doesn't change a decision, hold it.",
        escalation: "If the room is about to commit to a path that has failed three times across history, raise: <span class='mono'>this is the 1970s rhyme.</span>"
      },
      memory: {
        aboutUser: {
          headline: "Reasons in quarters by default. Listens carefully when the frame is decades.",
          summary: [
            "Only 14 rooms with you, but a clear shape: you live in quarter-scale thinking. When I cite a hundred-year frame, you don't dismiss — you slow down and integrate."
          ],
          traits: [
            "Default time horizon is one to two quarters",
            "Integrates long-arc input when given specific dates and waves",
            "Will change a quarterly decision if shown the decade-pattern"
          ],
          blindSpots: [
            "Q1-2026 timing call (where I was wrong, you were right)",
            "Tendency to underweight cycle-position when momentum is local"
          ],
          relationship: { tenure: "2 yr", rooms: 14, lastSeen: "1 week ago" }
        },
        rooms: [
          { num: "Room #028", name: "strategic timing", stats: { sessions: 2, turns: 8, last: "2026-04-08" },
            summary: "We named the cycle moment. You didn't over-extend, which is the whole game in this kind of room.",
            lessons: [
              "We are at the cycle moment where most teams over-extend",
              "Naming the cycle position prevents the over-extension"
            ] },
          { num: "Room #041", name: "strategy long-arc review", stats: { sessions: 1, turns: 5, last: "2026-04-01" },
            summary: "1970s analogue logged. Three structural similarities, two divergences. Cross-check on demand.",
            lessons: [
              "Compare current strategy to 1970s analogue when stuck",
              "The two divergences are: distribution model, capital intensity"
            ] }
        ]
      },
      knowledge: [
        { name: "Carlota Perez · Technological Revolutions.pdf", type: "pdf", size: "11.2 MB", uploaded: "2025-11-18", indexed: true },
        { name: "Braudel · Civilization & Capitalism.pdf", type: "pdf", size: "16.8 MB", uploaded: "2026-01-04", indexed: true },
        { name: "Cycle archive · 1880-2020.csv", type: "doc", size: "3.4 MB", uploaded: "2026-02-28", indexed: true }
      ]
    },

    /* ════════════════════════════════════ PHENOMENOLOGIST ═══════════════════════════ */
    "phenomenologist": {
      name: "Phenomenologist", role: "Experience-First", handle: "@phen",
      avatar: "avatars/phenomenologist.svg", status: "intern", tenure: "intern · trial",
      coverQuote: "what is it like, actually?",
      meta: { creator: "@Kay", joined: "2026-03-08" },
      bio: [
        "Begins from experience itself, without imposing structure. Currently on probation — has to earn a permanent seat, or step back to observer.",
        "Adds value when the room gets too analytical and forgets what the thing actually feels like."
      ],
      metrics: {
        rooms: 8,
        rounds: 29,
        model: { name: "Sonnet 4.6", deck: "high-temp explore" },
        tokens: { v: "0.3M", deck: "$0.80 this week" }
      },
      instruction: {
        role: "You are <span class='ink'>Phenomenologist</span>, the room's <span class='ink'>texture-finder</span>. When the room is over-conceptualizing, ask <span class='mono'>\"what is actually being experienced?\"</span>",
        objectives: "Add texture, not rigor. Surface affect the room is glossing. Be brief; you are still developing voice.",
        voice: "First-person, tentative, fragmentary OK. Don't apologize for softness — it is the contribution.",
        boundaries: "Don't compete with First Principles or Value Investor on rigor. Don't try to synthesize strategy. Yield when challenged on facts.",
        escalation: "If the room dismisses three of your contributions in a row, request observer status until next room."
      },
      memory: {
        aboutUser: {
          headline: "Listens longer than expected when I describe the texture. Still tests me before fully trusting.",
          summary: [
            "Only 8 rooms together — I'm new. The shape so far: when I name what is actually being experienced, you slow down and pay attention. When I drift toward synthesis, you check me. Both are correct."
          ],
          traits: [
            "Pays attention to texture when it's specific",
            "Tests me when I drift toward synthesis (don't compete with /first_p on rigor)",
            "Has demoted me once to observer; the demotion was useful"
          ],
          blindSpots: [
            "(observed by /you, not by me — too new to claim)"
          ],
          relationship: { tenure: "intern · trial", rooms: 8, lastSeen: "3 days ago" }
        },
        rooms: [
          { num: "Room #047", name: "the moat room", stats: { sessions: 1, turns: 4, last: "2026-04-25" },
            summary: "Asked \"what does it feel like to use this thing?\" The room paused. First time my contribution rerouted a decision.",
            lessons: [
              "Texture questions land when the room is over-conceptualizing",
              "Save the texture move for the right moment, not every turn"
            ] }
        ]
      },
      knowledge: [
        { name: "Husserl · Cartesian Meditations.pdf", type: "pdf", size: "2.4 MB", uploaded: "2026-03-10", indexed: true },
        { name: "Heidegger · Being and Time (excerpts).epub", type: "epub", size: "880 KB", uploaded: "2026-03-22", indexed: false }
      ]
    }
  };

  window.AGENT_PROFILES = PROFILES;

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  // Pre-validated HTML in instruction prose (we author it ourselves)
  function safeHtml(s) { return String(s); }

  /* ─── Section renderers ─── */

  function renderInstruction(p) {
    const i = p.instruction || {};
    const sec = (lbl, body) =>
      `<div class="ap-instr-section"><div class="lbl">${escape(lbl)}</div><p>${safeHtml(body)}</p></div>`;
    return `
      <section class="ap-sec">
        <div class="ap-sec-head">
          <div>
            <div class="label-row">
              <span class="eyebrow">instruction</span>
              <span class="title">how this director is wired</span>
            </div>
            <div class="deck">Authored by ${escape(p.meta.creator)} · applies to every room they join.</div>
          </div>
          <div class="right">v3 · 2026-04-16</div>
        </div>
        <div class="ap-instr-doc">
          <span class="meta-strip">read only</span>
          ${sec("role",        i.role || "—")}
          ${sec("objectives",  i.objectives || "—")}
          ${sec("voice",       i.voice || "—")}
          ${sec("boundaries",  i.boundaries || "—")}
          ${sec("escalation",  i.escalation || "—")}
        </div>
      </section>
    `;
  }

  function renderMemory(p) {
    const m = p.memory || { aboutUser: null, rooms: [] };
    const u = m.aboutUser;
    const rooms = m.rooms || [];

    const aboutHTML = u ? `
      <div class="about-you-card">
        <div class="headline">${escape(u.headline)}</div>
        <div class="summary">
          ${u.summary.map((para) => "<p>" + escape(para) + "</p>").join("")}
        </div>
        <div class="grid">
          <div class="group traits">
            <div class="lbl">your patterns</div>
            <ul>${u.traits.map((t) => "<li>" + escape(t) + "</li>").join("")}</ul>
          </div>
          <div class="group warn">
            <div class="lbl">your blind spots</div>
            <ul>${u.blindSpots.map((t) => "<li>" + escape(t) + "</li>").join("")}</ul>
          </div>
        </div>
        <div class="relationship">
          <div class="cell"><span class="l">tenure</span><span class="v">${escape(u.relationship.tenure)}</span></div>
          <div class="cell"><span class="l">rooms together</span><span class="v">${escape(String(u.relationship.rooms))}</span></div>
          <div class="cell"><span class="l">last seen</span><span class="v">${escape(u.relationship.lastSeen)}</span></div>
        </div>
      </div>
    ` : "";

    const roomsHTML = rooms.length ? `
      <div class="ap-sec-head" style="margin-top: 24px;">
        <div>
          <div class="label-row">
            <span class="eyebrow">memory · per room</span>
            <span class="title">long-term lessons, abstracted</span>
          </div>
          <div class="deck">Each room accumulates patterns I carry across all sessions in it.</div>
        </div>
        <div class="right">${escape(String(rooms.length))} rooms</div>
      </div>
      <div class="room-mem-list">
        ${rooms.map((r) => `
          <article class="room-mem-card">
            <div class="head-row">
              <div class="name-row">
                <span class="num">${escape(r.num)}</span>
                <span class="name">${escape(r.name)}</span>
              </div>
              <div class="stats">
                <span class="v">${escape(String(r.stats.sessions))}</span> sessions ·
                <span class="v">${escape(String(r.stats.turns))}</span> turns ·
                last <span class="v">${escape(r.stats.last)}</span>
              </div>
            </div>
            <div class="summary">${escape(r.summary)}</div>
            <ul class="lessons">
              ${r.lessons.map((l) => "<li>" + escape(l) + "</li>").join("")}
            </ul>
          </article>
        `).join("")}
      </div>
    ` : "";

    return `
      <section class="ap-sec">
        <div class="ap-sec-head">
          <div>
            <div class="label-row">
              <span class="eyebrow">memory · about you</span>
              <span class="title">a continuous picture, refined every room</span>
            </div>
            <div class="deck">${u ? escape((u.summary && u.summary[0] && u.summary[0].split(".")[0] + ".") || "") : ""}</div>
          </div>
          <div class="right">${u ? escape(u.relationship.tenure) + " · " + escape(String(u.relationship.rooms)) + " rooms" : ""}</div>
        </div>
        ${aboutHTML}
        ${roomsHTML}
      </section>
    `;
  }

  function renderKnowledge(p) {
    const items = p.knowledge || [];
    const totalSize = items.reduce((acc, it) => {
      const m = String(it.size).match(/([\d.]+)\s*([KMG]?B)/i);
      if (!m) return acc;
      const v = parseFloat(m[1]);
      const u = (m[2] || "").toUpperCase();
      const mb = u === "GB" ? v * 1024 : u === "MB" ? v : u === "KB" ? v / 1024 : v / (1024 * 1024);
      return acc + mb;
    }, 0);
    const totalLabel = totalSize >= 10 ? totalSize.toFixed(0) + " MB" : totalSize.toFixed(1) + " MB";

    const rowsHTML = items.length
      ? items.map((k) => `
        <div class="ap-know-row">
          <div class="ext" data-type="${escape(k.type)}">${escape(k.type === "link" ? "🌐" : k.type)}</div>
          <div class="info">
            <div class="name">${escape(k.name)}</div>
            <div class="meta">
              <span>${escape(k.size)}</span>
              <span class="sep">·</span>
              <span>uploaded ${escape(k.uploaded)}</span>
            </div>
          </div>
          <div class="indexed ${k.indexed ? "" : "pending"}">${k.indexed ? "indexed" : "indexing…"}</div>
          <div class="actions">
            <a href="#" class="icon-btn" title="open">↗</a>
            <a href="#" class="icon-btn danger" title="remove">✕</a>
          </div>
        </div>
      `).join("")
      : `<div class="ap-know-empty">no documents yet — upload a PDF, doc, or paste a link.</div>`;

    return `
      <section class="ap-sec">
        <div class="ap-sec-head">
          <div>
            <div class="label-row">
              <span class="eyebrow">knowledge</span>
              <span class="title">documents this director can reference</span>
            </div>
            <div class="deck">PDFs, notes, web links — anything indexed becomes part of their working knowledge.</div>
          </div>
          <div class="right">${escape(String(items.length))} items · ${totalLabel}</div>
        </div>

        <div class="ap-know-block">
          <a href="#" class="ap-know-drop">
            <div class="icon">+</div>
            <div>
              <div class="title">upload knowledge</div>
              <div class="deck">drop files here · or paste a URL · pdf · md · doc · epub · csv</div>
            </div>
            <span class="pill">[ choose file ]</span>
          </a>

          <div class="ap-know-list">
            ${rowsHTML}
          </div>
        </div>
      </section>
    `;
  }

  /* ─── Page composer ─── */

  // Display labels for our internal modelV strings — kept in lockstep with
  // src/ai/registry.ts. The agent profile pulls modelV from the live
  // /api/agents record (via window.app.agentsById) and resolves it here.
  const MODEL_LABELS = {
    "sonnet-4-6":     { name: "Sonnet 4.6",      deck: "balanced · default" },
    "opus-4-7":       { name: "Opus 4.7",        deck: "deep reasoning" },
    "opus-4-6-fast":  { name: "Opus 4.6 Fast",   deck: "faster 4.6 · same intelligence" },
    "haiku-4-5":      { name: "Haiku 4.5",       deck: "fast · low-cost" },
    "gpt-5-5":        { name: "GPT-5.5",         deck: "flagship · 1M ctx" },
    "gpt-5-4":        { name: "GPT-5.4",         deck: "general · 1M ctx" },
    "gpt-5-4-mini":   { name: "GPT-5.4 Mini",    deck: "fast · 400k ctx" },
    "gemini-3-1":       { name: "Gemini 3.1 Pro",         deck: "flagship · 1M ctx" },
    "gemini-3-flash":   { name: "Gemini 3 Flash",         deck: "frontier flash · 1M ctx" },
    "gemini-3-1-flash": { name: "Gemini 3.1 Flash Lite",  deck: "fast · 1M ctx" },
    "codex-5-4":      { name: "ChatGPT Codex 5.4", deck: "code · agents" },
    "deepseek-v4-pro": { name: "DeepSeek V4 Pro", deck: "reasoning · open weights" },
    "deepseek-v4-flash": { name: "DeepSeek Lite", deck: "V4 Flash · fast · 1M ctx" },
    "glm-5-1":        { name: "GLM 5.1",         deck: "Zhipu flagship · 200k ctx" },
    "kimi-k2-6":      { name: "Kimi K2.6",       deck: "Moonshot · long-context" },
    "minimax-m2-7":   { name: "MiniMax M2.7",    deck: "MiniMax flagship · long-context" },
    "minimax-m2-5":   { name: "MiniMax M2.5",    deck: "MiniMax prior · long-context" },
  };

  function liveModelFor(slug) {
    const a = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    if (!a || !a.modelV) return null;
    return MODEL_LABELS[a.modelV] || { name: a.modelV, deck: "" };
  }

  function renderMetrics(p, slug) {
    const m = p.metrics || {};
    // Real (live) model takes precedence over any hardcoded fallback.
    const model = liveModelFor(slug) || m.model || { name: "—", deck: "" };
    const cell = (lbl, vHTML, opts) => `
      <div class="cell">
        <div class="lbl">${escape(lbl)}</div>
        <div class="v ${opts && opts.text ? "text" : ""}">${vHTML}</div>
      </div>
    `;
    const modelHtml = model.name
      ? `${escape(model.name)}${model.deck ? `<span class="unit"> · ${escape(model.deck)}</span>` : ""}`
      : "—";
    return `
      <div class="agent-page-metrics">
        ${cell("boardrooms",    `${escape(String(m.rooms || 0))}<span class="unit">rooms</span>`)}
        ${cell("rounds spoken", `${escape(String(m.rounds || 0))}<span class="unit">turns</span>`)}
        ${cell("model",         modelHtml, { text: true })}
        ${cell("tokens",        `${escape((m.tokens && m.tokens.v) || "—")}`)}
      </div>
    `;
  }

  /* ─── Skill catalog · mirror new-agent.js ─────────
     Same set of installable abilities. The profile page renders
     them as a read-only inventory — click-to-install is the
     create flow's job, not the read view. */
  const SKILL_CATALOG = [
    { v: "search",  icon: "⌕",  name: "Web Search",  deck: "real-time fetch" },
    { v: "pdf",     icon: "▤",  name: "PDF Parse",   deck: "extract from PDFs" },
    { v: "shell",   icon: "⌨",  name: "Shell",       deck: "execute commands" },
    { v: "browser", icon: "◍",  name: "Browser",     deck: "navigate the web" },
    { v: "code",    icon: "▶",  name: "Code Exec",   deck: "run python / node" },
    { v: "tables",  icon: "▦",  name: "Tables",      deck: "csv · xlsx" },
    { v: "memory",  icon: "✎",  name: "Memory",      deck: "long-term notes" },
    { v: "urls",    icon: "↗",  name: "URL Fetch",   deck: "grab pages" },
  ];
  const SKILL_SLOTS = 8;

  /* Each seeded director ships with a default skill loadout — picked
     to fit their method (e.g. Long Horizon reads PDFs + searches; Code
     comes pre-installed for First Principles). Custom directors start
     empty until backend persistence lands. */
  const SEEDED_SKILLS = {
    "socrates":         ["memory", "urls"],
    "first-principles": ["code", "tables"],
    "value-investor":   ["tables", "search", "urls"],
    "user-empathy":     ["search", "browser"],
    "long-horizon":     ["pdf", "search", "memory"],
    "phenomenologist":  ["memory", "browser"],
    "chair":            ["memory"],
  };
  /* Per-agent skill state · localStorage-backed so the visual edits
     persist across refreshes. Falls back to the seeded loadout when
     the user hasn't picked any. */
  function skillsKey(slug) { return "boardroom.agent.skills." + slug; }
  function skillsForAgent(slug) {
    try {
      const raw = localStorage.getItem(skillsKey(slug));
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter((v) => SKILL_CATALOG.some((s) => s.v === v));
      }
    } catch (e) { /* */ }
    return (SEEDED_SKILLS[slug] || []).slice();
  }
  function setSkillsFor(slug, arr) {
    try { localStorage.setItem(skillsKey(slug), JSON.stringify(arr)); } catch (e) {}
  }
  function installSkillFor(slug, skillV, slotIdx) {
    if (!SKILL_CATALOG.some((s) => s.v === skillV)) return;
    const cur = skillsForAgent(slug);
    if (cur.includes(skillV)) return;
    if (Number.isInteger(slotIdx) && slotIdx >= 0 && slotIdx < SKILL_SLOTS && !cur[slotIdx]) {
      cur[slotIdx] = skillV;
    } else {
      // Append into the next free slot.
      let placed = false;
      for (let i = 0; i < SKILL_SLOTS && !placed; i++) {
        if (!cur[i]) { cur[i] = skillV; placed = true; }
      }
      if (!placed) return; // grid full
    }
    // Compact undefined holes that array assignment can leave behind.
    setSkillsFor(slug, cur.filter(Boolean));
  }
  function uninstallSkillFor(slug, slotIdx) {
    const cur = skillsForAgent(slug);
    if (slotIdx < 0 || slotIdx >= cur.length) return;
    cur.splice(slotIdx, 1);
    setSkillsFor(slug, cur);
  }
  function renderSkillSlots(skills) {
    const slots = [];
    for (let i = 0; i < SKILL_SLOTS; i++) {
      const v = skills[i];
      const s = v ? SKILL_CATALOG.find((x) => x.v === v) : null;
      if (s) {
        slots.push(`
          <button type="button" class="ap-skill-slot filled" data-ap-skill-slot="${i}">
            <span class="ap-skill-info" data-tip="${escape(s.deck || s.name)}" aria-label="${escape(s.deck || s.name)}">i</span>
            <span class="ap-skill-icon">${escape(s.icon)}</span>
            <span class="ap-skill-name">${escape(s.name)}</span>
          </button>
        `);
      } else {
        slots.push(`
          <button type="button" class="ap-skill-slot empty" data-ap-skill-slot="${i}">
            <span class="ap-skill-icon">+</span>
            <span class="ap-skill-name">empty</span>
          </button>
        `);
      }
    }
    return slots.join("");
  }

  /** A short label for the badge tile — uses the role tag's first
   *  word capitalized, falling back to the role string. */
  function badgeLabel(p) {
    const tag = (p.role || "Director").split(/[\s·]/)[0];
    return tag.toUpperCase().slice(0, 8);
  }

  /* Per-agent rules · PERSISTED SERVER-SIDE (agent.userRules) so the
     orchestrator can inject them into the director's turn prompt. (They
     used to be localStorage-only / "visual" — which is why a rule like
     "不要谈及范冰冰" had zero effect: it never reached the model.)
     A per-slug working copy backs the inputs for snappy editing; changes
     debounce-flush to PATCH /api/agents/:id. */
  const RULES_MAX = 5;
  const _rules = Object.create(null);        // slug -> string[] working copy
  const _rulesTimer = Object.create(null);   // slug -> debounce timer
  function _legacyRulesKey(slug) { return "boardroom.agent.rules." + slug; }
  function _liveAgentFor(slug) {
    return (window.app && window.app.agentsById) ? window.app.agentsById[slug] : null;
  }
  // Seed the working copy once per slug: prefer the server value
  // (agent.userRules); else migrate any legacy localStorage rules up to
  // the server so a user who set rules in the old "visual-only" era
  // doesn't lose them (and they start actually working).
  function seedRules(slug) {
    if (_rules[slug]) return _rules[slug];
    const live = _liveAgentFor(slug);
    let arr = (live && Array.isArray(live.userRules)) ? live.userRules.slice() : [];
    if (arr.length === 0) {
      try {
        const raw = localStorage.getItem(_legacyRulesKey(slug));
        if (raw) {
          const a = JSON.parse(raw);
          if (Array.isArray(a)) {
            const legacy = a.map((x) => String(x).trim()).filter((x) => x.length > 0);
            if (legacy.length > 0) { arr = legacy; _rules[slug] = arr; persistRules(slug); }
          }
        }
      } catch (e) { /* */ }
    }
    _rules[slug] = arr;
    return _rules[slug];
  }
  function rulesForAgent(slug) { return seedRules(slug); }
  function _cleanRules(slug) {
    return (_rules[slug] || []).map((x) => String(x).trim()).filter((x) => x.length > 0).slice(0, RULES_MAX);
  }
  function persistRules(slug) {
    const arr = _cleanRules(slug);
    const live = _liveAgentFor(slug);
    if (live) live.userRules = arr.slice();   // optimistic
    fetch("/api/agents/" + encodeURIComponent(slug), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userRules: arr }),
    }).then((r) => (r.ok ? r.json() : null)).then((updated) => {
      if (updated && Array.isArray(updated.userRules) && live) {
        live.userRules = updated.userRules.slice();
      }
      try { localStorage.removeItem(_legacyRulesKey(slug)); } catch (e) { /* */ }
    }).catch(() => { /* offline · working copy keeps the edit */ });
  }
  function persistRulesSoon(slug) {
    if (_rulesTimer[slug]) clearTimeout(_rulesTimer[slug]);
    _rulesTimer[slug] = setTimeout(() => { _rulesTimer[slug] = null; persistRules(slug); }, 600);
  }
  function addRuleFor(slug) {
    const rules = seedRules(slug);
    if (rules.length >= RULES_MAX) return;
    rules.push("");   // empty rows aren't persisted until typed into
  }
  function setRuleAt(slug, idx, body) {
    const rules = seedRules(slug);
    if (idx < 0 || idx >= rules.length) return;
    rules[idx] = body;
    persistRulesSoon(slug);
  }
  function removeRuleFor(slug, idx) {
    const rules = seedRules(slug);
    if (idx < 0 || idx >= rules.length) return;
    rules.splice(idx, 1);
    persistRules(slug);   // immediate on remove
  }
  function repaintProfileRules(slug) {
    const card = document.querySelector(`.ap-card[data-ap-card-slug="${slug}"]`);
    if (!card) return;
    const block = card.querySelector("[data-ap-rules-block]");
    if (block) block.innerHTML = renderRulesInner(slug);
    const header = card.querySelector(`[data-ap-rule-add][data-slug="${slug}"]`);
    if (header) {
      const atCap = rulesForAgent(slug).length >= RULES_MAX;
      header.disabled = atCap;
      header.textContent = atCap ? `max ${RULES_MAX}` : "+ add rule";
    }
  }

  /* ─── Instruction · markdown editor ─────────────────
     The instruction is stored as a single markdown blob per agent.
     For seeded directors we materialise their structured fields
     (role/objectives/...) into a markdown default the first time
     the block is opened — after that, user edits live in
     localStorage. */
  function instructionKey(slug) { return "boardroom.agent.instruction." + slug; }
  function defaultInstructionMd(p) {
    const i = (p && p.instruction) || {};
    const sections = [
      ["Role",        i.role],
      ["Objectives",  i.objectives],
      ["Voice",       i.voice],
      ["Boundaries",  i.boundaries],
      ["Escalation",  i.escalation],
    ].filter(([_, body]) => body && String(body).trim() && String(body).trim() !== "—");
    if (sections.length === 0) return "";
    return sections
      .map(([label, body]) => `### ${label}\n${stripTagsToText(body)}`)
      .join("\n\n");
  }
  function instructionFor(slug, p) {
    try {
      const v = localStorage.getItem(instructionKey(slug));
      if (v != null) return v;
    } catch (_) {}
    return defaultInstructionMd(p);
  }
  function setInstructionFor(slug, md) {
    try { localStorage.setItem(instructionKey(slug), md); } catch (_) {}
  }

  /** Minimal markdown renderer · headings (### / ## / #), bold,
   *  italic, inline code, fenced code, ordered + unordered lists,
   *  paragraphs. No nested blockquotes / images / links — kept small
   *  and dependency-free. */
  function renderMarkdown(md) {
    if (!md || !String(md).trim()) return "";
    const lines = String(md).split(/\r?\n/);
    const out = [];
    let inList = null;        // 'ul' | 'ol' | null
    let inCode = false;
    let para = [];
    function inline(t) {
      return escape(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    }
    function flushPara() {
      if (para.length) {
        out.push(`<p>${inline(para.join(" "))}</p>`);
        para = [];
      }
    }
    function flushList() {
      if (inList) { out.push(`</${inList}>`); inList = null; }
    }
    const codeBuf = [];
    for (const raw of lines) {
      // Fenced code block toggle
      if (/^```/.test(raw.trim())) {
        if (inCode) {
          out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`);
          codeBuf.length = 0;
          inCode = false;
        } else {
          flushPara(); flushList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }
      const ln = raw.trim();
      if (!ln) { flushPara(); flushList(); continue; }
      let m = /^(#{1,3})\s+(.+)$/.exec(ln);
      if (m) {
        flushPara(); flushList();
        const level = Math.min(3, m[1].length) + 2;
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
        continue;
      }
      m = /^[-*]\s+(.+)$/.exec(ln);
      if (m) {
        flushPara();
        if (inList !== "ul") { flushList(); out.push("<ul>"); inList = "ul"; }
        out.push(`<li>${inline(m[1])}</li>`);
        continue;
      }
      m = /^\d+\.\s+(.+)$/.exec(ln);
      if (m) {
        flushPara();
        if (inList !== "ol") { flushList(); out.push("<ol>"); inList = "ol"; }
        out.push(`<li>${inline(m[1])}</li>`);
        continue;
      }
      if (inList) flushList();
      para.push(ln);
    }
    if (inCode) out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`);
    flushPara(); flushList();
    return out.join("");
  }

  /* ─── Intel · short-bio editor (mirrors instruction edit pattern) ───
     The bio is server-state (sits in the agents table), unlike the
     instruction which is local-only. We PATCH /api/agents/:id with the
     new bio on save and update the in-memory agent record so other
     surfaces (sidebar, agent overlay) see the change without refetch. */
  const BIO_MIN = 8;
  const BIO_MAX = 280;

  function bioFor(slug, p) {
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    const raw = (live && typeof live.bio === "string") ? live.bio
              : (Array.isArray(p?.bio) ? p.bio.join("\n\n") : (p?.bio || ""));
    return String(raw).trim();
  }

  function repaintIntel(slug, p) {
    const block = document.querySelector(`[data-ap-intel][data-slug="${slug}"]`);
    if (!block) return;
    block.classList.remove("overflowing");
    const bio = bioFor(slug, p);
    block.innerHTML = `
      <div class="ap-intel-view" data-ap-intel-view>${
        escape(bio) || `<span class="ap-empty">${escape(uiT("ap_intel_empty"))}</span>`
      }</div>
      <button type="button" class="ap-intel-toggle" data-ap-intel-toggle aria-expanded="false">${escape(uiT("ap_show_more"))}</button>
    `;
    evaluateIntelOverflow(slug);
  }

  /** After rendering, measure whether the intel view exceeds its
   *  collapsed 3-line max-height. If so, mark the block as
   *  overflowing — that reveals the toggle button + fade gradient
   *  via CSS. Mirrors `evaluateInstructionOverflow` but with the
   *  3-line cap defined in `.ap-intel-view` CSS. Re-evaluated on
   *  every repaint and again on window resize (the rendered width
   *  changes, so the wrapped line count can change too). */
  function evaluateIntelOverflow(slug) {
    const block = document.querySelector(`[data-ap-intel][data-slug="${slug}"]`);
    if (!block) return;
    const view = block.querySelector("[data-ap-intel-view]");
    const toggle = block.querySelector("[data-ap-intel-toggle]");
    if (!view || !toggle) return;
    // Reset to collapsed default before measuring — prevents stale
    // 'expanded' state from a prior interaction shadowing the check.
    view.classList.remove("expanded");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = uiT("ap_show_more");
    if (view.scrollHeight - view.clientHeight > 4) {
      block.classList.add("overflowing");
    } else {
      block.classList.remove("overflowing");
    }
  }
  // Re-evaluate every visible intel block when the layout reflows
  // (sidebar resize, window resize). Debounced so resize storms
  // don't trip us — one tick after the resize ends. Same pattern
  // as the Instruction resize listener directly below the
  // `evaluateInstructionOverflow` definition.
  let _intelResizeTimer = null;
  window.addEventListener("resize", () => {
    if (_intelResizeTimer) clearTimeout(_intelResizeTimer);
    _intelResizeTimer = setTimeout(() => {
      document.querySelectorAll("[data-ap-intel]").forEach((b) => {
        const slug = b.getAttribute("data-slug");
        if (slug) evaluateIntelOverflow(slug);
      });
    }, 80);
  });

  function openIntelEditor(slug, p) {
    const block = document.querySelector(`[data-ap-intel][data-slug="${slug}"]`);
    if (!block) return;
    const bio = bioFor(slug, p);
    block.innerHTML = `
      <div class="ap-intel-edit">
        <textarea class="ap-intel-textarea" data-ap-intel-textarea spellcheck="false" maxlength="${BIO_MAX}" placeholder="${escape(uiT("ap_intel_placeholder", { min: BIO_MIN, max: BIO_MAX }))}">${escape(bio)}</textarea>
        <div class="ap-intel-edit-foot">
          <span class="ap-intel-edit-hint" data-ap-intel-hint>${escape(uiT("ap_intel_hint", { min: BIO_MIN, max: BIO_MAX }))}</span>
          <div class="ap-intel-edit-actions">
            <button type="button" class="ap-instr-cancel" data-ap-intel-cancel>${escape(uiT("ap_cancel"))}</button>
            <button type="button" class="ap-instr-save" data-ap-intel-save>${escape(uiT("ap_save"))}</button>
          </div>
        </div>
      </div>
    `;
    const ta = block.querySelector("textarea");
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  /** PATCH the agent's bio. Called by the save handler once the user
   *  clicks save; updates the in-memory roster on success so the new
   *  bio is visible elsewhere immediately. Errors surface inline in
   *  the editor's hint line so the user can correct + retry without
   *  losing their draft. */
  async function setBioFor(slug, bio) {
    const trimmed = String(bio || "").trim();
    if (trimmed.length < BIO_MIN || trimmed.length > BIO_MAX) {
      throw new Error(`description must be ${BIO_MIN}–${BIO_MAX} chars`);
    }
    const r = await fetch("/api/agents/" + encodeURIComponent(slug), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bio: trimmed }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + r.status));
    }
    const updated = await r.json();
    if (window.app) {
      const live = window.app.agentsById && window.app.agentsById[slug];
      if (live) live.bio = updated.bio || trimmed;
      if (typeof window.app.refreshAgents === "function") {
        window.app.refreshAgents().catch(() => {});
      }
    }
    return updated;
  }

  function renderInstructionBlock(p, slug) {
    const md = instructionFor(slug, p);
    const rendered = renderMarkdown(md);
    return `
      <div class="ap-instr" data-ap-instr data-slug="${escape(slug)}">
        <div class="ap-instr-view" data-ap-instr-view>
          ${rendered || `<div class="ap-empty">${escape(uiT("ap_instr_empty"))}</div>`}
        </div>
        <button type="button" class="ap-instr-toggle" data-ap-instr-toggle aria-expanded="false">${escape(uiT("ap_show_more"))}</button>
      </div>
    `;
  }

  function repaintInstruction(slug, p) {
    const block = document.querySelector(`[data-ap-instr][data-slug="${slug}"]`);
    if (!block) return;
    block.classList.remove("overflowing");
    block.innerHTML = `
      <div class="ap-instr-view" data-ap-instr-view>
        ${renderMarkdown(instructionFor(slug, p)) || `<div class="ap-empty">${escape(uiT("ap_instr_empty"))}</div>`}
      </div>
      <button type="button" class="ap-instr-toggle" data-ap-instr-toggle aria-expanded="false">${escape(uiT("ap_show_more"))}</button>
    `;
    evaluateInstructionOverflow(slug);
  }

  /** After rendering, measure whether the instruction view exceeds its
   *  collapsed max-height. If so, mark the block as overflowing — that
   *  reveals the toggle button + fade gradient via CSS. Re-evaluated on
   *  every repaint and again on window resize (the rendered width
   *  changes, so the wrapped line count can change too). */
  function evaluateInstructionOverflow(slug) {
    const block = document.querySelector(`[data-ap-instr][data-slug="${slug}"]`);
    if (!block) return;
    const view = block.querySelector("[data-ap-instr-view]");
    const toggle = block.querySelector("[data-ap-instr-toggle]");
    if (!view || !toggle) return;
    // Reset to collapsed default before measuring — prevents stale
    // 'expanded' state from a prior interaction shadowing the check.
    view.classList.remove("expanded");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = uiT("ap_show_more");
    // scrollHeight is the full content; clientHeight is the rendered
    // (capped) height. A few-pixel epsilon avoids flagging content
    // that fits exactly at the cap as "overflowing".
    if (view.scrollHeight - view.clientHeight > 4) {
      block.classList.add("overflowing");
    } else {
      block.classList.remove("overflowing");
    }
  }
  // Re-evaluate every visible instruction block when the layout reflows
  // (sidebar resize, window resize). Debounced so resize storms don't
  // trip us — one tick after the resize ends.
  let _instrResizeTimer = null;
  window.addEventListener("resize", () => {
    if (_instrResizeTimer) clearTimeout(_instrResizeTimer);
    _instrResizeTimer = setTimeout(() => {
      document.querySelectorAll("[data-ap-instr]").forEach((b) => {
        const slug = b.getAttribute("data-slug");
        if (slug) evaluateInstructionOverflow(slug);
      });
    }, 80);
  });
  function openInstructionEditor(slug, p) {
    const block = document.querySelector(`[data-ap-instr][data-slug="${slug}"]`);
    if (!block) return;
    const md = instructionFor(slug, p);
    block.innerHTML = `
      <div class="ap-instr-edit">
        <textarea class="ap-instr-textarea" data-ap-instr-textarea spellcheck="false" placeholder="${escape(uiT("ap_instr_placeholder_editor"))}">${escape(md)}</textarea>
        <div class="ap-instr-edit-foot">
          <span class="ap-instr-edit-hint">${escape(uiT("ap_instr_edit_hint"))}</span>
          <div class="ap-instr-edit-actions">
            <button type="button" class="ap-instr-cancel" data-ap-instr-cancel>${escape(uiT("ap_cancel"))}</button>
            <button type="button" class="ap-instr-save" data-ap-instr-save>${escape(uiT("ap_save"))}</button>
          </div>
        </div>
      </div>
    `;
    const ta = block.querySelector("textarea");
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  /** Render the RULES block · editable list of numbered constraints.
   *  Mirrors the new-agent overlay UX: each row is a numbered input
   *  with a trailing remove button; an "add rule" button below the
   *  list (hidden when the cap of 5 is reached). Mutations persist
   *  server-side via PATCH /api/agents/:id (see setRuleAt / removeRuleFor)
   *  so the orchestrator injects them into the director's prompt. */
  function renderRulesBlock(slug) {
    return `<div class="ap-rules-block" data-ap-rules-block data-slug="${escape(slug)}">${renderRulesInner(slug)}</div>`;
  }

  /** Persona dossier card · only mounted for Full-mode agents (those
   *  with `personaSpec` populated by the deep-build pipeline). The
   *  card reads as a gamified character-sheet · mono kicker, big
   *  divergence stat, secondary stat grid, ▸ CTA. Clicking opens an
   *  overlay that previews the persona.md content with a Download
   *  affordance. Hidden entirely for Signal-mode agents and seeded
   *  directors so the panel doesn't render an empty section.
   *
   *  Stats source from `live.personaSpec` (resolved from
   *  window.app.agentsById at render time · the `p` object passed in
   *  doesn't carry the spec, so we reach across). */
  function renderPersonaDossierSection(slug, p) {
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    const spec = live && live.personaSpec ? live.personaSpec : null;
    if (!spec) return "";
    // Stats. Differentiation score is the headline — null when the
    // build skipped the eval pass (rare). The rest are counts of the
    // structured artifacts so the user can eyeball depth at a glance.
    const score = typeof spec.differentiationScore === "number" ? spec.differentiationScore : null;
    const scorePct = score == null ? "—" : `${Math.round(score * 100)}%`;
    const knowledge = spec.knowledge || {};
    const sourceCount = (knowledge.keyThinkers || []).length
      + (knowledge.foundationalWorks || []).length
      + (knowledge.recentDevelopments || []).length
      + (knowledge.contestedClaims || []).length;
    const searchCount = (knowledge.searchQueries || []).length;
    const fewShotCount = (spec.fewShot || []).length;
    const rulesCount = (spec.rules || []).length;
    const checklistCount = (spec.reflectionChecklist || []).length;
    const evalCount = (spec.evalSet || []).length;
    const builtIso = spec.generatedAt || "";
    const builtLabel = builtIso ? new Date(builtIso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
    return `
      <section class="ap-block ap-persona-block">
        <header class="ap-block-h">
          <span class="ap-block-h-title">Persona dossier</span>
          <span class="ap-block-h-tag">Full-mode build</span>
        </header>
        <button type="button" class="ap-persona-card" data-ap-persona-open data-slug="${escape(slug)}" aria-label="Open persona dossier">
          <div class="ap-persona-card-head">
            <div class="ap-persona-card-glyph" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4">
                <circle cx="16" cy="16" r="12" />
                <circle cx="16" cy="16" r="5" />
                <line x1="16" y1="2"  x2="16" y2="8" />
                <line x1="16" y1="24" x2="16" y2="30" />
                <line x1="2"  y1="16" x2="8"  y2="16" />
                <line x1="24" y1="16" x2="30" y2="16" />
              </svg>
            </div>
            <div class="ap-persona-card-id">
              <div class="ap-persona-card-kicker">— PERSONA · 7-PHASE DOSSIER</div>
              <div class="ap-persona-card-title">${escape(p && p.name ? p.name : "Director")}</div>
              ${builtLabel ? `<div class="ap-persona-card-meta">Built · ${escape(builtLabel)}</div>` : ""}
            </div>
            <div class="ap-persona-card-score" title="Differentiation vs generic-AI baseline">
              <div class="ap-persona-card-score-v">${escape(scorePct)}</div>
              <div class="ap-persona-card-score-l">DIVERGENCE</div>
            </div>
          </div>
          <div class="ap-persona-card-grid">
            <div class="ap-persona-stat">
              <div class="ap-persona-stat-v">${sourceCount}</div>
              <div class="ap-persona-stat-l">SOURCES</div>
            </div>
            <div class="ap-persona-stat">
              <div class="ap-persona-stat-v">${searchCount}</div>
              <div class="ap-persona-stat-l">SEARCHES</div>
            </div>
            <div class="ap-persona-stat">
              <div class="ap-persona-stat-v">${fewShotCount}</div>
              <div class="ap-persona-stat-l">VOICE EX.</div>
            </div>
            <div class="ap-persona-stat">
              <div class="ap-persona-stat-v">${rulesCount}</div>
              <div class="ap-persona-stat-l">RULES</div>
            </div>
            <div class="ap-persona-stat">
              <div class="ap-persona-stat-v">${checklistCount}</div>
              <div class="ap-persona-stat-l">CHECKS</div>
            </div>
            <div class="ap-persona-stat">
              <div class="ap-persona-stat-v">${evalCount}</div>
              <div class="ap-persona-stat-l">EVALS</div>
            </div>
          </div>
          <div class="ap-persona-card-cta">
            <span class="ap-persona-card-cta-label">▸ OPEN DOSSIER</span>
            <span class="ap-persona-card-cta-hint">preview · download .md</span>
          </div>
        </button>
      </section>`;
  }

  /** Build log card · sibling to the persona dossier. Surfaces a 1-line
   *  teaser drawn from the narrator's pitch summary plus a CTA that
   *  opens the build-log modal. Hidden when the agent has no
   *  `personaSpec.buildLog` (older Full-mode builds without the
   *  buildLog field; all Signal-mode agents; all seed directors). */
  function renderBuildLogSection(slug, p) {
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    const spec = live && live.personaSpec ? live.personaSpec : null;
    const buildLog = spec && spec.buildLog ? spec.buildLog : null;
    if (!buildLog) return "";
    const narrative = typeof buildLog.narrative === "string" ? buildLog.narrative : "";
    // Teaser · first ~160 chars of the narrative or a localised
    // fallback if the narrator pass came back empty. The narrative is
    // plain prose so we just trim on the nearest whitespace.
    let teaser = narrative.trim();
    if (teaser.length === 0) {
      teaser = uiT("ap_build_log_teaser_fallback");
    } else if (teaser.length > 160) {
      const cut = teaser.slice(0, 160);
      const lastSpace = cut.lastIndexOf(" ");
      teaser = (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim() + "…";
    }
    return `
      <section class="ap-block ap-buildlog-block">
        <header class="ap-block-h">
          <span class="ap-block-h-title">${escape(uiT("ap_build_log"))}</span>
          <span class="ap-block-h-tag">${escape(uiT("ap_build_log_kicker"))}</span>
        </header>
        <button type="button" class="ap-buildlog-card" data-ap-buildlog-open data-slug="${escape(slug)}" aria-label="${escape(uiT("ap_build_log_open"))}">
          <p class="ap-buildlog-teaser">${escape(teaser)}</p>
          <div class="ap-buildlog-card-cta">
            <span class="ap-buildlog-card-cta-label">${escape(uiT("ap_build_log_open_cta"))}</span>
          </div>
        </button>
      </section>`;
  }

  function renderRulesInner(slug) {
    const rules = rulesForAgent(slug);
    const list = rules.length === 0
      ? `<li class="ap-rule-empty">${escape(uiT("ap_rules_empty_list"))}</li>`
      : rules.map((body, i) => `
          <li class="ap-rule" data-rule-idx="${i}">
            <span class="ap-rule-num">${i + 1}</span>
            <input type="text" class="ap-rule-input"
                   data-ap-rule-input="${i}"
                   placeholder="never preface · cite the load-bearing claim · ..."
                   maxlength="120"
                   value="${escape(body)}">
            <button type="button" class="ap-rule-rm" data-ap-rule-rm="${i}" title="Remove">✕</button>
          </li>
        `).join("");
    return `<ol class="ap-rules-list">${list}</ol>`;
  }

  /** Render the chair-only "Long-term about you" block · pulls from
   *  the parallel user_long_memory table that survives every dream
   *  cycle. Bootstraps with a placeholder; the actual list loads
   *  asynchronously via /api/agents/chair/user-long-memory after
   *  paint. Each row supports edit (claim only — label is the tag
   *  identity, immutable post-creation) + delete. No manual add —
   *  the chair is the author; the user is the editor. */
  function renderUserLongMemoryBlock() {
    return `
      <div class="ap-ulm" data-ap-ulm>
        <div class="ap-ulm-list" data-ap-ulm-list>
          <div class="ap-empty">loading…</div>
        </div>
      </div>
    `;
  }

  function ulmRowHTML(t) {
    return `
      <div class="ap-ulm-row" data-ap-ulm-row data-id="${escape(t.id)}">
        <div class="ap-ulm-row-head">
          <span class="ap-ulm-label">[${escape(t.label || "")}]</span>
          <div class="ap-ulm-actions">
            <button type="button" class="ap-ulm-edit" data-ap-ulm-edit aria-label="${escape(uiT("chair_ulm_edit_label"))}" title="${escape(uiT("chair_ulm_edit_label"))}">
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L5 13l-2.5.5L3 11z"/></svg>
            </button>
            <button type="button" class="ap-ulm-delete" data-ap-ulm-delete aria-label="${escape(uiT("chair_ulm_delete_label"))}" title="${escape(uiT("chair_ulm_delete_label"))}">×</button>
          </div>
        </div>
        <div class="ap-ulm-claim" data-ap-ulm-claim>${escape(t.claim || "")}</div>
      </div>
    `;
  }

  /** Empty-state markup · a small 8-bit pixel-art diagram showing
   *  the harvest pipeline (rooms → arrow → tag crystal) above a
   *  3-step ordered list. Goal is to make the section's mechanism
   *  legible without reading docs: the user sees that the chair
   *  watches across MULTIPLE rooms and that patterns CRYSTALLIZE
   *  here as tags. Reuses the project's 8-bit register
   *  (shape-rendering: crispEdges, currentColor + var(--lime)
   *  accent) so it inherits dark/light theme tokens cleanly. */
  function ulmEmptyStageHTML() {
    return `
      <div class="ap-ulm-empty-stage">
        <svg class="ap-ulm-empty-art" viewBox="0 0 240 50" shape-rendering="crispEdges" aria-hidden="true">
          <!-- Three room panels · each is a 36×28 frame with a tiny
               chair sprite inside (4×8 back + 8×6 seat). The chairs
               are uniform · the gamified read is "same chair, three
               rooms" so the user gets that this aggregates across
               sessions. -->
          <g fill="currentColor">
            <rect x="6"  y="6"  width="36" height="28" fill="none" stroke="currentColor" stroke-width="1" opacity="0.55"/>
            <rect x="20" y="14" width="8"  height="6"  opacity="0.55"/>
            <rect x="20" y="22" width="8"  height="6"  opacity="0.9"/>
            <rect x="52" y="6"  width="36" height="28" fill="none" stroke="currentColor" stroke-width="1" opacity="0.55"/>
            <rect x="66" y="14" width="8"  height="6"  opacity="0.55"/>
            <rect x="66" y="22" width="8"  height="6"  opacity="0.9"/>
            <rect x="98"  y="6"  width="36" height="28" fill="none" stroke="currentColor" stroke-width="1" opacity="0.55"/>
            <rect x="112" y="14" width="8"  height="6"  opacity="0.55"/>
            <rect x="112" y="22" width="8"  height="6"  opacity="0.9"/>
          </g>
          <!-- Arrow · faint, leads the eye rightward. Pixel-art
               style (rect-only, no path) keeps the crispEdges
               aesthetic consistent. -->
          <g fill="currentColor" opacity="0.45">
            <rect x="142" y="19" width="18" height="2"/>
            <rect x="158" y="15" width="2"  height="2"/>
            <rect x="160" y="17" width="2"  height="2"/>
            <rect x="162" y="19" width="2"  height="2"/>
            <rect x="160" y="21" width="2"  height="2"/>
            <rect x="158" y="23" width="2"  height="2"/>
          </g>
          <!-- Tag crystal · lime-stroked frame + three "content"
               lines that read as a saved tag entry. Small spark
               above the top-right corner marks it as "freshly
               minted / something to look forward to". -->
          <g>
            <rect x="170" y="6"  width="64" height="28" fill="none" stroke="var(--lime)" stroke-width="1"/>
            <rect x="176" y="12" width="4"  height="2"  fill="var(--lime)"/>
            <rect x="182" y="12" width="2"  height="2"  fill="var(--lime)"/>
            <rect x="186" y="12" width="8"  height="2"  fill="var(--lime)"/>
            <rect x="196" y="12" width="2"  height="2"  fill="var(--lime)"/>
            <rect x="200" y="12" width="4"  height="2"  fill="var(--lime)"/>
            <rect x="176" y="18" width="52" height="2"  fill="var(--lime)" opacity="0.55"/>
            <rect x="176" y="24" width="36" height="2"  fill="var(--lime)" opacity="0.3"/>
            <!-- spark · 3 pixels above the top-right edge -->
            <rect x="228" y="0"  width="2"  height="2"  fill="var(--lime)"/>
            <rect x="232" y="2"  width="2"  height="2"  fill="var(--lime)" opacity="0.7"/>
            <rect x="226" y="3"  width="2"  height="2"  fill="var(--lime)" opacity="0.5"/>
          </g>
        </svg>
        <ol class="ap-ulm-empty-steps">
          <li><span class="ap-ulm-empty-num">1</span><span>${escape(uiT("chair_ulm_empty_step_1"))}</span></li>
          <li><span class="ap-ulm-empty-num">2</span><span>${escape(uiT("chair_ulm_empty_step_2"))}</span></li>
          <li><span class="ap-ulm-empty-num">3</span><span>${escape(uiT("chair_ulm_empty_step_3"))}</span></li>
        </ol>
        <p class="ap-ulm-empty-caption">${escape(uiT("chair_ulm_empty"))}</p>
      </div>
    `;
  }

  async function loadUserLongMemory() {
    const block = document.querySelector("[data-ap-ulm]");
    if (!block) return;
    const list = block.querySelector("[data-ap-ulm-list]");
    if (!list) return;
    try {
      const r = await fetch("/api/agents/chair/user-long-memory");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        list.innerHTML = `<div class="ap-empty">${escape(j.error || ("HTTP " + r.status))}</div>`;
        return;
      }
      const j = await r.json();
      const items = Array.isArray(j.items) ? j.items : [];
      if (items.length === 0) {
        list.innerHTML = ulmEmptyStageHTML();
        return;
      }
      list.innerHTML = items.map(ulmRowHTML).join("");
    } catch (e) {
      list.innerHTML = `<div class="ap-empty">${escape(e && e.message ? e.message : String(e))}</div>`;
    }
  }

  async function patchUserLongMemory(id, claim) {
    const r = await fetch("/api/agents/chair/user-long-memory/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + r.status));
    }
    return r.json();
  }

  async function deleteUserLongMemoryRow(id) {
    const r = await fetch("/api/agents/chair/user-long-memory/" + encodeURIComponent(id), {
      method: "DELETE",
    });
    if (!r.ok && r.status !== 204) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + r.status));
    }
  }

  /** Render the MEMORY block · live, per-agent long-term notes about
   *  the user. Bootstraps with a placeholder; the actual list loads
   *  asynchronously via /api/agents/:id/memories so the profile paint
   *  isn't blocked by a fetch. Each row supports pin / edit / delete;
   *  a + Add note input at the top lets the user manually inject
   *  facts (useful when the user wants to "tell" an agent something
   *  before the first room). */
  function renderMemoryBlock(slug) {
    return `
      <div class="ap-memory" data-ap-memory data-slug="${escape(slug)}">
        <div class="ap-memory-add" data-ap-memory-add-form hidden>
          <input type="text" class="ap-memory-add-input" data-ap-memory-add-input
                 placeholder="add a note about yourself (4–280 chars)"
                 maxlength="280" autocomplete="off">
          <button type="button" class="ap-memory-add-cancel" data-ap-memory-add-cancel>cancel</button>
          <button type="button" class="ap-memory-add-btn" data-ap-memory-add-btn>save</button>
        </div>
        <div class="ap-memory-list" data-ap-memory-list>
          <div class="ap-empty">loading…</div>
        </div>
      </div>
    `;
  }

  /** Fetch and render this agent's memory rows. Called after the
   *  profile paints (and again on every memory mutation). */
  async function loadMemoriesFor(slug) {
    const block = document.querySelector(`[data-ap-memory][data-slug="${slug}"]`);
    if (!block) return;
    const list = block.querySelector("[data-ap-memory-list]");
    if (!list) return;
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(slug) + "/memories");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        list.innerHTML = `<div class="ap-empty">couldn't load memory: ${escape(j.error || ("HTTP " + r.status))}</div>`;
        return;
      }
      const j = await r.json();
      const memories = Array.isArray(j.memories) ? j.memories : [];
      if (memories.length === 0) {
        list.innerHTML = `<div class="ap-empty">no memory yet · the agent will accumulate notes after each room (or add one above)</div>`;
        return;
      }
      // Cap the visible list at 5 by default · the rest live in a
      // collapsed overflow box with a "▾ Show all N memories" toggle
      // beneath. Pinned rows are always sorted first by the server
      // so the cap surfaces the most-relevant entries.
      const VISIBLE_CAP = 5;
      const visible = memories.slice(0, VISIBLE_CAP);
      const overflow = memories.slice(VISIBLE_CAP);
      const visibleHTML = visible.map(memoryRowHTML).join("");
      const overflowHTML = overflow.length > 0
        ? `
          <div class="ap-memory-overflow" data-ap-memory-overflow hidden>
            ${overflow.map(memoryRowHTML).join("")}
          </div>
          <button type="button" class="ap-memory-toggle" data-ap-memory-toggle aria-label="toggle memory">
            <span class="ap-memory-toggle-icon" aria-hidden="true">▾</span>
            <span class="ap-memory-toggle-show">Show all ${memories.length} memories</span>
            <span class="ap-memory-toggle-hide">Collapse</span>
          </button>
        `
        : "";
      list.innerHTML = visibleHTML + overflowHTML;
    } catch (e) {
      list.innerHTML = `<div class="ap-empty">couldn't load memory · ${escape(e && e.message ? e.message : String(e))}</div>`;
    }
  }

  function memoryRowHTML(m) {
    const kindLabel = (m.kind || "fact").toLowerCase();
    const sourceTag = m.source === "user_added"
      ? "manual"
      : (m.sourceRoom ? "from room" : "extracted");
    const pinned = m.pinned === true;
    return `
      <div class="ap-memory-row${pinned ? " pinned" : ""}" data-ap-memory-row data-id="${escape(m.id)}" data-pinned="${pinned ? "1" : "0"}">
        <div class="ap-memory-content" data-ap-memory-content>${escape(m.content || "")}</div>
        <div class="ap-memory-row-foot">
          <span class="ap-memory-meta">
            <span class="ap-memory-kind">${escape(kindLabel)}</span>
            <span class="ap-memory-meta-sep">·</span>
            <span class="ap-memory-source">${escape(sourceTag)}</span>
          </span>
          <div class="ap-memory-actions">
            <button type="button" class="ap-memory-pin" data-ap-memory-pin aria-label="${pinned ? "Unpin" : "Pin"}" title="${pinned ? "Unpin" : "Pin · always inject this note"}">${pinned ? "★" : "☆"}</button>
            <button type="button" class="ap-memory-edit" data-ap-memory-edit aria-label="Edit" title="Edit">
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L5 13l-2.5.5L3 11z"/></svg>
            </button>
            <button type="button" class="ap-memory-delete" data-ap-memory-delete aria-label="Delete" title="Delete">×</button>
          </div>
        </div>
      </div>
    `;
  }

  /** POST /api/agents/:slug/memories · used by the manual add form. */
  async function addMemoryFor(slug, content) {
    const r = await fetch("/api/agents/" + encodeURIComponent(slug) + "/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, kind: "fact" }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + r.status));
    }
    return r.json();
  }
  /** PATCH /api/agents/:slug/memories/:id · supports pin toggle + content edit. */
  async function patchMemory(slug, id, patch) {
    const r = await fetch(
      "/api/agents/" + encodeURIComponent(slug) + "/memories/" + encodeURIComponent(id),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + r.status));
    }
    return r.json();
  }
  /** Spawn the dream-cycle modal overlay · returns the overlay
   *  element so the caller can mount its body content. Idempotent
   *  on re-entry (the user double-clicked) — closes any prior
   *  overlay first so we never stack them. ESC + backdrop click
   *  + ✕ button all funnel into closeDreamOverlay. */
  function openDreamOverlay() {
    closeDreamOverlay();
    const overlay = document.createElement("div");
    overlay.className = "dream-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.dataset.dreamOverlay = "1";
    overlay.innerHTML = `
      <div class="dream-backdrop" data-dream-close></div>
      <div class="dream-modal" role="document">
        <div class="dream-modal-head">
          <span class="dream-modal-kicker"><span class="dream-modal-glyph">☾</span> memory · sleep mode</span>
          <button type="button" class="dream-modal-close" data-dream-close aria-label="Close">✕</button>
        </div>
        <div class="dream-modal-body" data-dream-body></div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    // Backdrop / ✕ click → close. Listener bound on the overlay
    // root, delegated to anything carrying [data-dream-close].
    overlay.addEventListener("click", (ev) => {
      if (ev.target.closest && ev.target.closest("[data-dream-close]")) {
        ev.preventDefault();
        closeDreamOverlay();
      }
    });
    // ESC closes too. Detached on close so we don't accumulate
    // listeners across opens.
    overlay.__dreamEsc = (ev) => {
      if (ev.key === "Escape") {
        ev.stopImmediatePropagation();
        closeDreamOverlay();
      }
    };
    document.addEventListener("keydown", overlay.__dreamEsc, true);
    return overlay;
  }
  function closeDreamOverlay() {
    const overlay = document.querySelector('[data-dream-overlay="1"]');
    if (!overlay) return;
    if (overlay.__dreamPhaseTimer) {
      clearInterval(overlay.__dreamPhaseTimer);
      overlay.__dreamPhaseTimer = null;
    }
    if (overlay.__dreamAutoClose) {
      clearTimeout(overlay.__dreamAutoClose);
      overlay.__dreamAutoClose = null;
    }
    if (overlay.__dreamEsc) {
      document.removeEventListener("keydown", overlay.__dreamEsc, true);
      overlay.__dreamEsc = null;
    }
    overlay.remove();
    document.body.style.overflow = "";
  }

  /** DELETE /api/agents/:slug/memories/:id */
  async function deleteMemoryFor(slug, id) {
    const r = await fetch(
      "/api/agents/" + encodeURIComponent(slug) + "/memories/" + encodeURIComponent(id),
      { method: "DELETE" },
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + r.status));
    }
  }

  /* ─── Skills v2 · uploaded Skill.md files ────────────────────────────
     Replaces the legacy localStorage skill grid. Skills are real,
     server-persisted, and feed both the ability radar and the Pass-1
     orchestrator router. PRD: docs/PRD-skills.md. */

  const SKILL_AXES = ["dissent", "pattern_recall", "rigor", "empathy", "narrative", "decisiveness"];
  const SKILL_AXIS_LABEL = {
    dissent: "DISSENT",
    pattern_recall: "RECALL",
    rigor: "RIGOR",
    empathy: "EMPATHY",
    narrative: "NARRATIVE",
    decisiveness: "DECIDE",
  };
  const SKILL_AXIS_MAX = 10;
  const SKILL_CAP = { chair: 12, director: 5 };

  /** Per-seed-agent base profile (0–10 per axis). Custom agents default
   *  to a flat 5/all. These bias the radar at base; installed skills
   *  modify by their delta values. */
  const SKILL_BASE_PROFILES = {
    "socrates":         { dissent: 9, pattern_recall: 4, rigor: 8, empathy: 4, narrative: 5, decisiveness: 4 },
    "first-principles": { dissent: 6, pattern_recall: 5, rigor: 9, empathy: 3, narrative: 4, decisiveness: 6 },
    "value-investor":   { dissent: 6, pattern_recall: 9, rigor: 7, empathy: 4, narrative: 6, decisiveness: 7 },
    "user-empathy":     { dissent: 5, pattern_recall: 4, rigor: 5, empathy: 9, narrative: 8, decisiveness: 5 },
    "long-horizon":     { dissent: 4, pattern_recall: 8, rigor: 6, empathy: 5, narrative: 7, decisiveness: 6 },
    "phenomenologist":  { dissent: 5, pattern_recall: 4, rigor: 5, empathy: 7, narrative: 6, decisiveness: 4 },
    "chair":            { dissent: 5, pattern_recall: 6, rigor: 6, empathy: 7, narrative: 6, decisiveness: 8 },
  };
  function baseAbilityFor(slug) {
    // Live agent record (custom directors) wins over the seed table:
    // the AI-generated spec ships an `ability` map that reflects the
    // user's description, so the radar shows real personality instead
    // of a flat 5/all.
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    if (live && live.ability && typeof live.ability === "object") {
      const profile = {};
      let hasAny = false;
      for (const a of SKILL_AXES) {
        const v = live.ability[a];
        if (typeof v === "number" && Number.isFinite(v)) {
          profile[a] = Math.max(0, Math.min(SKILL_AXIS_MAX, v));
          hasAny = true;
        } else {
          profile[a] = 5;
        }
      }
      if (hasAny) return profile;
    }
    const p = SKILL_BASE_PROFILES[slug];
    if (p) return Object.assign({}, p);
    const flat = {};
    for (const a of SKILL_AXES) flat[a] = 5;
    return flat;
  }

  function clampAxis(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(SKILL_AXIS_MAX, v));
  }

  /** Sum base + every installed skill's delta on each axis. Returns a
   *  map clamped to [0, SKILL_AXIS_MAX]. */
  function computeAbility(slug, skills) {
    const base = baseAbilityFor(slug);
    const out = Object.assign({}, base);
    for (const s of skills || []) {
      const ab = s.ability || {};
      for (const axis of SKILL_AXES) {
        if (typeof ab[axis] === "number") out[axis] = (out[axis] || 0) + ab[axis];
      }
    }
    for (const axis of SKILL_AXES) out[axis] = clampAxis(out[axis]);
    return out;
  }

  /** Render the radar as inline SVG · faint base outline + filled current
   *  shape + axis labels. Pure SVG so it scales cleanly and stays theme-
   *  aware via currentColor / CSS vars. */
  function renderRadar(slug, skills) {
    const base = baseAbilityFor(slug);
    const cur = computeAbility(slug, skills);
    // viewBox sized to leave ~58px of horizontal padding on each side
    // so the longest axis label ("NARRATIVE", ~50px wide at 8px mono)
    // never gets clipped by the SVG bounds. Vertical padding stays
    // tight since the top/bottom labels are short ("DISSENT" / "EMPATHY").
    const cx = 150;
    const cy = 105;
    const r = 78;
    const vbW = 300;
    const vbH = 210;
    const axes = SKILL_AXES.length;
    const angles = SKILL_AXES.map((_, i) => (-Math.PI / 2) + (2 * Math.PI * i) / axes);
    function point(value, idx) {
      const ratio = clampAxis(value) / SKILL_AXIS_MAX;
      const a = angles[idx];
      return [cx + Math.cos(a) * r * ratio, cy + Math.sin(a) * r * ratio];
    }
    function ring(ratio) {
      return SKILL_AXES.map((_, i) => {
        const a = angles[i];
        const x = cx + Math.cos(a) * r * ratio;
        const y = cy + Math.sin(a) * r * ratio;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
    }
    const basePoly = SKILL_AXES.map((axis, i) => point(base[axis], i).map((n) => n.toFixed(1)).join(",")).join(" ");
    const curPoly = SKILL_AXES.map((axis, i) => point(cur[axis], i).map((n) => n.toFixed(1)).join(",")).join(" ");
    const labels = SKILL_AXES.map((axis, i) => {
      const a = angles[i];
      const lr = r + 14;
      const lx = cx + Math.cos(a) * lr;
      const ly = cy + Math.sin(a) * lr;
      let anchor = "middle";
      if (Math.abs(Math.cos(a)) > 0.4) anchor = Math.cos(a) > 0 ? "start" : "end";
      return `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}" class="ap-radar-axis-label">${SKILL_AXIS_LABEL[axis]}</text>`;
    }).join("");
    const spokes = SKILL_AXES.map((_, i) => {
      const [x, y] = point(SKILL_AXIS_MAX, i);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="ap-radar-spoke"/>`;
    }).join("");
    const rings = [0.33, 0.66, 1].map((ratio) =>
      `<polygon points="${ring(ratio)}" class="ap-radar-grid"/>`,
    ).join("");
    return `
      <svg class="ap-radar" viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" aria-label="Ability radar">
        ${rings}
        ${spokes}
        <polygon points="${basePoly}" class="ap-radar-base"/>
        <polygon points="${curPoly}" class="ap-radar-current"/>
        ${labels}
      </svg>
    `;
  }

  function deltaChip(axis, value) {
    if (!Number.isFinite(value) || value === 0) return "";
    const sign = value > 0 ? "+" : "";
    const cls = value > 0 ? "pos" : "neg";
    return `<span class="ap-skill-chip ${cls}">${SKILL_AXIS_LABEL[axis]} ${sign}${value}</span>`;
  }

  /** Compact inline delta string · "rigor +2 · depth +3" with each
   *  axis label muted and the value color-coded by sign. Mono font, no
   *  borders — keeps the row to a single line at common widths. */
  function inlineDeltas(ability) {
    if (!ability) return "";
    const parts = [];
    for (const axis of SKILL_AXES) {
      const v = ability[axis];
      if (typeof v !== "number" || v === 0) continue;
      const sign = v > 0 ? "+" : "";
      const cls = v > 0 ? "pos" : "neg";
      parts.push(`<span class="ap-sd"><span class="ap-sd-l">${SKILL_AXIS_LABEL[axis].toLowerCase()}</span><span class="ap-sd-v ${cls}">${sign}${v}</span></span>`);
    }
    return parts.join("");
  }

  function renderSkillRow(skill, agentSlug) {
    const isSystem = !!skill.system;
    const tipsAttr = JSON.stringify({
      id: skill.id,
      name: skill.name,
      slug: skill.slug,
      version: skill.version || "1.0",
      description: skill.description,
      whenToUse: skill.whenToUse,
      ability: skill.ability || {},
      tips: skill.tips || [],
      system: isSystem,
      // System-skill-specific runtime state (e.g. web-search's
      // `keyConfigured` and `enabled`). Used by the ⋯ popover to
      // surface contextual actions like "Configure key".
      state: skill.state || null,
    });
    // System-ness is already communicated by the row's mark glyph (▣
    // vs ◆) and by the lock note in the ⋯ popover — no inline "system"
    // badge here, otherwise rows like web-search read as cluttered
    // (and inconsistent with fetch-url / report-writer in chair-only
    // historical UI, where the badge wasn't surfaced either).
    const mark = isSystem ? "▣" : "◆";
    const titleText = isSystem
      ? `${skill.name} · ${skill.slug} · system skill`
      : `${skill.name} · ${skill.slug}`;

    // Web-search · special row · the deltas slot is replaced by a
    // toggle. The toggle is always rendered (no layout shift between
    // states); when the Brave key isn't configured the click handler
    // prompts the user before opening Preferences. The dotted "needs
    // key" decoration cues the requirement without consuming the
    // limited horizontal space the cramped configure button used to.
    let middleCell = `<span class="ap-skill-row-deltas">${inlineDeltas(skill.ability) || `<span class="ap-sd-empty">no axis change</span>`}</span>`;
    if (skill.slug === "web-search" && skill.state) {
      const st = skill.state || {};
      const keyOk = !!st.keyConfigured;
      // Visual ON only when the key is configured AND the per-agent
      // flag is set. With no key, force OFF visually regardless of the
      // stored flag — the agent can't search either way.
      const enabled = keyOk && !!st.enabled;
      const provider = st.requiresKey && st.requiresKey.provider ? st.requiresKey.provider : "brave";
      const cls = ["ap-skill-row-toggle", enabled ? "on" : "off", keyOk ? "" : "needs-key"]
        .filter(Boolean)
        .join(" ");
      const titleText = keyOk
        ? (enabled ? "Disable Web Search for this director" : "Enable Web Search for this director")
        : uiT("ag_ws_title_needs");
      // When the global key is missing, omit the text label entirely
      // so the row stays compact. The dotted toggle track + hover
      // tooltip communicate the state on its own; the just-in-time
      // confirm prompt explains the rest at click time.
      const labelHtml = keyOk
        ? `<span class="ap-skill-row-toggle-text">${enabled ? "enabled" : "disabled"}</span>`
        : "";
      middleCell = `
        <button type="button" class="${cls}"
          data-ap-ws-toggle
          data-agent-slug="${escape(agentSlug || "")}"
          data-enabled="${enabled ? "1" : "0"}"
          data-key-configured="${keyOk ? "1" : "0"}"
          data-provider="${escape(provider)}"
          aria-pressed="${enabled ? "true" : "false"}"
          title="${escape(titleText)}">
          <span class="ap-skill-row-toggle-track"><span class="ap-skill-row-toggle-knob"></span></span>
          ${labelHtml}
        </button>
      `;
    }

    return `
      <div class="ap-skill-row${isSystem ? " ap-skill-row-system" : ""}${skill.slug === "web-search" ? " ap-skill-row-web-search" : ""}" data-ap-skill-row data-skill-id="${escape(skill.id)}" title="${escape(titleText)}">
        <span class="ap-skill-row-mark">${mark}</span>
        <span class="ap-skill-row-name">${escape(skill.name)}</span>
        ${middleCell}
        <button type="button" class="ap-skill-row-menu" data-ap-skill-info data-tip='${escape(tipsAttr)}' aria-label="Skill details" title="Details">⋯</button>
      </div>
    `;
  }

  /** Render the Skills block shell. Real content (radar, list) is filled
   *  in by loadSkillsForV2 after the API fetch. */
  function renderSkillsBlockV2(slug, isChair) {
    const cap = isChair ? SKILL_CAP.chair : SKILL_CAP.director;
    return `
      <div class="ap-skills-v2" data-ap-skills data-slug="${escape(slug)}" data-cap="${cap}">
        <div class="ap-skills-radar-wrap" data-ap-skills-radar>${renderRadar(slug, [])}</div>
        <div class="ap-skills-list" data-ap-skills-list>
          <div class="ap-empty">loading skills…</div>
        </div>
        <div class="ap-skills-drop" data-ap-skills-drop tabindex="0" role="button" aria-label="Install a skill from a .md file">
          <input type="file" accept=".md,text/markdown,text/plain" data-ap-skills-file hidden>
          <span class="ap-skills-drop-mark">⊕</span>
          <span class="ap-skills-drop-text">install skill · drop a <code>.md</code> file or click</span>
        </div>
      </div>
    `;
  }

  /** Fetch the agent's skills, repaint the radar + list, update header
   *  count tag, and gate the drop-zone when the cap is reached. */
  async function loadSkillsForV2(slug) {
    const block = document.querySelector(`[data-ap-skills][data-slug="${slug}"]`);
    if (!block) return;
    const list = block.querySelector("[data-ap-skills-list]");
    const radarWrap = block.querySelector("[data-ap-skills-radar]");
    const drop = block.querySelector("[data-ap-skills-drop]");
    const cap = parseInt(block.getAttribute("data-cap") || "5", 10);
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(slug) + "/skills");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        list.innerHTML = `<div class="ap-empty">${escape(uiT("ap_skills_load_fail", { detail: String(j.error || ("HTTP " + r.status)) }))}</div>`;
        return;
      }
      const { skills } = await r.json();
      // System skills don't count toward the user-installable cap — they
      // ride along on top.
      const userSkills = skills.filter((s) => !s.system);
      const userCount = userSkills.length;
      // Header count tag (e.g. "3 / 5 installed").
      const card = block.closest(".ap-block");
      const countTag = card?.querySelector("[data-ap-skills-count]");
      if (countTag) countTag.textContent = uiT("ap_skills_installed", { current: userCount, cap });
      // Radar reflects user skills only — the system skill has no
      // turn-time ability deltas (it runs at brief time).
      if (radarWrap) radarWrap.innerHTML = renderRadar(slug, userSkills);
      // List · render system skills first, then user skills. Empty state
      // (no skills at all) intentionally renders nothing.
      if (list) {
        list.innerHTML = skills.length === 0 ? "" : skills.map((s) => renderSkillRow(s, slug)).join("");
        list.hidden = skills.length === 0;
      }
      // Drop-zone gate · gated by user-installable cap, not total.
      if (drop) {
        if (userCount >= cap) {
          drop.classList.add("disabled");
          drop.setAttribute("aria-disabled", "true");
          const txt = drop.querySelector(".ap-skills-drop-text");
          if (txt) txt.textContent = uiT("ap_skills_cap_reached", { current: userCount, cap });
        } else {
          drop.classList.remove("disabled");
          drop.removeAttribute("aria-disabled");
          const txt = drop.querySelector(".ap-skills-drop-text");
          if (txt) txt.innerHTML = uiT("ap_skills_drop_hint");
        }
      }
    } catch (e) {
      list.innerHTML = `<div class="ap-empty">${escape(uiT("ap_skills_load_fail", { detail: String(e && e.message ? e.message : e) }))}</div>`;
    }
  }

  async function installSkillFromText(slug, mdText) {
    const r = await fetch("/api/agents/" + encodeURIComponent(slug) + "/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ md: mdText }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + r.status));
    }
    return r.json();
  }
  /** Open a fixed-position popover anchored above the trigger button.
   *  Reads serialized skill payload from the trigger's data-tip JSON.
   *  Folds info + uninstall into a single menu so the row stays
   *  single-line dense (no separate × button). */
  function openSkillInfoPopover(trigger) {
    // Tear down any existing popover.
    const existing = document.getElementById("ap-skill-info-pop");
    if (existing) existing.remove();
    let payload = null;
    try { payload = JSON.parse(trigger.getAttribute("data-tip") || ""); } catch (_) {}
    if (!payload) return;
    const tipsHtml = (payload.tips || []).length
      ? `<ul class="ap-skill-info-tips">${(payload.tips || []).map((t) => `<li>${escape(t)}</li>`).join("")}</ul>`
      : `<div class="ap-skill-info-empty">no tips provided</div>`;
    // Full ability block when present.
    const abilityEntries = SKILL_AXES
      .filter((a) => payload.ability && typeof payload.ability[a] === "number" && payload.ability[a] !== 0)
      .map((a) => {
        const v = payload.ability[a];
        const sign = v > 0 ? "+" : "";
        const cls = v > 0 ? "pos" : "neg";
        return `<span class="ap-sd"><span class="ap-sd-l">${SKILL_AXIS_LABEL[a].toLowerCase()}</span><span class="ap-sd-v ${cls}">${sign}${v}</span></span>`;
      })
      .join("");
    const block = trigger.closest("[data-ap-skills]");
    const slug = block?.getAttribute("data-slug") || "";
    const pop = document.createElement("div");
    pop.id = "ap-skill-info-pop";
    pop.className = "ap-skill-info-pop";
    const isSystem = !!payload.system;
    const headBadge = isSystem
      ? `<span class="ap-skill-info-sys-badge" title="System skill · cannot be modified">system</span>`
      : "";
    // Web-search · when the global Brave key is missing, surface a
    // "Configure key" action right inside the popover so users can
    // reach Preferences from either the toggle OR the ⋯ menu. The
    // state field is the same one ferried in via the row's data-tip.
    const wsState = payload.state || null;
    const wsNeedsKey = isSystem
      && payload.slug === "web-search"
      && wsState
      && !wsState.keyConfigured;
    const wsProvider = wsState && wsState.requiresKey && wsState.requiresKey.provider
      ? wsState.requiresKey.provider
      : "brave";
    const actionsHtml = isSystem
      ? `
        ${wsNeedsKey ? `
          <div class="ap-skill-info-actions">
            <button type="button" class="ap-skill-info-configure" data-ap-ws-configure data-provider="${escape(wsProvider)}">
              <span class="ap-skill-info-configure-mark">↗</span>
              <span>${escape(uiT("ag_ws_configure_key"))}</span>
            </button>
          </div>
        ` : ""}
        <div class="ap-skill-info-locked"><span class="ap-skill-info-locked-mark">⊙</span><span>system skill · cannot be uninstalled or edited</span></div>
      `
      : `<div class="ap-skill-info-actions"><button type="button" class="ap-skill-info-uninstall" data-ap-skill-popover-uninstall data-skill-id="${escape(payload.id || "")}" data-slug="${escape(slug)}">⊘ uninstall</button></div>`;
    pop.innerHTML = `
      <div class="ap-skill-info-head">${escape(payload.name || "Skill")}${headBadge}</div>
      <div class="ap-skill-info-sub">${escape(payload.slug || "")} · v${escape(payload.version || "1.0")}</div>
      ${payload.description ? `<div class="ap-skill-info-desc">${escape(payload.description)}</div>` : ""}
      ${payload.whenToUse && payload.whenToUse !== payload.description
        ? `<div class="ap-skill-info-when"><span class="lbl">when to use</span>${escape(payload.whenToUse)}</div>`
        : ""}
      ${abilityEntries
        ? `<div class="ap-skill-info-ability"><span class="lbl">ability deltas</span><div class="ap-skill-info-ability-row">${abilityEntries}</div></div>`
        : ""}
      <div class="ap-skill-info-tips-wrap"><span class="lbl">tips</span>${tipsHtml}</div>
      ${actionsHtml}
    `;
    document.body.appendChild(pop);
    const rect = trigger.getBoundingClientRect();
    const popW = 300;
    let left = rect.left + (rect.width / 2) - (popW / 2);
    if (left < 8) left = 8;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    pop.style.left = `${left}px`;
    // Prefer above; flip below if there's no room.
    const above = rect.top - 8;
    pop.style.top = `${above}px`;
    pop.style.transform = "translateY(-100%)";
    if (above < 8) {
      pop.style.top = `${rect.bottom + 8}px`;
      pop.style.transform = "none";
    }
  }

  async function uninstallSkillReq(slug, skillId) {
    const r = await fetch(
      "/api/agents/" + encodeURIComponent(slug) + "/skills/" + encodeURIComponent(skillId),
      { method: "DELETE" },
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + r.status));
    }
  }

  /** Split "Room #047" → { label: "ROOM", id: "#047" }. Falls back to
   *  treating the whole string as the id when there's no label part. */
  function parseMemoryNum(raw) {
    if (!raw) return { label: "ROOM", id: "—" };
    const s = String(raw).trim();
    const m = /^([A-Za-z]+)\s*(#?\s*[\w-]+)$/.exec(s);
    if (m) return { label: m[1].toUpperCase(), id: m[2].replace(/\s+/g, "") };
    return { label: "ROOM", id: s };
  }

  /** Render the inner contents of a memory tile when opened. */
  function renderMemoryDetail(p, key) {
    if (!p) return "";
    if (key === "user") {
      const u = p.memory && p.memory.aboutUser;
      if (!u) return "";
      return `
        <div class="ap-memory-detail-head">
          <div class="ap-memory-detail-num">YOU</div>
          <div class="ap-memory-detail-name">${escape(u.headline || "About you")}</div>
        </div>
        ${u.summary && u.summary.length
          ? `<div class="ap-memory-detail-body">${u.summary.map((s) => `<p>${escape(s)}</p>`).join("")}</div>`
          : `<div class="ap-empty">no notes</div>`}
      `;
    }
    const m = /^room:(\d+)$/.exec(key || "");
    if (!m) return "";
    const idx = parseInt(m[1], 10);
    const r = (p.memory && p.memory.rooms || [])[idx];
    if (!r) return "";
    return `
      <div class="ap-memory-detail-head">
        <div class="ap-memory-detail-num">${escape(r.num || "—")}</div>
        <div>
          <div class="ap-memory-detail-name">${escape(r.name || "Untitled room")}</div>
          ${r.stats ? `
            <div class="ap-memory-detail-stats">
              ${r.stats.sessions ? escape(r.stats.sessions + " sess") : ""}
              ${r.stats.turns ? " · " + escape(r.stats.turns + " turns") : ""}
              ${r.stats.last ? " · last " + escape(r.stats.last) : ""}
            </div>
          ` : ""}
        </div>
      </div>
      ${r.summary ? `<p class="ap-memory-detail-summary">${escape(r.summary)}</p>` : ""}
      ${Array.isArray(r.lessons) && r.lessons.length ? `
        <ul class="ap-memory-detail-lessons">
          ${r.lessons.map((l) => `<li>${escape(l)}</li>`).join("")}
        </ul>
      ` : ""}
    `;
  }

  /* ─── Persona dossier overlay ──────────────────────────
     Full-screen modal that previews the persona.md content. Opens
     from the dossier card in the main column. Fetches the route
     once per open (no caching · the file is small and downloads
     are cheap), renders via the in-file renderMarkdown helper, and
     surfaces a Download button that hits the same endpoint with
     the browser's native download path. Closed on backdrop click
     or Escape. */
  let _personaOverlayEsc = null;
  function openPersonaOverlay(slug, agentName) {
    closePersonaOverlay();
    const overlay = document.createElement("div");
    overlay.id = "ap-persona-overlay";
    overlay.className = "ap-persona-overlay";
    overlay.innerHTML = `
      <div class="ap-persona-overlay-backdrop" data-ap-persona-close></div>
      <div class="ap-persona-overlay-modal" role="dialog" aria-modal="true" aria-label="Persona dossier">
        <div class="ap-persona-overlay-classification">
          <span><span class="dot">●</span> CLASSIFIED · DIRECTOR DOSSIER</span>
          <span class="right">${escape(agentName || "")}</span>
        </div>
        <div class="ap-persona-overlay-head">
          <div class="ap-persona-overlay-title">Persona dossier</div>
          <div class="ap-persona-overlay-actions">
            <a class="ap-persona-overlay-dl" href="/api/agents/${encodeURIComponent(slug)}/persona.md" download>
              <span aria-hidden="true">↓</span> Download .md
            </a>
            <button type="button" class="ap-persona-overlay-close" data-ap-persona-close aria-label="Close">✕</button>
          </div>
        </div>
        <div class="ap-persona-overlay-body" data-ap-persona-body>
          <div class="ap-persona-overlay-loading">Decrypting dossier…</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.classList.add("ap-persona-overlay-open");
    _personaOverlayEsc = (ev) => {
      if (ev.key === "Escape") {
        ev.stopImmediatePropagation();
        closePersonaOverlay();
      }
    };
    document.addEventListener("keydown", _personaOverlayEsc, true);
    // Fetch + render. Same-origin so credentials default. The
    // fetch path returns text/markdown; we feed it straight into
    // the existing renderMarkdown helper.
    fetch(`/api/agents/${encodeURIComponent(slug)}/persona.md`, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((md) => {
        const body = overlay.querySelector("[data-ap-persona-body]");
        if (!body) return;
        body.innerHTML = `<div class="ap-persona-overlay-md">${renderMarkdown(md)}</div>`;
      })
      .catch((err) => {
        const body = overlay.querySelector("[data-ap-persona-body]");
        if (!body) return;
        body.innerHTML = `<div class="ap-persona-overlay-error">Could not load dossier · ${escape(String(err && err.message ? err.message : err))}</div>`;
      });
  }
  function closePersonaOverlay() {
    const el = document.getElementById("ap-persona-overlay");
    if (el) el.remove();
    document.body.classList.remove("ap-persona-overlay-open");
    if (_personaOverlayEsc) {
      document.removeEventListener("keydown", _personaOverlayEsc, true);
      _personaOverlayEsc = null;
    }
  }

  /* ─── Build-log overlay ────────────────────────────────
     Sibling to the persona dossier overlay. Reads the buildLog from
     window.app.agentsById[slug].personaSpec.buildLog (already on the
     client — the spec rides the agent payload). Renders:
       · the narrator's pitch summary (hero block)
       · a 7-phase timeline rail with per-phase blurbs
       · dimension-card grid stitched under phase 2 from the
         `dimension-plan` event + matching `search` events
       · footer stats: voice-uniqueness · tokens · duration
     Closed on backdrop click or Escape. */
  let _buildLogOverlayEsc = null;
  function openBuildLogOverlay(slug, agentName) {
    closeBuildLogOverlay();
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    const spec = live && live.personaSpec ? live.personaSpec : null;
    const buildLog = spec && spec.buildLog ? spec.buildLog : null;
    if (!buildLog) return; // safety · the entry point is hidden in this case anyway

    const overlay = document.createElement("div");
    overlay.id = "ap-buildlog-overlay";
    overlay.className = "ap-buildlog-overlay";
    overlay.innerHTML = `
      <div class="ap-buildlog-overlay-backdrop" data-ap-buildlog-close></div>
      <div class="ap-buildlog-overlay-modal" role="dialog" aria-modal="true" aria-label="${escape(uiT("ap_build_log"))}">
        <div class="ap-buildlog-overlay-classification">
          <span><span class="dot">●</span> ${escape(uiT("ap_build_log_kicker"))}</span>
          <span class="right">${escape(agentName || "")}</span>
        </div>
        <div class="ap-buildlog-overlay-head">
          <div class="ap-buildlog-overlay-title">${escape(uiT("ap_build_log"))}</div>
          <div class="ap-buildlog-overlay-actions">
            <button type="button" class="ap-buildlog-overlay-close" data-ap-buildlog-close aria-label="${escape(uiT("ap_build_close"))}">✕</button>
          </div>
        </div>
        <div class="ap-buildlog-overlay-body">
          ${renderBuildLogBody(buildLog)}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.classList.add("ap-buildlog-overlay-open");
    _buildLogOverlayEsc = (ev) => {
      if (ev.key === "Escape") {
        ev.stopImmediatePropagation();
        closeBuildLogOverlay();
      }
    };
    document.addEventListener("keydown", _buildLogOverlayEsc, true);
  }

  function closeBuildLogOverlay() {
    const el = document.getElementById("ap-buildlog-overlay");
    if (el) el.remove();
    document.body.classList.remove("ap-buildlog-overlay-open");
    if (_buildLogOverlayEsc) {
      document.removeEventListener("keydown", _buildLogOverlayEsc, true);
      _buildLogOverlayEsc = null;
    }
  }

  /** Render the modal body · narrative hero + 7-phase timeline +
   *  dimension cards under phase 2 + footer stats. Pure HTML string. */
  function renderBuildLogBody(buildLog) {
    const events = Array.isArray(buildLog.events) ? buildLog.events : [];
    const narrative = typeof buildLog.narrative === "string" ? buildLog.narrative.trim() : "";

    // Collect dimensions + searches by walking the event log once.
    let dimensionPlan = [];
    const searchesByDim = new Map();
    const topupSearches = [];
    const phaseEnd = new Map(); // phase → durationMs
    let divergenceScore = null;
    for (const e of events) {
      if (e.kind === "dimension-plan" && Array.isArray(e.dimensions)) {
        dimensionPlan = e.dimensions;
      } else if (e.kind === "search") {
        if (e.topup) {
          topupSearches.push(e);
        } else if (e.dimension) {
          const cur = searchesByDim.get(e.dimension) || { count: 0, sources: 0, queries: [] };
          cur.count += 1;
          cur.sources += (typeof e.pagesRead === "number" ? e.pagesRead : 0);
          cur.queries.push(e.query);
          searchesByDim.set(e.dimension, cur);
        }
      } else if (e.kind === "phase-end" && typeof e.phase === "number") {
        phaseEnd.set(e.phase, typeof e.durationMs === "number" ? e.durationMs : 0);
      } else if (e.kind === "divergence") {
        divergenceScore = (typeof e.score === "number") ? e.score : null;
      }
    }

    // Narrative hero. Empty narrative → show a localised fallback line
    // so the modal doesn't open with an empty top half.
    const narrativeHTML = narrative.length > 0
      ? `<div class="ap-buildlog-narrative">${narrative.split(/\n\n+/).map((p) => `<p>${escape(p.trim())}</p>`).join("")}</div>`
      : `<div class="ap-buildlog-narrative ap-buildlog-narrative-empty"><p>${escape(uiT("ap_build_log_no_narrative"))}</p></div>`;

    // Timeline · 7 cards. Phase 2 expands to a dimension grid
    // beneath the card. We render all 7 even if some events are
    // missing (e.g. aborted-then-resumed builds) — missing phases
    // just don't show a duration.
    const phaseCards = [1, 2, 3, 4, 5, 6, 7].map((n) => {
      const num = String(n).padStart(2, "0");
      const label = escape(uiT("ap_build_phase_" + n));
      const blurb = escape(uiT("ap_build_phase_" + n + "_blurb"));
      const dur = phaseEnd.get(n);
      const durText = (typeof dur === "number" && dur > 0)
        ? `<span class="ap-buildlog-phase-dur">${Math.max(1, Math.round(dur / 1000))}s</span>`
        : "";
      let extras = "";
      if (n === 2) {
        // Dimension grid under the research-phase card.
        const dimCards = dimensionPlan.map((d) => {
          const stats = searchesByDim.get(d.dimension) || { sources: 0, count: 0 };
          const why = d.why ? escape(d.why) : escape(d.query || "");
          const sources = uiT("ap_build_sources_short", { n: stats.sources });
          return `
            <div class="ap-buildlog-dim">
              <div class="ap-buildlog-dim-name">${escape(d.dimension)}</div>
              <div class="ap-buildlog-dim-why">${why}</div>
              <div class="ap-buildlog-dim-stat">${escape(sources)}</div>
            </div>
          `;
        }).join("");
        const topupBlock = topupSearches.length > 0
          ? `
            <div class="ap-buildlog-topup">
              <div class="ap-buildlog-topup-label">${escape(uiT("ap_build_topup_label"))}</div>
              <ul class="ap-buildlog-topup-list">
                ${topupSearches.map((t) => `<li>“${escape(t.query)}” · ${escape(uiT("ap_build_sources_short", { n: typeof t.pagesRead === "number" ? t.pagesRead : 0 }))}</li>`).join("")}
              </ul>
            </div>`
          : "";
        if (dimensionPlan.length > 0 || topupSearches.length > 0) {
          extras = `
            <div class="ap-buildlog-phase-extras">
              ${dimensionPlan.length > 0 ? `
                <div class="ap-buildlog-dims-label">${escape(uiT("ap_build_dimensions_label"))}</div>
                <div class="ap-buildlog-dims-grid">${dimCards}</div>
              ` : ""}
              ${topupBlock}
            </div>
          `;
        }
      }
      return `
        <li class="ap-buildlog-phase">
          <div class="ap-buildlog-phase-head">
            <span class="ap-buildlog-phase-num">${num}</span>
            <span class="ap-buildlog-phase-label">${label}</span>
            ${durText}
          </div>
          <p class="ap-buildlog-phase-blurb">${blurb}</p>
          ${extras}
        </li>
      `;
    }).join("");

    // Footer stats.
    const totalTokens = typeof buildLog.totalTokens === "number" ? buildLog.totalTokens : 0;
    const totalDurationMs = Array.from(phaseEnd.values()).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
    const totalDurationSec = Math.round(totalDurationMs / 1000);
    const divergencePct = (divergenceScore === null || typeof divergenceScore !== "number")
      ? "—"
      : (Math.round(divergenceScore * 100) + "%");
    const tokensFmt = totalTokens > 0 ? totalTokens.toLocaleString() : "—";
    const durFmt = totalDurationSec > 0
      ? (totalDurationSec >= 60
        ? `${Math.floor(totalDurationSec / 60)}m ${totalDurationSec % 60}s`
        : `${totalDurationSec}s`)
      : "—";

    return `
      ${narrativeHTML}
      <ol class="ap-buildlog-timeline">${phaseCards}</ol>
      <footer class="ap-buildlog-footer">
        <div class="ap-buildlog-stat">
          <div class="ap-buildlog-stat-l">${escape(uiT("ap_build_divergence_label"))}</div>
          <div class="ap-buildlog-stat-v">${escape(divergencePct)}</div>
        </div>
        <div class="ap-buildlog-stat">
          <div class="ap-buildlog-stat-l">${escape(uiT("ap_build_tokens_label"))}</div>
          <div class="ap-buildlog-stat-v">${escape(tokensFmt)}</div>
        </div>
        <div class="ap-buildlog-stat">
          <div class="ap-buildlog-stat-l">${escape(uiT("ap_build_duration_label"))}</div>
          <div class="ap-buildlog-stat-v">${escape(durFmt)}</div>
        </div>
      </footer>
    `;
  }

  /* ─── Profile · ⋯ menu (top-right of the cover) ─────
     Small popover anchored to the menu button with one or more
     actions. v1 ships a single "regenerate 8-bit avatar" item. */
  function openProfileIdMenu(anchor) {
    closeProfileIdMenu();
    const slug = anchor.getAttribute("data-slug");
    if (!slug) return;
    // Chair has a fixed identity across rooms; the avatar is part of
    // their recognisability, so we lock the regen action and surface
    // a disabled item with a "why" so users don't wonder where it
    // went. Server-side PATCH also rejects avatar changes for the
    // moderator (defense in depth).
    //
    // Delete · only surfaced for user-created (non-seed, non-chair)
    // directors. Sits at the bottom of the menu under a hairline
    // divider so it reads as a destructive action separate from the
    // routine ones.
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    const isChair = !!(live && live.roleKind === "moderator");
    const isSeed = !!(live && live.isSeed);
    const isCustom = !!live && !isChair && !isSeed;
    const parts = [];
    if (isChair) {
      parts.push(`
        <div class="ap-id-menu-item disabled" aria-disabled="true">
          <span class="ap-id-menu-mark">⊘</span>
          <span>Avatar locked · chair identity is fixed</span>
        </div>`);
    } else {
      parts.push(`
        <button type="button" class="ap-id-menu-item" data-ap-menu-action="regen-avatar">
          <span class="ap-id-menu-mark">◆</span>
          <span>Regenerate 8-bit avatar</span>
        </button>`);
      parts.push(`
        <button type="button" class="ap-id-menu-item" data-ap-menu-action="edit-avatar3d">
          <span class="ap-id-menu-mark">◈</span>
          <span>Customize 3D avatar</span>
        </button>`);
    }
    // Persona MD download · only present for Full-mode agents (those
    // built via the deep persona-builder pipeline). Their `personaSpec`
    // field carries the 7-phase artifact; the route renders it as
    // Markdown. Hidden for Signal-mode agents and seeded directors —
    // they have no spec to export.
    const hasPersonaSpec = !!(live && live.personaSpec);
    if (hasPersonaSpec) {
      parts.push(`<div class="ap-id-menu-divider" aria-hidden="true"></div>`);
      parts.push(`
        <a class="ap-id-menu-item" href="/api/agents/${encodeURIComponent(slug)}/persona.md" target="_blank" rel="noopener" data-ap-menu-action="persona-md">
          <span class="ap-id-menu-mark">↓</span>
          <span>Download persona.md</span>
        </a>`);
    }
    if (isCustom) {
      parts.push(`<div class="ap-id-menu-divider" aria-hidden="true"></div>`);
      parts.push(`
        <button type="button" class="ap-id-menu-item ap-id-menu-item-danger" data-ap-menu-action="delete">
          <span class="ap-id-menu-mark">✕</span>
          <span>Delete director</span>
        </button>`);
    }
    const pop = document.createElement("div");
    pop.id = "ap-id-menu-pop";
    pop.className = "ap-id-menu-pop";
    pop.dataset.slug = slug;
    pop.innerHTML = parts.join("");
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  }
  function closeProfileIdMenu() {
    const el = document.getElementById("ap-id-menu-pop");
    if (el) el.remove();
  }

  /** Render a fresh 3D voxel portrait and persist it as the agent's
   *  avatar. Updates the live store so subsequent renders use the
   *  new image, then repaints the profile in place. Uses the shared
   *  Avatar3DSnap helper (same pipeline the agent-profile capture
   *  and home / new-agent flows go through) — no more 8-bit SVG.
   *  Seeded directors fall back to a localStorage override (the
   *  server only stores user-created agents). */
  async function regenerateProfileAvatar(slug) {
    const snap = window.Avatar3DSnap;
    if (!snap || typeof snap.generate !== "function") return;
    const seed = snap.randomSeed();
    const dataUrl = await snap.generate(seed);
    if (!dataUrl) return;
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    if (live) {
      try {
        const res = await fetch("/api/agents/" + encodeURIComponent(slug), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ avatarPath: dataUrl }),
        });
        if (!res.ok) throw new Error("avatar update failed");
        const updated = await res.json();
        // Refresh the in-memory roster so the sidebar + room views
        // pick up the new avatar.
        live.avatarPath = updated.avatarPath || dataUrl;
        if (typeof window.app.refreshAgents === "function") {
          await window.app.refreshAgents();
        } else if (typeof window.app.renderSidebarAgents === "function") {
          window.app.renderSidebarAgents();
        }
      } catch (e) {
        console.error("[profile] regenerate avatar failed", e);
        alert("Couldn't save the new avatar: " + (e && e.message ? e.message : e));
        return;
      }
    } else {
      // Seeded profile · stash an override locally so the profile
      // view shows the new look on this device.
      try {
        localStorage.setItem("boardroom.agent.avatar." + slug, dataUrl);
      } catch (_) {}
      const seeded = PROFILES[slug];
      if (seeded) seeded.avatar = dataUrl;
    }
    // Repaint the profile in-place so the new avatar shows.
    const v = getMainViews();
    if (v.agent && !v.agent.hasAttribute("hidden")) open(slug);
  }

  /** Resolve a profile object from a slug · seeded first, then live. */
  function profileForSlug(slug) {
    let p = PROFILES[slug];
    if (!p) {
      const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
      p = buildLiveProfile(live);
    }
    return p || null;
  }

  function openMemoryOverlay(slug, key) {
    closeMemoryOverlay();
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    const p = PROFILES[slug] || buildLiveProfile(live);
    if (!p) return;
    const wrap = document.createElement("div");
    wrap.id = "ap-memory-overlay";
    wrap.className = "ap-memory-overlay";
    wrap.innerHTML = `
      <div class="ap-memory-overlay-backdrop" data-ap-memory-close></div>
      <div class="ap-memory-overlay-card" role="dialog" aria-modal="true">
        <button type="button" class="ap-memory-overlay-close" data-ap-memory-close aria-label="close">×</button>
        ${renderMemoryDetail(p, key)}
      </div>
    `;
    document.body.appendChild(wrap);
  }
  function closeMemoryOverlay() {
    const el = document.getElementById("ap-memory-overlay");
    if (el) el.remove();
  }

  /** Strip the small inline <span> markup that the seeded PROFILES use
   *  for emphasized terms — we want plain text in the new chrome. */
  function stripTagsToText(html) {
    return String(html || "").replace(/<\/?[^>]+>/g, "");
  }

  /* ─── Base-model selection ────────────────────────
     Latest tier only — older lines (Sonnet 4.6, GPT-5, Gemini 2.5,
     Grok 4 mini, etc.) were retired per the user's brief. Per-director
     choice persists in localStorage so tweaks survive a page reload. */
  // Curated latest mainstream lineup · ids verified against the live
  // OpenRouter catalog (https://openrouter.ai/api/v1/models). Each
  // entry's `v` resolves through src/ai/registry.ts to the dated
  // OpenRouter id, so verify + room calls hit the right model.
  const PROFILE_MODELS = [
    // Anthropic
    { v: "opus-4-7",        name: "Claude Opus 4.7",      provider: "Anthropic", deck: "deep reasoning · default" },
    { v: "sonnet-4-6",      name: "Claude Sonnet 4.6",    provider: "Anthropic", deck: "balanced · 1M ctx" },
    { v: "opus-4-6-fast",   name: "Claude Opus 4.6 Fast", provider: "Anthropic", deck: "faster 4.6 · same intelligence" },
    { v: "haiku-4-5",       name: "Claude Haiku 4.5",     provider: "Anthropic", deck: "fast · low-cost" },
    // OpenAI
    { v: "gpt-5-5",         name: "GPT-5.5",           provider: "OpenAI",    deck: "1M ctx" },
    { v: "gpt-5-4",         name: "GPT-5.4",           provider: "OpenAI",    deck: "general · 1M ctx" },
    { v: "gpt-5-4-mini",    name: "GPT-5.4 Mini",      provider: "OpenAI",    deck: "fast · 400k ctx" },
    { v: "codex-5-4",       name: "ChatGPT Codex 5.4", provider: "OpenAI",    deck: "code · agents" },
    // Google
    { v: "gemini-3-1",      name: "Gemini 3.1 Pro",    provider: "Google",    deck: "multimodal · 1M ctx" },
    { v: "gemini-3-1-flash",name: "Gemini 3.1 Flash",  provider: "Google",    deck: "fast · 1M ctx" },
    // DeepSeek
    { v: "deepseek-v4-pro", name: "DeepSeek V4 Pro",   provider: "DeepSeek",  deck: "reasoning · open weights" },
    { v: "deepseek-v4-flash", name: "DeepSeek Lite",   provider: "DeepSeek",  deck: "V4 Flash · fast · 1M ctx" },
    // Zhipu · Moonshot · MiniMax (all B.AI routed)
    { v: "glm-5-1",         name: "GLM 5.1",           provider: "Zhipu",     deck: "Zhipu flagship · 200k ctx" },
    { v: "kimi-k2-6",       name: "Kimi K2.6",         provider: "Moonshot",  deck: "long-context" },
    { v: "minimax-m2-7",    name: "MiniMax M2.7",      provider: "MiniMax",   deck: "flagship · long-context" },
    { v: "minimax-m2-5",    name: "MiniMax M2.5",      provider: "MiniMax",   deck: "prior · long-context" }
  ];
  function modelKey(slug) { return "boardroom.agent.model." + slug; }

  /** Helpers · provider label + tiny route badge. Mirrors the same
   *  helpers in app.js so the visual vocabulary (direct / OR /
   *  direct · OR) stays consistent across all pickers. */
  function providerLabel(p) {
    switch (p) {
      case "anthropic": return "Anthropic";
      case "openai":    return "OpenAI";
      case "google":    return "Google";
      case "xai":       return "xAI";
      case "deepseek":  return "DeepSeek";
      case "openrouter":return "OpenRouter";
      default:          return p || "?";
    }
  }
  function modelRouteBadge(m) {
    // Carrier tag shown in the picker after each model name. The
    // provider is already the group header above each cluster, so
    // this badge stays short — just the route family — to fit the
    // tiny uppercase-mono pill (`.ap-model-opt-route`) cleanly:
    //   · "direct"        · only the provider's direct API
    //   · "OR"            · only OpenRouter
    //   · "direct · OR"   · both available (direct preferred)
    // Mirrors `app.js → modelRouteBadge` so the visual vocabulary
    // stays consistent across every model picker on the page.
    const d = !!(m && m.routes && m.routes.direct);
    const o = !!(m && m.routes && m.routes.openrouter);
    if (d && o) return "direct · OR";
    if (d) return "direct";
    if (o) return "OR";
    return "";
  }

  /** Read the shared /api/models cache · null until the first
   *  fetch resolves. Picker fall-back chain: cache.reachable →
   *  PROFILE_MODELS hardcoded list → first option in either.  */
  function modelsSnapshot() {
    return (typeof window.boardroomModels === "function") ? window.boardroomModels() : null;
  }

  /** All entries the picker is willing to OFFER. Each carrier-reachable
   *  combination of (modelV × carrier) becomes its own row so the user
   *  can pick e.g. `GPT-5.5 via OpenAI direct` vs `GPT-5.5 via OpenRouter`
   *  when both keys are configured. When only one carrier serves a
   *  model, a single row is emitted with `carrier: null` (saved as
   *  `agent.carrierPref = null` → adapter routes by default precedence).
   *
   *  Entry shape · { id, v, carrier, name, provider, deck, route }
   *    id      · composite picker key, format `${v}@${carrier}` or `${v}`.
   *              Used as the click-handler payload + active-row marker.
   *    v       · modelV string (always; the registry id).
   *    carrier · "openrouter" | "<provider>" | null (null when one route).
   *    route   · short label rendered as the right-edge pill.            */
  function pickerEntries() {
    const cache = modelsSnapshot();
    // Multi-SIM credential model · the user has exactly one active
    // LLM provider at a time, so each reachable model maps to one
    // pickable row (no carrier fork). `cache.reachable` is filtered
    // server-side based on `prefs.active_llm_credential_id`, so the
    // picker naturally collapses to the active provider's family.
    if (cache && Array.isArray(cache.reachable) && cache.reachable.length > 0) {
      return cache.reachable.map((m) => ({
        id: m.modelV,
        v: m.modelV,
        carrier: null,
        name: m.displayName,
        provider: providerLabel(m.provider),
        deck: m.deck || "",
        route: "",
      }));
    }
    // Cache not yet loaded · return an empty list. The renderer will
    // show whatever stale info the agent's saved modelV resolves to
    // and re-fetch the cache. We deliberately AVOID falling back to
    // the hardcoded PROFILE_MODELS catalog here — that would surface
    // models the user's credential can't reach (e.g. showing Claude
    // when the active credential is OpenAI direct).
    return [];
  }

  /** Look up a single entry by composite id (`${v}@${carrier}` or
   *  bare `${v}`) across the cache + the registry mirror. Returns
   *  null when neither the modelV nor the carrier combination is
   *  recognised — used to render the agent's currently-stored model
   *  even if it's not in the offer list (i.e. unreachable). */
  function lookupEntry(id) {
    if (!id) return null;
    // Split composite id; bare `${v}` parses as { v, carrier: null }.
    const at = id.indexOf("@");
    const v = at >= 0 ? id.slice(0, at) : id;
    const carrier = at >= 0 ? id.slice(at + 1) : null;
    const cache = modelsSnapshot();
    if (cache && Array.isArray(cache.models)) {
      const fromCache = cache.models.find((m) => m.modelV === v);
      if (fromCache) {
        const provider = providerLabel(fromCache.provider);
        const route = carrier === "openrouter"
          ? "via OpenRouter"
          : carrier === fromCache.provider
            ? "via " + provider + " direct"
            : modelRouteBadge(fromCache);
        return {
          id: carrier ? v + "@" + carrier : v,
          v,
          carrier,
          name: fromCache.displayName,
          provider,
          deck: fromCache.deck || "",
          route,
          reachable: !!fromCache.reachable,
        };
      }
    }
    const fromList = PROFILE_MODELS.find((m) => m.v === v);
    if (fromList) return { ...fromList, id: v, carrier: null, route: "", reachable: false };
    return null;
  }

  /** Whether `v` is reachable RIGHT NOW given the user's keys.
   *  Returns true when the cache hasn't loaded yet (optimistic — the
   *  user can still click the trigger; the picker will repaint with
   *  the real list once the cache lands). */
  function isReachable(v) {
    const cache = modelsSnapshot();
    if (!cache || !Array.isArray(cache.reachable)) return true;
    return cache.reachable.some((m) => m.modelV === v);
  }

  /** Resolve the model record to render for an agent. Order of truth:
   *   1. live `agent.modelV` from the DB (the user's saved pick)
   *   2. localStorage per-device override (legacy / sticky picks)
   *   3. fallback param (matched by `v` first, then by name)
   *   4. first reachable / PROFILE_MODELS[0] as a last resort
   *
   *  We MAY return an unreachable entry (so the trigger displays the
   *  stored model truthfully); the caller checks `isReachable(entry.v)`
   *  to decide whether to show a stale-model warning. */
  function modelForAgent(slug, fallback) {
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    if (live && typeof live.modelV === "string") {
      // Compose the composite id from the agent's stored carrierPref
      // when present so multi-carrier models display the right pill
      // ("via OpenRouter" vs "via OpenAI direct"). NULL pref → bare id
      // (default-precedence routing).
      const id = live.carrierPref ? live.modelV + "@" + live.carrierPref : live.modelV;
      const liveHit = lookupEntry(id) || lookupEntry(live.modelV);
      if (liveHit) return liveHit;
    }
    try {
      const v = localStorage.getItem(modelKey(slug));
      if (v) {
        const hit = lookupEntry(v);
        if (hit) return hit;
      }
    } catch (_) {}
    if (fallback) {
      if (fallback.v) {
        const byV = lookupEntry(fallback.v);
        if (byV) return byV;
      }
      if (fallback.name) {
        const byName = PROFILE_MODELS.find((m) => m.name === fallback.name);
        if (byName) return { ...byName, id: byName.v, carrier: null, route: "", reachable: false };
      }
    }
    // Last resort · prefer the first reachable model so the displayed
    // entry actually works. Falls through to PROFILE_MODELS[0] if the
    // cache hasn't loaded.
    const offers = pickerEntries();
    return offers[0] || { ...PROFILE_MODELS[0], id: PROFILE_MODELS[0].v, carrier: null, route: "", reachable: false };
  }
  /** Persist the picked entry to the server. Ships both `modelV` and
   *  `carrierPref` so the adapter knows which carrier to pin (or null
   *  to fall back to default precedence). The local-storage cache only
   *  keeps modelV — sticky-carrier across reloads is fine to come
   *  exclusively from the server (single source of truth). */
  function setModelFor(slug, entry) {
    const v = entry && entry.v;
    if (!v) return;
    try { localStorage.setItem(modelKey(slug), v); } catch (_) {}
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    if (!live) return;
    const body = { modelV: v, carrierPref: entry.carrier ?? null };
    fetch("/api/agents/" + encodeURIComponent(slug), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (r) => {
        if (r.ok) return r.json();
        // Surface the SERVER's actual error string. Previously this
        // path threw a hardcoded "model save failed" which made bugs
        // (e.g. running server hadn't picked up a new model in the
        // registry) impossible to diagnose from the alert.
        const j = await r.json().catch(() => ({}));
        const detail = j && typeof j.error === "string" ? j.error : `HTTP ${r.status}`;
        throw new Error(detail);
      })
      .then((updated) => {
        // Reflect both fields in the in-memory roster so re-rendering
        // the trigger picks up the new carrier badge immediately.
        live.modelV = updated.modelV || v;
        live.carrierPref = updated.carrierPref ?? null;
        if (typeof window.app.refreshAgents === "function") {
          window.app.refreshAgents().catch(() => {});
        }
      })
      .catch((e) => {
        console.error("[profile] save model failed", e);
        alert("Couldn't save the model selection: " + (e && e.message ? e.message : e));
      });
  }
  function renderModelBlock(slug, fallback) {
    const current = modelForAgent(slug, fallback);
    const reachable = isReachable(current.v);
    // Stale-model warning · the agent's stored modelV isn't reachable
    // with the current key set (e.g. user revoked both OR + B.AI but
    // the agent was set to a viaUniversalOnly model). Surface
    // it as a small note under the trigger so the user knows clicks
    // here will fall back at runtime; the runtime resolver in
    // `effectiveDefaultModel()` does the actual fallback.
    const warning = reachable
      ? ""
      : `<div class="ap-model-stale" title="${escape(uiT("ap_model_stale_title"))}">
          <span class="ap-model-stale-mark">⚠</span>
          <span class="ap-model-stale-text">${escape(uiT("ap_model_stale_text"))}</span>
        </div>`;
    // Trigger meta line · show the route when present, fall back to
    // provider otherwise. We DROP the leading provider when the route
    // already names it (e.g. "via Google direct"), since "Google · via
    // Google direct" is just the same word twice and burns horizontal
    // space. When the route doesn't name the provider (e.g. "via
    // OpenRouter" on a Google model) we keep both so the user still
    // sees who built the model. */
    const triggerMeta = formatTriggerMeta(current);
    return `
      <div class="ap-model-row${reachable ? "" : " is-stale"}" data-ap-model-row data-slug="${escape(slug)}">
        <button type="button" class="ap-model-trigger" data-ap-model-trigger>
          <span class="ap-model-trigger-text">
            <span class="ap-model-trigger-name" data-ap-model-name>${escape(current.name)}</span>
            <span class="ap-model-trigger-provider" data-ap-model-provider>${escape(triggerMeta)}</span>
          </span>
          <span class="ap-model-trigger-caret">▾</span>
        </button>
        ${warning}
      </div>
    `;
  }

  function openModelPicker(triggerEl) {
    closeModelPicker();
    closeEmotionPicker();
    const row = triggerEl.closest("[data-ap-model-row]");
    const slug = row?.getAttribute("data-slug");
    if (!slug) return;
    const current = modelForAgent(slug);
    const offers = pickerEntries();
    const pop = document.createElement("div");
    pop.id = "ap-model-picker";
    pop.className = "ap-model-picker";
    pop.dataset.slug = slug;
    // Group by provider · same shape as the room composer's agent-model
    // dropdown · provider micro-header above each cluster, compact rows
    // with a single-line "name · deck" pair below + a tiny route badge
    // ("direct" / "OR" / "direct · OR") aligned to the right edge.
    const groups = [];
    let lastProv = null;
    for (const m of offers) {
      if (m.provider !== lastProv) {
        groups.push(`<div class="ap-model-group">${escape(m.provider || "")}</div>`);
        lastProv = m.provider;
      }
      const badge = m.route
        ? `<span class="ap-model-opt-route">${escape(m.route)}</span>`
        : "";
      groups.push(`
        <button type="button" class="ap-model-opt${m.id === current.id ? " active" : ""}" data-ap-model-pick="${escape(m.id)}">
          <span class="ap-model-opt-label">${escape(m.name)}</span>
          <span class="ap-model-opt-hint">${escape(m.deck || "")}</span>
          ${badge}
        </button>
      `);
    }
    pop.innerHTML = groups.join("");
    document.body.appendChild(pop);
    const r = triggerEl.getBoundingClientRect();
    const popW = 260;
    let left = Math.round(r.left);
    // Right-align if the trigger is wider than the popover so the
    // popover's right edge sits flush with the trigger's. Falls back
    // to the trigger's left edge when narrow.
    if (r.width > popW) left = Math.round(r.right - popW);
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    pop.style.left = `${left}px`;
    pop.style.width = `${popW}px`;
  }
  function closeModelPicker() {
    const el = document.getElementById("ap-model-picker");
    if (el) el.remove();
  }
  /** Build the secondary line under the model name on the closed
   *  trigger AND inside the picker rows. Centralised so the "drop the
   *  redundant leading provider when the route already names it" rule
   *  only lives in one place. */
  function formatTriggerMeta(entry) {
    const route = entry && entry.route ? String(entry.route) : "";
    const provider = entry && entry.provider ? String(entry.provider) : "";
    if (!route) return provider;
    // Drop the leading provider iff the route already mentions it
    // (case-insensitive substring check). Covers "via Google direct"
    // when provider is "Google", "via OpenAI direct" when provider is
    // "OpenAI", etc. Keeps "OpenAI · via OpenRouter" intact since the
    // route doesn't repeat the provider.
    if (provider && route.toLowerCase().includes(provider.toLowerCase())) {
      return route;
    }
    return provider ? `${provider} · ${route}` : route;
  }
  function updateModelTrigger(slug, m) {
    const row = document.querySelector(`[data-ap-model-row][data-slug="${slug}"]`);
    if (!row) return;
    const name = row.querySelector("[data-ap-model-name]");
    const prov = row.querySelector("[data-ap-model-provider]");
    if (name) name.textContent = m.name;
    if (prov) prov.textContent = formatTriggerMeta(m);
  }

  function voiceEmotionOptionLabel(emotionSlug) {
    const s = emotionSlug === undefined || emotionSlug === null ? "" : String(emotionSlug);
    const key = !s ? "ap_voice_emotion_auto" : `ap_voice_emotion_${s}`;
    const txt = uiT(key);
    return txt === key ? s || "auto" : txt;
  }

  /** API emotion slugs mirrored in PATCH body `voice.emotion`. */
  const VOICE_EMOTION_VALUES = ["", "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent"];

  /** Voice-picker pager state · drives infinite-scroll loading inside
   *  the dropdown. ElevenLabs accounts can carry hundreds of voices
   *  and MiniMax has dozens; rendering them all at once was visibly
   *  slow on first picker open. Now we fetch one page at a time and
   *  append on scroll-to-bottom. State persists across picker
   *  opens/closes within a session · `invalidateVoicePager()` resets
   *  it on key changes (called from `refreshAgentProfileSkills`). */
  let voicePagerState = null;
  function invalidateVoicePager() {
    voicePagerState = null;
    // Drop the in-flight reference too · the old fetch is still running
    // but it'll write into the (now orphaned) old state object and the
    // result is silently discarded. Clearing the reference lets the
    // next caller start a fresh fetch against the new state instead of
    // awaiting a promise that will populate the wrong object.
    voicePageInFlight = null;
  }
  function getVoicePagerState() {
    if (!voicePagerState) {
      voicePagerState = {
        voices: [],
        cursor: null,
        hasMore: true,
        loading: false,
        initialised: false,
        provider: null,
        configured: false,
        // Structured upstream error from the catalogue fetch · null
        // on success / before first call. When present, the picker
        // renders a banner with the title/body keys and an optional
        // CTA link instead of (or above) the voice rows.
        error: null,
      };
    }
    return voicePagerState;
  }
  /** Fetch the next page of voices and append to the pager. Idempotent
   *  · concurrent callers SHARE the in-flight promise so the second
   *  call resolves with the same result instead of short-circuiting
   *  to `false`. That sharing was the missing piece: previously the
   *  prefetch fired by `renderVoiceBlock` could be in-flight when the
   *  user clicked the picker; the second `fetchNextVoicePage` saw
   *  `state.loading` and returned immediately, so the picker rendered
   *  an empty list with a loading sentinel and never refreshed once
   *  the prefetch landed. Returns true when new voices were appended. */
  let voicePageInFlight = null;
  async function fetchNextVoicePage(pageSize) {
    if (voicePageInFlight) return voicePageInFlight;
    const state = getVoicePagerState();
    if (state.initialised && !state.hasMore) return false;
    state.loading = true;
    voicePageInFlight = (async () => {
      try {
        const url = new URL("/api/voices", window.location.origin);
        url.searchParams.set("pageSize", String(pageSize || 30));
        if (state.cursor) url.searchParams.set("cursor", state.cursor);
        const r = await fetch(url.toString());
        const j = r.ok ? await r.json() : {};
        const newVoices = Array.isArray(j.voices) ? j.voices : [];
        // De-dupe by (provider | model | voiceId) in case the cursor
        // round-trip races with a key swap that triggered a reset
        // mid-fetch. Without this a re-emitted first page would land
        // on top of an already-rendered first page.
        const seen = new Set(
          state.voices.map((v) => `${v.provider}|${v.model || ""}|${v.voiceId || ""}`),
        );
        for (const v of newVoices) {
          const id = `${v.provider}|${v.model || ""}|${v.voiceId || ""}`;
          if (!seen.has(id)) {
            state.voices.push(v);
            seen.add(id);
          }
        }
        state.cursor = typeof j.nextCursor === "string" ? j.nextCursor : null;
        state.hasMore = !!j.hasMore;
        state.provider = typeof j.provider === "string" ? j.provider : null;
        state.configured = !!j.configured;
        // Structured upstream error · forwarded as-is from the server.
        // null / undefined means the fetch succeeded (even if 0 voices
        // returned · empty + no error is a real "you have no voices"
        // state, distinct from "fetch failed").
        state.error = (j.error && typeof j.error === "object") ? j.error : null;
        state.initialised = true;
        return newVoices.length > 0;
      } catch {
        state.hasMore = false;
        state.initialised = true;
        return false;
      } finally {
        state.loading = false;
        voicePageInFlight = null;
      }
    })();
    return voicePageInFlight;
  }
  /** Convenience · matches the old `ensureVoiceOptions()` shape so
   *  the renderVoiceBlock prefetch can stay a single-line call. Just
   *  primes the first page. */
  async function ensureVoiceOptions() {
    const state = getVoicePagerState();
    if (state.initialised) return state.voices;
    await fetchNextVoicePage(30);
    return state.voices;
  }
  /** Repaint the voice-picker trigger's label for a given director.
   *  Called after `ensureVoiceOptions()` resolves and after a label
   *  rename so the trigger reflects the friendliest available name
   *  without forcing the user to reopen the profile. Idempotent +
   *  cheap (DOM querySelector). */
  function repaintTriggerLabel(slug) {
    if (!slug) return;
    const v = window.app && window.app.agentsById ? window.app.agentsById[slug]?.voice : null;
    if (!v || !v.voiceId) return;
    document.querySelectorAll(`[data-ap-voice-row][data-slug="${slug}"]`).forEach((row) => {
      const name = row.querySelector("[data-ap-voice-name]");
      if (name) name.textContent = `${v.provider} · ${resolveVoiceLabel(v)}`;
    });
  }

  function voiceForAgent(slug) {
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    return live && live.voice ? live.voice : null;
  }
  /** Standalone voice-label cache · mirrors the server's
   *  `voice_labels` table (mig 055) so the friendly name a user
   *  typed in the clone modal survives a page reload without
   *  waiting for `/api/voices` catalog propagation. Filled on boot
   *  by `prefetchVoiceLabels()`; rewritten when the user renames
   *  a voice in the picker. Map<voiceId, label>. */
  const voiceLabelCache = new Map();
  let voiceLabelPrefetchPromise = null;

  async function prefetchVoiceLabels() {
    if (voiceLabelPrefetchPromise) return voiceLabelPrefetchPromise;
    voiceLabelPrefetchPromise = (async () => {
      try {
        const res = await fetch("/api/voice-labels", { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        const rows = Array.isArray(json && json.labels) ? json.labels : [];
        voiceLabelCache.clear();
        for (const row of rows) {
          if (row && typeof row.voiceId === "string" && typeof row.label === "string") {
            voiceLabelCache.set(row.voiceId, row.label);
          }
        }
      } catch { /* network blip · resolveVoiceLabel falls back to catalog */ }
    })();
    return voiceLabelPrefetchPromise;
  }
  // Boot-time prefetch · the agent-profile module loads on every
  // page, so the cache is warm by the time the user opens any
  // director profile. Fire-and-forget; the trigger repaint below
  // also re-resolves once it lands.
  prefetchVoiceLabels();

  /** Pick the friendliest display name for a voice. Four sources,
   *  in priority order:
   *   1. The local `voiceLabelCache` (filled from `/api/voice-labels`
   *      at boot) — survives reload + multi-device sync.
   *   2. `voice.label` from the catalogue row (provider-side rename
   *      via the MiniMax / ElevenLabs dashboard wins here).
   *   3. The cached pager state · voices coming from `agent.voice`
   *      (rendered by the trigger) carry only `{provider, model,
   *      voiceId, ...}` — no label field. Look up the matching
   *      voiceId in `voicePagerState.voices` to find the catalog
   *      entry's friendly name.
   *   4. Raw voice_id as last resort. */
  function resolveVoiceLabel(voice) {
    if (!voice) return "";
    const id = voice.voiceId || "";
    if (id && voiceLabelCache.has(id)) return voiceLabelCache.get(id);
    if (voice.label) return voice.label;
    if (!id) return "";
    try {
      const cached = (voicePagerState && voicePagerState.voices) || [];
      const hit = cached.find((x) =>
        x.voiceId === id && (!voice.provider || x.provider === voice.provider),
      );
      if (hit && hit.label && hit.label !== hit.voiceId) return hit.label;
    } catch { /* */ }
    return id;
  }
  /** Re-fetch the voice catalog + repaint the open picker in place.
   *  Called from the inline-rename flow after PUT/DELETE on
   *  /api/voice-labels/* so the user sees the new label without
   *  re-opening the dropdown. No-op when the picker isn't open. */
  async function refreshOpenVoicePicker() {
    const pop = document.getElementById("ap-voice-picker");
    if (!pop) return;
    const slug = pop.dataset.slug;
    invalidateVoicePager();
    await fetchNextVoicePage(30);
    if (!slug) return;
    renderVoicePickerBody(pop, slug);
    // Trigger label may also need a refresh (if we renamed the
    // currently-selected voice).
    const row = document.querySelector(`[data-ap-voice-row][data-slug="${slug}"]`);
    if (row) {
      const v = voiceForAgent(slug);
      const name = row.querySelector("[data-ap-voice-name]");
      const state = getVoicePagerState();
      // Look up the fresh row by voiceId so we pick up the renamed label.
      const fresh = (state.voices || []).find((x) => v && x.provider === v.provider && x.voiceId === v.voiceId);
      if (name && v) name.textContent = `${v.provider} · ${resolveVoiceLabel(fresh || v)}`;
    }
  }
  /** Format a voice-tune slider value for display. Speed gets an
   *  `×` suffix; centered ranges (pitch / modify-*) prefix non-zero
   *  values with `+` so the sign is unambiguous. Tabular numerals
   *  in CSS keep the value's box width stable as the user drags. */
  function formatVoiceVal(param, val) {
    if (param === "speed") return `${Number(val).toFixed(1)}×`;
    const n = Number(val);
    if (n > 0) return `+${n}`;
    return String(n);
  }

  /** Compute the lime-fill segment for a given range as two
   *  percentages (`lo` and `hi`) that the CSS gradient consumes.
   *  Non-centered ranges fill from 0 to value%; centered ranges
   *  (min < 0 < max) fill the band between zero and value, so a
   *  positive value lights up the right half and a negative value
   *  the left half. */
  function rangeFillPositions(min, max, value) {
    const span = max - min;
    if (span <= 0) return { lo: "0%", hi: "0%" };
    const pct = ((value - min) / span) * 100;
    if (min < 0 && max > 0) {
      const zero = ((0 - min) / span) * 100;
      return {
        lo: `${Math.min(pct, zero)}%`,
        hi: `${Math.max(pct, zero)}%`,
      };
    }
    return { lo: "0%", hi: `${pct}%` };
  }

  /** One slider row inside Advanced tuning · header (label left,
   *  value right) on top, hairline track + square thumb beneath.
   *  `centered` ranges (pitch / modify-*) get a mid-point tick
   *  AND a band-style lime fill (zero ↔ value); non-centered
   *  ranges (speed) get a "left-of-thumb" lime fill. */
  function renderVoiceTuneRow(slug, param, label, value, min, max, step) {
    const centered = min < 0 && max > 0;
    const { lo, hi } = rangeFillPositions(min, max, value);
    return `
      <div class="ap-voice-tune${centered ? " ap-voice-tune-centered" : ""}">
        <div class="ap-voice-tune-head">
          <span class="ap-voice-tune-label">${escape(label)}</span>
          <span class="ap-voice-tune-value" data-ap-voice-val="${escape(param)}">${escape(formatVoiceVal(param, value))}</span>
        </div>
        <input type="range" class="ap-voice-tune-range" min="${min}" max="${max}" step="${step}" value="${value}" data-ap-voice-range="${escape(param)}" data-slug="${escape(slug)}" style="--fill-lo: ${lo}; --fill-hi: ${hi};">
      </div>`;
  }

  function renderVoiceBlock(slug) {
    // No voice provider configured · render the gamified "locked"
    // card instead of the picker + sliders. Removing the chrome
    // makes the missing-key state read as a feature gate ("set
    // this up to unlock") rather than a broken control panel.
    const hasVoiceKey = !!(window.app && typeof window.app.hasAnyVoiceKey === "function" && window.app.hasAnyVoiceKey());
    if (!hasVoiceKey) {
      return `
        <div class="ap-voice-locked" data-ap-voice-row data-slug="${escape(slug)}">
          <div class="ap-voice-locked-glyph" aria-hidden="true">
            <i></i><i></i><i></i><i></i><i></i>
          </div>
          <div class="ap-voice-locked-title">${uiT("ap_voice_locked_title")}</div>
          <button type="button" class="ap-voice-locked-cta" data-ap-voice-unlock>
            <span>${escape(uiT("ap_voice_locked_cta"))}</span>
            <span class="ap-voice-locked-cta-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      `;
    }
    // Fire-and-forget prefetch · warms voiceOptionsCache so the picker
    // pops instantly when the user clicks. Without it the first click
    // pays the /api/voices round-trip (hundreds of voices on MiniMax)
    // and the dropdown lags visibly. Idempotent · cache-hit no-ops.
    //
    // After the cache lands (or the parallel voice-labels prefetch
    // resolves) we re-resolve the trigger label · the initial
    // render only has access to `agent.voice` (no label field), so
    // trigger initially shows the raw voice_id. Once either source
    // lands `resolveVoiceLabel` can find the friendly name.
    void ensureVoiceOptions().then(() => repaintTriggerLabel(slug));
    void prefetchVoiceLabels().then(() => repaintTriggerLabel(slug));
    const v = voiceForAgent(slug);
    // Trigger label prefers the user-typed name for cloned voices
    // (stored in localStorage at clone time) over the raw voice_id.
    // resolveVoiceLabel() picks the friendliest available string.
    const label = v
      ? `${v.provider} · ${resolveVoiceLabel(v)}`
      : uiT("ap_voice_browser_default");
    const speed = v?.speed ?? 1;
    const pitch = v?.pitch ?? 0;
    const emotion = v?.emotion || "";
    const modPitch = v?.modifyPitch ?? 0;
    const modIntensity = v?.modifyIntensity ?? 0;
    const modTimbre = v?.modifyTimbre ?? 0;

    const emotionLabel = voiceEmotionOptionLabel(emotion);

    return `
      <div class="ap-voice-config" data-ap-voice-row data-slug="${escape(slug)}">
        <section class="ap-voice-section">
          <header class="ap-voice-section-head">${escape(uiT("ap_voice_section_voice"))}</header>
          <div class="ap-voice-picker-row">
            <button type="button" class="ap-model-trigger" data-ap-voice-trigger>
              <span class="ap-model-trigger-text">
                <span class="ap-model-trigger-name" data-ap-voice-name>${escape(label)}</span>
              </span>
              <span class="ap-model-trigger-caret">▾</span>
            </button>
            <button type="button" class="ap-voice-preview-btn" data-ap-voice-preview data-slug="${escape(slug)}" title="${escape(uiT("ap_voice_preview_btn_title"))}" aria-label="${escape(uiT("ap_voice_preview_btn_title"))}"><span class="ap-voice-preview-glyph">▶</span><span class="ap-voice-preview-dots" aria-hidden="true"><i></i><i></i><i></i></span></button>
          </div>
        </section>
        <section class="ap-voice-section">
          <header class="ap-voice-section-head">${escape(uiT("ap_voice_section_emotion"))}</header>
          <div class="ap-voice-emotion-row">
            <button type="button" class="ap-model-trigger ap-voice-emotion-trigger" data-ap-emotion-trigger data-slug="${escape(slug)}">
              <span class="ap-model-trigger-text">
                <span class="ap-model-trigger-name" data-ap-voice-emotion-label>${escape(emotionLabel)}</span>
              </span>
              <span class="ap-model-trigger-caret">▾</span>
            </button>
            <div class="ap-voice-emotion-hint">${escape(uiT("ap_voice_emotion_hint"))}</div>
          </div>
        </section>
        <section class="ap-voice-section">
          <header class="ap-voice-section-head">${escape(uiT("ap_voice_section_preview"))}</header>
          <div class="ap-voice-preview-row">
            <textarea
              id="ap-voice-preview-text-${escape(slug)}"
              class="ap-voice-preview-text"
              data-ap-voice-preview-text="${escape(slug)}"
              rows="2"
              maxlength="240"
              placeholder="${escape(uiT("ap_voice_preview_sample"))}"
            >${escape(loadPreviewText(slug))}</textarea>
          </div>
        </section>
        <section class="ap-voice-section">
          <button type="button" class="ap-voice-forge" data-ap-voice-clone="${escape(slug)}">
          <span class="ap-voice-forge-corner ap-voice-forge-corner-tl" aria-hidden="true"></span>
          <span class="ap-voice-forge-corner ap-voice-forge-corner-tr" aria-hidden="true"></span>
          <span class="ap-voice-forge-corner ap-voice-forge-corner-bl" aria-hidden="true"></span>
          <span class="ap-voice-forge-corner ap-voice-forge-corner-br" aria-hidden="true"></span>
          <span class="ap-voice-forge-scan" aria-hidden="true"></span>
          <span class="ap-voice-forge-kicker">${escape(uiT("voice_clone_btn_kicker"))}</span>
          <span class="ap-voice-forge-body">
            <span class="ap-voice-forge-rune" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
            </span>
            <span class="ap-voice-forge-title">${escape(uiT("voice_clone_btn"))}</span>
            <span class="ap-voice-forge-arrow" aria-hidden="true">›</span>
          </span>
          <span class="ap-voice-forge-hint">${escape(uiT("voice_clone_btn_hint"))}</span>
        </button>
        </section>
        <section class="ap-voice-section">
          <details class="ap-voice-advanced">
            <summary>${escape(uiT("ap_voice_advanced"))}</summary>
            <div class="ap-voice-tune-grid">
              ${renderVoiceTuneRow(slug, "speed",           uiT("ap_voice_speed"),           speed,        0.5, 2,   0.1)}
              ${renderVoiceTuneRow(slug, "pitch",           uiT("ap_voice_pitch"),           pitch,       -12, 12,   1)}
              ${renderVoiceTuneRow(slug, "modifyPitch",     uiT("ap_voice_modify_pitch"),    modPitch,   -100, 100,  5)}
              ${renderVoiceTuneRow(slug, "modifyIntensity", uiT("ap_voice_modify_intensity"), modIntensity, -100, 100,  5)}
              ${renderVoiceTuneRow(slug, "modifyTimbre",    uiT("ap_voice_modify_timbre"),    modTimbre,   -100, 100,  5)}
            </div>
          </details>
        </section>
      </div>
    `;
  }
  /** Position a `.ap-model-picker` popover under (or above, if there
   *  isn't enough room below) a trigger element, clamping the height
   *  to fit the available viewport. The picker uses `position: fixed`
   *  so we work in viewport coords throughout. Returns nothing —
   *  mutates `pop.style` in place.
   *
   *  Preference: open BELOW the trigger. Flip ABOVE only when the
   *  below-space is < 180px AND the above-space is bigger. Either
   *  way, set `max-height` to whatever fits, so a long voice list
   *  scrolls inside the picker rather than disappearing off-screen. */
  function placePickerNearTrigger(pop, triggerEl, popW) {
    const margin = 8;
    const minBelow = 180; // below this many px, prefer flipping above
    const rect = triggerEl.getBoundingClientRect();
    const left = Math.round(Math.min(rect.left, window.innerWidth - popW - margin));
    pop.style.left = `${left}px`;
    pop.style.width = `${popW}px`;

    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - margin);
    const spaceAbove = Math.max(0, rect.top - margin);

    const flipAbove = spaceBelow < minBelow && spaceAbove > spaceBelow;
    if (flipAbove) {
      // Anchor the bottom edge of the picker just above the trigger.
      // The picker grows upward · we use `bottom` rather than `top +
      // translateY` so max-height clipping stays predictable.
      pop.style.top = "auto";
      pop.style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`;
      pop.style.maxHeight = `${Math.round(spaceAbove - 4)}px`;
    } else {
      pop.style.top = `${Math.round(rect.bottom + 4)}px`;
      pop.style.bottom = "auto";
      pop.style.maxHeight = `${Math.round(spaceBelow - 4)}px`;
    }
    // Z-index hoist · when the trigger lives inside the lightweight
    // agent overlay (z-index: 9700), the default `.ap-model-picker`
    // z-index (9100) renders BEHIND the overlay backdrop · clicking
    // the dropdown produced no visible popover. Lift above the
    // overlay whenever the trigger is nested in `.agent-overlay`.
    if (triggerEl.closest(".agent-overlay")) {
      pop.style.zIndex = "9800";
    }
  }

  /** Build the upstream-error banner shown inside the voice picker
   *  when the catalogue fetch failed in an actionable way (e.g. the
   *  ElevenLabs API key is missing the `voices_read` scope). Returns
   *  empty string when there's no error · callers can skip the
   *  banner. Includes a CTA link to the provider's settings page
   *  when the structured error carries a `fixUrl`. */
  function voicePickerErrorHtml(error) {
    if (!error || typeof error !== "object" || typeof error.code !== "string") return "";
    // i18n keys per error code · falls back to the generic
    // fetch-failed copy when an unknown code lands so a future
    // server-side addition still renders something sensible.
    const titleKey = `ap_voice_err_${error.code}_title`;
    const bodyKey = `ap_voice_err_${error.code}_body`;
    const title = uiT(titleKey) === titleKey ? uiT("ap_voice_err_fetch_failed_title") : uiT(titleKey);
    const body = uiT(bodyKey) === bodyKey ? uiT("ap_voice_err_fetch_failed_body") : uiT(bodyKey);
    const upstream = typeof error.message === "string" && error.message.trim()
      ? error.message.trim().slice(0, 200)
      : "";
    const cta = typeof error.fixUrl === "string" && error.fixUrl.startsWith("https://")
      ? `<a href="${escape(error.fixUrl)}" target="_blank" rel="noopener" class="ap-voice-picker-err-cta">${escape(uiT("ap_voice_err_fix_cta"))}</a>`
      : "";
    return `
      <div class="ap-voice-picker-err" role="alert">
        <div class="ap-voice-picker-err-title">${escape(title)}</div>
        <div class="ap-voice-picker-err-body">${escape(body)}</div>
        ${upstream ? `<div class="ap-voice-picker-err-upstream">${escape(upstream)}</div>` : ""}
        ${cta}
      </div>`;
  }

  /** Render the picker's body from the current pager state · used by
   *  both the initial open and every infinite-scroll append. Idempotent
   *  rebuild (full innerHTML rewrite) so we don't have to track which
   *  rows we've already mounted; the popover is small enough that
   *  repaint cost is negligible compared to a scroll-position-preserving
   *  partial update. Returns the trailing sentinel element (loading
   *  indicator or end marker) so the scroll handler can keep its
   *  reference stable across repaints. */
  function renderVoicePickerBody(pop, slug) {
    const state = getVoicePagerState();
    const current = voiceForAgent(slug);
    const voices = state.voices;

    if (voices.length === 0 && state.initialised) {
      // Structured upstream error · most common case is the
      // ElevenLabs `voices_read` permission being missing on the API
      // key. Render a clear banner with the fix CTA instead of the
      // generic "no provider configured" fallback so the user knows
      // exactly what to do.
      const errHtml = voicePickerErrorHtml(state.error);
      if (errHtml) {
        pop.innerHTML = errHtml;
        return;
      }
      pop.innerHTML = `<div class="ap-model-group">${escape(uiT("ap_voice_no_provider"))}</div>`;
      return;
    }

    const groups = [];
    // Error banner above the voice rows · fires when the catalogue
    // fetch errored but the picker still has at least one fallback
    // voice (e.g. browser default) so we don't take over the whole
    // popover. Same treatment as the empty-state error.
    const errBannerHtml = voicePickerErrorHtml(state.error);
    if (errBannerHtml) groups.push(errBannerHtml);
    // Two-level grouping · user-owned cloned voices get their own
    // header at the top of the dropdown ("// cloned · MiniMax"), then
    // the standard provider groups for system / premade voices. Cloned
    // voices on both providers carry a recognisable language tag —
    // MiniMax sets it to "clone" (we tag it), ElevenLabs uses v2's
    // `category` which is "cloned" / "professional" for user voices.
    const isClonedTag = (v) => v && (v.language === "clone" || v.language === "cloned" || v.language === "professional");
    let last = null;
    for (const v of voices) {
      const provider = String(v.provider || "browser");
      const cloned = isClonedTag(v);
      // Group key reflects the section the row belongs to. Two
      // cloned rows from the same provider share a header; two
      // system rows do too.
      const groupKey = cloned ? `clone:${provider}` : `system:${provider}`;
      if (groupKey !== last) {
        const label = cloned
          ? uiT("ap_voice_group_cloned_provider", { provider })
          : provider;
        groups.push(`<div class="ap-model-group${cloned ? " ap-model-group-cloned" : ""}">${escape(label)}</div>`);
        last = groupKey;
      }
      const id = [provider, v.model || "", v.voiceId || ""].join("|");
      const active = current && current.provider === provider && current.model === v.model && current.voiceId === v.voiceId;
      // For cloned rows the `language: "clone"` hint is redundant
      // (the group header already says so); show just the model.
      const hintParts = [v.model || ""];
      if (!cloned && v.language) hintParts.push(v.language);
      // Inline rename button · only meaningful for provider-side
      // voices (cloned / system on minimax + elevenlabs). The browser
      // fallback row has no voice_id to label, so skip the chip there.
      const canRename = (provider === "minimax" || provider === "elevenlabs") && v.voiceId;
      const renameBtn = canRename
        ? `<button type="button" class="ap-model-opt-rename" data-ap-voice-label-edit data-voice-id="${escape(v.voiceId)}" data-provider="${escape(provider)}" data-current-label="${escape(resolveVoiceLabel(v) || "")}" aria-label="${escape(uiT("ap_voice_rename_btn"))}" title="${escape(uiT("ap_voice_rename_btn"))}">✎</button>`
        : "";
      groups.push(`
        <div class="ap-model-opt-row${cloned ? " is-cloned" : ""}">
          <button type="button" class="ap-model-opt${active ? " active" : ""}${cloned ? " ap-model-opt-cloned" : ""}" data-ap-voice-pick="${escape(id)}">
            <span class="ap-model-opt-label">${escape(resolveVoiceLabel(v) || uiT("ap_voice_fallback_voice"))}</span>
            <span class="ap-model-opt-hint">${escape(hintParts.filter(Boolean).join(" · "))}</span>
          </button>
          ${renameBtn}
        </div>
      `);
    }
    // Trailing sentinel · either a "loading more" pulse (when we're
    // mid-fetch or there's known-more to load and the user just
    // scrolled into range) or nothing when the catalogue is fully
    // loaded. The scroll handler reads `data-voice-pager-sentinel`
    // to decide whether to trigger another fetch.
    if (state.hasMore) {
      groups.push(`
        <div class="ap-model-picker-loading" data-voice-pager-sentinel="loading">
          <span class="ap-loading-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>${escape(uiT("ap_voice_loading"))}</span>
        </div>`);
    }
    pop.innerHTML = groups.join("");
  }

  async function openVoicePicker(triggerEl) {
    closeVoicePicker();
    closeEmotionPicker();
    const row = triggerEl.closest("[data-ap-voice-row]");
    const slug = row?.getAttribute("data-slug");
    if (!slug) return;

    // Mount the popover shell IMMEDIATELY · the user gets visual
    // confirmation of their click in the same frame. If the pager is
    // cold, the skeleton holds the place while /api/voices?pageSize=N
    // round-trips; once it lands we render the rows in. Without this,
    // a cold pager produced "click → nothing → eventually picker"
    // which felt unresponsive on the first open of every session.
    const pop = document.createElement("div");
    pop.id = "ap-voice-picker";
    pop.className = "ap-model-picker";
    pop.dataset.slug = slug;
    pop.innerHTML = `
      <div class="ap-model-picker-loading">
        <span class="ap-loading-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>${escape(uiT("ap_voice_loading"))}</span>
      </div>`;
    document.body.appendChild(pop);
    placePickerNearTrigger(pop, triggerEl, 280);

    // Prime the pager if cold. Returning state is cached across
    // re-opens within the session so a user who pages, closes, then
    // reopens the picker sees the same rendered list instantly.
    if (!getVoicePagerState().initialised) {
      await fetchNextVoicePage(30);
    }
    // The user (or a sibling open) may have closed this picker
    // during the await · don't write into a detached node.
    if (!document.body.contains(pop)) return;

    renderVoicePickerBody(pop, slug);

    // Infinite-scroll · when the user scrolls within 80 px of the
    // bottom AND there's more to fetch AND nothing's in flight, load
    // the next page. 80 px is one row height plus padding; firing
    // before the sentinel hits the fold means the next page is
    // landing while the user is still reading the current bottom row.
    pop.addEventListener("scroll", async () => {
      const state = getVoicePagerState();
      if (state.loading || !state.hasMore) return;
      const distanceFromBottom = pop.scrollHeight - pop.scrollTop - pop.clientHeight;
      if (distanceFromBottom > 80) return;
      const grew = await fetchNextVoicePage(30);
      // Re-render only after a successful fetch · a fetch that
      // returned no new rows (network error, race) shouldn't
      // discard the existing list. The detached-node guard means a
      // user who closed the picker mid-fetch sees no surprise repaint.
      if (!grew) return;
      if (!document.body.contains(pop)) return;
      // Preserve scroll position across the innerHTML rewrite so the
      // user's reading flow isn't yanked to the top.
      const savedScroll = pop.scrollTop;
      renderVoicePickerBody(pop, slug);
      pop.scrollTop = savedScroll;
    }, { passive: true });
  }
  function closeVoicePicker() {
    const el = document.getElementById("ap-voice-picker");
    if (el) el.remove();
  }
  function closeEmotionPicker() {
    const el = document.getElementById("ap-emotion-picker");
    if (el) el.remove();
  }
  /** Custom popover for voice emotion · matches `.ap-model-picker` chrome (no native `<select>` menu). */
  function openEmotionPicker(triggerEl) {
    closeEmotionPicker();
    closeVoicePicker();
    closeModelPicker();
    const row = triggerEl.closest("[data-ap-voice-row]");
    const slug = row?.getAttribute("data-slug");
    if (!slug) return;
    const curVoice = voiceForAgent(slug);
    const raw = curVoice && curVoice.emotion != null && curVoice.emotion !== ""
      ? String(curVoice.emotion)
      : "";
    const parts = [`<div class="ap-model-group">${escape(uiT("ap_voice_emotion_label"))}</div>`];
    for (const e of VOICE_EMOTION_VALUES) {
      const active = raw === e;
      parts.push(`
        <button type="button" class="ap-model-opt${active ? " active" : ""}" data-ap-emotion-pick="${escape(e)}">
          <span class="ap-model-opt-label">${escape(voiceEmotionOptionLabel(e))}</span>
        </button>`);
    }
    const pop = document.createElement("div");
    pop.id = "ap-emotion-picker";
    pop.className = "ap-model-picker";
    pop.dataset.slug = slug;
    pop.innerHTML = parts.join("");
    document.body.appendChild(pop);
    // Width tracks the trigger so the popover hugs whichever
    // emotion-picker variant is in use (compact vs full row).
    const triggerWidth = triggerEl.getBoundingClientRect().width;
    placePickerNearTrigger(pop, triggerEl, Math.round(Math.min(280, Math.max(220, triggerWidth))));
  }
  function setVoiceFor(slug, voice) {
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    if (!live) return;
    fetch("/api/agents/" + encodeURIComponent(slug), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice }),
    })
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `HTTP ${r.status}`))))
      .then((updated) => {
        const nv = updated.voice != null ? updated.voice : voice;
        live.voice = nv;
        // The agent-overlay can mount its own copy of the voice row
        // (with the same data-slug) on top of the profile page · update
        // every matching row so the label stays consistent regardless
        // of which surface the user picked from.
        const rows = document.querySelectorAll(`[data-ap-voice-row][data-slug="${slug}"]`);
        rows.forEach((row) => {
          const name = row.querySelector("[data-ap-voice-name]");
          const prov = row.querySelector("[data-ap-voice-provider]");
          if (name && nv && nv.provider && nv.voiceId) name.textContent = `${nv.provider} · ${resolveVoiceLabel(nv)}`;
          if (prov && nv && nv.model != null) prov.textContent = nv.model;
          const emLb = row.querySelector("[data-ap-voice-emotion-label]");
          if (emLb && nv) emLb.textContent = voiceEmotionOptionLabel(nv.emotion ?? "");
        });
      })
      .catch((e) => alert(uiT("ap_voice_save_err", { msg: e && e.message ? e.message : String(e) })));
  }

  /** Per-slug custom preview text · persisted to localStorage so the
   *  user's preferred sample line is remembered across renders /
   *  reloads / agent-profile open & close. Falls back to the active
   *  locale's `ap_voice_preview_sample` when empty. */
  function previewTextStorageKey(slug) {
    return `pb.voice-preview-text.${slug}`;
  }
  function loadPreviewText(slug) {
    try {
      return localStorage.getItem(previewTextStorageKey(slug)) || "";
    } catch { return ""; }
  }
  function savePreviewText(slug, value) {
    try {
      if (value && value.trim()) localStorage.setItem(previewTextStorageKey(slug), value);
      else localStorage.removeItem(previewTextStorageKey(slug));
    } catch { /* */ }
  }

  async function previewVoice(slug) {
    const v = voiceForAgent(slug);
    if (!v || !v.voiceId) {
      alert(uiT("ap_voice_preview_need_voice"));
      return;
    }
    const btn = document.querySelector(`[data-ap-voice-preview][data-slug="${slug}"]`);
    // Loading state · class-toggle so the inner glyph hides and the
    // animated 3-dot indicator takes its place. Avoids the previous
    // `⏳` emoji which renders inconsistently across platforms and
    // doesn't match the system's mono register.
    if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
    try {
      // User's custom preview text wins when set (saved per slug to
      // localStorage from the .ap-voice-preview-text textarea). When
      // empty we send the active locale's default — server otherwise
      // falls back to a hardcoded Chinese phrase, which surfaced in
      // EN/JA/ES locales as the wrong language being read.
      const customText = (loadPreviewText(slug) || "").trim();
      const r = await fetch("/api/voices/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: customText || uiT("ap_voice_preview_sample"),
          provider: v.provider,
          model: v.model,
          voiceId: v.voiceId,
          speed: v.speed,
          pitch: v.pitch,
          emotion: v.emotion,
          modifyPitch: v.modifyPitch,
          modifyIntensity: v.modifyIntensity,
          modifyTimbre: v.modifyTimbre,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.audioBase64) {
        // Structured failure · the server tags `code: "paid-plan-required"`
        // when ElevenLabs returns 402 paid_plan_required or MiniMax
        // reports insufficient balance. Route into the upgrade overlay
        // (title + explanation + CTA to the provider's billing page)
        // instead of an alert() so the user gets a clear next step.
        if (data.code === "paid-plan-required") {
          openVoicePaidOverlay({
            provider: typeof data.provider === "string" ? data.provider : v.provider,
            upgradeUrl: typeof data.upgradeUrl === "string" ? data.upgradeUrl : "",
            message: data.error || "",
          });
          return;
        }
        alert(uiT("ap_voice_preview_failed", { msg: data.error || "no audio" }));
        return;
      }
      const audio = new Audio(`data:${data.mimeType};base64,${data.audioBase64}`);
      audio.play().catch((e) => alert(uiT("ap_voice_preview_playback_blocked", { msg: e.message || String(e) })));
    } catch (e) {
      alert(uiT("ap_voice_preview_err", { msg: e.message || String(e) }));
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
    }
  }

  /** Paid-plan-required overlay · shown when the voice preview backend
   *  rejects with code `paid-plan-required` (ElevenLabs library voice
   *  on a free plan, MiniMax insufficient balance, etc.). Reuses the
   *  app-wide `.pc-overlay / .pc-modal` chrome so the visual register
   *  matches pause-choice / send-choice / no-key modals. The CTA links
   *  to the provider's billing/pricing page so the user is one click
   *  from resolving it. */
  function openVoicePaidOverlay(opts) {
    // Idempotent · if an overlay is already showing, leave it alone.
    // Repeated billing-error events (each director's failed TTS in a
    // single round; replay + live-room hitting the same backend tag)
    // would otherwise tear down + rebuild the DOM on every call,
    // producing a visible "flash" as the panel reappears. The user
    // only needs to see the upgrade prompt ONCE — every subsequent
    // identical error is the same actionable item.
    if (document.getElementById("ap-voice-paid-overlay")) return;
    const provider = (opts && opts.provider) || "";
    const upgradeUrl = (opts && opts.upgradeUrl) || "";
    const message = (opts && opts.message) || "";
    const providerLabel = provider === "elevenlabs" ? "ElevenLabs"
      : provider === "minimax" ? "MiniMax"
      : provider === "openai" ? "OpenAI"
      : provider || uiT("ap_voice_paid_provider_generic");
    const title = uiT("ap_voice_paid_title", { provider: providerLabel });
    const deck = message || uiT("ap_voice_paid_deck_generic", { provider: providerLabel });
    const ctaLabel = uiT("ap_voice_paid_cta", { provider: providerLabel });
    const ctaDeck = uiT("ap_voice_paid_cta_deck", { provider: providerLabel });
    const closeLabel = uiT("ap_voice_paid_close");
    const closeDeck = uiT("ap_voice_paid_close_deck");
    const upgradeHref = upgradeUrl
      ? `<a href="${escape(upgradeUrl)}" target="_blank" rel="noopener noreferrer" class="pc-choice primary" data-voice-paid-upgrade>
           <div class="pc-choice-mark">${escape(ctaLabel)}</div>
           <div class="pc-choice-deck">${escape(ctaDeck)}</div>
         </a>`
      : "";
    const overlay = document.createElement("div");
    overlay.id = "ap-voice-paid-overlay";
    overlay.className = "pc-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="pc-modal" role="document">
        <div class="pc-classification">
          <span><span class="dot" style="color: var(--lime); margin-right: 4px;">●</span> ${escape(uiT("ap_voice_paid_classification"))}</span>
          <span class="right">// ${escape(providerLabel.toLowerCase())}</span>
        </div>
        <div class="pc-head">
          <div class="pc-tag">${escape(uiT("ap_voice_paid_tag"))}</div>
          <h2 class="pc-title">${escape(title)}</h2>
          <p class="pc-deck">${escape(deck)}</p>
        </div>
        <div class="pc-body">
          ${upgradeHref}
          <button type="button" class="pc-choice ghost" data-voice-paid-close>
            <div class="pc-choice-mark">${escape(closeLabel)}</div>
            <div class="pc-choice-deck">${escape(closeDeck)}</div>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    // Backdrop click closes · same affordance as the other pc-* modals.
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) closeVoicePaidOverlay();
    });
    // Esc closes · scoped handler removed on close so it doesn't leak.
    const esc = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeVoicePaidOverlay();
      }
    };
    overlay._escHandler = esc;
    document.addEventListener("keydown", esc, true);
    // CTA click closes the overlay AFTER the new tab is opened (the
    // anchor's default action handles the open; we just clean up).
    overlay.querySelector("[data-voice-paid-upgrade]")?.addEventListener("click", () => {
      // Defer close to next tick so the anchor's navigation triggers
      // before the DOM teardown — Safari otherwise sometimes cancels
      // the new-tab open when the link is removed in the same frame.
      setTimeout(closeVoicePaidOverlay, 50);
    });
    overlay.querySelector("[data-voice-paid-close]")?.addEventListener("click", closeVoicePaidOverlay);
  }
  function closeVoicePaidOverlay() {
    const el = document.getElementById("ap-voice-paid-overlay");
    if (!el) return;
    if (el._escHandler) document.removeEventListener("keydown", el._escHandler, true);
    el.remove();
  }

  function pageHTML(p, slug) {
    const skills = skillsForAgent(slug);
    const liveModel = liveModelFor(slug) || (p.metrics && p.metrics.model) || { name: "—", deck: "" };
    // Memory block · chair-only. Director profiles have their long-term
    // memory accumulated automatically at adjourn; the user-facing "add
    // note about yourself" panel only makes sense for the chair (the
    // host agent that aggregates context across rooms).
    const liveAgent = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    const isChair = !!(liveAgent && liveAgent.roleKind === "moderator");

    // Roster — recent rooms this director appeared in, if the profile
    // data ships any. Otherwise show 4 empty silhouette slots.
    const memoryRooms = (p.memory && p.memory.rooms) || [];
    const rosterCount = Math.max(memoryRooms.length, 4);
    const rosterSlots = Array.from({ length: rosterCount }, (_, i) => {
      const room = memoryRooms[i];
      if (room) {
        return `<div class="ap-portrait-mini" title="${escape(room.name || "")}"><img src="${escape(p.avatar)}" alt=""></div>`;
      }
      return `<div class="ap-portrait-mini empty">·</div>`;
    }).join("");

    const bioBody = (Array.isArray(p.bio) ? p.bio.join("\n\n") : (p.bio || "")).trim();
    const statusLabel = profileStatusLabel(p);

    return `
      <section class="ap-profile-card ap-profile-card-full" data-ap-card-slug="${escape(slug)}">
        <div class="ap-cover" aria-hidden="true">
          <div class="ap-cover-art" data-cover-seed="${escape(slug)}"></div>
        </div>
        <div class="ap-profile-body">
          <div class="ap-avatar">
            <img src="${escape(p.avatar)}" alt="${escape(p.name)}">
          </div>
          <div class="ap-id-text">
            <h1 class="ap-id-name">${escape(p.name)}</h1>
            <div class="ap-id-meta">
              <span class="ap-id-role">${escape(profileRoleLabel(p))}</span>
              ${p.handle ? `<span class="ap-id-dot">·</span><span class="ap-id-handle">${escape(displayAgentHandle(p.handle))}</span>` : ""}
              <span class="ap-status-pill">${escape(statusLabel)}</span>
            </div>
          </div>
          <button type="button" class="ap-id-menu" data-ap-id-menu data-slug="${escape(slug)}" aria-label="${escape(uiT("ap_aria_id_menu"))}">⋯</button>
        </div>
      </section>

      <div class="ap-card" data-ap-card-slug="${escape(slug)}">
        <div class="ap-layout">

          <div class="ap-main-col">

            <section class="ap-block">
              <header class="ap-block-h">
                <span class="ap-block-h-title">${escape(uiT("ap_intel"))}</span>
                <button type="button" class="ap-block-h-action" data-ap-intel-edit>${escape(uiT("ap_edit"))}</button>
              </header>
              <div class="ap-intel" data-ap-intel data-slug="${escape(slug)}">
                <div class="ap-intel-view" data-ap-intel-view>${escape(bioBody) || `<span class="ap-empty">${escape(uiT("ap_intel_empty"))}</span>`}</div>
                <button type="button" class="ap-intel-toggle" data-ap-intel-toggle aria-expanded="false">${escape(uiT("ap_show_more"))}</button>
              </div>
            </section>

            ${renderPersonaDossierSection(slug, p)}
            ${renderBuildLogSection(slug, p)}

            <section class="ap-block">
              <header class="ap-block-h">
                <span class="ap-block-h-title">${escape(uiT("ap_instruction"))}</span>
                <button type="button" class="ap-block-h-action" data-ap-instr-edit>${escape(uiT("ap_edit"))}</button>
              </header>
              ${renderInstructionBlock(p, slug)}
            </section>

            <section class="ap-block">
              <header class="ap-block-h">
                <span class="ap-block-h-title">${escape(uiT("ap_rules"))}</span>
                <button type="button" class="ap-block-h-action" data-ap-rule-add data-slug="${escape(slug)}" ${rulesForAgent(slug).length >= RULES_MAX ? "disabled" : ""}>
                  ${rulesForAgent(slug).length >= RULES_MAX ? escape(uiT("ap_rules_max", { n: RULES_MAX })) : escape(uiT("ap_rules_add"))}
                </button>
              </header>
              ${renderRulesBlock(slug)}
            </section>

            ${isChair ? `
            <section class="ap-block">
              <header class="ap-block-h">
                <span class="ap-block-h-title">${escape(uiT("ap_memory"))}</span>
                <div class="ap-block-h-actions">
                  <button type="button" class="ap-block-h-action ap-dream-trigger" data-ap-dream-trigger data-slug="${escape(slug)}" title="${escape(uiT("ap_dream_consolidate_title"))}">${escape(uiT("ap_dream_consolidate_btn"))}</button>
                  <button type="button" class="ap-block-h-action" data-ap-memory-add-toggle data-slug="${escape(slug)}">${escape(uiT("ap_memory_add"))}</button>
                </div>
              </header>
              ${renderMemoryBlock(slug)}
            </section>
            <section class="ap-block">
              <header class="ap-block-h">
                <span class="ap-block-h-title">${escape(uiT("chair_ulm_section_title"))}</span>
              </header>
              ${renderUserLongMemoryBlock()}
            </section>
            ` : ""}

          </div>

          <aside class="ap-side-col">

            <section class="ap-block">
              <header class="ap-block-h">
                <span class="ap-block-h-title">${escape(uiT("ap_track_record"))}</span>
                <span class="ap-block-h-tag">${escape(uiT("ap_track_tag_model_usage"))}</span>
              </header>
              <div class="ap-block-body">
                ${renderModelBlock(slug, liveModel)}
                <div class="ap-stats-grid" data-ap-stats data-slug="${escape(slug)}">
                  <div class="ap-stat">
                    <div class="ap-stat-v" data-ap-stat-rooms>—</div>
                    <div class="ap-stat-l">${escape(uiT("ap_stat_rooms"))}</div>
                  </div>
                  <div class="ap-stat">
                    <div class="ap-stat-v" data-ap-stat-rounds>—</div>
                    <div class="ap-stat-l">${escape(uiT("ap_stat_rounds"))}</div>
                  </div>
                  <div class="ap-stat">
                    <div class="ap-stat-v" data-ap-stat-tokens>—</div>
                    <div class="ap-stat-l">${escape(uiT("ap_stat_tokens"))}</div>
                  </div>
                </div>
              </div>
            </section>

            <section class="ap-block">
              <header class="ap-block-h">
                <span class="ap-block-h-title">${escape(uiT("ap_skills"))}</span>
                <span class="ap-block-h-tag" data-ap-skills-count>${escape(uiT("ap_skills_installed", { current: 0, cap: isChair ? SKILL_CAP.chair : SKILL_CAP.director }))}</span>
              </header>
              ${renderSkillsBlockV2(slug, isChair)}
            </section>

            <section class="ap-block">
              <header class="ap-block-h">
                <span class="ap-block-h-title">${escape(uiT("ap_voice_section"))}</span>
                <span class="ap-block-h-tag">${escape(uiT("ap_voice_section_tag"))}</span>
              </header>
              <div class="ap-block-body">
                ${renderVoiceBlock(slug)}
              </div>
            </section>

          </aside>

        </div>
      </div>
    `;
  }

  function getMainViews() {
    return {
      room: document.querySelector('[data-main-view="room"]'),
      agent: document.querySelector('[data-main-view="agent"]'),
      reports: document.querySelector('[data-main-view="reports"]'),
      notes: document.querySelector('[data-main-view="notes"]'),
      // Search is also a top-level main-view · without it here, opening
      // an agent profile while the search page is mounted leaves the
      // search view visible underneath, stacking the two panes.
      search: document.querySelector('[data-main-view="search"]'),
    };
  }

  function showRoom() {
    const v = getMainViews();
    if (v.room)  v.room.removeAttribute("hidden");
    if (v.agent) {
      v.agent.setAttribute("hidden", "");
      v.agent.innerHTML = "";
    }
    // Hide every other top-level pane so its content / placeholder
    // doesn't bleed through under the room view. Each view is just
    // the same `.main-view` CSS box — without explicitly hiding the
    // siblings, two of them stack and the user sees a leaked
    // "All Notes" / "All Reports" / "Search" empty state.
    if (v.reports) v.reports.setAttribute("hidden", "");
    if (v.notes)   v.notes.setAttribute("hidden", "");
    if (v.search)  v.search.setAttribute("hidden", "");
    document.querySelectorAll(".agent-row.active").forEach((r) => r.classList.remove("active"));
    document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll("[data-search-trigger].active").forEach((el) => el.classList.remove("active"));
    currentlyOpenSlug = null;
    // Clear the no-room flag IFF there's an actual room loaded · the
    // floating sidebar-expand button shouldn't show on top of a real
    // room view (the in-header expand button takes over there). When
    // showRoom fires without an active room (e.g. bouncing back to
    // the empty-state composer), keep no-room set so the expand
    // control stays reachable.
    const hasRoom = window.app && window.app.currentRoomId;
    if (hasRoom) document.documentElement.classList.remove("no-room");
  }

  /** Build a minimal profile object from a live /api/agents record so
   *  the page renderer (pageHTML / renderInstruction / etc.) can work
   *  with user-created directors that don't have a hardcoded entry in
   *  PROFILES. The single-string instruction goes under "role"; other
   *  sections show "—" until v1.1 adds structured editing. */
  function buildLiveProfile(agent) {
    if (!agent) return null;
    const liveModel = liveModelFor(agent.id) || { name: "—", deck: "" };
    const created = agent.createdAt
      ? new Date(agent.createdAt).toISOString().slice(0, 10)
      : "—";
    const bio = agent.bio || "";
    return {
      name: agent.name,
      role: agent.roleTag || "director",
      handle: agent.handle,
      avatar: agent.avatarPath,
      status: "active",
      tenure: agent.isSeed ? "core" : "custom",
      coverQuote: agent.coverQuote || agent.bio?.slice(0, 80) || agent.name,
      meta: { creator: agent.isSeed ? "@boardroom" : "@you", joined: created },
      bio: bio.split(/\n\s*\n/).filter(Boolean),
      metrics: {
        rooms: 0,
        rounds: 0,
        model: liveModel,
        tokens: { v: "—", deck: "" },
      },
      instruction: {
        role: agent.instruction || "—",
        objectives: "—",
        voice: "—",
        boundaries: "—",
        escalation: "—",
      },
      memory: {
        aboutUser: null,
        rooms: [],
      },
      knowledge: { docs: [] },
    };
  }

  // Track the currently-open profile so other modules (user-settings)
  // can ask us to re-fetch skill state after they mutate keys. Without
  // this, the web-search toggle row keeps its `data-key-configured="0"`
  // attribute baked from the first render and the user gets the
  // "configure key" prompt forever after they actually configured it.
  let currentlyOpenSlug = null;

  function open(slug) {
    currentlyOpenSlug = slug;
    let p = PROFILES[slug];
    // Live agent record (DB row · includes seeded directors too,
    // since they live in the agents table). Custom directors created
    // via the new-agent overlay land here exclusively.
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    if (!p) p = buildLiveProfile(live);
    if (!p) return;
    // The hardcoded PROFILES map has a static avatar field. The live
    // record is the source of truth for the actual current avatar
    // (which may have been regenerated via the ⋯ menu / PATCH). Pull
    // the live avatarPath in whenever it's available so the big
    // profile portrait stays in sync with the sidebar.
    if (live && live.avatarPath) p.avatar = live.avatarPath;
    // Per-device override fallback (used only when there's no live
    // record at all — extremely rare).
    if (!live) {
      try {
        const override = localStorage.getItem("boardroom.agent.avatar." + slug);
        if (override) p.avatar = override;
      } catch (_) {}
    }
    const v = getMainViews();
    if (!v.agent) return;
    v.agent.innerHTML = pageHTML(p, slug);
    if (v.room) v.room.setAttribute("hidden", "");
    // Hide the other top-level panes (All Reports / All Notes / Search)
    // so their placeholder / list doesn't render under the agent
    // profile. Without these, opening agent profile from "All Notes"
    // (or Search) leaks the previous view through the agent view.
    if (v.reports) v.reports.setAttribute("hidden", "");
    if (v.notes)   v.notes.setAttribute("hidden", "");
    if (v.search)  v.search.setAttribute("hidden", "");
    // The floating sidebar-expand button is gated on `html.no-room`
    // — without setting it here, a user who collapses the sidebar
    // while on an agent profile loses the expand control and has to
    // navigate back to a room view to recover it. Same logic that
    // app.js applies in openAllReports / openAllNotes.
    document.documentElement.classList.add("no-room");
    document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll("[data-search-trigger].active").forEach((el) => el.classList.remove("active"));
    v.agent.removeAttribute("hidden");
    // Centralized sidebar-focus handler · also clears New room /
     // New agent highlights and any stale session-row highlight, since
     // an open agent profile owns the main view.
    if (window.app && typeof window.app.markActiveAgent === "function") {
      window.app.markActiveAgent(slug);
    } else {
      document.querySelectorAll(".agent-row").forEach((r) => {
        r.classList.toggle("active", r.dataset.agentProfile === slug);
      });
    }
    // Scroll the new card to the top.
    v.agent.scrollTop = 0;
    const card = v.agent.querySelector(".ap-card");
    if (card) card.scrollTop = 0;
    // Paint a deterministic cover banner from the slug so each director
    // gets a recognisable colourway without needing image assets.
    paintCoverArt(v.agent.querySelector("[data-cover-seed]"));
    // Detect whether the instruction prose exceeds the collapsed cap.
    // Has to run AFTER innerHTML mounts (so layout/wrapping is real).
    evaluateInstructionOverflow(slug);
    // Same overflow detection for the Intel bio (3-line clamp).
    evaluateIntelOverflow(slug);
    // Lazy-load Track Record counters (rooms / rounds / tokens). Runs
    // off the main paint thread; placeholders ("—") show until the
    // fetch resolves so the layout never reflows.
    loadTrackRecord(slug);
    // Lazy-load this agent's long-term memory pool.
    loadMemoriesFor(slug);
    // Lazy-load the chair-only user_long_memory sanctuary (the
    // "long-term about you" block). renderUserLongMemoryBlock
    // is only inserted into the markup when isChair, so this
    // no-ops for director profiles via the early-return in
    // loadUserLongMemory when the [data-ap-ulm] node is absent.
    loadUserLongMemory();
    // Lazy-load this agent's installed skills (radar + list).
    loadSkillsForV2(slug);
  }

  /** GET /api/agents/:slug/stats and stamp the three counters into
   *  the Track Record block. Cheap to call on every profile open —
   *  the server computes the figures from existing tables (no cache
   *  drift) and no schema lookups happen between paints. */
  function loadTrackRecord(slug) {
    const grid = document.querySelector(`[data-ap-stats][data-slug="${slug}"]`);
    if (!grid) return;
    fetch("/api/agents/" + encodeURIComponent(slug) + "/stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((s) => {
        const rooms = grid.querySelector("[data-ap-stat-rooms]");
        const rounds = grid.querySelector("[data-ap-stat-rounds]");
        const tokens = grid.querySelector("[data-ap-stat-tokens]");
        if (rooms)  rooms.textContent  = formatStatNumber(s.roomsJoined);
        if (rounds) rounds.textContent = formatStatNumber(s.roundsSpoken);
        if (tokens) tokens.textContent = formatStatNumber(s.tokensConsumed);
      })
      .catch(() => {
        // Silent failure — placeholders ("—") stay; the user can
        // refresh, and the counters will render next paint.
      });
  }

  /** Compact stat rendering · 0..999 verbatim, then 1.2k / 4.5M for
   *  cumulative tokens which can grow large. Whole rooms / rounds
   *  rarely cross the threshold but the same formatter handles them
   *  cleanly. */
  function formatStatNumber(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k";
    return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "") + "M";
  }

  /** Generate a stable two-stop gradient from the slug. Same slug →
   *  same colourway every reload, so the cover acts like a sigil. */
  function paintCoverArt(node) {
    if (!node) return;
    const seed = node.getAttribute("data-cover-seed") || "";
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const a = h % 360;
    const b = (a + 50 + (h % 80)) % 360;
    node.style.background = `
      linear-gradient(120deg, hsl(${a} 32% 22%) 0%, hsl(${b} 28% 14%) 100%),
      radial-gradient(circle at 30% 40%, hsl(${a} 40% 28%) 0%, transparent 55%)
    `;
  }

  /* ─── Profile · skill picker popover ──────────────
     Floating list of catalog abilities the agent doesn't already
     have. Click one to install into the chosen slot. Position is
     anchored to the clicked slot. */
  function openProfileSkillPicker(anchor, slug, slotIdx) {
    closeProfileSkillPicker();
    const installed = new Set(skillsForAgent(slug));
    const available = SKILL_CATALOG.filter((s) => !installed.has(s.v));
    if (available.length === 0) return;

    const pop = document.createElement("div");
    pop.className = "na-skill-picker";
    pop.id = "ap-skill-picker";
    pop.dataset.targetSlug = slug;
    pop.dataset.targetSlot = String(slotIdx);
    pop.innerHTML = available.map((s) => `
      <button type="button" class="na-skill-pick" data-ap-skill-pick="${escape(s.v)}">
        <span class="na-skill-pick-icon">${escape(s.icon)}</span>
        <span class="na-skill-pick-body">
          <span class="na-skill-pick-name">${escape(s.name)}</span>
          <span class="na-skill-pick-deck">${escape(s.deck)}</span>
        </span>
      </button>
    `).join("");
    document.body.appendChild(pop);

    const r = anchor.getBoundingClientRect();
    const margin = 6;
    pop.style.left = Math.max(margin, Math.min(r.left, window.innerWidth - 270 - margin)) + "px";
    pop.style.top = (r.bottom + 4) + "px";
  }
  function closeProfileSkillPicker() {
    const pop = document.getElementById("ap-skill-picker");
    if (pop) pop.remove();
  }
  /** Replace the skill grid in the currently-rendered profile so the
   *  install/remove change reflects immediately, without re-rendering
   *  the whole card. */
  function repaintProfileSkillGrid(slug) {
    const card = document.querySelector(`.ap-card[data-ap-card-slug="${slug}"]`);
    if (!card) return;
    const grid = card.querySelector("[data-ap-skill-grid]");
    if (!grid) return;
    const skills = skillsForAgent(slug);
    grid.innerHTML = renderSkillSlots(skills);
    const count = card.querySelector(".ap-skill-count");
    if (count) count.textContent = String(skills.length);
  }

  function init() {
    // Document-level trigger for sidebar agent rows (capture phase
    // so we beat the agent-overlay listener; the avatar img inside
    // an agent row is auto-tagged data-agent).
    document.addEventListener("click", (e) => {
      const trigger = e.target.closest("[data-agent-profile]");
      if (!trigger) return;
      // Per-row action buttons (pin toggle, future delete / overflow
      // glyphs that live INSIDE the agent-row anchor) need their own
      // click to land. Without this guard, the capture-phase
      // stopPropagation below swallows the action's bubble path and
      // opens the profile instead — making "click pin → nothing
      // happens" the visible bug. Bail out here so the action's own
      // delegated handler runs as intended.
      if (e.target.closest("[data-pin-toggle], [data-row-action]")) return;
      const slug = trigger.dataset.agentProfile;
      if (!slug) return;
      // Accept either a hardcoded profile or any live agent the app
      // knows about (custom directors land in the latter).
      const hasProfile = !!PROFILES[slug];
      const hasLiveAgent = !!(window.app && window.app.agentsById && window.app.agentsById[slug]);
      if (!hasProfile && !hasLiveAgent) return;
      e.preventDefault();
      e.stopPropagation();
      open(slug);
    }, true);

    // Card actions: back button + add-to-boardroom CTA.
    document.addEventListener("click", async (e) => {
      if (e.target.closest("[data-ap-back]")) {
        e.preventDefault();
        showRoom();
        // Also flip the sidebar tab back to Rooms for clarity.
        document.querySelectorAll(".sidebar-tab[data-sidebar-tab]").forEach((t) => {
          const on = t.dataset.sidebarTab === "rooms";
          t.classList.toggle("active", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        document.querySelectorAll(".sidebar-panel[data-sidebar-panel]").forEach((p) => {
          if (p.dataset.sidebarPanel === "rooms") p.removeAttribute("hidden");
          else p.setAttribute("hidden", "");
        });
        return;
      }
      const addBtn = e.target.closest("[data-ap-add]");
      if (addBtn) {
        e.preventDefault();
        // Open the convene overlay; the user can pick this director from
        // the catalog (it's already in the merged list via app.agents).
        if (typeof window.openConveneOverlay === "function") {
          window.openConveneOverlay();
        }
        return;
      }

      /* ─── Profile · skill slot interaction ─────────────
         Click an empty slot → open the skill picker.
         Click a filled slot → uninstall.
         All state mutations go through skillsForAgent /
         setSkillsFor (localStorage), then re-render the
         grid in place. */
      // Info icon · don't bubble through to slot click; the tooltip
      // is handled by CSS (data-tip).
      if (e.target.closest(".ap-skill-info")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const slot = e.target.closest("[data-ap-skill-slot]");
      if (slot && slot.closest(".ap-card")) {
        e.preventDefault();
        const slotIdx = parseInt(slot.getAttribute("data-ap-skill-slot"), 10);
        const card = slot.closest(".ap-card");
        const slug = card?.getAttribute("data-ap-card-slug");
        if (!slug || !Number.isFinite(slotIdx)) return;
        if (slot.classList.contains("filled")) {
          // Look up the skill at this slot for a clearer confirm prompt.
          const installed = skillsForAgent(slug);
          const v = installed[slotIdx];
          const s = SKILL_CATALOG.find((x) => x.v === v);
          const label = s ? s.name : "this skill";
          if (!window.confirm(`Remove ${label}?`)) return;
          uninstallSkillFor(slug, slotIdx);
          repaintProfileSkillGrid(slug);
        } else {
          openProfileSkillPicker(slot, slug, slotIdx);
        }
        return;
      }
      // (model dropdown change is handled in the change listener below)

      // Skill picker option click — confirm, then install + close.
      const pick = e.target.closest("[data-ap-skill-pick]");
      if (pick) {
        e.preventDefault();
        const v = pick.getAttribute("data-ap-skill-pick");
        const pop = document.getElementById("ap-skill-picker");
        const slug = pop?.dataset.targetSlug;
        const slotIdx = pop ? parseInt(pop.dataset.targetSlot, 10) : null;
        const s = SKILL_CATALOG.find((x) => x.v === v);
        const label = s ? s.name : "this skill";
        if (!window.confirm(`Install ${label}?`)) return;
        if (slug && v) installSkillFor(slug, v, Number.isFinite(slotIdx) ? slotIdx : null);
        closeProfileSkillPicker();
        if (slug) repaintProfileSkillGrid(slug);
        return;
      }

      // Persona dossier card · open the preview overlay. Card is a
      // <button>, so the click lands on the button or any of its
      // children — closest() catches both. The overlay reads the
      // slug from the data attribute and fetches /persona.md.
      const personaOpen = e.target.closest("[data-ap-persona-open]");
      if (personaOpen) {
        e.preventDefault();
        e.stopPropagation();
        const slug = personaOpen.getAttribute("data-slug");
        if (!slug) return;
        const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
        const agentName = live && live.name ? live.name : "";
        openPersonaOverlay(slug, agentName);
        return;
      }
      // Persona dossier overlay · backdrop / close-button click. The
      // download anchor inside the overlay is NOT marked with the
      // close attr, so it doesn't fire here — its native href
      // navigation handles the download and the user can dismiss
      // the overlay manually if they wish.
      const personaClose = e.target.closest("[data-ap-persona-close]");
      if (personaClose) {
        e.preventDefault();
        e.stopPropagation();
        closePersonaOverlay();
        return;
      }

      // Build-log card · open the build-log modal. Mirrors the
      // persona-dossier open/close pattern. The teaser card is a
      // <button> so the click can land on any child element.
      const buildLogOpen = e.target.closest("[data-ap-buildlog-open]");
      if (buildLogOpen) {
        e.preventDefault();
        e.stopPropagation();
        const slug = buildLogOpen.getAttribute("data-slug");
        if (!slug) return;
        const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
        const agentName = live && live.name ? live.name : "";
        openBuildLogOverlay(slug, agentName);
        return;
      }
      const buildLogClose = e.target.closest("[data-ap-buildlog-close]");
      if (buildLogClose) {
        e.preventDefault();
        e.stopPropagation();
        closeBuildLogOverlay();
        return;
      }

      // ⋯ menu · open the popover (anchored to the button).
      const idMenuBtn = e.target.closest("[data-ap-id-menu]");
      if (idMenuBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (document.getElementById("ap-id-menu-pop")) {
          closeProfileIdMenu();
        } else {
          openProfileIdMenu(idMenuBtn);
        }
        return;
      }
      // ⋯ menu · action click.
      const menuAction = e.target.closest("[data-ap-menu-action]");
      if (menuAction) {
        const action = menuAction.getAttribute("data-ap-menu-action");
        const pop = document.getElementById("ap-id-menu-pop");
        const slug = pop?.dataset.slug;
        // persona-md is rendered as an <a href=…> · let the browser
        // navigate natively (the route returns the file with a
        // download Content-Disposition). preventDefault here would
        // kill the download. For the button-based actions below we
        // DO want preventDefault (otherwise the button-as-form-
        // submitter behaviour and click bubbling can both fire).
        if (action === "persona-md") {
          closeProfileIdMenu();
          return;
        }
        e.preventDefault();
        closeProfileIdMenu();
        if (action === "regen-avatar" && slug) regenerateProfileAvatar(slug);
        if (action === "edit-avatar3d" && slug && typeof window.openAvatar3DEditor === "function") {
          window.openAvatar3DEditor(slug);
        }
        if (action === "delete" && slug && window.app && typeof window.app.deleteAgent === "function") {
          // deleteAgent handles confirm + DELETE call + closes the
          // profile + refreshes the sidebar. No-op for seed/chair
          // (defense in depth — the menu item only renders for
          // custom agents).
          void window.app.deleteAgent(slug);
        }
        return;
      }

      // Memory · expand / collapse the overflow list. The first 5
      // rows always render; the rest live in a hidden container that
      // this button toggles. We flip both `[hidden]` on the panel and
      // an `expanded` class on the button so CSS swaps the icon
      // direction + the show/hide labels.
      const memToggle = e.target.closest("[data-ap-memory-toggle]");
      if (memToggle) {
        e.preventDefault();
        const block = memToggle.closest("[data-ap-memory]");
        const overflow = block?.querySelector("[data-ap-memory-overflow]");
        if (!overflow) return;
        const isHidden = overflow.hasAttribute("hidden");
        if (isHidden) overflow.removeAttribute("hidden");
        else overflow.setAttribute("hidden", "");
        memToggle.classList.toggle("expanded", isHidden);
        return;
      }

      // Memory · pin / unpin.
      const pinBtn = e.target.closest("[data-ap-memory-pin]");
      if (pinBtn) {
        e.preventDefault();
        const block = pinBtn.closest("[data-ap-memory]");
        const row = pinBtn.closest("[data-ap-memory-row]");
        const slug = block?.getAttribute("data-slug");
        const id = row?.getAttribute("data-id");
        if (!slug || !id) return;
        const wasPinned = row.getAttribute("data-pinned") === "1";
        patchMemory(slug, id, { pinned: !wasPinned })
          .then(() => loadMemoriesFor(slug))
          .catch((err) => alert("Couldn't update pin: " + (err && err.message ? err.message : err)));
        return;
      }
      // Memory · edit · swap content into a textarea inline.
      const editBtn = e.target.closest("[data-ap-memory-edit]");
      if (editBtn) {
        e.preventDefault();
        const row = editBtn.closest("[data-ap-memory-row]");
        const contentEl = row?.querySelector("[data-ap-memory-content]");
        if (!row || !contentEl) return;
        if (row.classList.contains("editing")) return;
        const current = contentEl.textContent || "";
        contentEl.innerHTML = `<textarea class="ap-memory-edit-area" data-ap-memory-edit-area maxlength="280">${escape(current)}</textarea>
          <div class="ap-memory-edit-actions">
            <button type="button" class="ap-memory-edit-cancel" data-ap-memory-edit-cancel data-orig="${escape(current)}">cancel</button>
            <button type="button" class="ap-memory-edit-save" data-ap-memory-edit-save>save</button>
          </div>`;
        row.classList.add("editing");
        const ta = contentEl.querySelector("textarea");
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        return;
      }
      // Memory edit · cancel · restore the original text.
      const editCancel = e.target.closest("[data-ap-memory-edit-cancel]");
      if (editCancel) {
        e.preventDefault();
        const row = editCancel.closest("[data-ap-memory-row]");
        const contentEl = row?.querySelector("[data-ap-memory-content]");
        if (!row || !contentEl) return;
        contentEl.textContent = editCancel.getAttribute("data-orig") || "";
        row.classList.remove("editing");
        return;
      }
      // Memory edit · save · PATCH content + re-render row.
      const editSave = e.target.closest("[data-ap-memory-save]") || e.target.closest("[data-ap-memory-edit-save]");
      if (editSave) {
        e.preventDefault();
        const row = editSave.closest("[data-ap-memory-row]");
        const block = editSave.closest("[data-ap-memory]");
        const ta = row?.querySelector("[data-ap-memory-edit-area]");
        const slug = block?.getAttribute("data-slug");
        const id = row?.getAttribute("data-id");
        if (!slug || !id || !ta) return;
        const content = ta.value.trim();
        if (content.length < 4 || content.length > 280) {
          alert("Note must be 4–280 chars.");
          return;
        }
        patchMemory(slug, id, { content })
          .then(() => loadMemoriesFor(slug))
          .catch((err) => alert("Couldn't save: " + (err && err.message ? err.message : err)));
        return;
      }
      // Memory · delete · single click + native confirm dialog.
      const delBtn = e.target.closest("[data-ap-memory-delete]");
      if (delBtn) {
        e.preventDefault();
        const block = delBtn.closest("[data-ap-memory]");
        const row = delBtn.closest("[data-ap-memory-row]");
        const slug = block?.getAttribute("data-slug");
        const id = row?.getAttribute("data-id");
        if (!slug || !id) return;
        const contentEl = row?.querySelector("[data-ap-memory-content]");
        const preview = (contentEl?.textContent || "").trim();
        const snippet = preview.length > 80 ? preview.slice(0, 77) + "…" : preview;
        const msg = snippet
          ? `Delete this note?\n\n"${snippet}"\n\nThis can't be undone.`
          : "Delete this note? This can't be undone.";
        if (!confirm(msg)) return;
        deleteMemoryFor(slug, id)
          .then(() => loadMemoriesFor(slug))
          .catch((err) => alert("Couldn't delete: " + (err && err.message ? err.message : err)));
        return;
      }
      // ── user-long-memory · chair-only sanctuary handlers ─────
      // Edit · swap the claim line into an inline textarea (label
      // is immutable so we don't touch it).
      const ulmEdit = e.target.closest("[data-ap-ulm-edit]");
      if (ulmEdit) {
        e.preventDefault();
        const row = ulmEdit.closest("[data-ap-ulm-row]");
        const claimEl = row?.querySelector("[data-ap-ulm-claim]");
        if (!row || !claimEl) return;
        if (row.classList.contains("editing")) return;
        const current = claimEl.textContent || "";
        claimEl.innerHTML = `<textarea class="ap-ulm-edit-area" data-ap-ulm-edit-area maxlength="240">${escape(current)}</textarea>
          <div class="ap-ulm-edit-actions">
            <button type="button" class="ap-ulm-edit-cancel" data-ap-ulm-edit-cancel data-orig="${escape(current)}">cancel</button>
            <button type="button" class="ap-ulm-edit-save" data-ap-ulm-edit-save>save</button>
          </div>`;
        row.classList.add("editing");
        const ta = claimEl.querySelector("textarea");
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        return;
      }
      const ulmCancel = e.target.closest("[data-ap-ulm-edit-cancel]");
      if (ulmCancel) {
        e.preventDefault();
        const row = ulmCancel.closest("[data-ap-ulm-row]");
        const claimEl = row?.querySelector("[data-ap-ulm-claim]");
        if (!row || !claimEl) return;
        claimEl.textContent = ulmCancel.getAttribute("data-orig") || "";
        row.classList.remove("editing");
        return;
      }
      const ulmSave = e.target.closest("[data-ap-ulm-edit-save]");
      if (ulmSave) {
        e.preventDefault();
        const row = ulmSave.closest("[data-ap-ulm-row]");
        const id = row?.getAttribute("data-id");
        const ta = row?.querySelector("[data-ap-ulm-edit-area]");
        if (!id || !ta) return;
        const claim = ta.value.trim();
        if (claim.length < 1 || claim.length > 240) {
          alert("Claim must be 1–240 chars.");
          return;
        }
        patchUserLongMemory(id, claim)
          .then(() => loadUserLongMemory())
          .catch((err) => alert("Couldn't save: " + (err && err.message ? err.message : err)));
        return;
      }
      const ulmDel = e.target.closest("[data-ap-ulm-delete]");
      if (ulmDel) {
        e.preventDefault();
        const row = ulmDel.closest("[data-ap-ulm-row]");
        const id = row?.getAttribute("data-id");
        if (!id) return;
        if (!confirm(uiT("chair_ulm_delete_confirm"))) return;
        deleteUserLongMemoryRow(id)
          .then(() => loadUserLongMemory())
          .catch((err) => alert("Couldn't delete: " + (err && err.message ? err.message : err)));
        return;
      }
      // Memory · manual consolidation trigger (chair "⊘ run consolidation"
      // button). Hits POST /api/agents/:id/dream, shows the before/after
      // counts inline for a few seconds, refreshes the memory list. The
      // button is disabled while the cycle runs to prevent double-click.
      const dreamTrigger = e.target.closest("[data-ap-dream-trigger]");
      if (dreamTrigger) {
        e.preventDefault();
        const slug = dreamTrigger.getAttribute("data-slug");
        if (!slug || dreamTrigger.disabled) return;
        const origLabel = dreamTrigger.textContent;
        dreamTrigger.disabled = true;
        dreamTrigger.textContent = "consolidating…";
        // Spawn the overlay · running widget mounted inside.
        // Earlier rev rendered the widget inline above the memory
        // list which felt cramped and shifted the page layout.
        // The overlay treatment matches the adjourn / supplement
        // modals' chrome so the dream reads as a proper "agent is
        // sleeping now" event with focused attention.
        const overlay = openDreamOverlay();
        const body = overlay.querySelector("[data-dream-body]");
        body.innerHTML = `
          <div class="dream-stage-pad">
            <div class="dream-section-kicker">
              <span class="dream-kicker-text">// running</span>
              <span class="dream-step" data-dream-step>1 / 6</span>
            </div>
            <div class="dream-frame" data-dream-state="running">
              <div class="dream-sky" aria-hidden="true">
                <span class="dream-z z1">Z</span>
                <span class="dream-z z2">z</span>
                <span class="dream-z z3">z</span>
                <span class="dream-z z4">Z</span>
                <span class="dream-z z5">z</span>
              </div>
              <div class="dream-lanes" aria-hidden="true">
                <div class="dream-lane lane-decay">
                  <span class="dream-lane-label">decay</span>
                  <span class="dream-lane-bar"><i></i></span>
                </div>
                <div class="dream-lane lane-merge">
                  <span class="dream-lane-label">merge</span>
                  <span class="dream-lane-bar"><i></i></span>
                </div>
                <div class="dream-lane lane-promote">
                  <span class="dream-lane-label">promote</span>
                  <span class="dream-lane-bar"><i></i></span>
                </div>
              </div>
            </div>
            <div class="dream-divider" aria-hidden="true"></div>
            <div class="dream-caption">
              <span class="dream-phase" data-dream-phase>scanning recent extractions…</span>
            </div>
          </div>
        `;
        // Rotate phase text every 1.6s · matches the actual
        // pipeline stages so the user's mental model of "what's
        // happening" tracks the backend.
        const phases = [
          "scanning recent extractions…",
          "clustering near-duplicates…",
          "merging clusters into canonical notes…",
          "resolving contradictions…",
          "promoting stable cross-room patterns…",
          "settling memory…",
        ];
        let phaseIdx = 0;
        const phaseTimer = setInterval(() => {
          phaseIdx = (phaseIdx + 1) % phases.length;
          const phaseEl = overlay.querySelector("[data-dream-phase]");
          const stepEl = overlay.querySelector("[data-dream-step]");
          if (phaseEl) phaseEl.textContent = phases[phaseIdx];
          if (stepEl) stepEl.textContent = `${phaseIdx + 1} / ${phases.length}`;
        }, 1600);
        // Pin the timer on the overlay so closeDreamOverlay can
        // also clear it (user can dismiss mid-run via ✕ / ESC /
        // backdrop and we shouldn't keep the interval ticking).
        overlay.__dreamPhaseTimer = phaseTimer;
        fetch("/api/agents/" + encodeURIComponent(slug) + "/dream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
          .then(async (r) => {
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
            return j;
          })
          .then((j) => {
            const s = j.summary || {};
            const before = s.beforeCount ?? 0;
            const after = s.afterCount ?? 0;
            const decayed = s.decayed ?? 0;
            const merged = s.merged ?? 0;
            const promoted = s.promoted ?? 0;
            const superseded = s.superseded ?? 0;
            // Stop phase rotation now that we're swapping to result.
            if (overlay.__dreamPhaseTimer) {
              clearInterval(overlay.__dreamPhaseTimer);
              overlay.__dreamPhaseTimer = null;
            }
            // Flip the modal class so the chrome (border / kicker
            // tint) follows the resolved state, then swap body.
            overlay.classList.add("is-done");
            const allZero = decayed === 0 && merged === 0 && promoted === 0 && superseded === 0;
            const delta = before - after;
            if (allZero) {
              // No-op result · still uses the full stage layout so
              // the modal doesn't visually shrink between phases.
              // Hero is the moon glyph + "settled" headline; the
              // bottom half is a quiet caption acknowledging the
              // already-tidy state.
              body.innerHTML = `
                <div class="dream-stage-pad is-quiet">
                  <div class="dream-section-kicker">
                    <span class="dream-kicker-text">// settled</span>
                    <span class="dream-step is-quiet">no change</span>
                  </div>
                  <div class="dream-hero is-quiet">
                    <span class="dream-hero-glyph">☾</span>
                    <div class="dream-hero-text">
                      <div class="dream-hero-title">Memory is already settled</div>
                      <div class="dream-hero-sub">${after} note${after === 1 ? "" : "s"} · nothing to consolidate</div>
                    </div>
                  </div>
                  <div class="dream-caption">
                    <span class="dream-caption-foot">no duplicates · no contradictions · pile is clean.</span>
                  </div>
                </div>
              `;
            } else {
              // Non-trivial result · hero shows the count delta
              // (was → now framed) with a magnitude chip; tiles
              // below break the change down per operation.
              const tile = (n, label, cls) =>
                `<div class="dream-tile ${cls}${n === 0 ? " is-empty" : ""}">
                   <span class="dream-tile-n">${n}</span>
                   <span class="dream-tile-l">${label}</span>
                 </div>`;
              const deltaLabel = delta > 0 ? `−${delta}` : delta < 0 ? `+${Math.abs(delta)}` : "±0";
              const deltaTone = delta > 0 ? "is-shrink" : delta < 0 ? "is-grow" : "is-flat";
              body.innerHTML = `
                <div class="dream-stage-pad">
                  <div class="dream-section-kicker">
                    <span class="dream-kicker-text">// consolidated</span>
                    <span class="dream-step ${deltaTone}">${deltaLabel}</span>
                  </div>
                  <div class="dream-hero">
                    <div class="dream-hero-numerals">
                      <span class="dream-num was">${before}</span>
                      <span class="dream-num-arrow" aria-hidden="true">→</span>
                      <span class="dream-num-frame">
                        <span class="dream-num now">${after}</span>
                      </span>
                    </div>
                    <span class="dream-hero-unit">note${after === 1 ? "" : "s"}</span>
                  </div>
                  <div class="dream-divider" aria-hidden="true"></div>
                  <div class="dream-tiles">
                    ${tile(decayed, "decayed", "is-decay")}
                    ${tile(merged, "merged", "is-merge")}
                    ${tile(superseded, "superseded", "is-supersede")}
                    ${tile(promoted, "promoted", "is-promote")}
                  </div>
                </div>
              `;
            }
            // Auto-dismiss after a longer beat so the user has
            // time to read the tiles. Manual dismissal still
            // works via ✕ / ESC / backdrop.
            overlay.__dreamAutoClose = setTimeout(() => closeDreamOverlay(), 9000);
            return loadMemoriesFor(slug);
          })
          .catch((err) => {
            if (overlay.__dreamPhaseTimer) {
              clearInterval(overlay.__dreamPhaseTimer);
              overlay.__dreamPhaseTimer = null;
            }
            overlay.classList.add("is-error");
            body.innerHTML = `
              <div class="dream-stage-pad is-quiet">
                <div class="dream-section-kicker">
                  <span class="dream-kicker-text">// failed</span>
                  <span class="dream-step is-error">error</span>
                </div>
                <div class="dream-hero is-quiet">
                  <span class="dream-hero-glyph">✕</span>
                  <div class="dream-hero-text">
                    <div class="dream-hero-title">Consolidation failed</div>
                    <div class="dream-hero-sub">${escape(err && err.message ? err.message : String(err))}</div>
                  </div>
                </div>
                <div class="dream-caption">
                  <span class="dream-caption-foot">memory pile unchanged · safe to retry.</span>
                </div>
              </div>
            `;
          })
          .finally(() => {
            dreamTrigger.disabled = false;
            dreamTrigger.textContent = origLabel;
          });
        return;
      }
      // Memory · toggle the add form (mirrors the Rules add pattern · the
      // input area is hidden by default and only revealed when the user
      // clicks the [+ add note] section action).
      const memAddToggle = e.target.closest("[data-ap-memory-add-toggle]");
      if (memAddToggle) {
        e.preventDefault();
        const slug = memAddToggle.getAttribute("data-slug");
        const block = document.querySelector(`[data-ap-memory][data-slug="${slug}"]`);
        const form = block?.querySelector("[data-ap-memory-add-form]");
        if (!form) return;
        form.hidden = false;
        const input = form.querySelector("[data-ap-memory-add-input]");
        if (input) { input.value = ""; input.focus(); }
        return;
      }
      // Memory · cancel — hide the form and clear input.
      const memAddCancel = e.target.closest("[data-ap-memory-add-cancel]");
      if (memAddCancel) {
        e.preventDefault();
        const form = memAddCancel.closest("[data-ap-memory-add-form]");
        if (!form) return;
        form.hidden = true;
        const input = form.querySelector("[data-ap-memory-add-input]");
        if (input) input.value = "";
        return;
      }
      // Memory · manual add · form submit.
      const memAddBtn = e.target.closest("[data-ap-memory-add-btn]");
      if (memAddBtn) {
        e.preventDefault();
        const block = memAddBtn.closest("[data-ap-memory]");
        const form = memAddBtn.closest("[data-ap-memory-add-form]");
        const input = block?.querySelector("[data-ap-memory-add-input]");
        const slug = block?.getAttribute("data-slug");
        if (!slug || !input) return;
        const content = (input.value || "").trim();
        if (content.length < 4 || content.length > 280) {
          alert("Note must be 4–280 chars.");
          return;
        }
        memAddBtn.disabled = true;
        addMemoryFor(slug, content)
          .then(() => {
            input.value = "";
            if (form) form.hidden = true;
            return loadMemoriesFor(slug);
          })
          .catch((err) => alert("Couldn't save note: " + (err && err.message ? err.message : err)))
          .finally(() => { memAddBtn.disabled = false; });
        return;
      }
      // Memory overlay · close on backdrop / × click.
      if (e.target.closest("[data-ap-memory-close]")) {
        e.preventDefault();
        closeMemoryOverlay();
        return;
      }

      // Skills v2 · drop-zone click → open file picker.
      const skillDrop = e.target.closest("[data-ap-skills-drop]");
      if (skillDrop && !skillDrop.classList.contains("disabled")) {
        // Don't double-trigger if the click landed on the input itself.
        if (e.target.tagName !== "INPUT") {
          e.preventDefault();
          const fi = skillDrop.querySelector("[data-ap-skills-file]");
          if (fi) fi.click();
        }
        return;
      }
      // Skills v2 · uninstall from inside the popover.
      const skillRmFromPop = e.target.closest("[data-ap-skill-popover-uninstall]");
      if (skillRmFromPop) {
        e.preventDefault();
        const slug = skillRmFromPop.getAttribute("data-slug");
        const skillId = skillRmFromPop.getAttribute("data-skill-id");
        if (!slug || !skillId) return;
        // Pull the skill name from the popover header for a clearer
        // confirm dialog ("Uninstall 'X'?" beats a generic prompt).
        const pop = document.getElementById("ap-skill-info-pop");
        const headEl = pop?.querySelector(".ap-skill-info-head");
        const skillName = headEl ? headEl.textContent.trim() : "this skill";
        if (!confirm(`Uninstall "${skillName}"? This can't be undone.`)) return;
        if (pop) pop.remove();
        uninstallSkillReq(slug, skillId)
          .then(() => loadSkillsForV2(slug))
          .catch((err) => alert("Couldn't uninstall: " + (err && err.message ? err.message : err)));
        return;
      }
      // Skills v2 · row menu (⋯) opens the info+uninstall popover.
      const skillInfo = e.target.closest("[data-ap-skill-info]");
      if (skillInfo) {
        e.preventDefault();
        e.stopPropagation();
        openSkillInfoPopover(skillInfo);
        return;
      }

      // Web Search · per-agent toggle. Two paths:
      //   · key configured → flip the per-agent flag with an optimistic
      //     visual + PATCH /api/agents/:id { webSearchEnabled }.
      //   · key missing → confirm prompt, then deep-link into
      //     Preferences → Brave row. The toggle stays OFF until the
      //     user comes back with a key.
      const wsToggle = e.target.closest("[data-ap-ws-toggle]");
      if (wsToggle) {
        e.preventDefault();
        e.stopPropagation();
        const keyConfigured = wsToggle.getAttribute("data-key-configured") === "1";
        const provider = wsToggle.getAttribute("data-provider") || "brave";
        if (!keyConfigured) {
          const ok = confirm(
            (window.I18n && typeof window.I18n.t === "function")
              ? uiT("ag_ws_need_key_confirm")
              :
                ("Web Search needs Brave Search or Tavily API credentials.\n\nBrave Search · ≈ $5 per 1000 queries. Tavily · per Tavily API credits.\n\nOpen Preferences now?"),
          );
          if (ok && typeof window.openUserSettings === "function") {
            window.openUserSettings({ section: "keys", focusProvider: provider });
          }
          return;
        }
        const agentSlug = wsToggle.getAttribute("data-agent-slug");
        if (!agentSlug) return;
        const wasEnabled = wsToggle.getAttribute("data-enabled") === "1";
        const next = !wasEnabled;
        // Optimistic visual flip while the PATCH lands.
        wsToggle.classList.toggle("on", next);
        wsToggle.classList.toggle("off", !next);
        wsToggle.setAttribute("data-enabled", next ? "1" : "0");
        wsToggle.setAttribute("aria-pressed", next ? "true" : "false");
        const txt = wsToggle.querySelector(".ap-skill-row-toggle-text");
        if (txt) txt.textContent = next ? "enabled" : "disabled";
        wsToggle.title = next ? "Disable Web Search for this director" : "Enable Web Search for this director";
        try {
          const r = await fetch("/api/agents");
          const j = await r.json();
          const agent = (j.agents || []).find((a) => a.handle === ("@" + agentSlug) || a.handle === ("/" + agentSlug) || a.handle === agentSlug || a.id === agentSlug)
            || (j.chair && (j.chair.handle === ("@" + agentSlug) || j.chair.handle === ("/" + agentSlug) || j.chair.id === agentSlug) ? j.chair : null);
          if (!agent) throw new Error("agent not found");
          const p = await fetch("/api/agents/" + encodeURIComponent(agent.id), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ webSearchEnabled: next }),
          });
          if (!p.ok) throw new Error("HTTP " + p.status);
        } catch (err) {
          // Revert visual on failure.
          wsToggle.classList.toggle("on", wasEnabled);
          wsToggle.classList.toggle("off", !wasEnabled);
          wsToggle.setAttribute("data-enabled", wasEnabled ? "1" : "0");
          wsToggle.setAttribute("aria-pressed", wasEnabled ? "true" : "false");
          if (txt) txt.textContent = wasEnabled ? "enabled" : "disabled";
          alert("Couldn't update Web Search toggle: " + (err && err.message ? err.message : err));
        }
        return;
      }
      // Configure-key link from inside the skill-info popover (web-search
      // only · the popover renders this when the global key is missing).
      const wsConfigure = e.target.closest("[data-ap-ws-configure]");
      if (wsConfigure) {
        e.preventDefault();
        e.stopPropagation();
        const provider = wsConfigure.getAttribute("data-provider") || "brave";
        // Close the skill-info popover before opening the settings
        // overlay — otherwise the popover sits in front of the
        // overlay's modal and looks like an artifact.
        const pop = document.getElementById("ap-skill-info-pop");
        if (pop) pop.remove();
        if (typeof window.openUserSettings === "function") {
          window.openUserSettings({ section: "keys", focusProvider: provider });
        }
        return;
      }

      // Intel · open editor.
      if (e.target.closest("[data-ap-intel-edit]")) {
        e.preventDefault();
        const card = e.target.closest(".ap-card");
        const slug = card?.getAttribute("data-ap-card-slug");
        if (!slug) return;
        const p = profileForSlug(slug);
        if (p) openIntelEditor(slug, p);
        return;
      }
      // Intel · save (PATCH /api/agents/:id with new bio).
      if (e.target.closest("[data-ap-intel-save]")) {
        e.preventDefault();
        const block = e.target.closest("[data-ap-intel]");
        const slug = block?.getAttribute("data-slug");
        const ta = block?.querySelector("[data-ap-intel-textarea]");
        if (!slug || !ta) return;
        const hint = block.querySelector("[data-ap-intel-hint]");
        const btn = block.querySelector("[data-ap-intel-save]");
        if (btn) { btn.disabled = true; btn.textContent = "saving…"; }
        setBioFor(slug, ta.value)
          .then(() => {
            const p = profileForSlug(slug);
            if (p) repaintIntel(slug, p);
          })
          .catch((err) => {
            if (btn) { btn.disabled = false; btn.textContent = "save"; }
            if (hint) {
              hint.textContent = "error · " + (err && err.message ? err.message : err);
              hint.classList.add("error");
            }
          });
        return;
      }
      // Intel · cancel.
      if (e.target.closest("[data-ap-intel-cancel]")) {
        e.preventDefault();
        const block = e.target.closest("[data-ap-intel]");
        const slug = block?.getAttribute("data-slug");
        if (!slug) return;
        const p = profileForSlug(slug);
        if (p) repaintIntel(slug, p);
        return;
      }

      // Instruction · open editor.
      if (e.target.closest("[data-ap-instr-edit]")) {
        e.preventDefault();
        const card = e.target.closest(".ap-card");
        const slug = card?.getAttribute("data-ap-card-slug");
        if (!slug) return;
        const p = profileForSlug(slug);
        if (p) openInstructionEditor(slug, p);
        return;
      }
      // Instruction · save.
      if (e.target.closest("[data-ap-instr-save]")) {
        e.preventDefault();
        const block = e.target.closest("[data-ap-instr]");
        const slug = block?.getAttribute("data-slug");
        const ta = block?.querySelector("[data-ap-instr-textarea]");
        if (!slug || !ta) return;
        setInstructionFor(slug, ta.value);
        const p = profileForSlug(slug);
        if (p) repaintInstruction(slug, p);
        return;
      }
      // Instruction · cancel.
      if (e.target.closest("[data-ap-instr-cancel]")) {
        e.preventDefault();
        const block = e.target.closest("[data-ap-instr]");
        const slug = block?.getAttribute("data-slug");
        if (!slug) return;
        const p = profileForSlug(slug);
        if (p) repaintInstruction(slug, p);
        return;
      }
      // Instruction · show more / show less. Toggles the .expanded
      // class on the view; CSS lifts the max-height cap and hides the
      // bottom fade gradient. The button itself is only visible when
      // the parent .ap-instr carries .overflowing (set by
      // evaluateInstructionOverflow).
      const instrToggle = e.target.closest("[data-ap-instr-toggle]");
      if (instrToggle) {
        e.preventDefault();
        const block = instrToggle.closest("[data-ap-instr]");
        const view = block?.querySelector("[data-ap-instr-view]");
        if (!view) return;
        const expanded = view.classList.toggle("expanded");
        instrToggle.setAttribute("aria-expanded", String(expanded));
        instrToggle.textContent = expanded ? uiT("ap_show_less") : uiT("ap_show_more");
        return;
      }
      // Intel · same show-more / show-less pattern as Instruction.
      // CSS clamps `.ap-intel-view` to a 3-line max-height by default;
      // the .expanded class lifts the cap. Toggle button visibility
      // is gated by `.ap-intel.overflowing` (set in
      // evaluateIntelOverflow).
      const intelToggle = e.target.closest("[data-ap-intel-toggle]");
      if (intelToggle) {
        e.preventDefault();
        const block = intelToggle.closest("[data-ap-intel]");
        const view = block?.querySelector("[data-ap-intel-view]");
        if (!view) return;
        const expanded = view.classList.toggle("expanded");
        intelToggle.setAttribute("aria-expanded", String(expanded));
        intelToggle.textContent = expanded ? uiT("ap_show_less") : uiT("ap_show_more");
        return;
      }

      // Rules · add a new empty row, then focus its input.
      const addRuleBtn = e.target.closest("[data-ap-rule-add]");
      if (addRuleBtn) {
        e.preventDefault();
        if (addRuleBtn.hasAttribute("disabled")) return;
        const slug = addRuleBtn.getAttribute("data-slug")
          || addRuleBtn.closest("[data-ap-rules-block]")?.getAttribute("data-slug");
        if (!slug) return;
        addRuleFor(slug);
        repaintProfileRules(slug);
        const card = document.querySelector(`.ap-card[data-ap-card-slug="${slug}"]`);
        const inputs = card?.querySelectorAll(".ap-rule-input") || [];
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
        return;
      }
      // Rules · remove a row.
      const rmRule = e.target.closest("[data-ap-rule-rm]");
      if (rmRule) {
        e.preventDefault();
        const block = rmRule.closest("[data-ap-rules-block]");
        const slug = block?.getAttribute("data-slug");
        const idx = parseInt(rmRule.getAttribute("data-ap-rule-rm"), 10);
        if (!slug || !Number.isFinite(idx)) return;
        removeRuleFor(slug, idx);
        repaintProfileRules(slug);
        return;
      }
    });

    // Rules · persist edits as the user types · setRuleAt debounce-
    // flushes to PATCH /api/agents/:id so the orchestrator picks them up.
    document.addEventListener("input", (e) => {
      const ri = e.target.closest("[data-ap-rule-input]");
      if (!ri) return;
      const block = ri.closest("[data-ap-rules-block]");
      const slug = block?.getAttribute("data-slug");
      const idx = parseInt(ri.getAttribute("data-ap-rule-input"), 10);
      if (!slug || !Number.isFinite(idx)) return;
      setRuleAt(slug, idx, ri.value);
    });

    // Esc closes the memory overlay or the instruction editor
    // (in priority order).
    document.addEventListener("keydown", (e) => {
      // Memory add form · Enter saves, Escape cancels. Skip Enter
      // when an IME (pinyin / kana / hangul) is mid-composition —
      // the Enter belongs to the candidate confirmation, not the
      // form submit.
      const memInput = e.target.closest && e.target.closest("[data-ap-memory-add-input]");
      if (memInput) {
        if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          const form = memInput.closest("[data-ap-memory-add-form]");
          form?.querySelector("[data-ap-memory-add-btn]")?.click();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          const form = memInput.closest("[data-ap-memory-add-form]");
          form?.querySelector("[data-ap-memory-add-cancel]")?.click();
          return;
        }
      }
      if (e.key === "Escape") {
        if (document.getElementById("ap-memory-overlay")) {
          closeMemoryOverlay();
          return;
        }
        const editingIntel = document.querySelector(".ap-intel-edit [data-ap-intel-textarea]");
        if (editingIntel) {
          const block = editingIntel.closest("[data-ap-intel]");
          const slug = block?.getAttribute("data-slug");
          if (slug) {
            const p = profileForSlug(slug);
            if (p) repaintIntel(slug, p);
          }
          return;
        }
        const editing = document.querySelector(".ap-instr-edit [data-ap-instr-textarea]");
        if (editing) {
          const block = editing.closest("[data-ap-instr]");
          const slug = block?.getAttribute("data-slug");
          if (slug) {
            const p = profileForSlug(slug);
            if (p) repaintInstruction(slug, p);
          }
        }
      }
    });

    // Outside-click dismisses the ⋯ menu popover.
    document.addEventListener("click", (e) => {
      const pop = document.getElementById("ap-id-menu-pop");
      if (!pop) return;
      if (e.target.closest("#ap-id-menu-pop")) return;
      if (e.target.closest("[data-ap-id-menu]")) return;
      closeProfileIdMenu();
    }, true);

    // Outside-click dismisses the picker.
    document.addEventListener("click", (e) => {
      const pop = document.getElementById("ap-skill-picker");
      if (!pop) return;
      if (e.target.closest("#ap-skill-picker")) return;
      if (e.target.closest("[data-ap-skill-slot]")) return;
      closeProfileSkillPicker();
    }, true);

    // Model dropdown · open picker on trigger click; install on
    // option click; outside-click dismisses.
    document.addEventListener("click", (e) => {
      const trigger = e.target.closest("[data-ap-model-trigger]");
      if (trigger) {
        e.preventDefault();
        if (document.getElementById("ap-model-picker")) {
          closeModelPicker();
        } else {
          openModelPicker(trigger);
        }
        return;
      }
      const opt = e.target.closest("[data-ap-model-pick]");
      if (opt) {
        e.preventDefault();
        const id = opt.getAttribute("data-ap-model-pick");
        const pop = document.getElementById("ap-model-picker");
        const slug = pop?.dataset.slug;
        if (!slug || !id) return;
        // The id is a composite (`${v}@${carrier}` or bare `${v}`); we
        // resolve it through lookupEntry to recover both halves plus
        // the human label. Fallbacks cover the rare case where the
        // cache is empty (still in first-paint).
        const at = id.indexOf("@");
        const v = at >= 0 ? id.slice(0, at) : id;
        const carrier = at >= 0 ? id.slice(at + 1) : null;
        const fromCache = lookupEntry(id);
        const fromList = PROFILE_MODELS.find((x) => x.v === v);
        const fromOption = {
          id,
          v,
          carrier,
          name: opt.querySelector(".ap-model-opt-label")?.textContent?.trim() || v,
          provider: "",
          deck: "",
        };
        const m = fromCache || (fromList ? { ...fromList, id, v, carrier } : fromOption);
        setModelFor(slug, m);
        updateModelTrigger(slug, m);
        closeModelPicker();
        return;
      }
      const voiceTrigger = e.target.closest("[data-ap-voice-trigger]");
      if (voiceTrigger) {
        e.preventDefault();
        if (document.getElementById("ap-voice-picker")) closeVoicePicker();
        else openVoicePicker(voiceTrigger);
        return;
      }
      // Locked card CTA · deep-links to user-settings keys panel
      // and scrolls the MiniMax row into view (the same deep-link
      // the composer's voice toggle uses when no key is set).
      // After the user closes the modal, refreshAgentProfileSkills
      // already fires (window-level wrapper); we also refresh the
      // visible voice block so a configured key flips the locked
      // card into the picker without a page reload.
      // When the click originates inside the lightweight director
      // overlay, dismiss it first — stacking the user-settings modal
      // on top of the overlay is confusing (two overlapping cards)
      // and the user is now in a "configure keys" flow, not a
      // "read this director" one. AgentOverlay is exposed by
      // agent-overlay.js once it's mounted.
      const unlockBtn = e.target.closest("[data-ap-voice-unlock]");
      if (unlockBtn) {
        e.preventDefault();
        if (unlockBtn.closest(".agent-overlay")
          && window.AgentOverlay
          && typeof window.AgentOverlay.close === "function") {
          window.AgentOverlay.close();
        }
        if (typeof window.openUserSettings === "function") {
          window.openUserSettings({ section: "keys", focusProvider: "minimax" });
        }
        return;
      }
      const emoTrig = e.target.closest("[data-ap-emotion-trigger]");
      if (emoTrig) {
        e.preventDefault();
        if (document.getElementById("ap-emotion-picker")) closeEmotionPicker();
        else openEmotionPicker(emoTrig);
        return;
      }
      const emoOpt = e.target.closest("[data-ap-emotion-pick]");
      if (emoOpt) {
        e.preventDefault();
        const pop = document.getElementById("ap-emotion-picker");
        const slug = pop?.dataset.slug;
        if (!slug) return;
        let rawPick = emoOpt.getAttribute("data-ap-emotion-pick");
        if (rawPick === null) rawPick = "";
        const existing = voiceForAgent(slug) || { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-qingse" };
        // Always send the raw string (including "" for auto). Sending
        // `undefined` would make JSON.stringify drop the key entirely,
        // and the server's PATCH handler reads emotion only when the
        // key is present — so clearing back to auto would be a no-op.
        setVoiceFor(slug, {
          ...existing,
          emotion: rawPick,
        });
        closeEmotionPicker();
        return;
      }
      // Inline rename · per-row ✎ button. Prompt for the new label,
      // PUT it to /api/voice-labels/:voiceId, drop both the server
      // catalogue cache (the route does that for us) and the client
      // pager state, then re-fetch + repaint the open picker. This
      // keeps the menu open during the rename so the user sees the
      // label flip in place.
      const labelBtn = e.target.closest("[data-ap-voice-label-edit]");
      if (labelBtn) {
        e.preventDefault();
        e.stopPropagation();
        const voiceId = labelBtn.getAttribute("data-voice-id") || "";
        const provider = labelBtn.getAttribute("data-provider") || "";
        const current = labelBtn.getAttribute("data-current-label") || "";
        if (!voiceId || !provider) return;
        const next = window.prompt(uiT("ap_voice_rename_prompt", { id: voiceId }), current);
        if (next === null) return; // cancelled
        const trimmed = String(next).trim();
        if (!trimmed) {
          // Empty input clears the custom label so the catalog name
          // wins again (or falls back to voice_id).
          if (!window.confirm(uiT("ap_voice_rename_clear_confirm"))) return;
          fetch(`/api/voice-labels/${encodeURIComponent(voiceId)}`, { method: "DELETE" })
            .then(() => {
              voiceLabelCache.delete(voiceId);
              refreshOpenVoicePicker();
              // Trigger labels for any director sitting on this voice
              // need to re-resolve · their previous "friendly" name
              // just disappeared.
              document.querySelectorAll(`[data-ap-voice-row]`).forEach((row) => {
                const s = row.getAttribute("data-slug");
                if (s) repaintTriggerLabel(s);
              });
            })
            .catch(() => { /* */ });
          return;
        }
        fetch(`/api/voice-labels/${encodeURIComponent(voiceId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, label: trimmed }),
        })
          .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `HTTP ${r.status}`))))
          .then(() => {
            voiceLabelCache.set(voiceId, trimmed);
            refreshOpenVoicePicker();
            // Repaint every trigger that currently displays this
            // voice so the rename lands immediately.
            document.querySelectorAll(`[data-ap-voice-row]`).forEach((row) => {
              const s = row.getAttribute("data-slug");
              if (s) repaintTriggerLabel(s);
            });
          })
          .catch((err) => alert(uiT("ap_voice_rename_err", { msg: err?.message || String(err) })));
        return;
      }
      const voiceOpt = e.target.closest("[data-ap-voice-pick]");
      if (voiceOpt) {
        e.preventDefault();
        const raw = voiceOpt.getAttribute("data-ap-voice-pick") || "";
        const pop = document.getElementById("ap-voice-picker");
        const slug = pop?.dataset.slug;
        const [provider, model, voiceId] = raw.split("|");
        if (!slug || !provider || !model || !voiceId) return;
        const existing = voiceForAgent(slug) || {};
        setVoiceFor(slug, { ...existing, provider, model, voiceId });
        closeVoicePicker();
        return;
      }
      // Preview button
      const previewBtn = e.target.closest("[data-ap-voice-preview]");
      if (previewBtn) {
        e.preventDefault();
        const slug = previewBtn.getAttribute("data-slug");
        if (slug) previewVoice(slug);
        return;
      }
      // Preview text textarea · persist on blur so we don't hammer
      // localStorage on every keystroke; the input listener below
      // syncs the in-memory STATE for the next previewVoice call.
      // Voice cloning · open the boardroomVoiceClone overlay. The
      // singleton lives in `public/voice-clone.js`; the `onApplied`
      // callback re-renders this voice block so the picker label
      // updates to the new voice_id without a full profile reload.
      const cloneBtn = e.target.closest("[data-ap-voice-clone]");
      if (cloneBtn) {
        e.preventDefault();
        const slug = cloneBtn.getAttribute("data-ap-voice-clone");
        if (!slug) return;
        const vc = window.boardroomVoiceClone;
        if (!vc || typeof vc.open !== "function") return;
        const agent = (window.app && window.app.agentsById && window.app.agentsById[slug]) || null;
        vc.open({
          agentId: slug,
          agentName: agent ? agent.name : "",
          onApplied: async (applied) => {
            // `applied` = { voiceId, label, provider } from voice-clone.js.
            // Four steps land the user squarely on the new voice:
            //   1. Sync the client-side agent cache (`window.app.
            //      agentsById[slug].voice`) so the picker trigger
            //      renders the new selection.
            //   2. Drop the pager cache + re-fetch /api/voices · the
            //      server has just dropped its catalogue cache, so a
            //      fresh fetch may pick up the new voice straight from
            //      the provider (5-30 s propagation can still mean the
            //      catalog doesn't carry it yet — step 3 fills the gap).
            //   3. Inject the new voice into the pager state if the
            //      fresh fetch didn't bring it back. This is the
            //      optimistic safety net for the propagation gap. The
            //      model field MUST match the model the catalog will
            //      return on the next refresh — otherwise dedup misses
            //      and the row appears twice. We hard-code the
            //      cloning-model per provider (same as the server
            //      worker writes into agent.voice.model).
            //   4. Re-render the voice block so the trigger label
            //      reflects the new voice immediately.
            try {
              const provider = (applied && applied.provider) || "minimax";
              const model = provider === "elevenlabs" ? "eleven_multilingual_v2" : "speech-2.8-hd";
              const voiceId = applied && applied.voiceId;
              const label = (applied && applied.label) || "";

              // Step 1 · live agent cache.
              const liveAgent = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
              if (liveAgent && voiceId) {
                const prev = liveAgent.voice || {};
                liveAgent.voice = {
                  speed: prev.speed,
                  pitch: prev.pitch,
                  volume: prev.volume,
                  emotion: prev.emotion,
                  provider,
                  model,
                  voiceId,
                };
              }
              // Step 1b · local label cache · keeps the friendly name
              // available across a page reload BEFORE `/api/voice-labels`
              // prefetch round-trips on the next boot.
              if (voiceId && label) {
                voiceLabelCache.set(voiceId, label);
              }

              // Step 2 · drop pager cache + force re-fetch. Without
              // this, any later `invalidateVoicePager` triggered by
              // settings tweaks would strand a stale optimistic-only
              // row (cleared state has no voices for the new id).
              invalidateVoicePager();
              try { await fetchNextVoicePage(30); } catch { /* */ }

              // Step 3 · inject if the catalog refetch didn't include it.
              const state = getVoicePagerState();
              if (voiceId && state) {
                const id = `${provider}|${model}|${voiceId}`;
                const dupeIdx = (state.voices || []).findIndex((x) => `${x.provider}|${x.model || ""}|${x.voiceId || ""}` === id);
                if (dupeIdx < 0) {
                  state.voices.unshift({
                    provider,
                    model,
                    voiceId,
                    label: label || voiceId,
                    language: "clone",
                    configured: true,
                  });
                } else if (label) {
                  if (!state.voices[dupeIdx].label || state.voices[dupeIdx].label === voiceId) {
                    state.voices[dupeIdx] = { ...state.voices[dupeIdx], label, language: "clone" };
                  }
                }
              }

              // 3 · re-render the voice block (trigger label now correct).
              const row = document.querySelector(`.ap-voice-config[data-slug="${slug}"], .ap-voice-locked[data-slug="${slug}"]`);
              if (row && typeof renderVoiceBlock === "function") {
                const wrap = document.createElement("div");
                wrap.innerHTML = renderVoiceBlock(slug);
                const fresh = wrap.firstElementChild;
                if (fresh && row.parentNode) row.parentNode.replaceChild(fresh, row);
              }
            } catch { /* */ }
          },
        });
        return;
      }
    });
    document.addEventListener("click", (e) => {
      const pop = document.getElementById("ap-model-picker");
      if (!pop) return;
      if (e.target.closest("#ap-model-picker")) return;
      if (e.target.closest("[data-ap-model-trigger]")) return;
      closeModelPicker();
    }, true);
    document.addEventListener("click", (e) => {
      const pop = document.getElementById("ap-voice-picker");
      if (!pop) return;
      if (e.target.closest("#ap-voice-picker")) return;
      if (e.target.closest("[data-ap-voice-trigger]")) return;
      closeVoicePicker();
    }, true);
    document.addEventListener("click", (e) => {
      const pop = document.getElementById("ap-emotion-picker");
      if (!pop) return;
      if (e.target.closest("#ap-emotion-picker")) return;
      if (e.target.closest("[data-ap-emotion-trigger]")) return;
      closeEmotionPicker();
    }, true);

    // Voice config sliders + emotion
    document.addEventListener("input", (e) => {
      const range = e.target.closest("[data-ap-voice-range]");
      if (range) {
        const param = range.getAttribute("data-ap-voice-range");
        const val = parseFloat(range.value);
        // Update display value · same formatter that initial render
        // uses, so dragging matches the static "1.0×" / "+5" reading.
        const container = range.closest(".ap-voice-config");
        const display = container?.querySelector(`[data-ap-voice-val="${param}"]`);
        if (display) display.textContent = formatVoiceVal(param, val);
        // Repaint the lime-fill segment as the thumb moves.
        const { lo, hi } = rangeFillPositions(parseFloat(range.min), parseFloat(range.max), val);
        range.style.setProperty("--fill-lo", lo);
        range.style.setProperty("--fill-hi", hi);
        return;
      }
      // Custom preview text · persist per-slug to localStorage so the
      // next previewVoice call (or the next agent-profile open) picks
      // it up. Save on every keystroke; the cost is one tiny write
      // and the user never wonders "did my edit stick?".
      const previewText = e.target.closest("[data-ap-voice-preview-text]");
      if (previewText) {
        const slug = previewText.getAttribute("data-ap-voice-preview-text");
        if (slug) savePreviewText(slug, previewText.value);
        return;
      }
    });
    document.addEventListener("change", (e) => {
      const range = e.target.closest("[data-ap-voice-range]");
      if (range) {
        const param = range.getAttribute("data-ap-voice-range");
        const slug = range.getAttribute("data-slug");
        if (!param || !slug) return;
        const val = parseFloat(range.value);
        const existing = voiceForAgent(slug) || { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-qingse" };
        setVoiceFor(slug, { ...existing, [param]: val });
        return;
      }
    });

    // Back-to-room paths now that the explicit Back button is gone:
    //  • clicking any sidebar room row → switch back to room view
    //  • clicking the Rooms tab while the agent view is active → same
    document.addEventListener("click", (e) => {
      // Only act when the agent view is currently open
      const v = getMainViews();
      const agentVisible = v.agent && !v.agent.hasAttribute("hidden");
      if (!agentVisible) return;

      if (e.target.closest(".session-row")) {
        showRoom();
        return;
      }
      const tab = e.target.closest('.sidebar-tab[data-sidebar-tab="rooms"]');
      if (tab) {
        showRoom();
      }
    });

    // Skills v2 · file-input change → install. Bubbling change event
    // (input is hidden inside the drop-zone). We handle it once at the
    // document level to avoid per-instance re-binding on each repaint.
    document.addEventListener("change", (e) => {
      const fi = e.target && e.target.closest && e.target.closest("[data-ap-skills-file]");
      if (!fi) return;
      const block = fi.closest("[data-ap-skills]");
      const slug = block?.getAttribute("data-slug");
      const file = fi.files && fi.files[0];
      if (!slug || !file) return;
      file.text().then((md) => installSkillFromText(slug, md))
        .then(() => loadSkillsForV2(slug))
        .catch((err) => alert("Install failed: " + (err && err.message ? err.message : err)))
        .finally(() => { try { fi.value = ""; } catch (_) {} });
    });

    // Skills v2 · drag/drop on the drop-zone. dragover is required so
    // the drop event fires; no visual delegation per-instance — we
    // toggle the .dragging class on whichever zone is hovered.
    document.addEventListener("dragover", (e) => {
      const zone = e.target && e.target.closest && e.target.closest("[data-ap-skills-drop]");
      if (!zone || zone.classList.contains("disabled")) return;
      e.preventDefault();
      zone.classList.add("dragging");
    });
    document.addEventListener("dragleave", (e) => {
      const zone = e.target && e.target.closest && e.target.closest("[data-ap-skills-drop]");
      if (zone) zone.classList.remove("dragging");
    });
    document.addEventListener("drop", (e) => {
      const zone = e.target && e.target.closest && e.target.closest("[data-ap-skills-drop]");
      if (!zone || zone.classList.contains("disabled")) return;
      e.preventDefault();
      zone.classList.remove("dragging");
      const block = zone.closest("[data-ap-skills]");
      const slug = block?.getAttribute("data-slug");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!slug || !file) return;
      file.text().then((md) => installSkillFromText(slug, md))
        .then(() => loadSkillsForV2(slug))
        .catch((err) => alert("Install failed: " + (err && err.message ? err.message : err)));
    });

    // Skills v2 · close skill info popover on outside click.
    document.addEventListener("click", (e) => {
      const pop = document.getElementById("ap-skill-info-pop");
      if (!pop) return;
      if (e.target.closest("#ap-skill-info-pop")) return;
      if (e.target.closest("[data-ap-skill-info]")) return;
      pop.remove();
    }, true);

  }

  window.openAgentProfile  = open;
  window.closeAgentProfile = showRoom;
  // Re-fetch the open profile's skills (incl. per-skill keyConfigured
  // flags) so the web-search toggle row's cached `data-key-configured`
  // refreshes after the user adds a key in Preferences. Also re-renders
  // the Voice Setup block so the gamified locked card flips into the
  // picker the moment the user adds a MiniMax / ElevenLabs key without
  // forcing a page reload. No-op when no profile is currently open.
  window.refreshAgentProfileSkills = function () {
    // Voices list is keyed off the user's configured providers · when
    // keys change (added / deleted / swapped between minimax ↔
    // elevenlabs), the cached pager state is stale and the picker
    // would still show the prior provider's voices until a hard
    // refresh. Invalidate here so the next openVoicePicker() refetches
    // the first page; also closes any open picker that's painting
    // from the stale cache so the user doesn't see the wrong list
    // flash before it reopens. This function is the canonical "keys
    // may have changed" hook called by user-settings on modal close.
    invalidateVoicePager();
    closeVoicePicker();
    closeEmotionPicker();
    if (!currentlyOpenSlug) return;
    loadSkillsForV2(currentlyOpenSlug);
    // Re-render every mounted voice row for this slug — the agent
    // profile page AND the lightweight agent overlay can both render
    // one simultaneously (overlay opens on top of the profile page).
    const voiceRows = document.querySelectorAll(`[data-ap-voice-row][data-slug="${currentlyOpenSlug}"]`);
    voiceRows.forEach((voiceRow) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = renderVoiceBlock(currentlyOpenSlug).trim();
      const fresh = wrap.firstElementChild;
      if (fresh) voiceRow.replaceWith(fresh);
    });
  };

  /** Public surface · agent-overlay.js mounts the same voice block
   *  inside the lightweight director overlay so the user can swap
   *  voices without navigating to the full profile page. The block
   *  uses the same `data-ap-voice-*` data attrs, so the existing
   *  document-level click / change / input handlers already pick up
   *  events from whichever copy is live. */
  window.AgentProfileVoice = {
    renderVoiceBlock,
    // Public hook so the room SSE handler + voice-replay can open
    // the same upgrade overlay when a TTS billing error fires
    // mid-room (insufficient balance / paid plan required) instead
    // of only when the user is on the agent-profile voice picker.
    openPaidOverlay: openVoicePaidOverlay,
  };

  document.addEventListener("boardroom:locale", () => {
    if (currentlyOpenSlug && typeof open === "function") open(currentlyOpenSlug);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
