/**
 * Mobile (PWA) e2e — covers every screen + every interactive feature on the
 * mobile shell. Mirrors the matrix used in the in-session MCP-Playwright
 * audit. Failing any of these means `public/m/index.html` has regressed.
 *
 *     npx playwright test
 */
import { expect, request, test, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3030";

test.describe.configure({ mode: "serial" });

// ── fixtures ───────────────────────────────────────────────────────────────
let LIVE_OR_PAUSED_ROOM = "";
let VOICE_LIVE_OR_PAUSED_ROOM = "";
let ADJOURNED_ROOM = "";
let FIRST_AGENT = "";
let CHAIR_ID = "";

test.beforeAll(async () => {
  const ctx = await request.newContext({ baseURL: BASE });
  const rooms = (await (await ctx.get("/api/rooms")).json()).rooms ?? [];
  LIVE_OR_PAUSED_ROOM = rooms.find((r: { status: string }) => r.status === "live" || r.status === "paused")?.id ?? rooms[0]?.id ?? "";
  VOICE_LIVE_OR_PAUSED_ROOM = rooms.find((r: { status: string; deliveryMode?: string }) =>
    (r.status === "live" || r.status === "paused") && r.deliveryMode === "voice"
  )?.id ?? "";
  ADJOURNED_ROOM = rooms.find((r: { status: string }) => r.status === "adjourned")?.id ?? rooms[0]?.id ?? "";
  const agentState = await (await ctx.get("/api/agents")).json();
  const agents = agentState.agents ?? [];
  CHAIR_ID = agentState.chair?.id ?? "";
  FIRST_AGENT = agents.find((a: { roleKind: string }) => a.roleKind === "director")?.id ?? agents[0]?.id ?? "";
  await ctx.dispose();
});

async function waitListReady(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (elId) => {
      const el = document.getElementById(elId);
      return !!el && el.dataset.state !== "loading";
    },
    id,
    { timeout: 6_000 },
  );
}

async function installFetchInterceptor(page: Page, options: { hasModelKey?: boolean; hasVoiceKey?: boolean } = {}): Promise<void> {
  // Intercept POST/DELETE/PATCH so functional tests don't mutate real state.
  // Most GETs still hit the real server so list rendering tests are honest;
  // model-key endpoints are faked so action tests do not depend on local keys.
  const hasModelKey = options.hasModelKey ?? true;
  const hasVoiceKey = options.hasVoiceKey ?? true;
  await page.addInitScript(({ hasModelKey: keyReady, hasVoiceKey: voiceReady }) => {
    const w = window as unknown as { __captured: { url: string; method: string; body?: string }[] };
    w.__captured = [];
    const orig = window.fetch.bind(window);
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET" && /(^|\/)api\/models(?:$|\?)/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ hasAnyKey: keyReady, models: [], reachable: [], providers: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          }),
        );
      }
      if (method === "GET" && /(^|\/)api\/credentials(?:$|\?)/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({
            credentials: keyReady ? [{ id: "fake-llm", provider: "openai", label: "Test LLM" }] : [],
            activeId: keyReady ? "fake-llm" : null,
          }), {
            status: 200, headers: { "content-type": "application/json" },
          }),
        );
      }
      if (method === "GET" && /(^|\/)api\/voice-credentials(?:$|\?)/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({
            credentials: voiceReady ? [{ id: "fake-voice", provider: "minimax", label: "Test Voice" }] : [],
            activeId: voiceReady ? "fake-voice" : null,
          }), {
            status: 200, headers: { "content-type": "application/json" },
          }),
        );
      }
      if (method !== "GET" && method !== "HEAD") {
        w.__captured.push({ url, method, body: typeof init?.body === "string" ? init?.body : undefined });
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, briefId: "fake-id", room: { id: "mock", status: "live" }, members: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          }),
        );
      }
      return orig(input as RequestInfo, init);
    };
  }, { hasModelKey, hasVoiceKey });
}

async function captured(page: Page): Promise<{ url: string; method: string; body?: string }[]> {
  return page.evaluate(() => (window as unknown as { __captured: unknown[] }).__captured as { url: string; method: string; body?: string }[]);
}

async function installActiveRoundPrompt(page: Page, promptId = "e2e-round-prompt"): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as {
      appState: { activeChair?: { id?: string; name?: string } };
      roomMeetingController?: {
        state?: {
          chair?: { id: string; name: string };
          messagesById?: Record<string, unknown>;
          order?: string[];
        };
      };
    };
    const chair = {
      id: w.appState.activeChair?.id || "e2e-chair",
      name: w.appState.activeChair?.name || "Chair",
    };
    w.appState.activeChair = chair;
    const state = w.roomMeetingController?.state;
    if (!state) return;
    state.chair = chair;
    state.messagesById = {
      ...(state.messagesById || {}),
      [id]: {
        id,
        authorKind: "agent",
        authorId: chair.id,
        body: "继续？",
        meta: { kind: "round-prompt" },
      },
    };
    state.order = [
      ...(Array.isArray(state.order) ? state.order.filter((messageId) => messageId !== id) : []),
      id,
    ];
  }, promptId);
}

// ── basic screen render tests ──────────────────────────────────────────────

test("rooms tab renders real cards + 4-tab navbar", async ({ page }) => {
  await page.goto(`${BASE}/m/`);
  await waitListReady(page, "rooms-list");
  await expect(page.locator(".screen.on")).toHaveAttribute("data-screen", "rooms");
  await expect(page.locator(".tabbar .tab")).toHaveCount(4);
  await expect(page.locator(".tabbar .tab.on")).toHaveAttribute("data-tab", "rooms");
  expect((await page.locator("#rooms-list .room-card").count()) + (await page.locator("#rooms-list [data-empty]").count())).toBeGreaterThan(0);
});

test("agents tab renders director grid", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=agents`);
  await waitListReady(page, "agents-list");
  expect(await page.locator("#agents-list .ag-card").count()).toBeGreaterThan(0);
});

test("briefs tab renders cards with mode-aware viewer href", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=briefs`);
  await waitListReady(page, "briefs-list");
  expect((await page.locator("#briefs-list .brief-card").count()) + (await page.locator("#briefs-list [data-empty]").count())).toBeGreaterThan(0);
});

test("boardroom no-roomId renders demo seats with JS layout", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=boardroom`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const seatCount = await page.locator("#bd-stage .bd-seat").count();
  expect(seatCount).toBeGreaterThanOrEqual(4);
  const firstStyle = await page.locator("#bd-stage .bd-seat").first().getAttribute("style");
  expect(firstStyle).toMatch(/left:\s*\d/);
  expect(firstStyle).toMatch(/transform:\s*translate/);
});

test("boardroom with roomId loads real room members", async ({ page }) => {
  test.skip(!ADJOURNED_ROOM, "no rooms in DB");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${ADJOURNED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("bd-title")?.textContent && document.getElementById("bd-title")?.textContent !== "圆桌", null, { timeout: 6_000 });
  await expect(page.locator("#bd-title")).not.toHaveText("圆桌");
  await expect(page.locator("#bd-sub")).toContainText("directors");
  expect(await page.locator("#bd-stage .bd-seat").count()).toBeGreaterThan(0);
});

test("boardroom renders PC chair as moderator seat", async ({ page }) => {
  test.skip(!ADJOURNED_ROOM || !CHAIR_ID, "need a room and chair");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${ADJOURNED_ROOM}`);
  await page.waitForFunction(() => (window as unknown as { appState?: { activeChair?: { id?: string } } }).appState?.activeChair?.id, null, { timeout: 6_000 });
  const meta = await page.evaluate(() => {
    const seats = Array.from(document.querySelectorAll("#bd-stage .bd-seat")) as HTMLElement[];
    const chairSeats = seats.filter((el) => el.dataset.roleKind === "moderator");
    return {
      chairId: (window as unknown as { appState: { activeChair?: { id?: string } } }).appState.activeChair?.id,
      chairSeatCount: chairSeats.length,
      firstRole: seats[0]?.dataset.roleKind || "",
      firstName: seats[0]?.querySelector(".bd-name")?.textContent || "",
      sub: document.getElementById("bd-sub")?.textContent || "",
    };
  });
  expect(meta.chairId).toBe(CHAIR_ID);
  expect(meta.chairSeatCount).toBe(1);
  expect(meta.firstRole).toBe("moderator");
  expect(meta.firstName).toContain("主持");
  expect(meta.sub).toContain("主持");
});

test("room-chat with roomId loads real messages + active room status", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent && document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  expect(await page.locator("#rc-msgs .msg").count()).toBeGreaterThan(0);
  // Force idle-live state so the action bar surfaces.
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; renderRoomActions: () => void };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.appState.continuePending = false;
    w.renderRoomActions();
  });
  await expect(page.locator("#rc-actions")).toBeVisible();
  await expect(page.locator("#rc-act-primary")).toContainText(/继续讨论|生成报告/);
});

test("agent-profile loads real agent data", async ({ page }) => {
  test.skip(!FIRST_AGENT, "no agents");
  await page.goto(`${BASE}/m/?screen=agent-profile&agentId=${FIRST_AGENT}`);
  await page.waitForFunction(() => document.getElementById("ap-title")?.textContent && document.getElementById("ap-title")?.textContent !== "董事", null, { timeout: 6_000 });
  await expect(page.locator("#ap-title")).not.toHaveText("董事");
  await expect(page.locator("#ap-name")).not.toHaveText("—");
  await expect(page.locator("[data-screen=\"agent-profile\"] .group")).toHaveCount(4);
});

