import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { redactSensitive } from "../src/agent/guardrails.js";
import { Orchestrator } from "../src/agent/orchestrator.js";
import { createApp } from "../src/app.js";
import { defaultProfile, normaliseProfile, ProfileStore } from "../src/domain/profile.js";
import { BankSimulator, CallRequiredError } from "../src/services/bank.js";
import { DryRunEmailSender } from "../src/services/email.js";
import { GeoService } from "../src/services/geo.js";
import { Session, SessionStore } from "../src/session.js";
import { FakeLlm, FIXED_NOW, makeHub, parse, testConfig } from "./helpers.js";

describe("input guardrails", () => {
  it("redacts Luhn-valid card numbers, Aadhaar-like 12 digits and OTP/PIN/CVV", () => {
    const r = redactSensitive("my card is 4111 1111 1111 1111, aadhaar 1234 5678 9012, OTP is 482913 and cvv: 123");
    expect(r.text).not.toMatch(/4111|5678 9012|482913|123\b/);
    expect(r.text).toContain("[REDACTED CARD NUMBER]");
    expect(r.text).toContain("[REDACTED ID NUMBER]");
    expect(r.redactions.map((x) => x.kind).sort()).toEqual(["aadhaar", "card_number", "otp_pin_cvv", "otp_pin_cvv"]);
    expect(r.redactions.find((x) => x.kind === "card_number")!.sample).toBe("••••••••••••1111");
  });

  it("leaves normal speech, amounts and last-4 digits alone", () => {
    const t = "the card ending 4821 was charged 4999 rupees at 3 pm, call 1800 1234";
    expect(redactSensitive(t)).toEqual({ text: t, redactions: [] });
  });

  it("the orchestrator never sends redacted data to the LLM and emits a guardrail event", async () => {
    const h = await makeHub();
    const llm = new FakeLlm([{ text: "Please never share that." }]);
    await new Orchestrator(llm).runTurn({ history: [], system: "s", hub: h.hub, gate: h.gate, events: h.events }, "my full card number is 4111111111111111");
    const sent = JSON.stringify(llm.requests[0].messages);
    expect(sent).not.toContain("4111111111111111");
    expect(sent).toContain("Guardrail notice");
    expect(h.seen.find((e) => e.type === "guardrail")).toMatchObject({ kinds: ["card_number"] });
    expect(h.seen.find((e) => e.type === "user_said")).toMatchObject({ text: "my full card number is [REDACTED CARD NUMBER]" });
    await h.hub.close();
  });

  it("never exposes an unfreeze tool", async () => {
    const { hub } = await makeHub();
    expect(hub.tools().some((t) => /unfreeze|unblock|activate/.test(t.name))).toBe(false);
    await hub.close();
  });
});

describe("profiles", () => {
  it("default profile is Koushik with three cards including a call-only card", () => {
    const p = defaultProfile("k@example.com");
    expect(p.name).toBe("Koushik");
    expect(p.cards.map((c) => c.last4)).toEqual(["4821", "1093", "7710"]);
    expect(p.cards[2].channels).toEqual(["call"]);
  });

  it("fills missing card ids, rejects duplicates and bad last-4", () => {
    const base = defaultProfile();
    const p = normaliseProfile({ ...base, cards: [...base.cards, { bank: "AXIS", kind: "debit", network: "Visa", last4: "5555" }] });
    expect(p.cards.at(-1)!.id).toBe("axis-dc-5555");
    expect(() => normaliseProfile({ ...base, cards: [base.cards[0], base.cards[0]] })).toThrow(/Duplicate/);
    expect(() => normaliseProfile({ ...base, cards: [{ ...base.cards[0], last4: "4111111111111111" }] })).toThrow();
  });

  it("persists to disk and survives a reload", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sarva-")), "profile.json");
    const store = new ProfileStore(file);
    store.save({ ...defaultProfile(), name: "Koushik V" });
    expect(new ProfileStore(file).get().name).toBe("Koushik V");
  });
});

