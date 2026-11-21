import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/agent/orchestrator.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { createApp } from "../src/app.js";
import { defaultProfile } from "../src/domain/profile.js";
import { defaultIdGen, REF_PATTERN, spokenRef } from "../src/domain/refs.js";
import { withSpokenRefs } from "../src/mcp/hub.js";
import { DryRunEmailSender } from "../src/services/email.js";
import { GeoService } from "../src/services/geo.js";
import { TelecomSimulator } from "../src/services/telecom.js";
import { Session, SessionStore } from "../src/session.js";
import { FakeLlm, FIXED_NOW, makeHub, parse, testConfig } from "./helpers.js";

const deps = (llm: FakeLlm) => ({
  orchestrator: new Orchestrator(llm),
  geo: new GeoService(async () => new Response("x"), "offline"),
  email: new DryRunEmailSender(),
  profile: () => ({ ...defaultProfile("k@example.com"), emergencyContact: { name: "Amma", relation: "mother", phone: "+91 90000 00000" } }),
  bankOutages: [],
  now: () => FIXED_NOW,
  callStepDelayMs: 0,
});

describe("reference format", () => {
  it("generates CODE-KIND-NNNNNN with digits only, and a spoken form", () => {
    const a = defaultIdGen("AXIS-BLK");
    const b = defaultIdGen("AXIS-BLK");
    expect(a).toMatch(/^AXIS-BLK-\d{6}$/);
    expect(a).not.toBe(b);
    expect(REF_PATTERN.test(a)).toBe(true);
    expect(spokenRef("AXIS-BLK-482913")).toBe("A X I S, block, four eight two, nine one three");
    expect(spokenRef("ICICI-CALL-507216")).toBe("I C I C I, call, five zero seven, two one six");
  });

  it("adds ...Spoken fields next to references in tool results", () => {
    expect(withSpokenRefs({ reference: "HDFC-BLK-123456", nested: [{ disputeId: "DSP-654321" }], other: "hello" })).toEqual({
      reference: "HDFC-BLK-123456",
      referenceSpoken: "H D F C, block, one two three, four five six",
      nested: [{ disputeId: "DSP-654321", disputeIdSpoken: "dispute, six five four, three two one" }],
      other: "hello",
    });
  });

  it("tool outcomes sent to the model carry the spoken form", async () => {
    const { hub } = await makeHub();
    const r = parse((await hub.execute("freeze_card", { card_id: "4821" }, "f")).content);
    expect(r.referenceSpoken).toMatch(/^H D F C, block, /);
    await hub.close();
  });
});

describe("telecom (lost phone)", () => {
  it("SIM block, locate/lock, CEIR needs a police report, erase is final", () => {
    const t = new TelecomSimulator({ model: "Pixel 8", os: "android", operator: "Jio", numberLast4: "4210" }, () => FIXED_NOW, (p) => `${p}-000001`);
    expect(t.blockSim()).toMatchObject({ operator: "Jio", reference: "JIO-SIM-000001" });
    expect(t.blockSim()).toMatchObject({ alreadyBlocked: true });
    expect(t.deviceAction("locate")).toMatchObject({ ok: true, lastSeen: { online: false } });
    expect(t.deviceAction("lock")).toMatchObject({ ok: true });
    expect(() => t.blockImei(undefined)).toThrow(/police complaint/);
    expect(t.blockImei("SRK-LAR-123456")).toMatchObject({ policeReference: "SRK-LAR-123456" });
    t.deviceAction("erase");
    expect(t.deviceAction("ring")).toMatchObject({ ok: false });
  });

  it("MCP: block_sim is free; erase/CEIR/notify are approval-gated; CEIR waits for the report", async () => {
    const { hub, gate, ctx } = await makeHub();
    const sim = parse((await hub.execute("block_sim", {}, "s")).content);
    expect(sim).toMatchObject({ operator: "Jio", referenceSpoken: "J I O, SIM, one zero zero, zero zero one" });
    expect(parse((await hub.execute("remote_erase_device", {}, "e")).content).error).toBe("APPROVAL_REQUIRED");
    gate.userTurn();
    const { approval_id } = parse((await hub.execute("request_user_approval", { action: "block_imei_ceir", summary: "Block IMEI" }, "a")).content);
    gate.userTurn();
    expect(parse((await hub.execute("block_imei_ceir", { approval_id }, "c")).content).error).toBe("POLICE_REPORT_REQUIRED");
    expect(ctx.caseFile.phoneActions.map((p) => p.action)).toEqual(["block_sim"]);
    await hub.close();
  });
});