test("new-agent screen has working composer + start button", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=new-agent`);
  await expect(page.locator("[data-screen=\"new-agent\"] textarea")).toBeVisible();
  await expect(page.locator("#new-agent-submit")).toBeVisible();
});

test("me tab renders prefs + version", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=me`);
  await expect(page.locator("[data-screen=\"me\"] .me .em")).toContainText("@");
  await expect(page.locator("[data-screen=\"me\"] .group")).toHaveCount(5);
});

test("new-room sheet opens via deep link with real cast picker", async ({ page }) => {
  await page.goto(`${BASE}/m/?sheet=new-room`);
  await page.waitForFunction(() => document.querySelectorAll("#sh-cast-grid .pick").length > 0, null, { timeout: 6_000 });
  const sheet = page.locator(".sheet[data-sheet=\"new-room\"]");
  await expect(sheet).toHaveClass(/(^|\s)on(\s|$)/);
  await expect(sheet.locator("#sh-subject")).toBeVisible();
  expect(await sheet.locator("#sh-cast-grid .pick").count()).toBeGreaterThan(2);
});

test("new-room voice option follows PC TTS-key gate", async ({ page }) => {
  await installFetchInterceptor(page, { hasVoiceKey: false });
  await page.goto(`${BASE}/m/?sheet=new-room`);
  await page.waitForFunction(() => document.querySelectorAll("#sh-cast-grid .pick").length > 0, null, { timeout: 6_000 });
  await page.locator('#sh-delivery .opt[data-delivery="voice"]').click();
  await expect(page.locator("#app-modal-title")).toHaveText("需要配置语音凭据");
  const state = await page.evaluate(() => {
    const w = window as unknown as { appState: { selectedDelivery: string } };
    return {
      selectedDelivery: w.appState.selectedDelivery,
      voiceOn: document.querySelector('#sh-delivery .opt[data-delivery="voice"]')?.classList.contains("on") || false,
      textOn: document.querySelector('#sh-delivery .opt[data-delivery="text"]')?.classList.contains("on") || false,
    };
  });
  expect(state).toEqual({ selectedDelivery: "text", voiceOn: false, textOn: true });
});

test("tab nav cycles all 4 tabs", async ({ page }) => {
  await page.goto(`${BASE}/m/`);
  await waitListReady(page, "rooms-list");
  for (const t of ["agents", "briefs", "me", "rooms"]) {
    await page.evaluate((tab) => (window as unknown as { setTab: (n: string) => void }).setTab(tab), t);
    await expect(page.locator(".screen.on")).toHaveAttribute("data-screen", t);
  }
});

// ── functional click matrix (intercepts state-changing calls) ─────────────

test("cast picker toggles + submit posts to /api/rooms", async ({ page }) => {
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?sheet=new-room`);
  await page.waitForFunction(() => document.querySelectorAll("#sh-cast-grid .pick:not([style*=\"dashed\"])").length > 0, null, { timeout: 6_000 });
  await page.locator("#sh-subject").fill("e2e · automated room create");
  await page.locator("#sh-cast-grid .pick:not([style*=\"dashed\"])").first().click();
  await expect(page.locator("#sh-cast-grid .pick.on")).toHaveCount(1);
  await page.locator("#sh-submit").click();
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/rooms"));
  expect(post).toBeTruthy();
  expect(post?.body).toContain("e2e · automated room create");
});

test("new-agent submit posts to generate-persona with extracted voice URL", async ({ page }) => {
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=new-agent`);
  await page.locator("#new-agent-desc").fill("价值投资型角色 https://youtube.com/watch?v=test");
  await expect(page.locator("#new-agent-url-hint")).toBeVisible();
  await page.locator("#new-agent-submit").click();
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/agents/generate-persona"));
  expect(post).toBeTruthy();
  expect(post?.body).toContain("voiceSourceUrl");
  expect(post?.body).toContain("youtube.com");
});

test("room-chat send button posts message", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; roomMeetingController: { state: { queue: unknown[] } } };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.roomMeetingController.state.queue = [];
  });
  await page.locator("#rc-input").fill("e2e · auto send");
  await page.locator("[data-screen=\"room-chat\"] .composer .send").click();
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
  expect(post).toBeTruthy();
});

test("room-chat ⋯更多 sheet exposes PC-parity row actions", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; renderRoomActions: () => void };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.appState.pendingVoteMessageId = null;
    w.appState.activeRoomAwaitingContinue = false;
    w.appState.activeRoomModeShiftProposal = null;
    w.renderRoomActions();
  });
  await page.locator("#rc-act-more").click();
  const sheet = page.locator(".sheet[data-sheet=\"room-more\"]");
  await expect(sheet).toHaveClass(/(^|\s)on(\s|$)/);
  await expect(sheet.locator(".row:visible")).toHaveCount(8);
  await expect(sheet).toContainText("加入 / 移除董事");
  await expect(sheet).toContainText("Divergence report");
  // No mid-session voice/silent toggle · PC removed it (delivery is fixed at
  // room creation), so mobile must not expose one either.
  await expect(sheet).not.toContainText("语音 / 静默");
  await expect(sheet.locator('[data-room-more-row="brief"]')).toBeHidden();
  await expect(sheet.locator('[data-room-more-row="export"]')).toBeHidden();
});

test("agent-profile · WebSearch toggle PATCHes the agent", async ({ page }) => {
  test.skip(!FIRST_AGENT, "no agents");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=agent-profile&agentId=${FIRST_AGENT}`);
  await page.waitForFunction(() => document.getElementById("ap-title")?.textContent !== "董事", null, { timeout: 6_000 });
  await page.locator("[data-screen=\"agent-profile\"] .row[onclick*=\"toggleWebSearch\"]").click();
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/api/agents/"));
  expect(patch).toBeTruthy();
  expect(patch?.body).toContain("webSearchEnabled");
});

test("agent-profile · 长期记忆 row opens manager + fetches memories", async ({ page }) => {
  test.skip(!FIRST_AGENT, "no agents");
  await page.goto(`${BASE}/m/?screen=agent-profile&agentId=${FIRST_AGENT}`);
  await page.waitForFunction(() => document.getElementById("ap-title")?.textContent !== "董事", null, { timeout: 6_000 });
  const respPromise = page.waitForResponse((r) => r.url().includes("/memories"), { timeout: 6_000 });
  await page.locator("[data-screen=\"agent-profile\"] .row[onclick*=\"openAgentMemories\"]").click();
  await respPromise;
  await expect(page.locator(".sheet[data-sheet=\"mgr\"]")).toHaveClass(/(^|\s)on(\s|$)/);
  await expect(page.locator("#mgr-title")).toHaveText("长期记忆");
});

test("agent-profile · 技能 row opens manager + fetches skills", async ({ page }) => {
  test.skip(!FIRST_AGENT, "no agents");
  await page.goto(`${BASE}/m/?screen=agent-profile&agentId=${FIRST_AGENT}`);
  await page.waitForFunction(() => document.getElementById("ap-title")?.textContent !== "董事", null, { timeout: 6_000 });
  const respPromise = page.waitForResponse((r) => r.url().includes("/skills"), { timeout: 6_000 });
  await page.locator("[data-screen=\"agent-profile\"] .row[onclick*=\"openAgentSkills\"]").click();
  await respPromise;
  await expect(page.locator("#mgr-title")).toHaveText("技能");
});

test("me · 凭据管理 三类入口都打开 manager", async ({ page }) => {
  for (const kind of ["llm", "voice", "search"] as const) {
    await page.goto(`${BASE}/m/?screen=me`);
    await page.waitForTimeout(300);
    const expected = kind === "llm" ? "/api/credentials" : `/api/${kind}-credentials`;
    const respPromise = page.waitForResponse((r) => r.url().includes(expected), { timeout: 6_000 });
    await page.locator(`[data-screen="me"] .row[onclick*="openCredentialMgr('${kind}')"]`).click();
    await respPromise;
    await expect(page.locator(".sheet[data-sheet=\"mgr\"]")).toHaveClass(/(^|\s)on(\s|$)/);
  }
});

test("me · 主席记忆入口打开 manager + fetches chair memories", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=me`);
  await page.waitForTimeout(300);
  const respPromise = page.waitForResponse((r) => r.url().includes("/user-long-memory"), { timeout: 6_000 });
  await page.locator("[data-screen=\"me\"] .row[onclick*=\"openChairLongMemory\"]").click();
  await respPromise;
  await expect(page.locator("#mgr-title")).toHaveText("主席关于我的记忆");
});

