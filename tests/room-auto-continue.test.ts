/**
 * Unit coverage for the shared auto-continue controller that powers
 * both PC (public/app.js) and the mobile shell (public/m/index.html).
 *
 * The module is plain JS (browser-loadable as ES module) so vitest can
 * import the named exports directly. Tests focus on:
 *   · canAutoContinue truth table — every eligibility gate
 *   · controller lifecycle — setRoom starts/cancels, detach clears
 *   · the mid-tick self-cancel that fixes the "still beeping after
 *     leaving the room" mobile bug
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shared controller ships as a classic IIFE so the mobile shell's
// inline classic script can consume it synchronously. Pull it in via
// side-effect import + the `globalThis` namespace it attaches.
import "../public/room-auto-continue.js";

const RoomAutoContinue = (globalThis as unknown as {
  RoomAutoContinue: {
    canAutoContinue: (room: unknown) => boolean;
    activeRoundPromptId: (messages: unknown[], chairId: string) => string | null;
    isRoundPromptSpent: (messages: unknown[], chairId: string, messageId: string) => boolean;
    AutoContinueController: new (opts: Record<string, unknown>) => {
      setRoom(room: unknown): void;
      cancel(): void;
      detach(): void;
      readonly secondsLeft: number;
      readonly active: boolean;
    };
  };
}).RoomAutoContinue;

const { canAutoContinue, activeRoundPromptId, isRoundPromptSpent, AutoContinueController } = RoomAutoContinue;

function liveRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: "room-1",
    status: "live",
    awaitingClarify: false,
    awaitingContinue: false,
    voteTrigger: "auto",
    queueLen: 0,
    round: { spoken: 3, total: 3 },
    activeRoundPromptId: "prompt-1",
    lastAgentMsg: { streaming: false, voicePlaying: false },
    chairPending: false,
    ...overrides,
  };
}

describe("canAutoContinue", () => {
  it("returns true for a live room with a complete round and nothing in flight", () => {
    expect(canAutoContinue(liveRoom())).toBe(true);
  });

  it("returns false when room is null", () => {
    expect(canAutoContinue(null)).toBe(false);
  });

  it("returns false when room has no active id", () => {
    expect(canAutoContinue(liveRoom({ id: null }))).toBe(false);
    expect(canAutoContinue(liveRoom({ id: "" }))).toBe(false);
  });

  it("returns false when status is not live", () => {
    expect(canAutoContinue(liveRoom({ status: "paused" }))).toBe(false);
    expect(canAutoContinue(liveRoom({ status: "adjourned" }))).toBe(false);
  });

  it("returns false while awaitingClarify or awaitingContinue", () => {
    expect(canAutoContinue(liveRoom({ awaitingClarify: true }))).toBe(false);
    expect(canAutoContinue(liveRoom({ awaitingContinue: true }))).toBe(false);
  });

  it("returns false when voteTrigger is manual", () => {
    expect(canAutoContinue(liveRoom({ voteTrigger: "manual" }))).toBe(false);
  });

  it("returns false when the speaker queue still has pending entries", () => {
    expect(canAutoContinue(liveRoom({ queueLen: 1 }))).toBe(false);
  });

  it("returns false until the round is complete", () => {
    expect(canAutoContinue(liveRoom({ round: { spoken: 1, total: 3 } }))).toBe(false);
    expect(canAutoContinue(liveRoom({ round: { spoken: 0, total: 0 } }))).toBe(false);
    expect(canAutoContinue(liveRoom({ round: null }))).toBe(false);
  });

  it("returns false until a live round-prompt exists", () => {
    expect(canAutoContinue(liveRoom({ activeRoundPromptId: null }))).toBe(false);
  });

  it("returns false while the last agent message is still streaming or speaking", () => {
    expect(canAutoContinue(liveRoom({ lastAgentMsg: { streaming: true, voicePlaying: false } }))).toBe(false);
    expect(canAutoContinue(liveRoom({ lastAgentMsg: { streaming: false, voicePlaying: true } }))).toBe(false);
  });

  it("returns false while the chair is mid-vote / mid-prompt", () => {
    expect(canAutoContinue(liveRoom({ chairPending: true }))).toBe(false);
  });
});

describe("round-prompt helpers", () => {
  it("returns the latest unspent chair round-prompt", () => {
    const messages = [
      { id: "settings", authorKind: "agent", authorId: "chair", meta: { kind: "settings" } },
      { id: "prompt-1", authorKind: "agent", authorId: "chair", meta: { kind: "round-prompt" } },
      { id: "settings-2", authorKind: "agent", authorId: "chair", meta: { kind: "settings" } },
    ];
    expect(activeRoundPromptId(messages, "chair")).toBe("prompt-1");
    expect(isRoundPromptSpent(messages, "chair", "prompt-1")).toBe(false);
  });

  it("marks a round-prompt spent once any non-settings event follows it", () => {
    const messages = [
      { id: "prompt-1", authorKind: "agent", authorId: "chair", meta: { kind: "round-prompt" } },
      { id: "director-1", authorKind: "agent", authorId: "director", meta: { streaming: true } },
    ];
    expect(activeRoundPromptId(messages, "chair")).toBeNull();
    expect(isRoundPromptSpent(messages, "chair", "prompt-1")).toBe(true);
  });
});

describe("AutoContinueController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts ticking and fires onFire when the countdown reaches zero", () => {
    const onTick = vi.fn();
    const onFire = vi.fn();
    const onBeep = vi.fn();
    const c = new AutoContinueController({ totalSeconds: 3, onTick, onFire, onBeep });

    c.setRoom(liveRoom());

    // First tick emitted synchronously during setRoom → maybeStart.
    expect(c.active).toBe(true);
    expect(onTick).toHaveBeenLastCalledWith(3);
    expect(onBeep).toHaveBeenLastCalledWith(3);
    expect(onFire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenLastCalledWith(2);

    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenLastCalledWith(1);

    vi.advanceTimersByTime(1000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(c.active).toBe(false);
  });

  it("does not restart when setRoom is called with the same eligible state", () => {
    const onTick = vi.fn();
    const c = new AutoContinueController({ totalSeconds: 10, onTick, onFire: () => {} });

    c.setRoom(liveRoom());
    expect(c.active).toBe(true);
    vi.advanceTimersByTime(2000);
    const before = c.secondsLeft;

    c.setRoom(liveRoom()); // same eligible state again
    // Still ticking from the original start — not reset to 10.
    expect(c.secondsLeft).toBe(before);
    expect(c.active).toBe(true);
  });

  it("cancels when setRoom drops state out of eligibility", () => {
    const onFire = vi.fn();
    const c = new AutoContinueController({ totalSeconds: 5, onFire });

    c.setRoom(liveRoom());
    expect(c.active).toBe(true);

    c.setRoom(liveRoom({ awaitingClarify: true }));
    expect(c.active).toBe(false);
    expect(onFire).not.toHaveBeenCalled();

    // Advancing past the original deadline must NOT fire after cancel.
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("self-cancels mid-tick when the controller's room state has drifted out of eligibility", () => {
    // Mirrors the mobile bug: countdown starts, user leaves the room
    // (state should now be ineligible), but no setRoom was fired before
    // the next tick. The tick itself must re-check canAutoContinue and
    // self-cancel — otherwise it keeps beeping and eventually fires
    // onFire for a room the user has already left.
    const onFire = vi.fn();
    const onBeep = vi.fn();
    const c = new AutoContinueController({ totalSeconds: 5, onFire, onBeep });

    c.setRoom(liveRoom());
    expect(c.active).toBe(true);

    // Mutate the snapshot the controller is holding · the next tick
    // should see it and bail. Real callers won't mutate like this —
    // they'll setRoom(null) on leave — but this directly tests the
    // defensive re-check.
    // @ts-expect-error · poking the private field for the bug repro.
    c._room.status = "paused";

    onBeep.mockClear();
    vi.advanceTimersByTime(1000);
    expect(c.active).toBe(false);
    expect(onFire).not.toHaveBeenCalled();
    // No further beeps after the self-cancel · the cancel itself
    // emits one final onTick(0) but does not invoke onBeep again.
    expect(onBeep).not.toHaveBeenCalled();
  });

  it("detach() drops the room reference and stops the timer", () => {
    const onFire = vi.fn();
    const c = new AutoContinueController({ totalSeconds: 5, onFire });

    c.setRoom(liveRoom());
    expect(c.active).toBe(true);

    c.detach();
    expect(c.active).toBe(false);

    // After detach, even if a tick was queued, no fire should land.
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("does not start when the first setRoom is ineligible", () => {
    const onTick = vi.fn();
    const c = new AutoContinueController({ totalSeconds: 5, onTick, onFire: () => {} });

    c.setRoom(liveRoom({ awaitingClarify: true }));
    expect(c.active).toBe(false);
    // onTick still fires once with 0 so the surface can clear its badge.
    expect(onTick).toHaveBeenLastCalledWith(0);
  });
});
