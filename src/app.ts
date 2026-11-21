import express, { type Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_UID, buildJoinPayload, rtcToken, startAgent, stopAgent } from "./agora/convoai.js";
import { missingFor, type AppConfig } from "./config.js";
import { summarise } from "./domain/case.js";
import { llmProxyHandler } from "./llm-proxy.js";
import type { FetchLike } from "./services/geo.js";
import type { SessionStore } from "./session.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AppDeps {
  config: AppConfig;
  store: SessionStore;
  fetchFn?: FetchLike; // used for Agora REST calls (mocked in tests)
}

export function createApp({ config, store, fetchFn = fetch }: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(root, "public")));
  app.use("/vendor/agora", express.static(path.join(root, "node_modules/agora-rtc-sdk-ng")));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      voiceReady: missingFor(config, "voice").length === 0,
      missing: { voice: missingFor(config, "voice"), llm: missingFor(config, "llm"), email: missingFor(config, "email") },
      emailMode: config.email.mode,
      model: config.claude.model,
    });
  });

  // Create a session (text mode works without Agora).
  app.post("/api/sessions", async (_req, res) => {
    const s = await store.create();
    res.json({ sessionId: s.id, caseId: s.caseFile.caseId });
  });

  // Start the Agora voice agent for a session.
  app.post("/api/sessions/:id/voice/start", async (req, res) => {
    const missing = missingFor(config, "voice");
    if (missing.length) {
      res.status(412).json({ error: `Missing config: ${missing.join(", ")}` });
      return;
    }
    const s = store.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const channel = `sarva-${s.id}`;
    const userUid = 1000 + Math.floor(Math.random() * 8000) + 2; // never equals AGENT_UID
    try {
      const payload = buildJoinPayload(config, { sessionId: s.id, channel, userUid, token: rtcToken(config, channel, Number(AGENT_UID)) });
      const { agentId } = await startAgent(config, payload, fetchFn);
      s.agentId = agentId;
      s.channel = channel;
      s.events.emit({ type: "status", message: "Voice agent joined the channel" });
      res.json({ appId: config.agora.appId, channel, uid: userUid, token: rtcToken(config, channel, userUid) || null, agentId });
    } catch (e) {
      s.events.emit({ type: "error", message: (e as Error).message });
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.post("/api/sessions/:id/voice/stop", async (req, res) => {
    const s = store.get(req.params.id);
    if (s?.agentId) {
      await stopAgent(config, s.agentId, fetchFn).catch((e) => s.events.emit({ type: "error", message: (e as Error).message }));
      s.agentId = undefined;
      s.events.emit({ type: "status", message: "Voice agent left" });
    }
    res.json({ ok: true });
  });

  // Text fallback (also used by the CLI): same agent, no voice minutes spent.
  app.post("/api/sessions/:id/text", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "text required" });
      return;
    }
    const s = await store.getOrCreate(req.params.id);
    const r = await s.say(text);
    res.json(r);
  });

  app.get("/api/sessions/:id/case", (req, res) => {
    const s = store.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.json(summarise(s.caseFile));
  });

  // Live activity feed (Server-Sent Events) with replay.
  app.get("/api/sessions/:id/events", (req, res) => {
    const s = store.get(req.params.id);
    if (!s) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    s.events.history().forEach(send);
    const unsubscribe = s.events.subscribe(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // Agora Conversational AI → our agent (OpenAI-compatible).
  app.post(
    "/llm/:sessionId/chat/completions",
    llmProxyHandler(config.llmProxySecret, async (sessionId, text, onText) => {
      const s = await store.getOrCreate(sessionId);
      return s.say(text, onText);
    }),
  );

  return app;
}