test("boardroom seat click navigates to agent-profile", async ({ page }) => {
  test.skip(!ADJOURNED_ROOM, "no rooms");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${ADJOURNED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  await page.locator('#bd-stage .bd-seat[data-role-kind="director"]').first().click();
  await expect(page.locator(".screen.on")).toHaveAttribute("data-screen", "agent-profile");
});

test("boardroom uses global gesture unlock without a mobile-only voice banner", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=boardroom`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  await expect(page.locator("#bd-audio-unlock")).toHaveCount(0);
  await page.locator(".bd-table").click();
  await page.waitForFunction(() => (window as unknown as { appState: { voiceUnlocked: boolean } }).appState.voiceUnlocked === true);
});

test("meeting runtime is shared by mobile room actions", async ({ page }) => {
  await page.goto(`${BASE}/m/`);
  const runtime = await page.evaluate(() => {
    const w = window as unknown as { RoomMeetingRuntime?: Record<string, unknown>; roomMeetingController?: unknown; roomVoiceController?: unknown };
    return {
      hasApi: typeof w.RoomMeetingRuntime?.createApiClient === "function",
      hasMeeting: !!w.roomMeetingController,
      hasVoice: !!w.roomVoiceController,
      hasActionState: typeof w.RoomMeetingRuntime?.deriveRoomActionState === "function",
      hasCaptionState: typeof w.RoomMeetingRuntime?.pickVisibleCaptionText === "function",
    };
  });
  expect(runtime).toEqual({ hasApi: true, hasMeeting: true, hasVoice: true, hasActionState: true, hasCaptionState: true });
});

test("mobile does not expose its own voice queue store", async ({ page }) => {
  await page.goto(`${BASE}/m/`);
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      roomVoiceController: { queue: unknown[]; queues: Record<string, unknown> };
    };
    return {
      hasMobileQueueAlias: Object.prototype.hasOwnProperty.call(w.appState, "voiceQueue"),
      sharedQueueIsArray: Array.isArray(w.roomVoiceController.queue),
      sharedQueuesObject: !!w.roomVoiceController.queues && typeof w.roomVoiceController.queues === "object",
    };
  });
  expect(result).toEqual({ hasMobileQueueAlias: false, sharedQueueIsArray: true, sharedQueuesObject: true });
});

test("voice room card enters boardroom by default like PC", async ({ page }) => {
  test.skip(!VOICE_LIVE_OR_PAUSED_ROOM, "no live/paused voice room");
  await page.goto(`${BASE}/m/`);
  await waitListReady(page, "rooms-list");
  await page.evaluate((roomId) => localStorage.removeItem(`rt-view-${roomId}`), VOICE_LIVE_OR_PAUSED_ROOM);
  await page.locator(`.room-card[data-room-id="${VOICE_LIVE_OR_PAUSED_ROOM}"]`).click();
  await expect(page.locator(".screen.on")).toHaveAttribute("data-screen", "boardroom", { timeout: 6_000 });
  await expect(page.locator("#bd-audio-unlock")).toHaveCount(0);
  await expect(page.locator("#bd-audio")).toHaveCount(1);
});

test("voice queue · voice-final drives playback and reports PC voice protocol", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: { voicePlaying: unknown; voicePlayedIds: Set<string>; activeRoomDelivery: string; voiceUnlocked: boolean };
      roomMeetingController: { disconnect: () => void };
      roomVoiceController: { stop: () => void; queue: unknown[] };
      syncRoomVoiceController: () => void;
      handleMessageFinal: (p: { messageId: string; authorId: string }) => void;
      handleVoiceChunk: (p: Record<string, unknown>) => void;
      handleVoiceFinal: (p: Record<string, unknown>) => void;
      __testVoiceSrc?: string;
    };
    const audio = document.getElementById("bd-audio") as HTMLAudioElement;
    audio.play = () => Promise.resolve();
    w.roomMeetingController.disconnect();
    w.roomVoiceController.stop();
    w.roomVoiceController.queue = [];
    w.appState.voicePlaying = null;
    w.appState.voicePlayedIds.clear();
    w.appState.activeRoomDelivery = "voice";
    w.appState.voiceUnlocked = true;
    w.syncRoomVoiceController();
    w.handleMessageFinal({ messageId: "synthetic-test-msg", authorId: "synthetic-agent" });
    w.handleVoiceChunk({
      roomId: "synthetic-room",
      messageId: "synthetic-test-msg",
      authorId: "synthetic-agent",
      mimeType: "audio/wav",
      audioBase64: "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
    });
    w.handleVoiceFinal({ roomId: "synthetic-room", messageId: "synthetic-test-msg", authorId: "synthetic-agent" });
    audio.onplaying?.(new Event("playing"));
    w.__testVoiceSrc = audio.src;
    audio.onended?.(new Event("ended"));
  });
  await page.waitForTimeout(800);
  const src = await page.evaluate(() => (window as unknown as { __testVoiceSrc?: string }).__testVoiceSrc || "");
  expect(src).toContain("data:audio/wav;base64");
  const calls = await captured(page);
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/voice-progress"))).toBeTruthy();
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/voice-done"))).toBeTruthy();
});

test("voice-final without an existing queue does not resurrect hard-paused audio", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      appState: { voicePlaying: unknown; voicePlayedIds: Set<string>; activeRoomDelivery: string; voiceUnlocked: boolean };
      roomVoiceController: { stop: () => void; has: (messageId: string) => boolean; queue: unknown[] };
      syncRoomVoiceController: () => void;
      roomMeetingController: { handleEvent: (type: string, p: Record<string, unknown>) => void };
      handleVoiceFinal: (p: Record<string, unknown>) => void;
    };
    const audio = document.getElementById("bd-audio") as HTMLAudioElement;
    let playCalls = 0;
    audio.play = () => { playCalls += 1; return Promise.resolve(); };
    w.roomVoiceController.stop();
    w.roomVoiceController.queue = [];
    w.appState.voicePlaying = null;
    w.appState.voicePlayedIds.clear();
    w.appState.activeRoomDelivery = "voice";
    w.appState.voiceUnlocked = true;
    w.syncRoomVoiceController();
    w.roomMeetingController.handleEvent("config-event", { kind: "room-paused", payload: { mode: "hard" } });
    w.handleVoiceFinal({ roomId: "synthetic-room", messageId: "late-final-after-hard-pause", authorId: "synthetic-agent" });
    return {
      playCalls,
      hasQueue: w.roomVoiceController.has("late-final-after-hard-pause"),
      queueLen: w.roomVoiceController.queue.length,
      playing: w.appState.voicePlaying ?? null,
      played: w.appState.voicePlayedIds.has("late-final-after-hard-pause"),
    };
  });
  expect(result).toEqual({ playCalls: 0, hasQueue: false, queueLen: 0, playing: null, played: false });
});

test("paused room shows '恢复并继续' label + click resumes then continues + label flips to live", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  // Inject a stateful mock that returns paused first, then live after resume.
  await page.addInitScript(() => {
    const w = window as unknown as { __captured: { url: string; method: string; body?: string }[] };
    w.__captured = [];
    let serverStatus: "paused" | "live" = "paused";
    const orig = window.fetch.bind(window);
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || "GET").toUpperCase();
      // intercept POST/PUT/DELETE/PATCH
      if (method !== "GET" && method !== "HEAD") {
        w.__captured.push({ url, method, body: typeof init?.body === "string" ? init?.body : undefined });
        if (method === "POST" && url.endsWith("/resume")) serverStatus = "live";
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      // intercept GET /api/rooms/:id to return our synthetic status
      if (/\/api\/rooms\/[^/]+$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({
          room: { id: "synthetic", status: serverStatus },
          members: [], messages: [], round: { spoken: 0, total: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return orig(input as RequestInfo, init);
    };
  });
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => {
    const w = window as unknown as { appState: { activeRoomStatus: string } };
    return w.appState?.activeRoomStatus === "paused";
  }, null, { timeout: 6_000 });
  await expect(page.locator("#rc-act-primary")).toHaveText(/恢复并继续/);
  await page.locator("#rc-act-primary").click();
  await page.waitForTimeout(1000);
  const calls = await captured(page);
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/resume"))).toBeTruthy();
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/continue"))).toBeTruthy();
  // Simulate the SSE that would normally clear the "推进中..." pending
  // state and put the room back into idle (round complete, queue empty).
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; renderRoomActions: () => void };
    w.appState.continuePending = false;
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.renderRoomActions();
  });
  await expect(page.locator("#rc-act-primary")).toHaveText(/继续讨论$/);
  await expect(page.locator("#rc-act-primary")).not.toHaveText(/恢复/);
});

test("paused boardroom does not render a mobile-only voice status control", async ({ page }) => {
  await page.addInitScript(() => {
    const orig = window.fetch.bind(window);
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method || "GET").toUpperCase() === "GET" && /\/api\/rooms\/[^/]+$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({
          room: { id: "synthetic", status: "paused", deliveryMode: "voice" },
          members: [],
          messages: [],
          round: { spoken: 0, total: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return orig(input as RequestInfo, init);
    };
  });
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=synthetic`);
  await page.waitForFunction(() => document.getElementById("bd-title")?.textContent === "房间", null, { timeout: 6_000 });
  await expect(page.locator("#bd-audio-unlock")).toHaveCount(0);
});

