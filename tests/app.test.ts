import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/agent/orchestrator.js";
import { AGENT_UID, basicAuth, buildJoinPayload, rtcToken } from "../src/agora/convoai.js";
import { createApp } from "../src/app.js";
import { loadConfig, missingFor } from "../src/config.js";
import { authorised, lastUserText } from "../src/llm-proxy.js";
import { DryRunEmailSender } from "../src/services/email.js";
import { GeoService } from "../src/services/geo.js";
import { SessionStore } from "../src/session.js";
import { FakeLlm, FIXED_NOW, testConfig } from "./helpers.js";

function makeApp(script: ConstructorParameters<typeof FakeLlm>[0], env: Record<string, string> = {}, fetchFn?: any) {
  const config = testConfig(env);
  const store = new SessionStore({
    orchestrator: new Orchestrator(new FakeLlm(script)),
    geo: new GeoService(async () => {
      throw new Error("offline");
    }, "offline"),
    email: new DryRunEmailSender(),
    userEmail: "demo@example.com",
    bankOutages: ["SBI"],
    now: () => FIXED_NOW,
  });
  return { app: createApp({ config, store, fetchFn }), store, config };
}

const parseSse = (raw: string) =>
  raw
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data: "))
    .map((b) => b.slice(6));

describe("config", () => {
  it("parses env with sane defaults", () => {
    const c = loadConfig({ SCENARIO_BANK_OUTAGE: "sbi, hdfc", PUBLIC_BASE_URL: "https://x.y/", CLAUDE_EFFORT: "bogus" });
    expect(c.bankOutages).toEqual(["SBI", "HDFC"]);
    expect(c.publicBaseUrl).toBe("https://x.y");
    expect(c.claude).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
    expect(c.email.mode).toBe("dry-run");
    expect(missingFor(c, "voice")).toEqual(expect.arrayContaining(["AGORA_APP_ID", "MURF_API_KEY"]));
    expect(missingFor(testConfig(), "voice")).toEqual([]);
  });
});

describe("llm proxy helpers", () => {
  it("extracts the last user text from OpenAI messages", () => {
    expect(lastUserText([{ role: "system", content: "s" }, { role: "user", content: " hi " }, { role: "assistant", content: "yo" }])).toBe("hi");
    expect(lastUserText([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }])).toBe("a b");
    expect(lastUserText([{ role: "assistant", content: "x" }])).toBeNull();
    expect(lastUserText(undefined)).toBeNull();
  });

  it("checks the bearer secret in constant time", () => {
    expect(authorised("Bearer s3cret", "s3cret")).toBe(true);
    expect(authorised("Bearer nope", "s3cret")).toBe(false);
    expect(authorised(undefined, "s3cret")).toBe(false);
    expect(authorised(undefined, "")).toBe(true);
  });
});

describe("POST /llm/:session/chat/completions (Agora custom LLM)", () => {
  it("rejects requests without the secret", async () => {
    const { app } = makeApp([]);
    const r = await request(app).post("/llm/s1/chat/completions").send({ messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(401);
  });

  it("streams OpenAI-style SSE chunks ending with [DONE]", async () => {
    const { app, store } = makeApp([{ tools: [{ name: "list_cards", input: {} }] }, { text: "You have two cards." }]);
    const r = await request(app)
      .post("/llm/s1/chat/completions")
      .set("Authorization", "Bearer s3cret")
      .send({ model: "sarva-rakshak", stream: true, messages: [{ role: "system", content: "ignored" }, { role: "user", content: "what cards?" }] })
      .buffer(true)
      .parse((res, cb) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => cb(null, d));
      });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseSse(r.body as string);
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    expect(text).toBe("On it. You have two cards.");
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    expect(store.get("s1")).toBeDefined(); // lazily created
  });

  it("supports non-streaming responses", async () => {
    const { app } = makeApp([{ text: "Hello." }]);
    const r = await request(app)
      .post("/llm/s2/chat/completions")
      .set("Authorization", "Bearer s3cret")
      .send({ stream: false, messages: [{ role: "user", content: "hi" }] });
    expect(r.body.choices[0].message).toEqual({ role: "assistant", content: "Hello." });
  });

  it("400s when there is no user message", async () => {
    const { app } = makeApp([]);
    const r = await request(app).post("/llm/s3/chat/completions").set("Authorization", "Bearer s3cret").send({ messages: [] });
    expect(r.status).toBe(400);
  });
});

