/**
 * Auto-continue countdown · shared state machine between PC
 * (public/app.js) and the mobile shell (public/m/index.html). The
 * 10-second timer that fires `continueRoom` automatically when a
 * round completes lives here and ONLY here — surfaces translate
 * their internal room state into a normalised RoomSnapshot, hand
 * it to `setRoom`, and render whatever the controller emits via
 * the tick / fire / beep callbacks. No DOM, no fetch, no SSE.
 *
 * Bridge format · authored as an ES module so vitest can import the
 * pure functions in tests, plus a global-attach side effect so the
 * mobile inline script (which uses window-globals) can pick it up
 * with a plain `<script type="module" src="room-auto-continue.js">`.
 *
 * RoomSnapshot shape (the contract callers must produce):
 *   {
 *     id:             string | null,
 *     status:         'live' | 'paused' | 'adjourned' | null,
 *     awaitingClarify:  boolean,
 *     awaitingContinue: boolean,
 *     voteTrigger:    'auto' | 'manual',
 *     queueLen:       number,          // pending speakers in the queue
 *     round:          { spoken: number, total: number } | null,
 *     lastAgentMsg:   { streaming: boolean, voicePlaying: boolean } | null,
 *     chairPending:   boolean          // chair is mid-vote / mid-prompt
 *   }
 *
 * The previous mobile-only `continueSeen > 0` / `onBoardroom` gates
 * (which forced the first round on the text view to be advanced
 * manually) are intentionally NOT replicated here — PC has never
 * required a manual first click and the surfaces are meant to be
 * behavioural twins. UI differences (where the countdown badge is
 * painted, what the beep sounds like) stay in the surfaces.
 */

/** Pure decision · `true` iff the supplied snapshot describes a room
 *  in the resting "round complete, nothing in flight" state where the
 *  10-second timer is allowed to spin. Mirrors PC `App.canAutoContinue`
 *  in public/app.js (which still inlines its own copy pending a later
 *  migration to this module). */
export function canAutoContinue(room) {
  if (!room) return false;
  if (room.status !== "live") return false;
  if (room.awaitingClarify) return false;
  if (room.awaitingContinue) return false;
  if (room.voteTrigger === "manual") return false;
  if ((room.queueLen || 0) > 0) return false;
  if (!room.round || (room.round.total || 0) === 0) return false;
  if ((room.round.spoken || 0) < (room.round.total || 0)) return false;
  if (room.lastAgentMsg && room.lastAgentMsg.streaming) return false;
  if (room.lastAgentMsg && room.lastAgentMsg.voicePlaying) return false;
  if (room.chairPending) return false;
  return true;
}

const DEFAULT_TOTAL_SECONDS = 10;

/** Stateful controller wrapping the countdown lifecycle. One instance
 *  per surface (PC, mobile). Surfaces feed room snapshots in via
 *  `setRoom`; the controller decides whether the timer should be
 *  running, ticks it down, and invokes `onFire` when it reaches zero. */
export class AutoContinueController {
  constructor(opts) {
    opts = opts || {};
    this.totalSeconds = opts.totalSeconds || DEFAULT_TOTAL_SECONDS;
    this.onTick = typeof opts.onTick === "function" ? opts.onTick : noop;
    this.onFire = typeof opts.onFire === "function" ? opts.onFire : noop;
    this.onBeep = typeof opts.onBeep === "function" ? opts.onBeep : noop;
    this._room = null;
    this._timer = null;
    this._deadline = 0;
    this._secondsLeft = 0;
    this._firing = false;
  }

  /** Caller hands in a fresh snapshot every time room state changes
   *  (SSE update, poll tick, user action). The controller starts the
   *  timer if state is now eligible, or cancels it if not. */
  setRoom(room) {
    this._room = room;
    if (canAutoContinue(room)) {
      this._maybeStart();
    } else {
      this.cancel();
    }
  }

  /** Hard reset · drop the room reference and stop any running timer.
   *  Surfaces call this when the user navigates away or the room is
   *  torn down (adjourned, deleted). Distinct from `cancel()` because
   *  it also nulls the snapshot so a subsequent stale tick can't
   *  restart on the old data. */
  detach() {
    this._room = null;
    this.cancel();
  }

  /** Stop the timer without dropping the room reference · used when
   *  the user clicks the manual Continue button (the controller will
   *  re-arm itself on the next `setRoom` call once the next round
   *  finishes). */
  cancel() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._secondsLeft = 0;
    this._deadline = 0;
    this._firing = false;
    // Emit a final 0 so surfaces can clear their countdown badge.
    this.onTick(0);
  }

  /** Seconds remaining on the current countdown · 0 when idle. */
  get secondsLeft() {
    return this._secondsLeft;
  }

  /** True while the timer is actively ticking. */
  get active() {
    return !!this._timer;
  }

  _maybeStart() {
    if (this._timer) return; // already counting · don't restart mid-cycle
    this._deadline = Date.now() + this.totalSeconds * 1000;
    this._secondsLeft = this.totalSeconds;
    this._firing = false;
    this._timer = setInterval(() => this._tick(), 1000);
    // First beep + paint fire synchronously so the audible "10!" cue
    // lands in lockstep with the visible number. The next 9 ticks
    // come from `_tick`.
    this.onBeep(this.totalSeconds);
    this.onTick(this.totalSeconds);
  }

  _tick() {
    // Re-validate every second · if the room state drifted out of the
    // eligible shape mid-countdown (new message landed, user left the
    // room, status flipped to paused), self-cancel instead of blindly
    // ticking down to a stale fire. This is the mobile-side bug the
    // previous inline impl never caught.
    if (!canAutoContinue(this._room)) {
      this.cancel();
      return;
    }
    const left = Math.max(0, Math.ceil((this._deadline - Date.now()) / 1000));
    this._secondsLeft = left;
    this.onTick(left);
    this.onBeep(left);
    if (left <= 0 && !this._firing) {
      this._firing = true;
      clearInterval(this._timer);
      this._timer = null;
      this.onFire();
    }
  }
}

function noop() {}

// Side-effect global · the mobile shell loads this file via a
// `<script type="module">` tag and consumes the API through
// `window.RoomAutoContinue.*` because its inline script doesn't itself
// use `import`. Tests pick the named exports up directly.
if (typeof globalThis !== "undefined") {
  globalThis.RoomAutoContinue = { canAutoContinue, AutoContinueController };
}