test("agent-profile · 试听 toggle calls pause() when audio is playing", async ({ page }) => {
  test.skip(!FIRST_AGENT, "no agents");
  await page.goto(`${BASE}/m/?screen=agent-profile&agentId=${FIRST_AGENT}`);
  await page.waitForFunction(() => document.getElementById("ap-title")?.textContent !== "董事", null, { timeout: 6_000 });
  // Simulate the "audio is currently playing" branch — override the
  // <audio> element to look like a live playback session, then invoke
  // playVoicePreview (the same function the button's onclick fires).
  // Verify the toggle path called .pause() exactly once.
  const result = await page.evaluate(async () => {
    const audio = document.getElementById("ap-preview-audio") as HTMLAudioElement;
    let pauseCalls = 0;
    audio.pause = () => { pauseCalls++; Object.defineProperty(audio, "paused", { value: true, configurable: true }); };
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    Object.defineProperty(audio, "ended", { value: false, configurable: true });
    Object.defineProperty(audio, "currentTime", { value: 1.5, configurable: true });
    Object.defineProperty(audio, "duration", { value: 8, configurable: true });
    audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
    await (window as unknown as { playVoicePreview: () => Promise<void> }).playVoicePreview();
    return { pauseCalls, iconText: document.getElementById("ap-preview-icon")?.textContent };
  });
  expect(result.pauseCalls).toBe(1);
  expect(result.iconText).toBe("▶");
});

test("switching agent clears the previous preview clip src", async ({ page }) => {
  const ctx = await request.newContext({ baseURL: BASE });
  const agents = (await (await ctx.get("/api/agents")).json()).agents ?? [];
  const dirs = agents.filter((a: { roleKind: string }) => a.roleKind === "director");
  await ctx.dispose();
  test.skip(dirs.length < 2, "need 2+ agents to switch");
  const [a1, a2] = dirs;
  await page.goto(`${BASE}/m/?screen=agent-profile&agentId=${a1.id}`);
  await page.waitForFunction(() => document.getElementById("ap-title")?.textContent !== "董事", null, { timeout: 6_000 });
  // Force a leftover src on the audio (simulates "previously played a clip").
  await page.evaluate(() => {
    const a = document.getElementById("ap-preview-audio") as HTMLAudioElement;
    a.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
  });
  // Switch to agent 2 via openAgent
  await page.evaluate((id) => (window as unknown as { openAgent: (id: string) => Promise<void> }).openAgent(id), a2.id);
  await page.waitForFunction((expected) => document.getElementById("ap-title")?.textContent === expected, a2.name, { timeout: 4_000 });
  // audio.src should be cleared so a fresh 试听 click synths the new agent's clip
  const src = await page.evaluate(() => (document.getElementById("ap-preview-audio") as HTMLAudioElement).src);
  // Either empty string or a path that's not the leftover data URL
  expect(src.startsWith("data:audio/wav;base64,UklGRiQAAA")).toBe(false);
});

test("leaving agent-profile auto-pauses the preview clip", async ({ page }) => {
  test.skip(!FIRST_AGENT, "no agents");
  await page.goto(`${BASE}/m/?screen=agent-profile&agentId=${FIRST_AGENT}`);
  await page.waitForFunction(() => document.getElementById("ap-title")?.textContent !== "董事", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const audio = document.getElementById("ap-preview-audio") as HTMLAudioElement;
    audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
    return audio.play().catch(() => {});
  });
  await page.evaluate(() => (window as unknown as { goto: (n: string) => void }).goto("agents"));
  const paused = await page.evaluate(() => (document.getElementById("ap-preview-audio") as HTMLAudioElement)?.paused);
  expect(paused).toBe(true);
});

test("SSE message-token incrementally appends to existing message DOM", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  // Inject a synthetic message via SSE handlers then stream tokens to it.
  await page.evaluate(() => {
    const w = window as unknown as {
      sseAppendMessage: (p: Record<string, unknown>) => void;
      sseAppendToken: (p: Record<string, unknown>) => void;
    };
    w.sseAppendMessage({ messageId: "tok-test-1", authorKind: "agent", authorId: "synthetic-agent", body: "", roundNum: 1 });
    w.sseAppendToken({ messageId: "tok-test-1", delta: "Hello, " });
    w.sseAppendToken({ messageId: "tok-test-1", delta: "this is " });
    w.sseAppendToken({ messageId: "tok-test-1", delta: "streaming." });
  });
  const text = await page.locator('#rc-msgs .msg[data-msg-id="tok-test-1"] .text').textContent();
  expect(text).toContain("Hello, this is streaming.");
});

test("SSE message-removed drops the matching DOM node", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { sseAppendMessage: (p: Record<string, unknown>) => void; sseRemoveMessage: (p: Record<string, unknown>) => void };
    w.sseAppendMessage({ messageId: "rm-test-1", authorKind: "agent", authorId: "synthetic", body: "to be removed" });
  });
  await expect(page.locator('#rc-msgs .msg[data-msg-id="rm-test-1"]')).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { sseRemoveMessage: (p: Record<string, unknown>) => void }).sseRemoveMessage({ messageId: "rm-test-1" }));
  await expect(page.locator('#rc-msgs .msg[data-msg-id="rm-test-1"]')).toHaveCount(0);
});

test("SSE message-removed clears any matching voice queue", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      appState: { voicePlaying: unknown; activeRoomDelivery: string; voiceUnlocked: boolean };
      syncRoomVoiceController: () => void;
      handleVoiceChunk: (p: Record<string, unknown>) => void;
      handleVoiceFinal: (p: Record<string, unknown>) => void;
      sseRemoveMessage: (p: Record<string, unknown>) => void;
      roomVoiceController: { stop: () => void; has: (messageId: string) => boolean; queue: unknown[] };
    };
    const audio = document.getElementById("bd-audio") as HTMLAudioElement;
    audio.play = () => Promise.resolve();
    w.roomVoiceController.stop();
    w.appState.activeRoomDelivery = "voice";
    w.appState.voiceUnlocked = true;
    w.syncRoomVoiceController();
    w.handleVoiceChunk({ roomId: "synthetic-room", messageId: "rm-voice-1", authorId: "synthetic", mimeType: "audio/wav", audioBase64: "AAAA", seq: 1 });
    w.handleVoiceFinal({ roomId: "synthetic-room", messageId: "rm-voice-1", authorId: "synthetic" });
    const before = { hasQueue: w.roomVoiceController.has("rm-voice-1"), queueLen: w.roomVoiceController.queue.length };
    w.sseRemoveMessage({ messageId: "rm-voice-1" });
    return {
      before,
      hasQueue: w.roomVoiceController.has("rm-voice-1"),
      queueLen: w.roomVoiceController.queue.length,
      playing: w.appState.voicePlaying ?? null,
    };
  });
  expect(result.before.hasQueue).toBe(true);
  expect(result.hasQueue).toBe(false);
  expect(result.queueLen).toBe(0);
  expect(result.playing).toBeNull();
});

test("SSE message-error tags the message with a visible error annotation", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { sseAppendMessage: (p: Record<string, unknown>) => void; sseErrorMessage: (p: Record<string, unknown>) => void };
    w.sseAppendMessage({ messageId: "err-test-1", authorKind: "agent", authorId: "synthetic", body: "partial" });
    w.sseErrorMessage({ messageId: "err-test-1", message: "rate limit hit" });
  });
  await expect(page.locator('#rc-msgs .msg[data-msg-id="err-test-1"]')).toHaveClass(/msg-error/);
  await expect(page.locator('#rc-msgs .msg[data-msg-id="err-test-1"] .text')).toContainText("rate limit hit");
});

test("SSE message-error clears matching voice queue before auto-continue recheck", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      appState: { voicePlaying: unknown; activeRoomDelivery: string; voiceUnlocked: boolean };
      syncRoomVoiceController: () => void;
      handleVoiceChunk: (p: Record<string, unknown>) => void;
      handleVoiceFinal: (p: Record<string, unknown>) => void;
      sseAppendMessage: (p: Record<string, unknown>) => void;
      sseErrorMessage: (p: Record<string, unknown>) => void;
      roomVoiceController: { stop: () => void; has: (messageId: string) => boolean; queue: unknown[] };
    };
    const audio = document.getElementById("bd-audio") as HTMLAudioElement;
    audio.play = () => Promise.resolve();
    w.roomVoiceController.stop();
    w.appState.activeRoomDelivery = "voice";
    w.appState.voiceUnlocked = true;
    w.syncRoomVoiceController();
    w.sseAppendMessage({ messageId: "err-voice-1", authorKind: "agent", authorId: "synthetic", body: "partial" });
    w.handleVoiceChunk({ roomId: "synthetic-room", messageId: "err-voice-1", authorId: "synthetic", mimeType: "audio/wav", audioBase64: "AAAA", seq: 1 });
    w.handleVoiceFinal({ roomId: "synthetic-room", messageId: "err-voice-1", authorId: "synthetic" });
    const before = { hasQueue: w.roomVoiceController.has("err-voice-1"), queueLen: w.roomVoiceController.queue.length };
    w.sseErrorMessage({ messageId: "err-voice-1", message: "provider failed" });
    return {
      before,
      hasQueue: w.roomVoiceController.has("err-voice-1"),
      queueLen: w.roomVoiceController.queue.length,
      playing: w.appState.voicePlaying ?? null,
      className: document.querySelector('#rc-msgs .msg[data-msg-id="err-voice-1"]')?.className || "",
    };
  });
  expect(result.before.hasQueue).toBe(true);
  expect(result.hasQueue).toBe(false);
  expect(result.queueLen).toBe(0);
  expect(result.playing).toBeNull();
  expect(result.className).toContain("msg-error");
});