describe("cards: call-only banks, replacements, card watch", () => {
  it("call-only cards raise CallRequiredError and provide helpline + script", () => {
    const b = new BankSimulator({ now: () => FIXED_NOW });
    expect(() => b.freezeCard("7710")).toThrow(CallRequiredError);
    const o = b.blockOptions("7710");
    expect(o).toMatchObject({ bank: "ICICI Bank", channels: ["call"], helpline: "1800 1080", tel: "tel:18001080" });
    expect(o.callScript).toContain("7 7 1 0");
  });

  it("freeze on a call-only card → CALL_REQUIRED + action needed; record_manual_block completes it", async () => {
    const { hub, ctx } = await makeHub();
    const r = parse((await hub.execute("freeze_card", { card_id: "7710" }, "f")).content);
    expect(r).toMatchObject({ error: "CALL_REQUIRED", helpline: "1800 1080", tel: "tel:18001080" });
    expect(ctx.caseFile.actionsNeeded).toEqual([expect.objectContaining({ id: "call-icici-cc-7710", done: false, tel: "tel:18001080" })]);
    const m = parse((await hub.execute("record_manual_block", { card_id: "7710", method: "call", reference: "ICI-77812" }, "m")).content);
    expect(m.status).toBe("blocked");
    expect(ctx.caseFile.actionsNeeded[0].done).toBe(true);
    expect(ctx.caseFile.cardActions.at(-1)).toMatchObject({ method: "call", reference: "ICI-77812" });
    await hub.close();
  });

  it("replacement needs approval and a blocked card", async () => {
    const { hub, gate, ctx } = await makeHub();
    gate.userTurn();
    const { approval_id } = parse((await hub.execute("request_user_approval", { action: "request_replacement_card", summary: "Replace HDFC 4821" }, "a")).content);
    gate.userTurn();
    const early = parse((await hub.execute("request_replacement_card", { card_id: "4821", approval_id }, "r0")).content);
    expect(early.error).toBe("REPLACEMENT_REJECTED"); // still active
    await hub.execute("freeze_card", { card_id: "4821" }, "f");
    gate.userTurn();
    const { approval_id: a2 } = parse((await hub.execute("request_user_approval", { action: "request_replacement_card", summary: "Replace" }, "a2")).content);
    gate.userTurn();
    const ok = parse((await hub.execute("request_replacement_card", { card_id: "4821", approval_id: a2 }, "r1")).content);
    expect(ok).toMatchObject({ bank: "HDFC Bank", last4: "4821", deliverTo: "registered address", expectedBy: "2026-11-28" });
    expect(ctx.caseFile.replacements).toHaveLength(1);
    await hub.close();
  });

  it("card watch: attempts on frozen cards are declined (and can't be disputed); active cards are flagged", async () => {
    const b = new BankSimulator({ now: () => FIXED_NOW });
    b.freezeCard("4821");
    const declined = b.simulateAttempt({ cardId: "4821" });
    expect(declined).toMatchObject({ status: "declined", declineReason: "card frozen", suspicious: true });
    expect(() => b.raiseDispute(declined.id, "x")).toThrow(/declined/);
    const through = b.simulateAttempt({ cardId: "1093", amountInr: 2000 });
    expect(through).toMatchObject({ status: "approved", suspicious: true, amountInr: 2000 });
  });

  it("session card watch queues an alert for the agent, emits events, and announces into the live call", async () => {
    const llm = new FakeLlm([{ text: "That attempt was blocked." }]);
    const s = await Session.create("w1", {
      orchestrator: new Orchestrator(llm),
      geo: new GeoService(async () => new Response("x"), "offline"),
      email: new DryRunEmailSender(),
      profile: () => defaultProfile("k@example.com"),
      bankOutages: [],
      now: () => FIXED_NOW,
    });
    s.bank.freezeCard("4821");
    s.agentId = "agent-1";
    const announce = vi.fn(async (_s: unknown, _t: string) => true);
    const r = await s.cardWatchEvent({ cardId: "4821" }, announce);
    expect(r).toMatchObject({ outcome: "declined", spoken: true });
    expect(announce.mock.calls[0][1]).toMatch(/declined because the card is already blocked/);
    expect(s.caseFile.cardAlerts).toHaveLength(1);
    expect(s.events.history().some((e) => e.type === "card_alert")).toBe(true);
    await s.say("what happened?");
    expect(JSON.stringify(llm.requests[0].messages)).toContain("[Card watch alert");
    expect(s.system).toContain("Koushik");
    expect(s.system).toContain("can block via call");
    await s.close();
  });
});

describe("settings API, card simulator endpoint and tunnel guard", () => {
  function app(fetchFn?: any) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sarva-")), "profile.json");
    const profiles = new ProfileStore(file, "k@example.com");
    const store = new SessionStore({
      orchestrator: new Orchestrator(new FakeLlm([])),
      geo: new GeoService(async () => new Response("x"), "offline"),
      email: new DryRunEmailSender(),
      profile: () => profiles.get(),
      bankOutages: [],
      now: () => FIXED_NOW,
    });
    return createApp({ config: testConfig(), store, profiles, fetchFn });
  }

  it("reads and updates the profile; new sessions use it", async () => {
    const a = app();
    const g = await request(a).get("/api/profile");
    expect(g.body.profile.name).toBe("Koushik");
    expect(g.body.banks.map((b: any) => b.code)).toContain("ICICI");
    const updated = { ...g.body.profile, name: "Koushik V", cards: [...g.body.profile.cards, { bank: "KOTAK", kind: "debit", network: "Visa", last4: "2468" }] };
    const p = await request(a).put("/api/profile").send(updated);
    expect(p.status).toBe(200);
    const s = await request(a).post("/api/sessions").send({});
    expect(s.body.user).toBe("Koushik V");
    expect(s.body.cards.map((c: any) => c.last4)).toContain("2468");
    const bad = await request(a).put("/api/profile").send({ ...updated, cards: [{ bank: "HDFC", kind: "debit", last4: "12" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/last 4/);
  });

  it("simulates a charge and reports card status", async () => {
    const a = app();
    const s = await request(a).post("/api/sessions").send({});
    const r = await request(a).post(`/api/sessions/${s.body.sessionId}/simulate/charge`).send({ cardId: "1093" });
    expect(r.body).toMatchObject({ outcome: "approved", spoken: false });
    const cards = await request(a).get(`/api/sessions/${s.body.sessionId}/cards`);
    expect(cards.body.cards).toHaveLength(3);
  });

  it("blocks everything except /llm when the request comes through the Cloudflare tunnel", async () => {
    const a = app();
    expect((await request(a).get("/api/profile").set("cf-connecting-ip", "1.2.3.4")).status).toBe(403);
    expect((await request(a).get("/").set("cf-ray", "abc")).status).toBe(403);
    const llm = await request(a).post("/llm/x/chat/completions").set("cf-ray", "abc").send({ messages: [] });
    expect(llm.status).toBe(401); // reached the endpoint; rejected by the bearer check, not the tunnel guard
  });
});
