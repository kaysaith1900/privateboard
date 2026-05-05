/* ═══════════════════════════════════════════
   MODELS CACHE · /api/models singleton
   ═══════════════════════════════════════════
   Shared store for the model availability snapshot · every picker
   (composer / agent profile / new-agent / user-settings default)
   reads from here so they all reflect the same key state at the
   same time.

   API:
     boardroomModels()              snapshot or null
     boardroomModelsRefresh()       Promise<snapshot>
     boardroomModelsOnUpdate(fn)    subscribe (returns unsubscribe)

   Snapshot shape mirrors GET /api/models:
     { hasAnyKey, models[], reachable[], defaultModelV,
       utilityModelV, providers[] }
*/
(function () {
  let _cache = null;
  const _subs = new Set();
  let _inflight = null;

  function notify() {
    for (const fn of _subs) {
      try { fn(_cache); } catch (e) { /* swallow */ }
    }
  }

  function refresh() {
    if (_inflight) return _inflight;
    _inflight = (async () => {
      try {
        const r = await fetch("/api/models");
        if (r.ok) _cache = await r.json();
      } catch (e) { /* keep last cache on offline */ }
      _inflight = null;
      notify();
      return _cache;
    })();
    return _inflight;
  }

  // Public API · synchronous read returns the latest snapshot
  // (or null until the first refresh resolves).
  window.boardroomModels = () => _cache;
  window.boardroomModelsRefresh = refresh;
  window.boardroomModelsOnUpdate = (fn) => {
    _subs.add(fn);
    return () => _subs.delete(fn);
  };

  // Kick off the initial fetch as soon as the module loads · every
  // consumer that calls boardroomModels() before this resolves will
  // get null and should subscribe via boardroomModelsOnUpdate to
  // re-render once the data arrives.
  refresh();
})();