test("boardroom highlight follows streaming author, not just voice playback", async ({ page }) => {
  test.skip(!ADJOURNED_ROOM, "need a room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${ADJOURNED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const firstSeat = page.locator("#bd-stage .bd-seat").nth(1);
  const agentId = await firstSeat.getAttribute("data-agent-id");
  expect(agentId).toBeTruthy();
  await page.evaluate(({ aid }) => {
    const w = window as unknown as { sseAppendMessage: (p: Record<string, unknown>) => void };
    // simulate the chair-side message-appended event for this director
    w.sseAppendMessage({ messageId: "bd-stream-test", authorKind: "agent", authorId: aid, body: "" });
  }, { aid: agentId });
  const speakingAuthor = await page.evaluate(() => {
    const seat = document.querySelector("#bd-stage .bd-pix.speaking")?.closest(".bd-seat");
    return seat?.getAttribute("data-agent-id");
  });
  expect(speakingAuthor).toBe(agentId);
});

test("boardroom busy state hides waiting action without a voice-mode control", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; renderRoomActions: () => void };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomQueueLen = 1;
    w.appState.activeRoomRound = { spoken: 0, total: 1 };
    w.appState.pendingVoteMessageId = null;
    w.appState.activeRoomAwaitingContinue = false;
    w.appState.continuePending = false;
    w.renderRoomActions();
  });
  await expect(page.locator("#bd-audio-unlock")).toHaveCount(0);
  await expect(page.locator("#bd-actions")).toBeHidden();
});

test("boardroom bottom chrome stacks above composer without overlap", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  await page.waitForTimeout(120);
  const idle = await page.evaluate(() => {
    const actions = document.getElementById("bd-actions") as HTMLElement;
    return {
      hasVoiceBanner: !!document.getElementById("bd-audio-unlock"),
      actionsHidden: getComputedStyle(actions).display === "none",
    };
  });
  expect(idle).toEqual({ hasVoiceBanner: false, actionsHidden: true });

  const stacked = await page.evaluate(async () => {
    const w = window as unknown as { appState: Record<string, unknown>; renderRoomActions: () => void };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomAwaitingClarify = false;
    w.appState.activeRoomAwaitingContinue = true;
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.renderRoomActions();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const actions = document.getElementById("bd-actions") as HTMLElement;
    const composer = document.querySelector('[data-screen="boardroom"] .composer') as HTMLElement;
    const br = actions.getBoundingClientRect();
    const cr = composer.getBoundingClientRect();
    return {
      actionsBottom: br.bottom,
      composerTop: cr.top,
      gap: cr.top - br.bottom,
    };
  });
  expect(stacked.actionsBottom).toBeLessThanOrEqual(stacked.composerTop);
  expect(stacked.gap).toBeGreaterThanOrEqual(4);
});

test("boardroom subtitle matches the PC short caption frame", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=boardroom`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const result = await page.evaluate(() => {
    const box = document.getElementById("bd-subtitle") as HTMLElement;
    const text = document.getElementById("bd-sub-text") as HTMLElement;
    text.textContent = Array(20).fill("这是一段用于验证圆桌字幕可以完整阅读的长文本").join("，");
    return {
      boxOverflow: getComputedStyle(box).overflowY,
      overflowY: getComputedStyle(box).overflowY,
      textOverflow: getComputedStyle(text).overflowY,
      visibleHeight: text.clientHeight,
      scrollHeight: text.scrollHeight,
    };
  });
  expect(result.boxOverflow).toBe("hidden");
  expect(result.textOverflow).toBe("hidden");
  expect(result.visibleHeight).toBeLessThan(result.scrollHeight);
  expect(result.overflowY).toBe("hidden");
});

test("boardroom speaker card paints the current caption sentence immediately", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=boardroom`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      appState: { activeMembersById?: Record<string, { id: string; name: string; roleTag: string }> };
      highlightSpeaker: (authorId: string, messageId: string) => void;
    };
    const authorId = "caption-speaker";
    w.appState.activeMembersById = w.appState.activeMembersById || {};
    w.appState.activeMembersById[authorId] = { id: authorId, name: "Caption Speaker", roleTag: "director" };
    document.getElementById("rc-msgs")?.insertAdjacentHTML("beforeend",
      `<div class="msg" data-msg-id="caption-long" data-author-id="${authorId}"><div class="text">第一句已经说完。第二句才是当前字幕。</div></div>`);
    w.highlightSpeaker(authorId, "caption-long");
    return {
      speakerCard: document.getElementById("bd-sub-text")?.textContent || "",
      table: document.getElementById("bd-table-quote")?.textContent || "",
    };
  });
  expect(result.speakerCard).toBe("第二句才是当前字幕。");
  expect(result.table).toContain("第二句才是当前字幕");
});

test("boardroom chair round summary is readable and scrollable", async ({ page }) => {
  test.skip(!ADJOURNED_ROOM || !CHAIR_ID, "need a room and chair");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${ADJOURNED_ROOM}`);
  await page.waitForFunction(() => (window as unknown as { appState?: { activeChair?: { id?: string } } }).appState?.activeChair?.id, null, { timeout: 6_000 });
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      appState: { activeChair: { id: string } };
      sseAppendMessage: (payload: Record<string, unknown>) => void;
    };
    const longText = Array(26).fill("主持会在每一轮结束时总结关键观点和下一轮议程").join("，");
    w.sseAppendMessage({
      messageId: "chair-summary-scroll-test",
      authorKind: "chair",
      authorId: w.appState.activeChair.id,
      body: longText,
      meta: { kind: "round-end" },
    });
    const textEl = document.getElementById("bd-roundwrap-text") as HTMLElement;
    const banner = document.getElementById("bd-roundwrap") as HTMLElement;
    const speakingSeat = document.querySelector("#bd-stage .bd-pix.speaking")?.closest(".bd-seat") as HTMLElement | null;
    return {
      visible: getComputedStyle(banner).display !== "none",
      text: textEl.textContent || "",
      clamp: getComputedStyle(textEl).webkitLineClamp,
      overflowY: getComputedStyle(textEl).overflowY,
      scrollable: textEl.scrollHeight > textEl.clientHeight,
      speakingRole: speakingSeat?.dataset.roleKind || "",
    };
  });
  expect(result.visible).toBe(true);
  expect(result.text).toContain("每一轮结束时总结");
  expect(result.clamp === "none" || result.clamp === "").toBe(true);
  expect(result.overflowY).toBe("auto");
  expect(result.scrollable).toBe(true);
  expect(result.speakingRole).toBe("moderator");
});

test("boardroom voice pauses when leaving stage or hiding page", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=boardroom`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const result = await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; goto: (screen: string) => void };
    const audio = document.getElementById("bd-audio") as HTMLAudioElement;
    let pauseCalls = 0;
    audio.pause = () => {
      pauseCalls += 1;
      Object.defineProperty(audio, "paused", { value: true, configurable: true });
    };
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    w.appState.voicePlaying = { messageId: "playing-before-leave", authorId: "a1" };
    w.goto("rooms");
    const afterGoto = { pauseCalls, voicePlaying: w.appState.voicePlaying ?? null };
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    w.appState.voicePlaying = { messageId: "playing-before-hide", authorId: "a1" };
    document.dispatchEvent(new Event("visibilitychange"));
    return { afterGoto, afterHide: { pauseCalls, voicePlaying: w.appState.voicePlaying ?? null } };
  });
  expect(result.afterGoto.pauseCalls).toBeGreaterThanOrEqual(1);
  expect(result.afterGoto.voicePlaying).toBeNull();
  expect(result.afterHide.pauseCalls).toBeGreaterThan(result.afterGoto.pauseCalls);
  expect(result.afterHide.voicePlaying).toBeNull();
});

