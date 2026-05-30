import { describe, expect, it } from "vitest";

import "../public/room-meeting-runtime.js";

const Runtime = (globalThis as unknown as {
	  RoomMeetingRuntime: {
	    shouldPreserveChairPendingForMessage: (message: unknown, context: unknown) => boolean;
	    shouldClearChairPendingOnMessage: (message: unknown, context: unknown) => boolean;
	    isBenignPauseRace: (error: unknown) => boolean;
	    isBenignContinueRace: (error: unknown) => boolean;
	    cleanCaptionText: (raw: unknown) => string;
	    pickVisibleCaptionText: (raw: unknown, options?: Record<string, unknown>) => string;
	    compactCaptionText: (raw: unknown, options?: Record<string, unknown>) => string;
	    deriveRoomActionState: (input: Record<string, unknown>) => Record<string, unknown>;
	    extractRoomVoteItems: (messages: Array<Record<string, unknown>>, modeShift?: Record<string, unknown> | null) => Array<Record<string, unknown>>;
	    VoicePlaybackController: new (opts: Record<string, unknown>) => {
	      setUnlocked(value: boolean): void;
	      markFinal(payload: Record<string, unknown>): void;
	      currentCaption(q: Record<string, unknown>): string;
	      playing?: Record<string, unknown>;
	    };
	    RoomActionController: new (opts: Record<string, unknown>) => {
	      pause(roomId: string, mode?: string): Promise<Record<string, unknown>>;
	      resume(roomId: string): Promise<Record<string, unknown>>;
	      continue(roomId: string): Promise<Record<string, unknown>>;
	      endRound(roomId: string, mode?: string): Promise<Record<string, unknown>>;
	      toggleVoteTrigger(roomId: string, current?: string): Promise<Record<string, unknown>>;
	      toggleDeliveryMode(roomId: string, current?: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
	      acceptModeShiftAndContinue(roomId: string, mode: string): Promise<Record<string, unknown>>;
	      voteKeyPoint(roomId: string, keyPointId: string, requested: "up" | "down" | number | null, prevVote?: "up" | "down" | null): Promise<Record<string, unknown>>;
	      adjourn(roomId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
	      generateBrief(roomId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
	      patchMembers(roomId: string, agentIds: string[]): Promise<Record<string, unknown>>;
	    };
	    SendController: new (opts: Record<string, unknown>) => {
	      submit(args: Record<string, unknown>): Promise<Record<string, unknown>>;
	    };
	    MeetingController: new (opts: Record<string, unknown>) => {
      adoptRoomState(data: unknown): void;
      handleEvent(type: string, payload: unknown): void;
      snapshot(): {
        chairPending: boolean;
        chairPendingPhase: string;
        pendingVoteMessageId?: string | null;
        modeShiftProposal?: Record<string, unknown> | null;
        awaitingContinue?: boolean;
        messages: Array<{ id: string; meta?: Record<string, unknown> }>;
      };
    };
  };
}).RoomMeetingRuntime;

function controller() {
  const c = new Runtime.MeetingController({
    api: {
      getRoom: async () => ({}),
    },
    EventSource: null,
  });
  c.adoptRoomState({
    room: { id: "room-1", status: "live", deliveryMode: "voice" },
    chair: { id: "chair", name: "Chair" },
    members: [],
    messages: [],
    queue: [],
    round: { spoken: 0, total: 0 },
  });
  return c;
}

describe("chair-pending event semantics", () => {
  it("preserves chair-pending for templated chair vote messages until voice arrives", () => {
    const c = controller();
    c.handleEvent("config-event", { kind: "chair-pending", payload: { phase: "round-end" } });

    c.handleEvent("message-appended", {
      messageId: "prompt-1",
      authorKind: "agent",
      authorId: "chair",
      body: "本轮结束，是否继续？",
      meta: { kind: "round-prompt", streaming: false },
    });

    expect(c.snapshot().chairPending).toBe(true);
    expect(c.snapshot().chairPendingPhase).toBe("round-end");

    c.handleEvent("voice-chunk", {
      messageId: "prompt-1",
      seq: 0,
      text: "本轮结束",
      audioBase64: "AA==",
    });

    expect(c.snapshot().chairPending).toBe(false);
    expect(c.snapshot().chairPendingPhase).toBe("");
  });

  it("clears chair-pending when a non-templated speaker message lands", () => {
    const c = controller();
    c.handleEvent("config-event", { kind: "chair-pending", payload: { phase: "next-speaker" } });

    c.handleEvent("message-appended", {
      messageId: "director-1",
      authorKind: "agent",
      authorId: "director",
      body: "",
      meta: { streaming: true },
    });

    expect(c.snapshot().chairPending).toBe(false);
    expect(c.snapshot().chairPendingPhase).toBe("");
  });

  it("uses the same predicate for PC and mobile chair-pending decisions", () => {
    const context = {
      chair: { id: "chair" },
      room: { deliveryMode: "voice" },
    };
    const prompt = {
      messageId: "prompt-1",
      id: "prompt-1",
      authorKind: "agent",
      authorId: "chair",
      meta: { kind: "round-end", streaming: false },
    };
    const director = {
      messageId: "director-1",
      id: "director-1",
      authorKind: "agent",
      authorId: "director",
      meta: { streaming: true },
    };

    expect(Runtime.shouldPreserveChairPendingForMessage(prompt, context)).toBe(true);
    expect(Runtime.shouldClearChairPendingOnMessage(prompt, context)).toBe(false);
    expect(Runtime.shouldPreserveChairPendingForMessage(director, context)).toBe(false);
    expect(Runtime.shouldClearChairPendingOnMessage(director, context)).toBe(true);
  });

  it("marks message-error as final so room actions and stage state can unblock", () => {
    const c = controller();
    c.handleEvent("message-appended", {
      messageId: "director-1",
      authorKind: "agent",
      authorId: "director",
      body: "",
      meta: { streaming: true },
    });

    c.handleEvent("message-error", { messageId: "director-1", message: "llm failed" });

    const msg = c.snapshot().messages.find((m) => m.id === "director-1");
    expect(msg?.meta?.streaming).toBe(false);
    expect(msg?.meta?.speakerStatus).toBe("final");
    expect(msg?.meta?.error).toBe("llm failed");
  });

  it("stores round-ended vote metadata in the shared room snapshot", () => {
    const c = controller();
    c.handleEvent("config-event", {
      kind: "round-ended",
      payload: {
        messageId: "round-end-1",
        modeShiftProposal: { to: "debate", because: "需要分歧" },
      },
    });

    expect(c.snapshot().awaitingContinue).toBe(true);
    expect(c.snapshot().pendingVoteMessageId).toBe("round-end-1");
    expect(c.snapshot().modeShiftProposal).toEqual({ to: "debate", because: "需要分歧" });

    c.handleEvent("config-event", { kind: "round-resumed", payload: {} });
    expect(c.snapshot().awaitingContinue).toBe(false);
    expect(c.snapshot().pendingVoteMessageId).toBeNull();
    expect(c.snapshot().modeShiftProposal).toBeNull();
  });
});

describe("visible caption picking", () => {
  it("uses the latest complete sentence instead of the whole turn body", () => {
    expect(Runtime.pickVisibleCaptionText("第一句已经说完。第二句正在说。")).toBe("第二句正在说。");
  });

  it("cleans markdown before choosing the visible caption", () => {
    expect(Runtime.pickVisibleCaptionText("## 标题\n- 第一条。\n**第二条。**")).toBe("第二条。");
  });

  it("can pick the sentence around an audio cursor", () => {
    const audio = { currentTime: 1, duration: 4 };
    expect(Runtime.pickVisibleCaptionText("一一一一。二二二二。三三三三。四四四四。", { audio })).toBe("一一一一。");
  });

  it("compacts long mobile captions to one short visible sentence", () => {
    const text = "这是一个非常非常长的句子，没有及时断句时也不能把整篇内容铺满移动端底部字幕区域。";
    expect(Runtime.compactCaptionText(text, { maxChars: 18 })).toBe("这是一个非常非常长的句子，没有及时…");
  });
});

describe("shared room action state", () => {
  it("marks a live incomplete round as busy", () => {
    expect(Runtime.deriveRoomActionState({
      roomId: "room-1",
      status: "live",
      queueLen: 0,
      round: { spoken: 2, total: 5 },
    }).kind).toBe("busy");
  });

  it("surfaces keypoint voting at a round boundary", () => {
    const state = Runtime.deriveRoomActionState({
      roomId: "room-1",
      status: "live",
      pendingVoteMessageId: "msg-1",
      round: { spoken: 5, total: 5 },
    });
    expect(state.kind).toBe("keypoints");
    expect(state.showEnd).toBe(true);
  });

  it("maps paused rooms to the continue action", () => {
    expect(Runtime.deriveRoomActionState({
      roomId: "room-1",
      status: "paused",
    }).action).toBe("continue");
  });
});

describe("shared room vote item extraction", () => {
  it("extracts keypoints and mode-shift from chair messages", () => {
    const items = Runtime.extractRoomVoteItems([
      {
        id: "msg-1",
        authorKind: "chair-system",
        body: "",
        meta: {
          keypoints: [
            { id: "kp-1", text: "第一点" },
            { kpId: "kp-2", title: "第二点" },
          ],
          modeShiftProposal: { to: "constructive", because: "需要收敛" },
        },
      },
    ]);

    expect(items).toEqual([
      { type: "mode-shift", id: "mode-shift", to: "constructive", because: "需要收敛" },
      { id: "kp-1", text: "第一点", msgId: "msg-1", vote: null },
      { id: "kp-2", text: "第二点", msgId: "msg-1", vote: null },
    ]);
  });

  it("carries the current vote on extracted keypoints so mobile can toggle", () => {
    const items = Runtime.extractRoomVoteItems([
      {
        id: "msg-1",
        authorKind: "chair-system",
        body: "",
        meta: {
          keypoints: [
            { id: "kp-1", text: "第一点", vote: "up" },
            { id: "kp-2", text: "第二点", vote: "weird" },
          ],
        },
      },
    ]);
    expect(items).toEqual([
      { id: "kp-1", text: "第一点", msgId: "msg-1", vote: "up" },
      { id: "kp-2", text: "第二点", msgId: "msg-1", vote: null },
    ]);
  });

  it("falls back to body lines when keypoints metadata is absent", () => {
    const items = Runtime.extractRoomVoteItems([
      {
        id: "msg-1",
        authorKind: "chair-system",
        body: "短\n足够长的一条关键点\n另一条也足够长",
        meta: { kind: "keypoints" },
      },
    ]);

    expect(items.map((x) => x.text)).toEqual(["足够长的一条关键点", "另一条也足够长"]);
  });
});

describe("shared voice caption playback", () => {
  it("uses full message body to switch captions when replaying stored audio without chunk captions", () => {
    const audio = { currentTime: 3, duration: 4, play: () => Promise.resolve() };
    const vc = new Runtime.VoicePlaybackController({
      audio,
      api: { postVoiceProgress: async () => ({}), postVoiceDone: async () => ({}) },
    });
    vc.setUnlocked(true);
    vc.markFinal({
      roomId: "room-1",
      messageId: "message-1",
      authorId: "agent-1",
      body: "第一句。第二句。第三句。",
    });
    expect(vc.currentCaption(vc.playing || {})).toBe("第三句。");
  });

  it("prefers decoded chunk end times over byte estimates for live caption sync", () => {
    const audio = { currentTime: 4, duration: 10, play: () => Promise.resolve() };
    const vc = new Runtime.VoicePlaybackController({
      audio,
      api: { postVoiceProgress: async () => ({}), postVoiceDone: async () => ({}) },
    });
    const q = {
      captions: [
        { text: "第一句。", bytes: 1, endTime: 5 },
        { text: "第二句。", bytes: 100, endTime: 10 },
      ],
      totalCaptionBytes: 101,
    };
    expect(vc.currentCaption(q)).toBe("第一句。");
    audio.currentTime = 6;
    expect(vc.currentCaption(q)).toBe("第二句。");
  });

  it("can start live voice from the first audio chunk instead of waiting for final", () => {
    let plays = 0;
    const audio = {
      currentTime: 0,
      duration: Number.NaN,
      play: () => { plays += 1; return Promise.resolve(); },
    };
    const vc = new Runtime.VoicePlaybackController({
      audio,
      useMediaSource: true,
      playOnFirstChunk: true,
      api: { postVoiceProgress: async () => ({}), postVoiceDone: async () => ({}) },
    });
    vc.setUnlocked(true);
    vc.enqueueChunk({
      roomId: "room-1",
      messageId: "message-1",
      audioBase64: "AA==",
      mimeType: "audio/mpeg",
      text: "第一段",
    });
    expect(vc.playing?.messageId).toBe("message-1");
    expect(plays).toBe(1);
  });
});

describe("shared room send semantics", () => {
  it("does not require a model key for paused-room supplemental input", async () => {
    const sent: string[] = [];
    const send = new Runtime.SendController({
      api: {
        sendPausedInput: async (_roomId: string, args: { body: string }) => {
          sent.push(args.body);
        },
      },
      requireModelKey: async () => false,
    });

    await expect(send.submit({
      roomId: "room-1",
      roomStatus: "paused",
      body: "补充一条",
    })).resolves.toMatchObject({ consumed: true, pausedInput: true });
    expect(sent).toEqual(["补充一条"]);
  });

  it("requires a model key for live sends that trigger directors", async () => {
    const send = new Runtime.SendController({
      api: {
        sendMessage: async () => {
          throw new Error("should not post without a model key");
        },
      },
      requireModelKey: async () => false,
    });

    await expect(send.submit({
      roomId: "room-1",
      roomStatus: "live",
      body: "继续",
    })).resolves.toMatchObject({ consumed: false, missingKey: true });
  });
});

describe("shared room action semantics", () => {
  it("keeps soft pause pending until the room-paused SSE settles it", async () => {
    const pendingStates: boolean[] = [];
    const action = new Runtime.RoomActionController({
      api: {
        pause: async () => ({ pending: true, room: { id: "room-1", status: "live" } }),
      },
      onPausePending: (active: boolean) => pendingStates.push(active),
    });

    const result = await action.pause("room-1", "soft");

    expect(result.pending).toBe(true);
    expect((result.room as { status: string }).status).toBe("live");
    expect(pendingStates).toEqual([true]);
  });

  it("swallows the PC-defined pause/continue 409 races", async () => {
    const pauseError = Object.assign(new Error("room is not live"), {
      status: 409,
      data: { error: "room is not live" },
    });
    const continueError = Object.assign(new Error("room already adjourned"), {
      status: 409,
      data: { error: "room already adjourned" },
    });

    expect(Runtime.isBenignPauseRace(pauseError)).toBe(true);
    expect(Runtime.isBenignContinueRace(continueError)).toBe(true);

    const action = new Runtime.RoomActionController({
      api: {
        pause: async () => { throw pauseError; },
        continue: async () => { throw continueError; },
      },
    });

    await expect(action.pause("room-1", "hard")).resolves.toMatchObject({ benignRace: true });
    await expect(action.continue("room-1")).resolves.toMatchObject({ benignRace: true });
  });

  it("normalizes round-end mode and surfaces deferred vote requests", async () => {
    const modes: string[] = [];
    const action = new Runtime.RoomActionController({
      api: {
        endRound: async (_roomId: string, mode: string) => {
          modes.push(mode);
          return { deferred: mode === "after-speaker" };
        },
      },
    });

    await expect(action.endRound("room-1", "after-speaker")).resolves.toMatchObject({
      mode: "after-speaker",
      deferred: true,
    });
    await expect(action.endRound("room-1", "bad-mode")).resolves.toMatchObject({
      mode: "now",
      deferred: false,
    });
    expect(modes).toEqual(["after-speaker", "now"]);
  });

  it("centralizes room setting toggles and keypoint voting", async () => {
    const calls: string[] = [];
    const action = new Runtime.RoomActionController({
      api: {
        patchSettings: async (_roomId: string, patch: Record<string, unknown>) => {
          calls.push(JSON.stringify(patch));
          return { room: { ...patch } };
        },
        voteKeyPoint: async (_roomId: string, keyPointId: string, vote: "up" | "down" | null) => {
          calls.push(`vote:${keyPointId}:${vote}`);
          return { ok: true };
        },
      },
    });

    await expect(action.toggleVoteTrigger("room-1", "auto")).resolves.toMatchObject({ next: "manual" });
    await expect(action.toggleDeliveryMode("room-1", "voice")).resolves.toMatchObject({ next: "text" });
    // "down" direction → sends the backend's vote contract, not a numeric score.
    await expect(action.voteKeyPoint("room-1", "kp-1", "down")).resolves.toMatchObject({ vote: "down" });
    // Legacy numeric score is still accepted and mapped (>0 → up, else down).
    await expect(action.voteKeyPoint("room-1", "kp-1", -99)).resolves.toMatchObject({ vote: "down" });
    // Re-voting the same direction toggles the vote off (sends null).
    await expect(action.voteKeyPoint("room-1", "kp-1", "up", "up")).resolves.toMatchObject({ vote: null });
    expect(calls).toEqual([
      "{\"voteTrigger\":\"manual\"}",
      "{\"deliveryMode\":\"text\"}",
      "vote:kp-1:down",
      "vote:kp-1:down",
      "vote:kp-1:null",
    ]);
  });

  it("can gate voice delivery and accept chair mode shift through shared actions", async () => {
    const calls: string[] = [];
    const action = new Runtime.RoomActionController({
      api: {
        patchSettings: async (_roomId: string, patch: Record<string, unknown>) => {
          calls.push(JSON.stringify(patch));
          return { room: { ...patch } };
        },
        continue: async () => {
          calls.push("continue");
          return { room: { status: "live" } };
        },
      },
    });

    await expect(action.toggleDeliveryMode("room-1", "text", {
      ensureVoiceReady: async () => false,
    })).resolves.toMatchObject({ ok: false, blocked: "voice-unavailable", next: "voice" });

    await expect(action.acceptModeShiftAndContinue("room-1", "debate")).resolves.toMatchObject({
      ok: true,
      mode: "debate",
    });
    expect(calls).toEqual(["{\"mode\":\"debate\"}", "continue"]);
  });

  it("centralizes adjourn and regenerate-brief flow", async () => {
    const calls: string[] = [];
    const action = new Runtime.RoomActionController({
      api: {
        adjourn: async (_roomId: string, args: Record<string, unknown>) => {
          calls.push(`adjourn:${JSON.stringify(args || {})}`);
          return { room: { status: "adjourned" } };
        },
        generateBrief: async (_roomId: string, args: Record<string, unknown>) => {
          calls.push(`brief:${JSON.stringify(args || {})}`);
          return { briefId: "brief-1" };
        },
      },
    });

    await expect(action.adjourn("room-1", { mode: "research-note" })).resolves.toMatchObject({
      ok: true,
      room: { status: "adjourned" },
    });
    await expect(action.generateBrief("room-1", {
      status: "live",
      ensureAdjourned: true,
      supplement: "强调风险",
    })).resolves.toMatchObject({
      ok: true,
      briefId: "brief-1",
    });
    expect(calls).toEqual([
      "adjourn:{\"mode\":\"research-note\"}",
      // ensureAdjourned must skip the server's auto-brief so the explicit
      // generateBrief below files exactly one report (no double generation).
      "adjourn:{\"skipBrief\":true}",
      "brief:{\"supplement\":\"强调风险\"}",
    ]);
  });

  it("centralizes cast edits through shared room actions", async () => {
    const action = new Runtime.RoomActionController({
      api: {
        patchMembers: async (_roomId: string, agentIds: string[]) => ({ members: agentIds.map((id) => ({ id })) }),
      },
    });

    await expect(action.patchMembers("room-1", ["a", "b"])).resolves.toMatchObject({
      ok: true,
      members: [{ id: "a" }, { id: "b" }],
    });
  });
});
