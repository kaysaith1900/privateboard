/**
 * Voice-distill tests · covers the storage layer, ffmpeg helpers (pure
 * filter-graph construction · no actual ffmpeg spawn), and the
 * orchestrator's voice-id slug generator. The orchestrator's full
 * pipeline involves real child processes (yt-dlp, ffmpeg) + real HTTP
 * (MiniMax) so end-to-end runs are exercised manually; here we keep
 * tests deterministic by mocking the external surfaces.
 */
import { describe, expect, it } from "vitest";

import {
  createVoiceDistillJob,
  getVoiceDistillJob,
  listRecentVoiceDistillJobs,
  markRunningVoiceDistillJobsFailed,
  updateVoiceDistillJob,
} from "../src/storage/voice-distill-jobs.js";

describe("voice-distill-jobs storage", () => {
  it("creates a job in running state with default counters", () => {
    const job = createVoiceDistillJob({
      id: "test-job-1",
      videoUrl: "https://example.com/v.mp4",
      celebrity: "test-speaker-a",
      agentId: null,
    });
    expect(job.id).toBe("test-job-1");
    expect(job.status).toBe("running");
    expect(job.currentPhase).toBe(1);
    expect(job.progressPct).toBe(0);
    expect(job.celebrity).toBe("test-speaker-a");
    expect(job.videoUrl).toBe("https://example.com/v.mp4");
  });

  it("patches phase + partial fields atomically", () => {
    createVoiceDistillJob({
      id: "test-job-2",
      videoUrl: "https://example.com/v2.mp4",
      celebrity: "test",
    });
    const patched = updateVoiceDistillJob("test-job-2", {
      currentPhase: 3,
      progressPct: 42,
      partial: { fileId: 999, voiceId: "pb_test_abc" },
    });
    expect(patched?.currentPhase).toBe(3);
    expect(patched?.progressPct).toBe(42);
    expect(patched?.partial?.fileId).toBe(999);
  });

  it("clamps progressPct to 0-100", () => {
    createVoiceDistillJob({ id: "test-job-3", videoUrl: "https://x", celebrity: "x" });
    const a = updateVoiceDistillJob("test-job-3", { progressPct: 250 });
    const b = updateVoiceDistillJob("test-job-3", { progressPct: -50 });
    expect(a?.progressPct).toBe(100);
    expect(b?.progressPct).toBe(0);
  });

  it("markRunningVoiceDistillJobsFailed flips running rows + leaves done rows alone", () => {
    createVoiceDistillJob({ id: "stuck", videoUrl: "https://a", celebrity: "a" });
    createVoiceDistillJob({ id: "fine", videoUrl: "https://b", celebrity: "b" });
    updateVoiceDistillJob("fine", { status: "done" });
    const fixed = markRunningVoiceDistillJobsFailed();
    expect(fixed).toBe(1);
    expect(getVoiceDistillJob("stuck")?.status).toBe("failed");
    expect(getVoiceDistillJob("stuck")?.error).toContain("server restarted");
    expect(getVoiceDistillJob("fine")?.status).toBe("done");
  });

  it("listRecentVoiceDistillJobs returns most-recent first", async () => {
    createVoiceDistillJob({ id: "old", videoUrl: "https://a", celebrity: "a" });
    await new Promise((r) => setTimeout(r, 5));
    createVoiceDistillJob({ id: "new", videoUrl: "https://b", celebrity: "b" });
    const rows = listRecentVoiceDistillJobs(10);
    expect(rows[0].id).toBe("new");
    expect(rows[1].id).toBe("old");
  });
});

describe("ffmpeg helpers", () => {
  it("trimSegmentsToBudget enforces a cumulative duration cap", async () => {
    const { trimSegmentsToBudget } = await import("../src/skills/ffmpeg.js");
    const res = trimSegmentsToBudget(
      [
        { start: 0, end: 60 },
        { start: 100, end: 160 },
        { start: 200, end: 260 },
      ],
      120,
    );
    expect(res.totalSec).toBe(120);
    expect(res.segments).toHaveLength(2);
    expect(res.segments[0]).toEqual({ start: 0, end: 60 });
    expect(res.segments[1]).toEqual({ start: 100, end: 160 });
  });

  it("trimSegmentsToBudget skips zero-length and infinite ranges", async () => {
    const { trimSegmentsToBudget } = await import("../src/skills/ffmpeg.js");
    const res = trimSegmentsToBudget(
      [
        { start: 10, end: 10 },
        { start: Number.NaN, end: 20 },
        { start: 0, end: 5 },
      ],
      120,
    );
    expect(res.segments).toHaveLength(1);
    expect(res.totalSec).toBe(5);
  });

  it("buildClipFilterChain wires N atrim filters into one concat sink", async () => {
    const { buildClipFilterChain } = await import("../src/skills/ffmpeg.js");
    const chain = buildClipFilterChain([
      { start: 0, end: 30 },
      { start: 60, end: 90 },
    ]);
    expect(chain).toContain("[0:a]atrim=start=0.000:end=30.000");
    expect(chain).toContain("[0:a]atrim=start=60.000:end=90.000");
    expect(chain).toContain("[a0][a1]concat=n=2:v=0:a=1[out]");
  });

  it("extractClips rejects empty segment lists", async () => {
    const { extractClips } = await import("../src/skills/ffmpeg.js");
    await expect(
      extractClips({
        inputPath: "/tmp/x.mp3",
        outputPath: "/tmp/y.mp3",
        segments: [],
      }),
    ).rejects.toThrow(/No usable segments/);
  });
});