describe("info tools and emergency contact", () => {
  it("get_case_status and get_profile_details answer 'where are we?' without secrets", async () => {
    const { hub } = await makeHub();
    await hub.execute("freeze_card", { card_id: "4821" }, "f");
    const st = parse((await hub.execute("get_case_status", {}, "s")).content);
    expect(st.cards[0]).toMatch(/frozen/);
    expect(st).toMatchObject({ reportFiled: false, caseFileEmailed: false });
    const pd = parse((await hub.execute("get_profile_details", {}, "p")).content);
    expect(pd.name).toBe("Koushik");
    expect(JSON.stringify(pd)).not.toMatch(/\d{12,}/);
    await hub.close();
  });

  it("notify_emergency_contact fails without a contact and needs approval", async () => {
    const { hub, gate } = await makeHub();
    gate.userTurn();
    const { approval_id } = parse((await hub.execute("request_user_approval", { action: "notify_emergency_contact", summary: "Tell family" }, "a")).content);
    gate.userTurn();
    expect(parse((await hub.execute("notify_emergency_contact", { message: "I lost my phone", approval_id }, "n")).content).error).toBe("NO_EMERGENCY_CONTACT");
    await hub.close();
  });
});

describe("end_call", () => {
  it("emits call_ended and asks the app to hang up after the goodbye", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async (url: string) => (url.endsWith("/join") ? new Response(JSON.stringify({ agent_id: "ag-1" })) : new Response("{}")));
    const store = new SessionStore(deps(new FakeLlm([{ text: "Take care, Koushik. Bye!", tools: [{ name: "end_call", input: { reason: "user said bye" } }] }, { text: "" }])));
    const app = createApp({ config: testConfig(), store, fetchFn, endCallDelayMs: 5000 });
    const s = await request(app).post("/api/sessions").send({});
    await request(app).post(`/api/sessions/${s.body.sessionId}/voice/start`).send({});
    await request(app).post(`/api/sessions/${s.body.sessionId}/text`).send({ text: "that's all, thanks bye" });
    const sess = store.get(s.body.sessionId)!;
    expect(sess.events.history().some((e) => e.type === "call_ended")).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => String(u).endsWith("/leave"))).toBe(false); // waits for the goodbye
    await vi.advanceTimersByTimeAsync(5100);
    expect(fetchFn.mock.calls.some(([u]) => String(u).endsWith("/leave"))).toBe(true);
    vi.useRealTimers();
  });
});

describe("interruptions", () => {
  it("when Agora cuts the stream, the unheard part is handed to the agent on the next turn", async () => {
    const long = "Your HDFC card is frozen. The reference is H D F C block four eight two nine one three, and please also lock Aadhaar biometrics today.";
    const llm = new FakeLlm([{ text: long }, { text: "Quickly, before I forget: your reference is on screen. Now, about your question…" }]);
    const s = await Session.create("i1", deps(llm));
    const ctrl = new AbortController();
    let chars = 0;
    await s.say("freeze my hdfc card", (d) => {
      chars += d.length;
      if (chars > 20) ctrl.abort(); // user starts talking after ~20 chars
    }, { signal: ctrl.signal });
    await s.say("wait, what about my aadhaar?");
    const sent = JSON.stringify(llm.requests[1].messages);
    expect(sent).toContain("Interruption note");
    expect(sent).toContain("lock Aadhaar biometrics");
    expect(s.events.history().some((e) => e.type === "interrupted")).toBe(true);
    await s.close();
  });

  it("uses Agora's truncated record of the last reply when available", async () => {
    const reply = "Done, both cards are frozen. One more thing: there's a suspicious charge of four thousand rupees I want to dispute.";
    const llm = new FakeLlm([{ text: reply }, { text: "ok" }, { text: "ok2" }]);
    const s = await Session.create("i2", deps(llm));
    await s.say("lost my wallet");
    await s.say("hello?", undefined, { heard: "Done, both cards are frozen." });
    expect(JSON.stringify(llm.requests[1].messages)).toContain("suspicious charge");
    // a fully heard reply produces no note
    await s.say("thanks", undefined, { heard: "ok" });
    expect(JSON.stringify(llm.requests[2].messages.at(-1))).not.toContain("Interruption note");
    await s.close();
  });
});

describe("conversational prompt", () => {
  it("covers persona, interruptions, ending the call, Hinglish, family members and phones", () => {
    const p = buildSystemPrompt({ ...((): any => null)() ?? {}, ...(require_case()) });
    for (const needle of ["GOOD CONVERSATIONALIST", "Interruption note", "end_call", "Hinglish", "someone else joins", "block_sim", "referenceSpoken", "Pixel 8"]) expect(p).toContain(needle);
  });
});

function require_case() {
  // minimal case file for the prompt
  const prof = defaultProfile("k@example.com");
  return {
    caseId: "CASE-1",
    createdAt: FIXED_NOW.toISOString(),
    user: { name: prof.name, email: prof.email, phoneMasked: prof.phone, city: prof.city, emergencyContact: prof.emergencyContact, documents: prof.documents, device: prof.device },
  };
}
