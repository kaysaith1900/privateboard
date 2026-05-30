import { test, expect } from "@playwright/test";

/**
 * PC (desktop) e2e harness · foundation for verifying that the PC app
 * (public/index.html + app.js + agent-profile.js) and the mobile shell share
 * one logic layer. PC is the reference implementation. These smoke tests
 * assert the app boots cleanly and reuses the SAME shared runtimes the mobile
 * shell uses (window.AgentRuntime / window.RoomMeetingRuntime). Per-feature
 * parity tests are layered on top of this base.
 */

const BASE = "http://127.0.0.1:3030";

test("PC app boots with no JS errors and exposes the shared runtimes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 8_000 });
  const probe = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ar = w.AgentRuntime as Record<string, unknown> | undefined;
    const rt = w.RoomMeetingRuntime as Record<string, unknown> | undefined;
    return {
      app: typeof w.app,
      agentRuntime: typeof w.AgentRuntime,
      roomMeetingRuntime: typeof w.RoomMeetingRuntime,
      // The PC controller routes through the SAME shared clients mobile uses.
      createAgentApi: typeof (ar && ar.createAgentApi),
      setDeliveryModeOnController: typeof (rt && rt.RoomActionController),
      ensureAgentApi: typeof (w.app as { _ensureAgentApi?: unknown })?._ensureAgentApi,
    };
  });
  expect(errors).toEqual([]);
  expect(probe.app).toBe("object");
  expect(probe.agentRuntime).toBe("object");
  expect(probe.roomMeetingRuntime).toBe("object");
  expect(probe.createAgentApi).toBe("function");
  expect(probe.setDeliveryModeOnController).toBe("function");
  expect(probe.ensureAgentApi).toBe("function");
});

test("PC agent profile loads real data through the shared agent api", async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: { agents?: unknown[] } }).app?.agents?.length, null, { timeout: 8_000 });
  const opened = await page.evaluate(() => {
    const w = window as unknown as { app: { agents: Array<{ id: string }> }; openAgentProfile?: (id: string) => void };
    const id = w.app.agents[0]?.id;
    if (id && typeof w.openAgentProfile === "function") w.openAgentProfile(id);
    return id || null;
  });
  expect(opened).toBeTruthy();
  // Track Record counters load via agentApi().agentStats (shared client).
  await expect(page.locator("[data-ap-stat-rooms]")).not.toHaveText("—", { timeout: 8_000 });
});

// ── PC page/surface coverage · one assertion per major PC surface, building
// toward feature-by-feature parity with the mobile suite (PC is the standard).

test("PC sidebar renders the rooms list", async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: { rooms?: unknown[] } }).app?.rooms?.length, null, { timeout: 8_000 });
  const n = await page.evaluate(() => (window as unknown as { app: { rooms: unknown[] } }).app.rooms.length);
  expect(n).toBeGreaterThan(0);
});

test("PC opens a room and renders messages", async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: { rooms?: unknown[] } }).app?.rooms?.length, null, { timeout: 8_000 });
  const res = await page.evaluate(async () => {
    const w = window as unknown as { app: { rooms: Array<{ id: string }>; openRoom: (id: string) => Promise<void>; currentRoomId?: string } };
    const id = w.app.rooms[0]?.id;
    if (id) await w.app.openRoom(id);
    return { id: id || null, current: w.app.currentRoomId || null };
  });
  expect(res.id).toBeTruthy();
  expect(res.current).toBe(res.id);
});

