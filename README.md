# PrivateBoard

> Your private board meeting, on call.
> A local-first, multi-agent thinking amplifier — convene a panel of directors with distinct lenses, drop a real question on the table, and let them argue. You walk away with a brief.

Not a chatbot. Not an assistant. A board.

---

## What it is

PrivateBoard runs entirely on your machine and routes to the model providers you bring keys for. You pick a few directors with sharp, opinionated lenses — Socrates, First Principles, Value Investor, User-Empathy, Long Horizon, Phenomenologist — convene a room, and they take turns pushing back on the question you actually care about. When you adjourn, a chair files a brief.

- **Local-first.** All state lives in `~/.boardroom/` (SQLite). Nothing leaves your machine without your provider call.
- **BYO keys.** OpenRouter (one key, all models) or direct keys for Anthropic / OpenAI / Google / xAI. Provider keys are stored on disk and never sent to PrivateBoard's authors.
- **Multi-agent.** A chair orchestrates the room: chooses speakers, manages the queue, intervenes when the discussion drifts, and writes the brief.
- **Streaming.** Director turns stream token-by-token over SSE.
- **Memory.** Each director carries an "About You" line and per-room lessons that compound across sessions.

## Quick start

```bash
# 1. Make sure you have Node 20+
node --version

# 2. Run it (no install needed)
npx privateboard@latest

# → boots a local server on http://127.0.0.1:3030 and opens your browser
```

First-run onboarding asks you to:
1. Pick a name.
2. Pick a theme.
3. Paste an API key for one provider — OpenRouter is the lowest-friction starting point.
4. Pick a starter question (or convene your own).

That's it. The directors take it from there.

## Bring your own key

PrivateBoard supports four LLM carriers. You only need one to get started; add more later from User Settings.

| Provider | What you get | Where to get a key |
|---|---|---|
| **OpenRouter** | Universal router · access every supported model with one key | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **OpenAI** | Direct route to GPT models | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Google** | Direct route to Gemini (defaults to Gemini Flash) | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **Anthropic** | Direct route to Claude (Sonnet today; more after registry expands) | [console.anthropic.com](https://console.anthropic.com/) |

Keys are stored locally in your `~/.boardroom/` SQLite database. PrivateBoard never proxies through a remote service.

## How a room works

1. **Convene** — pick a subject and a cast of directors (or let the chair auto-pick).
2. **Speaking queue** — the chair seats directors, opens the floor, and routes turns. Directors interrupt, agree, push back.
3. **Pause / resume / steer** — drop a follow-up at any time; the queue absorbs it.
4. **Adjourn** — the chair writes a brief: claims that held up, claims that fell, decisions, open questions.
5. **Brief library** — every adjourned room files a brief; All Reports surfaces them across rooms.

## Data & privacy

- **State directory:** `~/.boardroom/` (SQLite + brief markdown + logs).
- **No telemetry.** PrivateBoard does not phone home.
- **Provider calls are direct.** Your model traffic goes from your machine straight to the provider you configured a key for.
- **Wipe everything:** delete `~/.boardroom/`. Done.

## Development

```bash
git clone https://github.com/kaysaith1900/privateboard.git
cd privateboard
npm install

# watch-mode build + auto-restart
npm run dev

# one-shot build + run
npm run build
node dist/cli.js

# tests
npm test
```

Stack:

- **Runtime:** Node 20+
- **Server:** Hono (`@hono/node-server`)
- **Storage:** `better-sqlite3` with hand-rolled migrations
- **LLM:** Vercel AI SDK adapters for Anthropic, OpenAI, Google, xAI, plus an OpenAI-compatible adapter for OpenRouter
- **Frontend:** vanilla HTML / CSS / JS shipped from `public/`
- **Bundling:** `tsup`
- **Tests:** Vitest

```
src/
├── cli.ts              CLI entrypoint
├── server.ts           Hono app · static + JSON + SSE
├── routes/             /api/agents · rooms · briefs · keys · models · prefs · usage · avatar
├── orchestrator/       chair · room · stream · brief · memory · pickers
├── ai/                 model registry · provider adapters · skills
├── storage/            SQLite + migrations + reconcile
└── seed/               default directors + chair
public/                 frontend (served as-is)
```

## CLI

```
privateboard [options]
  -p, --port <n>   port to listen on (default: auto-detect from 3030)
      --host <h>   host to bind (default: 127.0.0.1)
      --no-open    skip auto-opening the browser
  -V, --version    print version
```

## License

MIT