describe("session + text API", () => {
  it("creates a session, runs a text turn and exposes the case summary", async () => {
    const { app } = makeApp([{ tools: [{ name: "freeze_card", input: { card_id: "4821" } }] }, { text: "Frozen." }]);
    const s = await request(app).post("/api/sessions").send({});
    expect(s.body.sessionId).toBeTruthy();
    const t = await request(app).post(`/api/sessions/${s.body.sessionId}/text`).send({ text: "freeze my hdfc card" });
    expect(t.body).toMatchObject({ text: "On it. Frozen.", toolCalls: 1 });
    const c = await request(app).get(`/api/sessions/${s.body.sessionId}/case`);
    expect(c.body.cards[0]).toMatch(/HDFC ••4821: frozen via api/);
    expect((await request(app).post(`/api/sessions/${s.body.sessionId}/text`).send({})).status).toBe(400);
  });

  it("health reports what is missing", async () => {
    const { app } = makeApp([], { MURF_API_KEY: "" });
    const r = await request(app).get("/api/health");
    expect(r.body.voiceReady).toBe(false);
    expect(r.body.missing.voice).toEqual(["MURF_API_KEY"]);
  });

  it("serves the UI and the Agora web SDK", async () => {
    const { app } = makeApp([]);
    expect((await request(app).get("/")).text).toContain("Sarva Rakshak");
    const sdk = await request(app).get("/vendor/agora/AgoraRTC_N-production.js");
    expect(sdk.status).toBe(200);
  });
});

describe("Agora Conversational AI integration (mocked REST)", () => {
  it("builds a join payload wiring ASR → custom LLM → Murf Falcon", () => {
    const cfg = testConfig();
    const p = buildJoinPayload(cfg, { sessionId: "abc", channel: "sarva-abc", userUid: 2345, token: "" });
    expect(p.properties).toMatchObject({ channel: "sarva-abc", agent_rtc_uid: AGENT_UID, remote_rtc_uids: ["2345"] });
    expect(p.properties.llm).toMatchObject({
      vendor: "custom",
      style: "openai",
      url: "https://demo.trycloudflare.com/llm/abc/chat/completions",
      api_key: "s3cret",
    });
    expect(p.properties.tts).toMatchObject({ vendor: "murf", params: { api_key: "murf-key", model: "FALCON", voiceId: "en-IN-isha" } });
    expect(p.properties.asr.vendor).toBe("ares");
  });

  it("uses Basic auth with the customer key/secret, and tokens only when a certificate exists", () => {
    const cfg = testConfig();
    expect(basicAuth(cfg)).toBe("Basic " + Buffer.from("ck:cs").toString("base64"));
    expect(rtcToken(cfg, "ch", 1)).toBe("");
    const withCert = testConfig({ AGORA_APP_CERTIFICATE: "0123456789abcdef0123456789abcdef", AGORA_APP_ID: "0123456789abcdef0123456789abcdef" });
    expect(rtcToken(withCert, "ch", 1).length).toBeGreaterThan(50);
  });

  it("starts and stops the agent through the REST API", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith("/join") ? new Response(JSON.stringify({ agent_id: "agent-9", status: "RUNNING" })) : new Response("{}"),
    );
    const { app } = makeApp([], {}, fetchFn);
    const s = await request(app).post("/api/sessions").send({});
    const start = await request(app).post(`/api/sessions/${s.body.sessionId}/voice/start`).send({});
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ appId: "appid123", agentId: "agent-9", token: null, channel: `sarva-${s.body.sessionId}` });
    expect(start.body.uid).not.toBe(Number(AGENT_UID));
    const [joinUrl, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(joinUrl).toBe("https://api.agora.io/api/conversational-ai-agent/v2/projects/appid123/join");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    await request(app).post(`/api/sessions/${s.body.sessionId}/voice/stop`).send({});
    expect(fetchFn.mock.calls[1][0]).toBe("https://api.agora.io/api/conversational-ai-agent/v2/projects/appid123/agents/agent-9/leave");
  });

  it("returns 412 when voice config is missing and 502 when Agora rejects", async () => {
    const { app } = makeApp([], { PUBLIC_BASE_URL: "" });
    const s = await request(app).post("/api/sessions").send({});
    expect((await request(app).post(`/api/sessions/${s.body.sessionId}/voice/start`).send({})).status).toBe(412);

    const bad = makeApp([], {}, async () => new Response(JSON.stringify({ message: "invalid vendor" }), { status: 400 }));
    const s2 = await request(bad.app).post("/api/sessions").send({});
    const r = await request(bad.app).post(`/api/sessions/${s2.body.sessionId}/voice/start`).send({});
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/invalid vendor/);
  });
});
