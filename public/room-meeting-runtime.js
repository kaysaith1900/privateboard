(function (global) {
  "use strict";

  const SEND_THROTTLE_MS = 700;
  const VOICE_HEARTBEAT_MS = 5000;

  function encode(value) {
    return encodeURIComponent(String(value || ""));
  }

  function base64ByteLength(value) {
    const text = String(value || "").replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
    if (!text) return 0;
    const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
  }

  function base64ToBytes(value) {
    const text = String(value || "").replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
    if (!text) return new Uint8Array(0);
    if (typeof atob === "function") {
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
    return new Uint8Array(0);
  }

  function cleanCaptionText(raw) {
    return String(raw || "")
      .replace(/\*+/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/^[-*]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function captionSentences(raw) {
    const text = cleanCaptionText(raw);
    if (!text) return [];
    const parts = [];
    const re = /[^。！？.!?；;\n]+[。！？.!?；;\n]?/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const sentence = match[0].trim();
      if (sentence) parts.push(sentence);
    }
    return parts.length ? parts : [text];
  }

  function pickVisibleCaptionText(raw, options) {
    const text = cleanCaptionText(raw);
    if (!text) return "";
    const parts = captionSentences(text);
    const audio = options && options.audio;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0
      && Number.isFinite(audio.currentTime)) {
      const progress = Math.max(0, Math.min(1, audio.currentTime / audio.duration));
      const cursor = Math.floor(text.length * progress);
      let acc = 0;
      for (const part of parts) {
        acc += part.length;
        if (acc >= cursor) return part;
      }
    }
    return parts[parts.length - 1] || text;
  }

  function compactCaptionText(raw, options) {
    const text = pickVisibleCaptionText(raw, options);
    if (!text) return "";
    const dense = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
    const max = options && Number.isFinite(options.maxChars)
      ? Math.max(12, Math.floor(options.maxChars))
      : dense ? 54 : 108;
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
  }

  function deriveRoomActionState(input) {
    const state = input || {};
    if (!state.roomId) return { kind: "none", hidden: true, placeholderKey: "default" };
    if (state.awaitingClarify) {
      return { kind: "clarify", hidden: true, placeholderKey: "clarify" };
    }
    const status = state.status || "live";
    if (status === "live") {
      const round = state.round || { spoken: 0, total: 0 };
      const total = Number(round.total || 0);
      const spoken = Number(round.spoken || 0);
      const busy = !!(
        state.continuePending
        || Number(state.queueLen || 0) > 0
        || (total > 0 && spoken < total)
      );
      const showSpecial = !!(state.pendingVoteMessageId || state.awaitingContinue);
      if (state.voteQueued) return { kind: "vote-queued", busy: true, action: "refresh" };
      if (busy && !showSpecial) return { kind: "busy", busy: true, action: "refresh" };
      if (state.pendingVoteMessageId) {
        return { kind: "keypoints", action: "open-keypoints", showEnd: true };
      }
      if (state.awaitingContinue) {
        return { kind: "awaiting-continue", action: "continue", showEnd: true };
      }
      return {
        kind: "live-continue",
        action: "continue",
        showEnd: true,
        secondsLeft: Number(state.secondsLeft || 0),
      };
    }
    if (status === "paused") return { kind: "paused-resume", action: "continue" };
    if (status === "adjourned") return { kind: "adjourned-brief", action: "brief" };
    return { kind: "unknown", action: null };
  }

  function extractRoomVoteItems(messages, modeShiftProposal) {
    const items = [];
    let modeShift = modeShiftProposal || null;
    (messages || []).forEach((message) => {
      if (!message) return;
      const meta = message.meta || {};
      const isKeyPointMessage = message.authorKind === "chair-system" || meta.kind === "keypoints" || meta.keypoints || meta.points;
      if (!isKeyPointMessage) return;
      if (meta.modeShiftProposal) modeShift = meta.modeShiftProposal;
      const points = meta.keypoints || meta.points;
      if (Array.isArray(points)) {
        points.forEach((point) => {
          if (!point) return;
          const id = point.id || point.kpId;
          const text = point.text || point.title;
          const vote = point.vote === "up" || point.vote === "down" ? point.vote : null;
          if (id && text) items.push({ id, text, msgId: message.id, vote });
        });
      } else if (typeof message.body === "string") {
        message.body
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 4)
          .slice(0, 6)
          .forEach((line, idx) => {
            items.push({ id: message.id + "-" + idx, text: line, msgId: message.id });
          });
      }
    });
    if (modeShift && modeShift.to) {
      items.unshift({
        type: "mode-shift",
        id: "mode-shift",
        to: modeShift.to,
        because: modeShift.because || "",
      });
    }
    return items;
  }

  function normalizeVoteTrigger(value) {
    return value === "manual" ? "manual" : "auto";
  }

  function nextVoteTrigger(current) {
    return normalizeVoteTrigger(current) === "auto" ? "manual" : "auto";
  }

  function normalizeDeliveryMode(value) {
    return value === "voice" ? "voice" : "text";
  }

  function nextDeliveryMode(current) {
    return normalizeDeliveryMode(current) === "voice" ? "text" : "voice";
  }

  function shouldPreserveChairPendingForMessage(message, context) {
    const chair = context && context.chair;
    const room = context && context.room;
    const meta = (message && message.meta) || {};
    const kind = meta.kind;
    return !!(
      message
      && message.authorKind === "agent"
      && chair && message.authorId === chair.id
      && room && room.deliveryMode === "voice"
      && meta.streaming === false
      && (kind === "round-prompt" || kind === "round-end" || kind === "intervention")
    );
  }

  function shouldClearChairPendingOnMessage(message, context) {
    if (!message) return false;
    if (message.authorKind !== "agent" && message.authorKind !== "director" && message.authorKind !== "chair") {
      return false;
    }
    return !shouldPreserveChairPendingForMessage(message, context);
  }

  async function readJson(response, fallback) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.error || fallback || ("HTTP " + response.status));
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function errorText(error) {
    if (!error) return "";
    return String(
      (error.data && error.data.error)
      || error.error
      || error.message
      || "",
    );
  }

  function isBenignPauseRace(error) {
    return !!(error && error.status === 409 && /not\s*live|already\s*paused/i.test(errorText(error)));
  }

  function isBenignContinueRace(error) {
    return !!(error && error.status === 409 && /not\s*live|already\s*(paused|adjourned)/i.test(errorText(error)));
  }

  function createApiClient(options) {
    const fetchImpl = (options && options.fetch) || global.fetch.bind(global);
    return {
      async getRoom(roomId) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId));
        return readJson(r, "failed to load room");
      },
      async createRoom(args) {
        const body = {
          subject: args && args.subject,
          agentIds: (args && args.agentIds) || [],
          mode: (args && args.mode) || "constructive",
          intensity: (args && args.intensity) || "sharp",
          briefStyle: (args && args.briefStyle) || "auto",
          deliveryMode: args && args.deliveryMode === "voice" ? "voice" : "text",
        };
        if (args && args.autoPick) body.autoPick = true;
        if (args && args.parentRoomId) body.parentRoomId = args.parentRoomId;
        if (args && args.parentBriefId) body.parentBriefId = args.parentBriefId;
        const r = await fetchImpl("/api/rooms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return readJson(r, "failed to create room");
      },
      async sendMessage(roomId, args) {
        const body = {
          body: String((args && args.body) || "").trim(),
          mentions: (args && args.mentions) || [],
        };
        if (args && args.mode === "after-speaker") body.mode = "after-speaker";
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return readJson(r, "send failed");
      },
      async sendPausedInput(roomId, args) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/paused-input", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: String((args && args.body) || "").trim() }),
        });
        return readJson(r, "add input failed");
      },
      async pause(roomId, mode) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/pause", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: mode === "soft" ? "soft" : "hard" }),
        });
        return readJson(r, "pause failed");
      },
      async resume(roomId) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/resume", { method: "POST" });
        return readJson(r, "resume failed");
      },
      async continue(roomId) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/continue", { method: "POST" });
        return readJson(r, "continue failed");
      },
      async adjourn(roomId, args) {
        const init = { method: "POST" };
        if (args && Object.keys(args).length) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(args);
        }
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/adjourn", init);
        return readJson(r, "adjourn failed");
      },
      async patchSettings(roomId, patch) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch || {}),
        });
        return readJson(r, "settings update failed");
      },
      async patchMembers(roomId, agentIds) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/members", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentIds: agentIds || [] }),
        });
        return readJson(r, "members update failed");
      },
      async getDiversity(roomId) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/diversity");
        return readJson(r, "diversity report failed");
      },
      async generateBrief(roomId, args) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/brief", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args || {}),
        });
        return readJson(r, "brief generation failed");
      },
      async endRound(roomId, mode) {
        const init = { method: "POST" };
        if (mode) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify({ mode });
        }
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/round-end", init);
        return readJson(r, "round end failed");
      },
      async voteKeyPoint(roomId, keyPointId, vote) {
        // Backend contract (src/routes/rooms.ts): body { vote: "up" | "down" | null }.
        // Anything else is coerced server-side to null (clears the vote).
        const normalized = vote === "up" || vote === "down" ? vote : null;
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/keypoints/" + encode(keyPointId) + "/vote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vote: normalized }),
        });
        return readJson(r, "vote failed");
      },
      async postVoiceProgress(roomId, messageId) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/messages/" + encode(messageId) + "/voice-progress", { method: "POST" });
        return readJson(r, "voice progress failed");
      },
      async postVoiceDone(roomId, messageId) {
        const r = await fetchImpl("/api/rooms/" + encode(roomId) + "/messages/" + encode(messageId) + "/voice-done", { method: "POST" });
        return readJson(r, "voice done failed");
      },
    };
  }

  class MeetingController {
    constructor(options) {
      this.api = (options && options.api) || createApiClient();
      this.EventSourceImpl = (options && options.EventSource) || global.EventSource;
      this.onState = (options && options.onState) || function () {};
      this.onEvent = (options && options.onEvent) || function () {};
      this.onError = (options && options.onError) || function () {};
      this.stream = null;
      this.roomId = null;
      this.state = this._emptyState();
    }

    _emptyState() {
      return {
        room: null,
        chair: null,
        membersById: {},
        messagesById: {},
        order: [],
        queue: [],
        round: { spoken: 0, total: 0 },
        currentActiveMessageId: null,
        awaitingClarify: false,
        awaitingContinue: false,
        chairPending: false,
        chairPendingPhase: "",
        pendingVoteMessageId: null,
        modeShiftProposal: null,
      };
    }

    disconnect() {
      if (this.stream) {
        try { this.stream.close(); } catch (_) {}
      }
      this.stream = null;
      this.roomId = null;
    }

    async load(roomId) {
      const data = await this.api.getRoom(roomId);
      this.adoptRoomState(data);
      return data;
    }

    adoptRoomState(data) {
      const next = this._emptyState();
      next.room = data.room || null;
      next.chair = data.chair || null;
      next.queue = data.queue || [];
      next.round = data.round || next.round;
      const members = data.members || [];
      for (const member of members) next.membersById[member.id] = member;
      if (next.chair && next.chair.id) next.membersById[next.chair.id] = next.chair;
      const messages = data.messages || [];
      for (const message of messages) {
        if (!message || !message.id) continue;
        next.messagesById[message.id] = message;
        next.order.push(message.id);
      }
      next.awaitingClarify = !!(next.room && next.room.awaitingClarify);
      next.awaitingContinue = !!(next.room && next.room.awaitingContinue);
      this.state = next;
      this.onState(this.snapshot());
    }

    snapshot() {
      return {
        room: this.state.room,
        chair: this.state.chair,
        membersById: { ...this.state.membersById },
        messages: this.state.order.map((id) => this.state.messagesById[id]).filter(Boolean),
        queue: this.state.queue.slice(),
        round: this.state.round,
        currentActiveMessageId: this.state.currentActiveMessageId,
        awaitingClarify: this.state.awaitingClarify,
        awaitingContinue: this.state.awaitingContinue,
        chairPending: this.state.chairPending,
        chairPendingPhase: this.state.chairPendingPhase,
        pendingVoteMessageId: this.state.pendingVoteMessageId,
        modeShiftProposal: this.state.modeShiftProposal,
      };
    }

    connect(roomId) {
      this.disconnect();
      this.roomId = roomId;
      if (!this.EventSourceImpl) return null;
      const es = new this.EventSourceImpl("/api/rooms/" + encode(roomId) + "/stream");
      this.stream = es;
      [
        "message-appended",
        "message-token",
        "message-updated",
        "message-removed",
        "message-error",
        "message-final",
        "voice-chunk",
        "voice-final",
        "voice-error",
        "queue-update",
        "config-event",
      ].forEach((type) => {
        es.addEventListener(type, (event) => {
          let payload = {};
          try { payload = event && event.data ? JSON.parse(event.data) : {}; }
          catch (err) { this.onError(err, type); return; }
          this.handleEvent(type, payload);
        });
      });
      es.addEventListener("message", (event) => {
        this.onEvent("message", event && event.data);
      });
      es.onerror = (event) => {
        this.onError(event, "stream-error");
      };
      return es;
    }

    handleEvent(type, payload) {
      if (type === "message-appended") this._messageAppended(payload);
      else if (type === "message-token") this._messageToken(payload);
      else if (type === "message-updated") this._messageUpdated(payload);
      else if (type === "message-removed") this._messageRemoved(payload);
      else if (type === "message-error") this._messageError(payload);
      else if (type === "message-final") this._messageFinal(payload);
      else if (type === "voice-chunk") this._voiceChunk(payload);
      else if (type === "queue-update") this._queueUpdate(payload);
      else if (type === "config-event") this._configEvent(payload);
      this.onEvent(type, payload, this.snapshot());
      this.onState(this.snapshot());
    }

    _messageAppended(payload) {
      if (!payload || !payload.messageId) return;
      if (!this.state.order.includes(payload.messageId)) this.state.order.push(payload.messageId);
      this.state.messagesById[payload.messageId] = {
        ...(this.state.messagesById[payload.messageId] || {}),
        id: payload.messageId,
        authorKind: payload.authorKind,
        authorId: payload.authorId,
        body: payload.body || "",
        meta: payload.meta || {},
        roundNum: payload.roundNum,
      };
      if (shouldClearChairPendingOnMessage(this.state.messagesById[payload.messageId], this.state)) {
        this.state.chairPending = false;
        this.state.chairPendingPhase = "";
      }
    }

    _messageToken(payload) {
      const msg = payload && payload.messageId ? this.state.messagesById[payload.messageId] : null;
      if (msg && typeof payload.delta === "string") msg.body = String(msg.body || "") + payload.delta;
    }

    _messageUpdated(payload) {
      const msg = payload && payload.messageId ? this.state.messagesById[payload.messageId] : null;
      if (!msg) return;
      if (typeof payload.body === "string") msg.body = payload.body;
      if (payload.meta) msg.meta = payload.meta;
    }

    _messageRemoved(payload) {
      if (!payload || !payload.messageId) return;
      delete this.state.messagesById[payload.messageId];
      this.state.order = this.state.order.filter((id) => id !== payload.messageId);
    }

    _messageError(payload) {
      const msg = payload && payload.messageId ? this.state.messagesById[payload.messageId] : null;
      if (!msg) return;
      msg.meta = { ...(msg.meta || {}), streaming: false, speakerStatus: "final", error: payload.message || "error" };
    }

    _messageFinal(payload) {
      const msg = payload && payload.messageId ? this.state.messagesById[payload.messageId] : null;
      if (!msg) return;
      msg.meta = { ...(msg.meta || {}), streaming: false, speakerStatus: "final" };
    }

    _queueUpdate(payload) {
      this.state.queue = payload.queue || [];
      if (payload.round) this.state.round = payload.round;
      if (typeof payload.activeMessageId === "string" || payload.activeMessageId === null) {
        this.state.currentActiveMessageId = payload.activeMessageId;
      }
    }

    _voiceChunk(payload) {
      if (!payload || !payload.messageId || !this.state.chairPending) return;
      this.state.chairPending = false;
      this.state.chairPendingPhase = "";
    }

    _configEvent(data) {
      const kind = data && data.kind;
      const payload = (data && data.payload) || {};
      if (!this.state.room) this.state.room = { id: this.roomId };
      if (kind === "room-paused") {
        this.state.room.status = "paused";
        this.state.room.pausedAt = payload.pausedAt || Date.now();
        this.state.chairPending = false;
        this.state.chairPendingPhase = "";
      } else if (kind === "room-resumed") {
        this.state.room.status = "live";
        this.state.room.pausedAt = null;
      } else if (kind === "room-adjourned") {
        this.state.room.status = "adjourned";
        this.state.room.adjournedAt = payload.adjournedAt || Date.now();
      } else if (kind === "settings-changed") {
        const ch = payload.changes || {};
        Object.keys(ch).forEach((key) => { this.state.room[key] = ch[key].to; });
      } else if (kind === "members-changed") {
        const removed = Array.isArray(payload.removed) ? payload.removed : [];
        removed.forEach((id) => { delete this.state.membersById[id]; });
      } else if (kind === "round-ended") {
        this.state.room.awaitingContinue = true;
        this.state.awaitingContinue = true;
        this.state.pendingVoteMessageId = payload.messageId || null;
        this.state.modeShiftProposal = payload.modeShiftProposal || null;
      } else if (kind === "round-resumed") {
        this.state.room.awaitingContinue = false;
        this.state.awaitingContinue = false;
        this.state.pendingVoteMessageId = null;
        this.state.modeShiftProposal = null;
      } else if (kind === "clarify-ready") {
        this.state.room.awaitingClarify = false;
        this.state.awaitingClarify = false;
        this.state.chairPending = false;
        this.state.chairPendingPhase = "";
      } else if (kind === "chair-pending") {
        this.state.chairPending = true;
        this.state.chairPendingPhase = payload.phase || "";
      } else if (kind === "member-added" && payload.agent) {
        this.state.membersById[payload.agent.id] = payload.agent;
      }
      this.state.awaitingClarify = !!this.state.room.awaitingClarify;
      this.state.awaitingContinue = !!this.state.room.awaitingContinue;
    }
  }

  class SendController {
    constructor(options) {
      this.api = (options && options.api) || createApiClient();
      this.requireModelKey = (options && options.requireModelKey) || (async () => true);
      this.onFollowUp = (options && options.onFollowUp) || function () {};
      this.sendInFlight = false;
      this.lastSendAt = 0;
      this.pendingUserMessage = null;
    }

    async submit(args) {
      const text = String((args && args.body) || "").trim();
      if (!text || !(args && args.roomId)) return { consumed: false };
      if (this.sendInFlight) return { consumed: false, throttled: true };
      const now = Date.now();
      if (now - this.lastSendAt < SEND_THROTTLE_MS) return { consumed: false, throttled: true };
      if (args.roomStatus === "paused") {
        this.lastSendAt = now;
        await this.api.sendPausedInput(args.roomId, { body: text });
        return { consumed: true, pausedInput: true };
      }
      if (args.roomStatus === "adjourned") {
        this.lastSendAt = now;
        this.onFollowUp({ subject: text, roomId: args.roomId });
        return { consumed: true, followUp: true };
      }
      if (!(await this.requireModelKey())) return { consumed: false, missingKey: true };
      this.lastSendAt = now;
      this.sendInFlight = true;
      try {
        await this.api.sendMessage(args.roomId, {
          body: text,
          mentions: args.mentions || [],
          mode: args.mode === "after-speaker" ? "after-speaker" : undefined,
        });
        if (args.mode === "after-speaker") this.pendingUserMessage = text;
        return { consumed: true };
      } finally {
        this.sendInFlight = false;
      }
    }
  }

  class RoomActionController {
    constructor(options) {
      this.api = (options && options.api) || createApiClient();
      this.onPausePending = (options && options.onPausePending) || function () {};
      this.onPauseSettled = (options && options.onPauseSettled) || function () {};
      this.onResumeSettled = (options && options.onResumeSettled) || function () {};
      this.onContinueSettled = (options && options.onContinueSettled) || function () {};
    }

    async pause(roomId, mode) {
      if (!roomId) return { ok: false, missingRoom: true };
      const pauseMode = mode === "soft" ? "soft" : "hard";
      if (pauseMode === "soft") this.onPausePending(true, { mode: pauseMode });
      try {
        const data = await this.api.pause(roomId, pauseMode);
        if (data && data.pending) {
          return { ok: true, pending: true, mode: pauseMode, room: data.room || null };
        }
        if (pauseMode === "soft") this.onPausePending(false, { mode: pauseMode });
        const room = (data && data.room) || null;
        this.onPauseSettled(room, { mode: pauseMode, data });
        return { ok: true, pending: false, mode: pauseMode, room };
      } catch (error) {
        if (pauseMode === "soft") this.onPausePending(false, { mode: pauseMode, error });
        if (isBenignPauseRace(error)) {
          return { ok: true, benignRace: true, pending: false, mode: pauseMode, room: null };
        }
        throw error;
      }
    }

    async resume(roomId) {
      if (!roomId) return { ok: false, missingRoom: true };
      const data = await this.api.resume(roomId);
      const room = (data && data.room) || null;
      this.onResumeSettled(room, { data });
      return { ok: true, room, data };
    }

    async continue(roomId) {
      if (!roomId) return { ok: false, missingRoom: true };
      try {
        const data = await this.api.continue(roomId);
        const room = (data && data.room) || null;
        this.onContinueSettled(room, { data });
        return { ok: true, room, data };
      } catch (error) {
        if (isBenignContinueRace(error)) return { ok: true, benignRace: true, room: null };
        throw error;
      }
    }

    async endRound(roomId, mode) {
      if (!roomId) return { ok: false, missingRoom: true };
      const resolvedMode = mode === "after-speaker" ? "after-speaker" : "now";
      const data = await this.api.endRound(roomId, resolvedMode);
      return {
        ok: true,
        mode: resolvedMode,
        deferred: !!(data && data.deferred),
        data,
      };
    }

    async setVoteTrigger(roomId, next) {
      if (!roomId) return { ok: false, missingRoom: true };
      const resolved = normalizeVoteTrigger(next);
      const data = await this.api.patchSettings(roomId, { voteTrigger: resolved });
      return { ok: true, next: resolved, room: (data && data.room) || null, data };
    }

    async toggleVoteTrigger(roomId, current) {
      return this.setVoteTrigger(roomId, nextVoteTrigger(current));
    }

    async setDeliveryMode(roomId, next, options) {
      if (!roomId) return { ok: false, missingRoom: true };
      const resolved = normalizeDeliveryMode(next);
      const ensureVoiceReady = options && options.ensureVoiceReady;
      if (resolved === "voice" && typeof ensureVoiceReady === "function") {
        const ready = await ensureVoiceReady();
        if (!ready) return { ok: false, blocked: "voice-unavailable", next: resolved };
      }
      const data = await this.api.patchSettings(roomId, { deliveryMode: resolved });
      return { ok: true, next: resolved, room: (data && data.room) || null, data };
    }

    async toggleDeliveryMode(roomId, current, options) {
      return this.setDeliveryMode(roomId, nextDeliveryMode(current), options);
    }

    async acceptModeShiftAndContinue(roomId, mode) {
      if (!roomId) return { ok: false, missingRoom: true };
      const resolvedMode = String(mode || "").trim();
      if (!resolvedMode) return { ok: false, missingMode: true };
      const settings = await this.api.patchSettings(roomId, { mode: resolvedMode });
      const continued = await this.continue(roomId);
      return { ok: true, mode: resolvedMode, settings, continued };
    }

    async voteKeyPoint(roomId, keyPointId, requested, prevVote) {
      if (!roomId) return { ok: false, missingRoom: true };
      if (!keyPointId) return { ok: false, missingKeyPoint: true };
      // Accept "up"/"down" (preferred) or a legacy numeric score (>0 → up, else down).
      let desired = requested;
      if (typeof requested === "number") desired = requested > 0 ? "up" : "down";
      if (desired !== "up" && desired !== "down") desired = null;
      // Toggle semantics match the PC controller: re-voting the same
      // direction clears the vote (sends null).
      const normalizedPrev = prevVote === "up" || prevVote === "down" ? prevVote : null;
      const vote = normalizedPrev !== null && normalizedPrev === desired ? null : desired;
      const data = await this.api.voteKeyPoint(roomId, keyPointId, vote);
      return { ok: true, keyPointId, vote, data };
    }

    async adjourn(roomId, args) {
      if (!roomId) return { ok: false, missingRoom: true };
      const data = await this.api.adjourn(roomId, args || {});
      return { ok: true, room: (data && data.room) || null, data };
    }

    async generateBrief(roomId, args) {
      if (!roomId) return { ok: false, missingRoom: true };
      const opts = args || {};
      let adjourned = null;
      if (opts.ensureAdjourned && opts.status !== "adjourned") {
        // Adjourn WITHOUT auto-generating a brief — the server auto-kicks a
        // brief on a bare /adjourn, which would collide with the explicit
        // generateBrief() below (double generation). Mirrors PC, which always
        // adjourns with { skipBrief: true } before a manual /brief.
        adjourned = await this.api.adjourn(roomId, { skipBrief: true });
      }
      const briefArgs = {};
      if (opts.supplement) briefArgs.supplement = opts.supplement;
      if (opts.mode) briefArgs.mode = opts.mode;
      const data = await this.api.generateBrief(roomId, briefArgs);
      return {
        ok: true,
        briefId: data && data.briefId,
        adjourned,
        data,
      };
    }

    async patchMembers(roomId, agentIds) {
      if (!roomId) return { ok: false, missingRoom: true };
      const ids = Array.isArray(agentIds) ? agentIds.slice() : [];
      const data = await this.api.patchMembers(roomId, ids);
      return {
        ok: true,
        members: (data && data.members) || [],
        room: (data && data.room) || null,
        data,
      };
    }
  }

  class VoicePlaybackController {
    constructor(options) {
      this.api = (options && options.api) || createApiClient();
      this.audio = options && options.audio;
      this.onPlaying = (options && options.onPlaying) || function () {};
      this.onDone = (options && options.onDone) || function () {};
      this.onError = (options && options.onError) || function () {};
      this.onTimeUpdate = (options && options.onTimeUpdate) || function () {};
      this.useMediaSource = !!(options && options.useMediaSource);
      this.playOnFirstChunk = !!(options && options.playOnFirstChunk);
      this.queues = {};
      this.queue = [];
      this.playing = null;
      this.unlocked = false;
      this.seenSeqs = {};
    }

    setAudio(audio) {
      this.audio = audio;
    }

    setUnlocked(value) {
      this.unlocked = !!value;
    }

    stop() {
      this.queue.length = 0;
      this.playing = null;
      Object.keys(this.queues).forEach((id) => { delete this.queues[id]; });
      this.seenSeqs = {};
      if (this.audio) {
        try { this.audio.pause(); } catch (_) {}
        try { delete this.audio.dataset.messageId; delete this.audio.dataset.authorId; } catch (_) {}
        try { this.audio.removeAttribute("src"); this.audio.load && this.audio.load(); } catch (_) {}
      }
    }

    pause() {
      if (!this.audio) return;
      try { this.audio.pause(); } catch (_) {}
    }

    enqueueChunk(payload) {
      if (!payload || !payload.messageId || !payload.audioBase64) return null;
      if (typeof payload.seq === "number") {
        let seen = this.seenSeqs[payload.messageId];
        if (!seen) seen = this.seenSeqs[payload.messageId] = {};
        if (seen[payload.seq]) return null;
        seen[payload.seq] = true;
      }
      const q = this._ensure(payload);
      const fresh = !q.parts.length;
      q.parts.push(payload.audioBase64);
      const buffer = base64ToBytes(payload.audioBase64);
      q.buffers.push(buffer);
      if (q.pendingBuffers && buffer.length) {
        q.pendingBuffers.push(buffer);
        this._flushMediaSource(q);
      }
      q.mime = payload.mimeType || q.mime || "audio/mpeg";
      q.authorId = payload.authorId || q.authorId || null;
      q.body = payload.body || q.body || "";
      const bytes = base64ByteLength(payload.audioBase64);
      q.captions.push({
        text: typeof payload.text === "string" ? payload.text : "",
        bytes,
        endTime: null,
      });
      q.totalCaptionBytes += bytes;
      if (fresh && this.playOnFirstChunk && this.useMediaSource && !q.enqueued) {
        q.enqueued = true;
        q.playState = "queued";
        this.queue.push(q);
        this.pump();
      }
      return q;
    }

    markFinal(payload) {
      if (!payload || !payload.messageId) return;
      const q = this._ensure(payload);
      q.final = true;
      q.authorId = payload.authorId || q.authorId || null;
      q.body = payload.body || q.body || "";
      this._flushMediaSource(q);
      if (!q.enqueued) {
        q.enqueued = true;
        q.playState = "queued";
        this.queue.push(q);
      }
      this.pump();
    }

    has(messageId) {
      return !!(messageId && this.queues[messageId]);
    }

    drop(messageId) {
      if (!messageId) return;
      const wasPlaying = this.playing && this.playing.messageId === messageId;
      this.queue = this.queue.filter((q) => q && q.messageId !== messageId);
      delete this.queues[messageId];
      if (this.seenSeqs) delete this.seenSeqs[messageId];
      if (wasPlaying) {
        this.playing = null;
        if (this.audio) {
          try { this.audio.pause(); } catch (_) {}
          try { delete this.audio.dataset.messageId; delete this.audio.dataset.authorId; } catch (_) {}
          try { this.audio.removeAttribute("src"); this.audio.load && this.audio.load(); } catch (_) {}
        }
        this.pump();
      }
    }

    _ensure(payload) {
      let q = this.queues[payload.messageId];
      if (!q) {
        q = {
          roomId: payload.roomId,
          messageId: payload.messageId,
          authorId: payload.authorId || null,
          body: payload.body || "",
          mime: payload.mimeType || "audio/mpeg",
          parts: [],
          buffers: [],
          captions: [],
          totalCaptionBytes: 0,
          final: false,
          enqueued: false,
          doneSent: false,
          playState: "idle",
          lastHeartbeatAt: 0,
        };
        this.queues[payload.messageId] = q;
      } else {
        q.roomId = payload.roomId || q.roomId;
        q.authorId = payload.authorId || q.authorId;
        q.body = payload.body || q.body || "";
      }
      return q;
    }

    pump() {
      if (!this.unlocked || !this.audio || this.playing) return;
      const next = this.queue[0];
      const canStartStreaming = !!(this.playOnFirstChunk && this.useMediaSource && next && next.parts && next.parts.length);
      if (!next || (!next.final && !canStartStreaming)) return;
      this.queue.shift();
      this.playing = next;
      next.playState = "playing";
      const audio = this.audio;
      next.audio = audio;
      audio.onplaying = () => {
        this.onPlaying(next);
        this._heartbeat(next);
        this._emitTimeUpdate(next);
      };
      audio.ontimeupdate = () => {
        this._heartbeat(next);
        this._emitTimeUpdate(next);
      };
      audio.onended = () => this._done(next);
      audio.onerror = () => {
        this.onError(next);
        this._done(next);
      };
      if (next.parts.length) {
        if (!this._startMediaSource(next, audio)) {
          audio.src = "data:" + (next.mime || "audio/mpeg") + ";base64," + next.parts.join("");
        }
      } else {
        audio.src = "/api/voices/message/" + encode(next.messageId) + "/audio?ts=" + Date.now();
      }
      try {
        audio.dataset.messageId = next.messageId || "";
        audio.dataset.authorId = next.authorId || "";
      } catch (_) {}
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          this.onError(next, err);
          this.playing = null;
        });
      }
    }

    _startMediaSource(q, audio) {
      const MediaSourceCtor = global.MediaSource || global.WebKitMediaSource;
      const URLApi = global.URL || global.webkitURL;
      if (!this.useMediaSource || !MediaSourceCtor || !URLApi || !q || !q.buffers || !q.buffers.length) {
        return false;
      }
      const mime = q.mime || "audio/mpeg";
      if (typeof MediaSourceCtor.isTypeSupported === "function" && !MediaSourceCtor.isTypeSupported(mime)) {
        return false;
      }
      try {
        const mediaSource = new MediaSourceCtor();
        q.mediaSource = mediaSource;
        q.pendingBuffers = q.buffers.slice();
        q.flushingIdx = -1;
        q.objectUrl = URLApi.createObjectURL(mediaSource);
        audio.src = q.objectUrl;
        mediaSource.addEventListener("sourceopen", () => {
          try {
            q.sourceBuffer = mediaSource.addSourceBuffer(mime);
            q.sourceBuffer.addEventListener("updateend", () => {
              try {
                if (q.captions && q.flushingIdx >= 0 && q.captions[q.flushingIdx] && q.sourceBuffer.buffered.length > 0) {
                  q.captions[q.flushingIdx].endTime = q.sourceBuffer.buffered.end(q.sourceBuffer.buffered.length - 1);
                }
              } catch (_) {}
              this._flushMediaSource(q);
            });
            this._flushMediaSource(q);
          } catch (err) {
            this.onError(q, err);
          }
        });
        return true;
      } catch (err) {
        this.onError(q, err);
        return false;
      }
    }

    _flushMediaSource(q) {
      if (!q || !q.sourceBuffer || q.sourceBuffer.updating) return;
      if (q.pendingBuffers && q.pendingBuffers.length) {
        const buf = q.pendingBuffers.shift();
        q.flushingIdx = Number.isFinite(q.flushingIdx) ? q.flushingIdx + 1 : 0;
        try {
          q.sourceBuffer.appendBuffer(buf);
        } catch (err) {
          this.onError(q, err);
        }
        return;
      }
      if (q.final && q.mediaSource && q.mediaSource.readyState === "open") {
        try { q.mediaSource.endOfStream(); } catch (_) {}
      }
    }

    _heartbeat(q) {
      if (!q || !q.roomId || !q.messageId) return;
      const now = Date.now();
      if (q.lastHeartbeatAt && now - q.lastHeartbeatAt < VOICE_HEARTBEAT_MS) return;
      q.lastHeartbeatAt = now;
      this.api.postVoiceProgress(q.roomId, q.messageId).catch(() => {});
    }

    currentCaption(q) {
      const captions = (q && q.captions) || [];
      if (!captions.length) return pickVisibleCaptionText((q && q.body) || "", { audio: this.audio });
      const firstText = (captions.find((cap) => cap && cap.text) || {}).text || "";
      const audio = this.audio;
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0
        || !Number.isFinite(audio.currentTime) || !q.totalCaptionBytes) {
        return firstText;
      }
      const timed = captions.some((cap) => cap && Number.isFinite(cap.endTime));
      if (timed) {
        let lastText = firstText;
        for (const cap of captions) {
          if (cap && cap.text) lastText = cap.text;
          if (cap && Number.isFinite(cap.endTime) && audio.currentTime < cap.endTime) {
            return cap.text || lastText || firstText;
          }
        }
        return lastText || firstText;
      }
      const ratio = Math.max(0, Math.min(1, audio.currentTime / audio.duration));
      const targetBytes = q.totalCaptionBytes * ratio;
      let seenText = "";
      let bytes = 0;
      for (const cap of captions) {
        bytes += cap && cap.bytes ? cap.bytes : 0;
        if (cap && cap.text) seenText = cap.text;
        if (bytes >= targetBytes) return seenText || firstText;
      }
      return seenText || firstText;
    }

    _emitTimeUpdate(q) {
      this.onTimeUpdate(q, this.currentCaption(q));
    }

    _done(q) {
      if (!q || q.doneSent) return;
      q.doneSent = true;
      this.api.postVoiceDone(q.roomId, q.messageId).catch(() => {});
      q.playState = "ended";
      delete this.queues[q.messageId];
      if (this.seenSeqs) delete this.seenSeqs[q.messageId];
      if (q.objectUrl && (global.URL || global.webkitURL)) {
        try { (global.URL || global.webkitURL).revokeObjectURL(q.objectUrl); } catch (_) {}
      }
      this.playing = null;
      this.onDone(q);
      this.pump();
    }
  }

  global.RoomMeetingRuntime = {
    SEND_THROTTLE_MS,
    cleanCaptionText,
    captionSentences,
    pickVisibleCaptionText,
    compactCaptionText,
    deriveRoomActionState,
    extractRoomVoteItems,
    nextVoteTrigger,
    nextDeliveryMode,
    shouldPreserveChairPendingForMessage,
    shouldClearChairPendingOnMessage,
    isBenignPauseRace,
    isBenignContinueRace,
    createApiClient,
    MeetingController,
    SendController,
    RoomActionController,
    VoicePlaybackController,
  };
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