test("boardroom voice resumes when re-entering the same room", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=boardroom`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const result = await page.evaluate(async () => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      goto: (screen: string) => void;
      roomVoiceController: { playing: unknown };
    };
    const audio = document.getElementById("bd-audio") as HTMLAudioElement;
    let pauseCalls = 0;
    let playCalls = 0;
    audio.pause = () => {
      pauseCalls += 1;
      Object.defineProperty(audio, "paused", { value: true, configurable: true });
    };
    audio.play = () => {
      playCalls += 1;
      Object.defineProperty(audio, "paused", { value: false, configurable: true });
      return Promise.resolve();
    };
    audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
    audio.dataset.messageId = "resume-msg";
    audio.dataset.authorId = "resume-author";
    Object.defineProperty(audio, "ended", { value: false, configurable: true });
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    w.appState.activeRoomId = "synthetic-room";
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomDelivery = "voice";
    w.appState.voiceUnlocked = true;
    w.appState.voicePlaying = { messageId: "resume-msg", authorId: "resume-author" };
    w.roomVoiceController.playing = { roomId: "synthetic-room", messageId: "resume-msg", authorId: "resume-author" };

    w.goto("rooms");
    const afterLeave = { pauseCalls, src: audio.src, messageId: audio.dataset.messageId || "", voicePlaying: w.appState.voicePlaying ?? null };
    w.goto("boardroom");
    await Promise.resolve();
    return {
      afterLeave,
      playCalls,
      voicePlaying: w.appState.voicePlaying ?? null,
      messageId: audio.dataset.messageId || "",
    };
  });
  expect(result.afterLeave.pauseCalls).toBeGreaterThanOrEqual(1);
  expect(result.afterLeave.src).toContain("data:audio/wav;base64");
  expect(result.afterLeave.messageId).toBe("resume-msg");
  expect(result.afterLeave.voicePlaying).toBeNull();
  expect(result.playCalls).toBeGreaterThanOrEqual(1);
  expect(result.voicePlaying).toEqual({ messageId: "resume-msg", authorId: "resume-author" });
  expect(result.messageId).toBe("resume-msg");
});

test("awaitingClarify hides action bar + changes composer placeholder", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { appState: { activeRoomAwaitingClarify: boolean }; renderRoomActions: () => void };
    w.appState.activeRoomAwaitingClarify = true;
    w.renderRoomActions();
  });
  await expect(page.locator("#rc-actions")).toBeHidden();
  await expect(page.locator("#rc-input")).toHaveAttribute("placeholder", /主席等你回答/);
  // flip back to idle live (round complete, queue empty → bar visible)
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; renderRoomActions: () => void };
    w.appState.activeRoomAwaitingClarify = false;
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.renderRoomActions();
  });
  await expect(page.locator("#rc-actions")).toBeVisible();
  await expect(page.locator("#rc-input")).toHaveAttribute("placeholder", /你的回应/);
});

test("auto-continue countdown · button shows countdown + countdownTick fires", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await installActiveRoundPrompt(page);
  const result = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ticks: number[] = [];
    (w as { boardroomTypingSfx: unknown }).boardroomTypingSfx = {
      countdownTick: (n: number) => ticks.push(n),
      tick: () => {},
      speakerChange: () => {},
      gavel: () => {},
      setThinking: () => {},
      setEnabled: () => {},
      isEnabled: () => true,
    };
    const a = (w.appState as Record<string, unknown>);
    a.activeRoomStatus = "live";
    a.activeRoomAwaitingClarify = false;
    a.activeRoomAwaitingContinue = false;
    a.activeRoomVoteTrigger = "auto";
    a.activeRoomQueueLen = 0;
    a.activeRoomRound = { spoken: 5, total: 5 };
    (w as unknown as { roomVoiceController: { queue: unknown[] } }).roomVoiceController.queue = [];
    a.voicePlaying = null;
    // Clear any pre-existing countdown so the shared controller can
    // re-engage from a clean state.
    (w.cancelAutoContinue as () => void)();
    (w.maybeStartAutoContinue as () => void)();
    const rcBtn = document.getElementById("rc-act-primary");
    // The countdown affordance must also surface in the boardroom
    // (voice) view · its rc-actions twin is hidden with the room-chat
    // section while the stage is up. renderRoomActions paints both.
    (w.renderRoomActions as () => void)();
    const bdBtn = document.getElementById("bd-act-primary");
    // canAutoContinue lives on the shared controller namespace now.
    const RAC = w.RoomAutoContinue as { canAutoContinue: (s: unknown) => boolean };
    const canAuto = RAC.canAutoContinue({
      id: a.activeRoomId || "x",
      status: "live",
      awaitingClarify: false,
      awaitingContinue: false,
      voteTrigger: "auto",
      queueLen: 0,
      round: { spoken: 5, total: 5 },
      activeRoundPromptId: "e2e-round-prompt",
      lastAgentMsg: { streaming: false, voicePlaying: false },
      chairPending: false,
    });
    return {
      ticks,
      rcBtn: rcBtn?.textContent || "",
      bdBtn: bdBtn?.textContent || "",
      canAuto,
      secondsLeft: (a.autoContinue as { secondsLeft: number }).secondsLeft,
    };
  });
  expect(result.canAuto).toBe(true);
  // Controller fires the first tick + beep synchronously on start.
  expect(result.secondsLeft).toBe(10);
  expect(result.ticks[0]).toBe(10);
  expect(result.rcBtn).toMatch(/继续讨论/);
  // Boardroom voice surface mirrors the same countdown button.
  expect(result.bdBtn).toMatch(/继续讨论/);
});

test("leaving room via bottom tab cancels auto-continue and blocks background continue", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await installActiveRoundPrompt(page);
  const before = await page.evaluate(() => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      roomVoiceController: { queue: unknown[] };
      roomMeetingController: { state: { queue: unknown[] } };
      maybeStartAutoContinue: () => void;
    };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomAwaitingClarify = false;
    w.appState.activeRoomAwaitingContinue = false;
    w.appState.activeRoomVoteTrigger = "auto";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 3, total: 3 };
    w.roomVoiceController.queue = [];
    w.roomMeetingController.state.queue = [];
    w.appState.voicePlaying = null;
    w.maybeStartAutoContinue();
    return (w.appState.autoContinue as { secondsLeft: number }).secondsLeft;
  });
  expect(before).toBe(10);

  await page.locator('.tabbar .tab[data-tab="agents"]').click();
  await expect(page.locator(".screen.on")).toHaveAttribute("data-screen", "agents");
  const after = await page.evaluate(async () => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      continueDiscussion: () => Promise<void>;
    };
    await w.continueDiscussion();
    return {
      secondsLeft: (w.appState.autoContinue as { secondsLeft: number }).secondsLeft,
      status: w.appState.activeRoomStatus ?? null,
      voicePlaying: w.appState.voicePlaying ?? null,
    };
  });
  expect(after.secondsLeft).toBe(0);
  expect(after.status).toBeNull();
  expect(after.voicePlaying).toBeNull();
  const calls = await captured(page);
  expect(calls.find((c) => c.method === "POST" && c.url.includes("/continue"))).toBeFalsy();
});

test("leaving while a director is speaking opens PC-style pause choice", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: { activeRoomStatus: string; activeMembersById: Record<string, { id: string; name: string }> };
      roomMeetingController: { state: { queue: { agentId: string; status: string }[] } };
    };
    w.appState.activeRoomStatus = "live";
    w.appState.activeMembersById.speaking_director = { id: "speaking_director", name: "发言董事" };
    w.roomMeetingController.state.queue = [{ agentId: "speaking_director", status: "speaking" }];
  });
  await page.locator('.tabbar .tab[data-tab="agents"]').click();
  await expect(page.locator("#app-modal-title")).toContainText("发言董事 正在发言");
  await expect(page.locator(".screen.on")).toHaveAttribute("data-screen", "room-chat");
  await page.locator("#app-modal-ok").click();
  await expect(page.locator(".screen.on")).toHaveAttribute("data-screen", "agents");
  const calls = await captured(page);
  const pause = calls.find((c) => c.method === "POST" && c.url.includes("/pause"));
  expect(pause?.body).toContain('"mode":"soft"');
});

test("soft pause pending keeps mobile live until room-paused SSE like PC", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: { activeRoomId: string; activeRoomStatus: string; activeMembersById: Record<string, { id: string; name: string }> };
      roomMeetingController: { state: { queue: { agentId: string; status: string }[] } };
      roomActionController: { api: { pause: (roomId: string, mode: string) => Promise<Record<string, unknown>> } };
      togglePauseRoom: () => Promise<void>;
      __togglePromise?: Promise<void>;
      __pauseMode?: string;
    };
    w.appState.activeRoomStatus = "live";
    w.appState.activeMembersById.speaking_director = { id: "speaking_director", name: "发言董事" };
    w.roomMeetingController.state.queue = [{ agentId: "speaking_director", status: "speaking" }];
    w.roomActionController.api.pause = async (_roomId, mode) => {
      w.__pauseMode = mode;
      return { pending: true, room: { id: w.appState.activeRoomId, status: "live" } };
    };
    w.__togglePromise = w.togglePauseRoom();
  });
  await expect(page.locator("#app-modal-title")).toContainText("发言董事 正在发言");
  await page.locator("#app-modal-ok").click();
  const result = await page.evaluate(async () => {
    const w = window as unknown as {
      appState: { activeRoomStatus: string };
      __togglePromise?: Promise<void>;
      __pauseMode?: string;
    };
    await w.__togglePromise;
    return { status: w.appState.activeRoomStatus, mode: w.__pauseMode };
  });
  expect(result).toEqual({ status: "live", mode: "soft" });
});

test("mobile continue swallows PC-defined benign 409 races", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  const result = await page.evaluate(async () => {
    const w = window as unknown as {
      alert: (msg: string) => void;
      appState: Record<string, unknown>;
      roomActionController: { api: { continue: (roomId: string) => Promise<Record<string, unknown>> } };
      continueDiscussion: () => Promise<void>;
      __alerts?: string[];
    };
    w.__alerts = [];
    w.alert = (msg: string) => { w.__alerts?.push(msg); };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomAwaitingClarify = false;
    w.appState.activeRoomAwaitingContinue = false;
    w.roomActionController.api.continue = async () => {
      throw Object.assign(new Error("room already paused"), {
        status: 409,
        data: { error: "room already paused" },
      });
    };
    await w.continueDiscussion();
    return {
      alerts: w.__alerts,
      pending: w.appState.continuePending,
    };
  });
  expect(result.alerts).toEqual([]);
  expect(result.pending).toBe(false);
});

test("chair-pending blocks auto-continue and highlights chair on boardroom", async ({ page }) => {
  test.skip(!ADJOURNED_ROOM || !CHAIR_ID, "need a room and chair");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${ADJOURNED_ROOM}`);
  await page.waitForFunction(() => (window as unknown as { appState?: { activeChair?: { id?: string } } }).appState?.activeChair?.id, null, { timeout: 6_000 });
  await installActiveRoundPrompt(page);
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      roomMeetingController: { handleEvent: (type: string, payload: Record<string, unknown>) => void };
      roomVoiceController: { queue: unknown[] };
      buildRoomSnapshot: () => unknown;
      RoomAutoContinue: { canAutoContinue: (room: unknown) => boolean };
    };
    const a = w.appState;
    a.activeRoomStatus = "live";
    a.activeRoomVoteTrigger = "auto";
    a.activeRoomAwaitingClarify = false;
    a.activeRoomAwaitingContinue = false;
    a.activeRoomQueueLen = 0;
    a.activeRoomRound = { spoken: 3, total: 3 };
    w.roomVoiceController.queue = [];
    a.voicePlaying = null;
    a.autoContinue = { secondsLeft: 0 };
    w.roomMeetingController.handleEvent("config-event", { kind: "chair-pending", payload: { phase: "round-end" } });
    const speakingSeat = document.querySelector("#bd-stage .bd-pix.speaking")?.closest(".bd-seat") as HTMLElement | null;
    return {
      chairPending: a.activeRoomChairPending,
      chairPendingPhase: a.activeRoomChairPendingPhase,
      canAuto: w.RoomAutoContinue.canAutoContinue(w.buildRoomSnapshot()),
      secondsLeft: (a.autoContinue as { secondsLeft?: number }).secondsLeft || 0,
      speakingRole: speakingSeat?.dataset.roleKind || "",
      subtitle: document.getElementById("bd-sub-text")?.textContent || "",
    };
  });
  expect(result.chairPending).toBe(true);
  expect(result.chairPendingPhase).toBe("round-end");
  expect(result.canAuto).toBe(false);
  expect(result.secondsLeft).toBe(0);
  expect(result.speakingRole).toBe("moderator");
  expect(result.subtitle).toContain("正在总结本轮");
});

