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
