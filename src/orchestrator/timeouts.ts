/**
 * Generic timeout helper for orchestrator calls that would otherwise
 * hang silently when the upstream LLM / TTS / tool stalls.
 *
 * Two uses cover all current call sites:
 *
 *   1. `withTimeout(promise, ms)` — race a promise against a timer.
 *      Rejects with TimeoutError when ms elapses. Caller decides what
 *      to do (fallback, retry, skip).
 *
 *   2. `withTimeoutAbort(work, ms, outerSignal?)` — for streaming
 *      calls that accept an AbortSignal. Composes an internal timeout
 *      controller with an outer abort signal (room abort, user
 *      action), so the work cancels on whichever fires first.
 *
 * Both leave the actual fallback / retry policy at the call site so
 * each caller can decide "fail loud" vs "fall back silently."
 */

export class TimeoutError extends Error {
  constructor(ms: number, label?: string) {
    super(`timeout after ${ms}ms${label ? ` · ${label}` : ""}`);
    this.name = "TimeoutError";
  }
}

/** Race a promise against a timer. Rejects with TimeoutError when
 *  ms elapses. Resolves / rejects with the promise's result otherwise.
 *  No abort propagation · the underlying work keeps running but its
 *  result is ignored. Use withTimeoutAbort when the work supports
 *  cancellation. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Run `work(signal)` with a composed AbortSignal that fires on
 *  EITHER the internal timeout OR the optional outer signal. Returns
 *  whatever `work` returns. Throws TimeoutError when the timeout
 *  fires, or the outer signal's reason when it does. The composed
 *  controller is always cleaned up on completion. */
export async function withTimeoutAbort<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outerSignal?: AbortSignal,
  label?: string,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  const onOuterAbort = (): void => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    else outerSignal.addEventListener("abort", onOuterAbort);
  }
  try {
    return await work(ctrl.signal);
  } catch (e) {
    if (timedOut) throw new TimeoutError(ms, label);
    throw e;
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
  }
}