test("auto-continue cancels when user manually clicks", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await installActiveRoundPrompt(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      roomVoiceController: { queue: unknown[] };
      maybeStartAutoContinue: () => void;
      renderRoomActions: () => void;
    };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomAwaitingClarify = false;
    w.appState.activeRoomAwaitingContinue = false;
    w.appState.activeRoomVoteTrigger = "auto";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 3, total: 3 };
    w.roomVoiceController.queue = [];
    w.appState.voicePlaying = null;
    w.maybeStartAutoContinue();
  });
  // Confirm countdown was running · the shared controller drives
  // appState.autoContinue.secondsLeft via its onTick callback.
  const beforeSeconds = await page.evaluate(() => (window as unknown as { appState: { autoContinue: { secondsLeft: number } } }).appState.autoContinue.secondsLeft);
  expect(beforeSeconds).toBe(10);
  await page.locator("#rc-act-primary").click();
  await page.waitForTimeout(300);
  // continueDiscussion() calls cancelAutoContinue() · the countdown
  // resets to 0 (controller emits a final onTick(0)).
  const afterSeconds = await page.evaluate(() => (window as unknown as { appState: { autoContinue: { secondsLeft: number } } }).appState.autoContinue.secondsLeft);
  expect(afterSeconds).toBe(0);
});

test("chair gavel SFX fires on round-prompt / round-end / intervention", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  const gavelHits = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    let n = 0;
    (w as { boardroomTypingSfx: unknown }).boardroomTypingSfx = { gavel: () => { n++; }, tick: () => {}, speakerChange: () => {}, countdownTick: () => {}, setThinking: () => {}, setEnabled: () => {}, isEnabled: () => true };
    const fn = w.sseAppendMessage as (p: Record<string, unknown>) => void;
    fn({ messageId: "gv-1", authorKind: "agent", authorId: "chair", body: "", meta: { kind: "round-prompt" } });
    fn({ messageId: "gv-2", authorKind: "agent", authorId: "chair", body: "", meta: { kind: "round-end" } });
    fn({ messageId: "gv-3", authorKind: "agent", authorId: "chair", body: "", meta: { kind: "intervention" } });
    return n;
  });
  expect(gavelHits).toBe(3);
});

test("round-end with keypoints surfaces 🗳 投票关键点 button", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const a = w.appState as Record<string, unknown>;
    a.activeRoomStatus = "live";
    a.activeRoomAwaitingClarify = false;
    a.activeRoomAwaitingContinue = false;
    (w.sseAppendMessage as (p: Record<string, unknown>) => void)({
      messageId: "kp-1", authorKind: "agent", authorId: "chair", body: "",
      meta: { kind: "round-end", keypoints: [{ id: "k1", text: "first point" }] },
    });
  });
  await expect(page.locator("#rc-act-primary")).toContainText(/投票关键点/);
});

test("awaitingContinue shows ✓ 确认继续 button", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const a = w.appState as Record<string, unknown>;
    a.activeRoomStatus = "live";
    a.activeRoomAwaitingClarify = false;
    a.activeRoomAwaitingContinue = true;
    a.pendingVoteMessageId = null;
    (w.renderRoomActions as () => void)();
  });
  await expect(page.locator("#rc-act-primary")).toContainText(/确认继续/);
});

test("@mention picker · typing @ surfaces director picker", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.locator("#rc-input").fill("hey @");
  await page.evaluate(() => {
    const w = window as unknown as { onComposerInput: (i: HTMLInputElement, id: string) => void };
    w.onComposerInput(document.getElementById("rc-input") as HTMLInputElement, "rc-input");
  });
  await expect(page.locator("#rc-mention-picker")).toBeVisible();
});

test("submitMessage extracts @handle mentions into payload", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  const handle = await page.evaluate(() => {
    const members = Object.values((window as unknown as { appState: { activeMembersById?: Record<string, { handle?: string }> } }).appState.activeMembersById || {});
    return members[0]?.handle?.replace(/^@/, "") || "";
  });
  test.skip(!handle, "room has no member with handle");
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; roomMeetingController: { state: { queue: unknown[] } } };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.roomMeetingController.state.queue = [];
  });
  await page.locator("#rc-input").fill(`hi @${handle} thoughts?`);
  await page.locator('[data-screen="room-chat"] .composer .send').click();
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
  expect(post?.body).toContain("mentions");
});

test("model-key gate blocks mobile room actions before POSTing", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page, { hasModelKey: false });
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; roomMeetingController: { state: { queue: unknown[] } } };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.roomMeetingController.state.queue = [];
  });
  await page.locator("#rc-input").fill("this should not post");
  await page.locator('[data-screen="room-chat"] .composer .send').click();
  await expect(page.locator("#app-modal-title")).toHaveText("需要配置 LLM 凭据");
  await expect(page.locator("#rc-input")).toHaveValue("this should not post");
  const calls = await captured(page);
  expect(calls.find((c) => c.method === "POST" && c.url.includes("/messages"))).toBeFalsy();
});

test("paused-room supplemental input does not require a model key", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page, { hasModelKey: false });
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      roomMeetingController: { state: { queue: unknown[] } };
      renderRoomActions: () => void;
    };
    w.appState.activeRoomStatus = "paused";
    w.roomMeetingController.state.queue = [];
    w.renderRoomActions();
  });
  await page.locator("#rc-input").fill("paused supplement");
  await page.locator('[data-screen="room-chat"] .composer .send').click();
  await page.waitForTimeout(300);
  await expect(page.locator("#app-modal-title")).not.toHaveText("需要配置 LLM 凭据");
  const calls = await captured(page);
  expect(calls.find((c) => c.method === "POST" && c.url.includes("/paused-input"))?.body).toContain("paused supplement");
  expect(calls.find((c) => c.method === "POST" && c.url.includes("/messages"))).toBeFalsy();
});

test("paused voice room without TTS key does not invent a mobile switch-to-text path", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page, { hasModelKey: true, hasVoiceKey: false });
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      renderRoomActions: () => void;
      roomRuntimeApi: { getRoom: (roomId: string) => Promise<Record<string, unknown>> };
    };
    const id = String(w.appState.activeRoomId);
    w.roomRuntimeApi.getRoom = async () => ({
      room: { id, status: "paused", deliveryMode: "voice", awaitingClarify: false, awaitingContinue: false },
      chair: null,
      members: [],
      messages: [],
      queue: [],
      round: { spoken: 1, total: 1 },
    });
    w.appState.activeRoomStatus = "paused";
    w.appState.activeRoomDelivery = "voice";
    w.appState.activeRoomAwaitingClarify = false;
    w.renderRoomActions();
  });
  await page.locator("#rc-act-primary").click();
  await expect(page.locator("#app-modal-title")).toHaveText("语音凭据不可用");
  await expect(page.getByRole("button", { name: "切到静默" })).toHaveCount(0);
  await page.getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(500);
  const calls = await captured(page);
  expect(calls.find((c) => c.method === "PATCH" && /\/api\/rooms\/[^/]+$/.test(c.url))).toBeFalsy();
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/resume"))).toBeFalsy();
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/continue"))).toBeFalsy();
});

