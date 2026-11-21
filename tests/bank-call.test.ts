import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/agent/orchestrator.js";
import { defaultProfile } from "../src/domain/profile.js";
import { BankSimulator } from "../src/services/bank.js";
import { BankCallSimulator, looksLikeDob, type BankCall } from "../src/services/bank-call.js";
import { DryRunEmailSender } from "../src/services/email.js";
import { GeoService } from "../src/services/geo.js";
import { Session } from "../src/session.js";
import { FakeLlm, FIXED_NOW, makeHub, parse, seqIds } from "./helpers.js";

describe("BankCallSimulator", () => {
  it("dials, navigates the menu, holds, then waits for verification; verify completes with a reference", async () => {
    const updates: BankCall[] = [];
    const sim = new BankCallSimulator({ now: () => FIXED_NOW, idGen: seqIds(), stepDelayMs: 0, onUpdate: (c) => updates.push(c) });
    const card = new BankSimulator({ now: () => FIXED_NOW }).getCard("7710");
    const call = await sim.start(card);
    expect(call).toMatchObject({ state: "verifying", bank: "ICICI Bank", simulated: true });
    expect(call.steps.map((s) => s.label)[0]).toBe("Dialing ICICI Bank · 1800 1080");
    expect(call.steps.at(-1)!.status).toBe("waiting_user");
    expect(updates.length).toBe(call.steps.length);
    await expect(sim.verify(call.callId, "blue")).rejects.toThrow(/repeat/);
    const done = await sim.verify(call.callId, "12/03/1998");
    expect(done).toMatchObject({ state: "completed", reference: expect.stringMatching(/^ICI-\d{5}$/) });
    await expect(sim.verify(call.callId, "12/03/1998")).rejects.toThrow(/not waiting/);
  });

  it("starting twice for the same card reuses the live call; cancel switches to co-pilot", async () => {
    const sim = new BankCallSimulator({ stepDelayMs: 0 });
    const card = new BankSimulator().getCard("7710");
    const a = await sim.start(card);
    const b = await sim.start(card);
    expect(b.callId).toBe(a.callId);
    expect(sim.cancel(a.callId)).toMatchObject({ state: "cancelled", mode: "copilot" });
  });

  it("recognises spoken/typed dates of birth", () => {
    for (const ok of ["12/03/1998", "12-3-1998", "1998-03-12", "12 March 1998", "twelfth of march 1998"]) expect(looksLikeDob(ok)).toBe(true);
    for (const bad of ["yes", "1234", "March"]) expect(looksLikeDob(bad)).toBe(false);
  });
});

describe("call tools via MCP", () => {
  it("call_bank_for_user → bank_call_verify blocks the card, saves the reference, completes the action", async () => {
    const { hub, ctx, seen } = await makeHub();
    await hub.execute("freeze_card", { card_id: "7710" }, "f"); // CALL_REQUIRED creates the action
    const started = parse((await hub.execute("call_bank_for_user", { card_id: "7710" }, "c")).content);
    expect(started).toMatchObject({ state: "verifying", next: expect.stringMatching(/date of birth/) });
    const done = parse((await hub.execute("bank_call_verify", { call_id: started.callId, date_of_birth: "12/03/1998" }, "v")).content);
    expect(done).toMatchObject({ blocked: true, last4: "7710", reference: expect.stringMatching(/^ICI-\d{5}$/) });
    expect(ctx.bank.getCard("7710").status).toBe("blocked");
    expect(ctx.caseFile.actionsNeeded[0]).toMatchObject({ done: true, detail: `Reference ${done.reference}` });
    expect(ctx.caseFile.cardActions.at(-1)).toMatchObject({ method: "call", reference: done.reference });
    // date of birth never shown in the activity feed
    const verifyEvent = seen.find((e) => e.type === "tool_start" && e.name === "bank_call_verify") as any;
    expect(verifyEvent.input.date_of_birth).toBe("••/••/••••");
    await hub.close();
  });

  it("start_call_copilot returns a guide and never asks for secrets", async () => {
    const { hub, ctx } = await makeHub();
    const r = parse((await hub.execute("start_call_copilot", { card_id: "7710" }, "p")).content);
    expect(r).toMatchObject({ mode: "copilot", tel: "tel:18001080", say: expect.stringContaining("7 7 1 0"), never: expect.stringMatching(/OTP, PIN or CVV/) });
    expect(ctx.caseFile.actionsNeeded).toHaveLength(1);
    await hub.close();
  });
});

describe("session: I'll call myself", () => {
  it("emits live bank_call events and switching to co-pilot notifies the agent", async () => {
    const llm = new FakeLlm([
      { tools: [{ name: "call_bank_for_user", input: { card_id: "7710" } }] },
      { text: "ICICI wants your date of birth." },
      { text: "Okay, I'll guide you." },
    ]);
    const s = await Session.create("c1", {
      orchestrator: new Orchestrator(llm),
      geo: new GeoService(async () => new Response("x"), "offline"),
      email: new DryRunEmailSender(),
      profile: () => defaultProfile("k@example.com"),
      bankOutages: [],
      now: () => FIXED_NOW,
      callStepDelayMs: 0,
    });
    await s.say("block my ICICI card");
    const callEvents = s.events.history().filter((e) => e.type === "bank_call");
    expect(callEvents.length).toBeGreaterThanOrEqual(5);
    const callId = (callEvents.at(-1) as any).call.callId;
    expect(s.switchToCopilot(callId)).toMatchObject({ state: "cancelled", mode: "copilot" });
    await s.say("ok");
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).toContain("I'll call myself");
    await s.close();
  });
});