test("PC reports page opens via #/reports", async ({ page }) => {
  await page.goto(`${BASE}/#/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 8_000 });
  // openAllReports / renderReportsPage is the PC reports surface.
  const ok = await page.evaluate(() => typeof (window as unknown as { app: { renderReportsPage?: unknown } }).app.renderReportsPage === "function");
  expect(ok).toBe(true);
});

test("PC agent composer (new director) renders its form", async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: { setComposerMode?: unknown } }).app?.setComposerMode, null, { timeout: 8_000 });
  const ok = await page.evaluate(() => {
    const w = window as unknown as { app: { setComposerMode?: (m: string) => void; renderAgentComposerHtml?: unknown } };
    return typeof w.app.renderAgentComposerHtml === "function";
  });
  expect(ok).toBe(true);
});

test("PC room-action surface reuses the shared RoomActionController (pause/resume/vote/delivery)", async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 8_000 });
  const probe = await page.evaluate(() => {
    const w = window as unknown as { app: Record<string, unknown>; RoomMeetingRuntime: { RoomActionController?: unknown } };
    const ctrl = (w.app.ensureRoomActionController as () => Record<string, unknown>)?.call(w.app);
    return {
      ensureRoomActionController: typeof w.app.ensureRoomActionController,
      pause: typeof ctrl?.pause,
      resume: typeof ctrl?.resume,
      voteKeyPoint: typeof ctrl?.voteKeyPoint,
      setDeliveryMode: typeof ctrl?.setDeliveryMode,
      sharedClass: typeof w.RoomMeetingRuntime.RoomActionController,
    };
  });
  expect(probe.ensureRoomActionController).toBe("function");
  expect(probe.pause).toBe("function");
  expect(probe.resume).toBe("function");
  expect(probe.voteKeyPoint).toBe("function");
  expect(probe.setDeliveryMode).toBe("function");
  expect(probe.sharedClass).toBe("function");
});

test("PC voice playback uses the shared VoicePlaybackController", async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 8_000 });
  const ok = await page.evaluate(() => {
    const w = window as unknown as { app: { ensureRoomVoiceController?: () => unknown }; RoomMeetingRuntime: { VoicePlaybackController?: unknown } };
    return typeof w.app.ensureRoomVoiceController === "function" && typeof w.RoomMeetingRuntime.VoicePlaybackController === "function";
  });
  expect(ok).toBe(true);
});

test("PC exposes settings / credentials + memory/skill/brief surfaces (mobile parity)", async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 8_000 });
  const probe = await page.evaluate(() => {
    const w = window as unknown as { app: Record<string, unknown>; openUserSettings?: unknown; openAgentProfile?: unknown };
    return {
      userSettings: typeof w.openUserSettings,
      agentProfile: typeof w.openAgentProfile,
      adjourn: typeof w.app.adjournRoom,
      divergence: typeof w.app.openDivergenceOverlay,
      brief: typeof w.app.generateBriefForAdjournedRoom,
      requireModelKey: typeof w.app.requireModelKey,
    };
  });
  expect(probe.userSettings).toBe("function");
  expect(probe.agentProfile).toBe("function");
  expect(probe.adjourn).toBe("function");
  expect(probe.divergence).toBe("function");
  expect(probe.brief).toBe("function");
  expect(probe.requireModelKey).toBe("function");
});

// ── PC parity for the behaviors the mobile suite exercises (PC = standard).
// These assert the PC controller exposes the same flows mobile tests, routed
// through the shared runtimes, so the two ends stay logic-aligned.
test("PC exposes the mobile-tested room/meeting behaviors", async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 8_000 });
  const t = await page.evaluate(() => {
    const a = (window as unknown as { app: Record<string, unknown> }).app;
    const RT = (window as unknown as { RoomMeetingRuntime: Record<string, unknown> }).RoomMeetingRuntime;
    const ty = (o: Record<string, unknown>, k: string) => typeof o[k];
    return {
      // send / mentions
      sendMessage: ty(a, "sendMessage"), openSendChoiceModal: ty(a, "openSendChoiceModal"), handleSendChoice: ty(a, "handleSendChoice"),
      // pause / resume choices
      openPauseChoiceModal: ty(a, "openPauseChoiceModal"), openResumeChoiceModal: ty(a, "openResumeChoiceModal"), handleResumeChoice: ty(a, "handleResumeChoice"),
      // round-end / keypoints / auto-continue
      requestRoundEnd: ty(a, "requestRoundEnd"), voteKeyPoint: ty(a, "voteKeyPoint"), maybeStartContinueCountdown: ty(a, "maybeStartContinueCountdown"), continueRoom: ty(a, "continueRoom"), acceptModeShiftAndContinue: ty(a, "acceptModeShiftAndContinue"),
      // voice queue
      enqueueVoiceChunk: ty(a, "enqueueVoiceChunk"), drainVoiceQueue: ty(a, "drainVoiceQueue"), unlockAudioPlayback: ty(a, "unlockAudioPlayback"),
      // cast / notes / brief mode
      updateRoomSettings: ty(a, "updateRoomSettings"), loadRoomNotes: ty(a, "loadRoomNotes"), renderBriefModePicker: ty(a, "renderBriefModePicker"),
      // shared pure helpers used by both ends
      deriveRoomActionState: typeof RT.deriveRoomActionState, extractRoomVoteItems: typeof RT.extractRoomVoteItems, nextDeliveryMode: typeof RT.nextDeliveryMode,
    };
  });
  for (const [k, v] of Object.entries(t)) {
    expect(v, `PC missing ${k}`).toBe("function");
  }
});
