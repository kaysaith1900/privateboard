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
let ADJOURNED_ROOM = "";
let FIRST_AGENT = "";

test.beforeAll(async () => {
  const ctx = await request.newContext({ baseURL: BASE });
  const rooms = (await (await ctx.get("/api/rooms")).json()).rooms ?? [];
  LIVE_OR_PAUSED_ROOM = rooms.find((r: { status: string }) => r.status === "live" || r.status === "paused")?.id ?? rooms[0]?.id ?? "";
  ADJOURNED_ROOM = rooms.find((r: { status: string }) => r.status === "adjourned")?.id ?? rooms[0]?.id ?? "";
  const agents = (await (await ctx.get("/api/agents")).json()).agents ?? [];
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

async function installFetchInterceptor(page: Page): Promise<void> {
  // Intercept POST/DELETE/PATCH so functional tests don't mutate real state.
  // GET still hits the real server so list rendering tests are honest.
  await page.addInitScript(() => {
    const w = window as unknown as { __captured: { url: string; method: string; body?: string }[] };
    w.__captured = [];
    const orig = window.fetch.bind(window);
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || "GET").toUpperCase();
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
  });
}

async function captured(page: Page): Promise<{ url: string; method: string; body?: string }[]> {
  return page.evaluate(() => (window as unknown as { __captured: unknown[] }).__captured as { url: string; method: string; body?: string }[]);
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
  await page.locator("#rc-input").fill("e2e · auto send");
  await page.locator("[data-screen=\"room-chat\"] .composer .send").click();
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
  expect(post).toBeTruthy();
});

test("room-chat ⋯更多 sheet exposes 8 row actions", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as { appState: Record<string, unknown>; renderRoomActions: () => void };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 1, total: 1 };
    w.renderRoomActions();
  });
  await page.locator("#rc-act-more").click();
  const sheet = page.locator(".sheet[data-sheet=\"room-more\"]");
  await expect(sheet).toHaveClass(/(^|\s)on(\s|$)/);
  await expect(sheet.locator(".row")).toHaveCount(10);
});

test("toggle delivery mode PATCHes the room", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => (window as unknown as { toggleDeliveryMode: () => Promise<void> }).toggleDeliveryMode());
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const patch = calls.find((c) => c.method === "PATCH" && /\/api\/rooms\/[^/]+$/.test(c.url));
  expect(patch).toBeTruthy();
  expect(patch?.body).toContain("deliveryMode");
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
  await page.locator("#bd-stage .bd-seat").first().click();
  await expect(page.locator(".screen.on")).toHaveAttribute("data-screen", "agent-profile");
});

test("boardroom shows audio-unlock banner + click unlocks voice queue", async ({ page }) => {
  await page.goto(`${BASE}/m/?screen=boardroom`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  const banner = page.locator("#bd-audio-unlock");
  await expect(banner).toBeVisible();
  // simulate the user gesture: tap banner
  await banner.click();
  // banner hides after unlock (data uri silent buffer should play OK in chromium)
  await expect(banner).toBeHidden({ timeout: 4_000 });
  // queue pump uses appState.voiceUnlocked = true
  const unlocked = await page.evaluate(() => (window as unknown as { appState: { voiceUnlocked: boolean } }).appState.voiceUnlocked);
  expect(unlocked).toBe(true);
});

test("voice queue · message-final sets audio src directly", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=boardroom&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.querySelectorAll("#bd-stage .bd-seat").length > 0, null, { timeout: 6_000 });
  await page.locator("#bd-audio-unlock").click();
  await page.evaluate(() => {
    (window as unknown as { handleMessageFinal: (p: { messageId: string; authorId: string }) => void })
      .handleMessageFinal({ messageId: "synthetic-test-msg", authorId: "synthetic-agent" });
  });
  await page.waitForTimeout(800);
  const src = await page.evaluate(() => (document.getElementById("bd-audio") as HTMLAudioElement)?.src || "");
  expect(src).toContain("synthetic-test-msg");
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
    a.continueSeen = 1; // unlock auto-continue (post first-landing)
    // Clear any pre-existing countdown so maybeStart can re-engage.
    (w.cancelAutoContinue as () => void)();
    (w.maybeStartAutoContinue as () => void)();
    const btn = document.getElementById("rc-act-primary");
    return {
      ticks,
      btn: btn?.textContent || "",
      canAuto: (w.canAutoContinue as () => boolean)(),
      hasInterval: !!(a.autoContinue as { interval: unknown }).interval,
    };
  });
  expect(result.canAuto).toBe(true);
  expect(result.hasInterval).toBe(true);
  expect(result.ticks[0]).toBe(10);
  expect(result.btn).toMatch(/继续讨论/);
});

test("auto-continue cancels when user manually clicks", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await installFetchInterceptor(page);
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      appState: Record<string, unknown>;
      maybeStartAutoContinue: () => void;
      renderRoomActions: () => void;
    };
    w.appState.activeRoomStatus = "live";
    w.appState.activeRoomAwaitingClarify = false;
    w.appState.activeRoomAwaitingContinue = false;
    w.appState.activeRoomVoteTrigger = "auto";
    w.appState.activeRoomQueueLen = 0;
    w.appState.activeRoomRound = { spoken: 3, total: 3 };
    w.appState.continueSeen = 1;
    w.maybeStartAutoContinue();
  });
  // Confirm countdown was running
  const beforeInterval = await page.evaluate(() => !!(window as unknown as { appState: { autoContinue: { interval: number | null } } }).appState.autoContinue.interval);
  expect(beforeInterval).toBe(true);
  await page.locator("#rc-act-primary").click();
  await page.waitForTimeout(300);
  const afterInterval = await page.evaluate(() => !!(window as unknown as { appState: { autoContinue: { interval: number | null } } }).appState.autoContinue.interval);
  expect(afterInterval).toBe(false);
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
  await page.locator("#rc-input").fill(`hi @${handle} thoughts?`);
  await page.locator('[data-screen="room-chat"] .composer .send').click();
  await page.waitForTimeout(300);
  const calls = await captured(page);
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
  expect(post?.body).toContain("mentions");
});

test("voice-chunk SSE caches base64 parts per messageId", async ({ page }) => {
  test.skip(!LIVE_OR_PAUSED_ROOM, "no live room");
  await page.goto(`${BASE}/m/?screen=room-chat&roomId=${LIVE_OR_PAUSED_ROOM}`);
  await page.waitForFunction(() => document.getElementById("rc-title")?.textContent !== "房间", null, { timeout: 6_000 });
  const cached = await page.evaluate(() => {
    const w = window as unknown as { handleVoiceChunk: (p: Record<string, unknown>) => void; appState: { voiceChunks: Record<string, { parts: string[] }> } };
    w.handleVoiceChunk({ messageId: "vc-1", audioBase64: "AAAA", mimeType: "audio/mpeg", seq: 0 });
    w.handleVoiceChunk({ messageId: "vc-1", audioBase64: "BBBB", seq: 1 });
    return w.appState.voiceChunks["vc-1"];
  });
  expect(cached.parts).toEqual(["AAAA", "BBBB"]);
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
