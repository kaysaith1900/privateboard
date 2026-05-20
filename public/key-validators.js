/* ─────────────── Static API-key validators ───────────────
   Sanity-check pasted API keys at the input layer BEFORE
   they ever round-trip to the server. The real authority
   on validity is still the upstream provider (every key
   gets exercised on first call); these rules just catch
   the obvious bad pastes — "123", a Brave key pasted into
   the OpenAI slot, a key with a stray space — that
   otherwise sit in the DB until the first SSE turn fails.

   Used by:
     · public/onboarding.js   · step-2 LLM key field
                              · step-3 voice key field
     · public/user-settings.js · LLM add-provider flow
                              · voice / skill key rows

   Loader: `<script src="key-validators.js" defer>` ahead
   of the two consumer scripts in index.html; the module
   self-publishes to `window.boardroomKeyValidator`.
*/

(function () {
  "use strict";
  if (typeof window === "undefined") return;

  // Per-provider rules.
  //   prefixes — accepted leading substrings. Empty array = no
  //     prefix check (provider keys are too varied to lock down).
  //   minLen   — minimum trimmed length. Picked conservatively;
  //     real keys are well above this so the floor only catches
  //     the obviously-wrong ("123", "test", a single word).
  //   label    — display name for the warning message.
  const RULES = {
    openrouter: { label: "OpenRouter",    prefixes: ["sk-or-"], minLen: 24 },
    bai:        { label: "B.AI",          prefixes: [],         minLen: 16 },
    anthropic:  { label: "Claude",        prefixes: ["sk-ant-"], minLen: 40 },
    openai:     { label: "ChatGPT",       prefixes: ["sk-"],    minLen: 20 },
    google:     { label: "Gemini",        prefixes: ["AIza"],   minLen: 30 },
    xai:        { label: "Grok",          prefixes: ["xai-"],   minLen: 32 },
    // Moonshot keys are `sk-...` (the Moonshot SDK uses the OpenAI
    // prefix convention so users frequently confuse them with OpenAI
    // keys · we only enforce the prefix + length floor, not a stricter
    // pattern that risks rejecting future key formats).
    moonshot:   { label: "Kimi",          prefixes: ["sk-"],    minLen: 40 },
    // Zhipu keys are `<32-hex>.<16-alnum>` (the period mid-string is
    // distinctive but a regex check would be fragile if Zhipu rotates
    // the format · the length floor catches the obvious bad paste).
    zhipu:      { label: "GLM",           prefixes: [],         minLen: 30 },
    minimax:    { label: "MiniMax",       prefixes: [],         minLen: 24 },
    elevenlabs: { label: "ElevenLabs",    prefixes: [],         minLen: 24 },
    brave:      { label: "Brave Search",  prefixes: ["BSA"],    minLen: 24 },
    tavily:     { label: "Tavily Search", prefixes: ["tvly-"],  minLen: 16 },
  };

  function ruleFor(provider) {
    if (!provider) return null;
    return Object.prototype.hasOwnProperty.call(RULES, provider)
      ? RULES[provider]
      : null;
  }

  /** Validate a key for a given provider.
   *  Returns `{ ok, code, rule }` where code is one of:
   *    "empty"       — value is blank (caller usually suppresses UI)
   *    "whitespace"  — internal space / tab / newline
   *    "prefix"      — required prefix not present
   *    "length"      — under the minLen floor
   *    null          — value passes all checks
   */
  function validate(provider, raw) {
    const rule = ruleFor(provider);
    // Unknown provider · let it through; the server is the source of
    // truth for whatever rules apply.
    if (!rule) return { ok: true, code: null, rule: null };

    const value = String(raw == null ? "" : raw);
    const trimmed = value.trim();
    if (trimmed.length === 0) return { ok: false, code: "empty", rule };

    if (/\s/.test(trimmed)) return { ok: false, code: "whitespace", rule };

    if (rule.prefixes.length > 0) {
      // Defer the prefix verdict until the value is long enough to
      // definitively fail it · otherwise a user typing manually
      // would see "must start with sk-ant-" after pressing one key.
      // Falls through to the length check below, which is the
      // honest answer at that point.
      const maxPrefixLen = Math.max.apply(null, rule.prefixes.map((p) => p.length));
      if (trimmed.length >= maxPrefixLen) {
        const matched = rule.prefixes.some((p) => trimmed.startsWith(p));
        if (!matched) return { ok: false, code: "prefix", rule };
      }
    }

    if (trimmed.length < rule.minLen) return { ok: false, code: "length", rule };

    return { ok: true, code: null, rule };
  }

  /** Localised one-line message for a failed validate() result.
   *  Resolution order:
   *    1. window.I18n.t("key_validate_<code>") with {prefix} / {label}
   *       / {minLen} substitutions.
   *    2. Hard-coded English fallback (same substitutions applied).
   */
  function describe(result) {
    if (!result || result.ok) return "";
    const rule = result.rule;
    if (!rule) return "";
    const prefix = rule.prefixes.length === 1
      ? rule.prefixes[0]
      : rule.prefixes.join(" / ");
    const subst = (tpl) => String(tpl)
      .replace(/\{label\}/g, rule.label)
      .replace(/\{prefix\}/g, prefix)
      .replace(/\{minLen\}/g, String(rule.minLen));

    const I18n = window.I18n;
    const lookup = (key, fb) => {
      if (I18n && typeof I18n.t === "function") {
        const v = I18n.t(key);
        if (v && v !== key) return subst(v);
      }
      return subst(fb);
    };
    switch (result.code) {
      case "empty":
        return lookup("key_validate_empty", "Enter an API key.");
      case "whitespace":
        return lookup("key_validate_whitespace", "Remove spaces from the key — pasted text often picks up a trailing space.");
      case "prefix":
        return lookup("key_validate_prefix", "{label} keys should start with \"{prefix}\".");
      case "length":
        return lookup("key_validate_length", "Looks too short for {label} — real keys run at least {minLen} characters.");
      default:
        return "";
    }
  }

  window.boardroomKeyValidator = { validate, describe, ruleFor };
})();
