# Voice Distill · from public video to MiniMax voice clone

PrivateBoard can take a public video URL + the name of a person in
that video, automatically extract a clean speech sample, and register
it as a MiniMax-cloned voice. The freshly cloned voice is then attached
to the next director the user saves, so the director can speak in the
real person's voice immediately.

This is the "agent creation auto-supports distilling a real person's
voice" feature scoped to MiniMax, the user's existing TTS provider.

## Prerequisites

- A MiniMax voice credential is configured and active
  (Preferences → Voice → MiniMax). The same key is reused for ASR,
  file upload, and voice clone.
- `yt-dlp` available on `PATH`. Install with `brew install yt-dlp`
  (macOS) or your distro's package manager.
- `ffmpeg` available on `PATH`. Install with `brew install ffmpeg`.

The dev server prints a startup warning if either binary is missing.

## How to use it

1. Open the agent composer (sidebar → **+ New Agent**).
2. Scroll past the celebrity grid to the **voice distill** panel.
3. Type the target speaker's display name (any public figure with
   publicly available recordings).
4. (Optional) paste a specific URL. Leave the URL field empty to let
   the pipeline **auto-search** YouTube and pick a candidate video.
5. Click **蒸馏声音**. The panel switches to a 10-phase progress view.
6. When the panel reads **complete · voice_id ready**, save your new
   director through the normal flow. The cloned voice is auto-attached
   as the director's default TTS voice.

You can run distill before you've named or described the director —
the cloned voice waits in a pending slot until you save the next agent.

## The pipeline (10 phases)

| # | Phase | Behaviour |
|---|---|---|
| 1 | Search candidate video | `yt-dlp ytsearchN:` finds a public interview / talk for the named speaker, ranks results by title match, duration, view count, and recency, and picks the best. Skipped when the caller supplied a URL. |
| 2 | Download audio | `yt-dlp` extracts the mp3 audio track. Inputs longer than 30 minutes are rejected. |
| 3 | Normalize audio | `ffmpeg` re-encodes to 16 kHz mono mp3 — the format MiniMax voice clone prefers. |
| 4 | Transcribe speech | MiniMax ASR with timestamps. Falls back to a silence heuristic if no ASR endpoint responds. |
| 5 | Identify target speaker | A utility-tier LLM (haiku-class) reads the transcript + the target name and picks segments where that person is speaking. Falls back to the longest non-silent stretch if no LLM is reachable or no segment matches. |
| 6 | Extract clean clip | `ffmpeg` slices the chosen segments and concatenates them, capped at 120 seconds. |
| 7 | Upload to MiniMax | `POST /v1/files/upload` with `purpose=voice_clone`. |
| 8 | Register voice clone | `POST /v1/voice_clone` with a generated slug like `pb_<name>_<random>`. |
| 9 | Persist + link agent | Stamps the new `voice_id` onto the linked agent's voice profile, or stashes it for the next saved agent. |
| 10 | Cleanup | Removes the `/tmp/voice-distill/<jobId>/` scratch directory. |

The pipeline emits per-phase SSE progress events on `GET /api/voices/clone-from-video/:jobId/stream`. Wall-clock hard cap is 15 minutes; the boot-time recovery in `src/boot.ts` marks any still-running job as failed after a server restart.

## API surface

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/voices/clone-from-video` | `{ videoUrl, celebrity, agentId? }` | `{ jobId }` |
| `GET` | `/api/voices/clone-from-video/:jobId/stream` | (SSE) | phase events + `voice-distill-final \| voice-distill-error \| voice-distill-aborted` |
| `POST` | `/api/voices/clone-from-video/:jobId/abort` | (none) | `{ ok: true }` (idempotent) |
| `GET` | `/api/voices/clone-from-video/recent?limit=20` | (none) | `{ jobs: VoiceDistillJob[] }` |

## Failure modes

- **Video too long**: reject in phase 1 with a clear error message.
- **Live stream URL**: rejected — only recorded videos are supported.
- **MiniMax ASR unavailable on this tenant**: phase 3 logs a warning,
  phase 4 falls back to silence detection. Quality of the clone may
  drop, but the pipeline still produces a voice_id.
- **No identifiable speaker in transcript**: phase 4 falls back to the
  longest non-silent stretch (centred 60s window).
- **Quota / balance exhaustion** on MiniMax: phase 6 or 7 surfaces the
  upstream error verbatim. The user resolves it on the MiniMax console.
- **Server restart mid-pipeline**: the boot recovery flips the row to
  `failed` with `error = "server restarted mid-distill"`. The temporary
  `/tmp/voice-distill/<jobId>/` directory is cleaned up either when the
  pipeline's `finally` runs or on the next process start.

## Legal / ethical note

Cloning the voice of a real public figure is constrained by the local
"right of voice" / personality-rights regime (e.g. PRC Civil Code
§1023). PrivateBoard's voice distill is meant for the user's private
boardroom — not for redistribution. Use clips you have legitimate
access to and don't deploy the cloned voice in public-facing
applications without consent.