test("endRound mirrors PC after-speaker mode while a director is speaking", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: { activeMembersById?: Record<string, { id: string; name: string }>; activeRoomStatus?: string };
      roomMeetingController: { state: { queue: unknown[] } };
    };
    w.appState.activeRoomStatus = "live";
    w.appState.activeMembersById = {
      ...(w.appState.activeMembersById || {}),
      speaking_director: { id: "speaking_director", name: "发言董事" },
    };
    w.roomMeetingController.state.queue = [{ agentId: "speaking_director", status: "speaking" }];
  });
  const endRoundPromise = page.evaluate(() => (window as unknown as { endRound: () => Promise<void> }).endRound());
  await expect(page.locator("#app-modal-title")).toContainText("发言董事 正在发言");
  await page.locator("#app-modal-ok").click();
  await endRoundPromise;
  const calls = await captured(page);
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/round-end"));
  expect(post?.body).toContain('"mode":"after-speaker"');
});

test("deferred round-end shows the same queued state PC uses", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: { activeMembersById?: Record<string, { id: string; name: string }>; activeRoomStatus?: string; activeRoomVoteQueued?: boolean };
      roomMeetingController: { state: { queue: unknown[] } };
      roomActionController: { api: { endRound: (roomId: string, mode: string) => Promise<Record<string, unknown>> } };
      endRound: () => Promise<void>;
      __endRoundPromise?: Promise<void>;
      __endRoundMode?: string;
    };
    w.appState.activeRoomStatus = "live";
    w.appState.activeMembersById = {
      ...(w.appState.activeMembersById || {}),
      speaking_director: { id: "speaking_director", name: "发言董事" },
    };
    w.roomMeetingController.state.queue = [{ agentId: "speaking_director", status: "speaking" }];
    w.roomActionController.api.endRound = async (_roomId, mode) => {
      w.__endRoundMode = mode;
      return { deferred: true };
    };
    w.__endRoundPromise = w.endRound();
  });
  await page.locator("#app-modal-ok").click();
  const result = await page.evaluate(async () => {
    const w = window as unknown as {
      appState: { activeRoomVoteQueued?: boolean };
      __endRoundPromise?: Promise<void>;
      __endRoundMode?: string;
    };
    await w.__endRoundPromise;
    return {
      mode: w.__endRoundMode,
      queued: w.appState.activeRoomVoteQueued,
      label: document.getElementById("rc-act-primary")?.textContent || "",
    };
  });
  expect(result.mode).toBe("after-speaker");
  expect(result.queued).toBe(true);
  expect(result.label).toContain("等本轮结束后总结");
});

test("round-end vote manager accepts chair mode-shift and continues", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; openRoomVote: () => Promise<void> };
    w.appState.activeRoomModeShiftProposal = { to: "constructive", because: "下一轮应该收束到建设性方案。" };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomAwaitingContinue = true;
    return w.openRoomVote();
  });
  await expect(page.locator("#mgr-title")).toHaveText("关键点投票");
  await expect(page.locator("#mgr-list")).toContainText("切换到 constructive");
  await page.locator("#mgr-list button", { hasText: "切换到 constructive" }).click();
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const patch = calls.find((c) => c.method === "PATCH" && /\/api\/rooms\/[^/]+$/.test(c.url));
  const cont = calls.find((c) => c.method === "POST" && c.url.includes("/continue"));
  expect(patch?.body).toContain('"mode":"constructive"');
  expect(cont).toBeTruthy();
});

test("voice-chunk SSE caches base64 parts per messageId", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  const cached = await page.evaluate(() => {
    const w = window as unknown as {
      handleVoiceChunk: (p: Record<string, unknown>) => void;
      roomVoiceController: { queues: Record<string, { parts: string[] }> };
    };
    w.handleVoiceChunk({ messageId: "vc-1", audioBase64: "AAAA", mimeType: "audio/mpeg", seq: 0 });
    w.handleVoiceChunk({ messageId: "vc-1", audioBase64: "BBBB", seq: 1 });
    return w.roomVoiceController.queues["vc-1"];
  });
  expect(cached.parts).toEqual(["AAAA", "BBBB"]);
});

test("voice chunk caption drives the boardroom speaker card, not table text", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("bd-title")?.textContent !== "圆桌", null, { timeout: 6_000 });
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      appState: { voicePlaying: { messageId: string; authorId: string | null }; activeMembersById: Record<string, { id: string; roleKind?: string }> };
      handleVoiceChunk: (p: Record<string, unknown>) => void;
      roomVoiceController: { queues: Record<string, { captions?: { text: string }[] }> };
      updateBoardroomVoiceCaption: (q: Record<string, unknown>, caption: string) => void;
    };
    const author = Object.values(w.appState.activeMembersById || {}).find((a) => a.roleKind !== "moderator")?.id || "director-1";
    const beforeTable = document.getElementById("bd-table-quote")?.textContent || "";
    w.handleVoiceChunk({ messageId: "voice-caption-sync", authorId: author, audioBase64: "AAAA", mimeType: "audio/mpeg", text: "第一段会被运行时缓存" });
    w.appState.voicePlaying = { messageId: "voice-caption-sync", authorId: author };
    w.updateBoardroomVoiceCaption({ messageId: "voice-caption-sync", authorId: author }, "当前正在朗读的这一句");
    return {
      cachedCaption: w.roomVoiceController.queues["voice-caption-sync"]?.captions?.[0]?.text || "",
      speakerCard: document.getElementById("bd-sub-text")?.textContent || "",
      table: document.getElementById("bd-table-quote")?.textContent || "",
      beforeTable,
    };
  });
  expect(result.cachedCaption).toBe("第一段会被运行时缓存");
  expect(result.speakerCard).toContain("当前正在朗读");
  expect(result.table).toBe(result.beforeTable);
});

test("boardroom more menu exposes pause, cast, divergence and adjourn actions", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("bd-title")?.textContent !== "圆桌", null, { timeout: 6_000 });
  await page.locator('[data-screen="boardroom"] .composer button').click();
  await expect(page.locator('.sheet[data-sheet="room-more"]')).toHaveClass(/on/);
  await expect(page.locator('.sheet[data-sheet="room-more"]')).toContainText(/暂停讨论|恢复讨论/);
  await expect(page.locator('.sheet[data-sheet="room-more"]')).toContainText("加入 / 移除董事");
  await expect(page.locator('.sheet[data-sheet="room-more"]')).toContainText("Divergence report");
  await expect(page.locator('.sheet[data-sheet="room-more"]')).toContainText("结束并归档");
  // No mid-session voice/silent toggle (PC removed it; delivery is set at creation).
  await expect(page.locator('.sheet[data-sheet="room-more"]')).not.toContainText("语音 / 静默");
});

test("mobile adjourn overlay can skip brief or choose report mode", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => (window as unknown as { openAdjournOverlay: () => void }).openAdjournOverlay());
  await expect(page.locator("#mobile-adjourn-overlay")).toBeVisible();
  await expect(page.locator("#mobile-adjourn-overlay")).toContainText("报告版式");
  await page.locator("#mobile-adjourn-overlay button", { hasText: "不生成简报" }).click();
  const calls = await captured(page);
  const adjourn = calls.find((c) => c.method === "POST" && c.url.includes("/adjourn"));
  expect(adjourn?.body).toContain('"skipBrief":true');
});

test("mobile divergence report renders PC diversity data", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.addInitScript(() => {
    const orig = window.fetch.bind(window);
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET" && /\/api\/rooms\/[^/]+\/diversity/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({
          branches: [
            { id: "b1", label: "老股套现与接盘风险识别", turnCount: 5 },
            { id: "b2", label: "十年复利曲线与不在场成本", turnCount: 2 },
          ],
          coverage: { filled: 8, total: 64, pct: 0.125 },
          buckets: { abstraction: [1, 2, 0, 0], time: [0, 1, 1, 0], stakeholder: [1, 0, 1, 0] },
          messagesScored: 7,
          unexplored: [{ id: "u1", angle: "平台 vs 彩票的商业模式差异" }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return orig(input as RequestInfo, init);
    };
  });
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => (window as unknown as { openDivergenceReport: () => Promise<void> }).openDivergenceReport());
  await expect(page.locator("#mobile-divergence-overlay")).toContainText("老股套现与接盘风险识别");
  await expect(page.locator("#mobile-divergence-overlay")).toContainText("平台 vs 彩票");
});

test("mobile cast editor PATCHes room members through shared endpoint", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  const boxCount = await page.evaluate(() => {
    const w = window as unknown as { openRoomCastEditor: () => void };
    w.openRoomCastEditor();
    return document.querySelectorAll("[data-mobile-cast-id]").length;
  });
  test.skip(boxCount < 2, "need at least two directors");
  await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll("[data-mobile-cast-id]")) as HTMLInputElement[];
    const target = boxes.find((b) => !b.checked) || boxes[boxes.length - 1];
    target.click();
  });
  await page.locator("#mobile-cast-overlay button", { hasText: "确认调整" }).click();
  const calls = await captured(page);
  const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/members"));
  expect(patch?.body).toContain("agentIds");
});

test("no JS errors / pageerrors across initial bootstrap + tab cycle", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  await page.goto(`${BASE}/m/`);
  await waitListReady(page, "rooms-list");
  for (const t of ["agents", "briefs", "me", "rooms"]) {
    await page.evaluate((tab) => (window as unknown as { setTab: (n: string) => void }).setTab(tab), t);
  }
  // ignore expected 404s from favicon/manifest
  const real = errors.filter((e) => !/favicon|manifest|404/.test(e));
  expect(real).toEqual([]);
});
