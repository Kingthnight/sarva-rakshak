import { describe, expect, it } from "vitest";
import { Orchestrator, appendUserText } from "../src/agent/orchestrator.js";
import { FILLER_LINE, APOLOGY_LINE, buildSystemPrompt } from "../src/agent/prompt.js";
import { FakeLlm, approvalIdFrom, makeHub } from "./helpers.js";

async function setup(script: ConstructorParameters<typeof FakeLlm>[0]) {
  const h = await makeHub();
  const llm = new FakeLlm(script);
  const orch = new Orchestrator(llm);
  const turn = { history: [] as any[], system: buildSystemPrompt(h.ctx.caseFile), hub: h.hub, gate: h.gate, events: h.events };
  return { ...h, llm, orch, turn };
}

describe("Orchestrator: full Track-3 workflow with a scripted LLM", () => {
  it("plans, executes, adapts (SBI outage), waits for approval, then confirms & follows up", async () => {
    const plan = [
      { title: "Freeze cards", status: "in_progress" },
      { title: "Check for fraud", status: "pending" },
      { title: "Police report", status: "pending" },
      { title: "Document reissue", status: "pending" },
      { title: "Case file & reminders", status: "pending" },
    ];
    const s = await setup([
      // Turn 1: initiate → plan + execute + adapt + ask approval
      {
        text: "I'm sorry, let's secure everything now.",
        tools: [
          { name: "record_incident", input: { items: ["wallet", "HDFC credit card", "SBI debit card", "driving licence", "aadhaar"], location: "Majestic bus stand", lost_at: "20 minutes ago" } },
          { name: "update_plan", input: { steps: plan } },
          { name: "list_cards", input: {} },
        ],
      },
      { tools: [{ name: "freeze_card", input: { card_id: "hdfc-cc-4821" } }, { name: "freeze_card", input: { card_id: "sbi-dc-1093" } }] },
      { text: "SBI is down, using the SMS block.", tools: [{ name: "send_sms_block", input: { card_id: "sbi-dc-1093" } }] },
      { tools: [{ name: "get_recent_transactions", input: { card_id: "hdfc-cc-4821" } }, { name: "get_recent_transactions", input: { card_id: "sbi-dc-1093" } }] },
      { tools: [{ name: "find_nearest_police_station", input: { location: "Majestic bus stand" } }] },
      {
        tools: [
          { name: "request_user_approval", input: { action: "raise_dispute", summary: "Dispute ₹4,999 at ELECTRO MART ONLINE" } },
          { name: "request_user_approval", input: { action: "file_lost_report", summary: "File lost report at Upparpet" } },
        ],
      },
      { text: "Shall I dispute that charge and file the report at Upparpet?" },
      // Turn 2: user says yes → sensitive actions + docs + follow-up
      {
        tools: [
          { name: "raise_dispute", input: (req) => ({ txn_id: "txn-9002", reason: "Unauthorised after wallet loss", approval_id: approvalIdFrom(req, "raise_dispute") }) },
          {
            name: "file_lost_report",
            input: (req) => ({ items: ["wallet"], location: "Majestic bus stand", lost_at: "20 minutes ago", narrative: "I lost my wallet at Majestic bus stand.", approval_id: approvalIdFrom(req, "file_lost_report") }),
          },
          { name: "get_reissue_steps", input: { documents: ["driving licence", "aadhaar", "debit card"] } },
        ],
      },
      {
        tools: [
          { name: "schedule_reminder", input: { title: "Follow up on police report", due_in_hours: 72 } },
          { name: "schedule_reminder", input: { title: "Apply for duplicate DL", due_in_hours: 24 } },
        ],
      },
      { tools: [{ name: "send_case_file", input: {} }] },
      { text: "All done. Your case file is in your inbox." },
    ]);

    const spoken1: string[] = [];
    const r1 = await s.orch.runTurn(s.turn, "I lost my wallet at Majestic bus stand with my HDFC and SBI cards, DL and Aadhaar", (d) => spoken1.push(d));
    expect(r1.stopReason).toBe("end_turn");
    expect(r1.toolCalls).toBe(11);
    expect(r1.text).toContain("Shall I dispute");
    expect(spoken1.join("")).toBe(r1.text + (spoken1.join("").endsWith(" ") ? " " : "")); // streamed == returned (modulo trim)
    // Adapt: SBI fell back to SMS; HDFC frozen
    expect(s.ctx.caseFile.cardActions.map((a) => `${a.bank}:${a.method}`)).toEqual(["HDFC Bank:api", "State Bank of India:sms"]);
    // Nothing sensitive happened yet
    expect(s.ctx.caseFile.disputes).toHaveLength(0);
    expect(s.ctx.caseFile.report).toBeUndefined();

    const r2 = await s.orch.runTurn(s.turn, "Yes, go ahead with both.");
    expect(r2.text).toContain("All done");
    expect(s.ctx.caseFile.disputes.map((d) => d.amountInr)).toEqual([4999]);
    expect(s.ctx.caseFile.report?.station?.name).toBe("Upparpet Police Station");
    expect(s.ctx.caseFile.reissue.length).toBe(3);
    expect(s.ctx.caseFile.reminders.length).toBe(2);
    expect(s.email.outbox).toHaveLength(1);
    expect(s.email.outbox[0].attachments!.map((a) => a.filename)).toEqual([
      "case-CASE-TEST.pdf",
      `lost-report-${s.ctx.caseFile.report!.reference}.pdf`,
      "sarva-reminders.ics",
    ]);
    expect(s.llm.remaining).toBe(0);

    // History stays well-formed: alternating roles, every tool_use answered.
    const roles = s.turn.history.map((m) => m.role);
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
    const uses = s.turn.history.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
    const results = s.turn.history.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id);
    expect(results.sort()).toEqual(uses.sort());

    const types = s.seen.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["user_said", "plan", "tool_start", "tool_end", "approval_requested", "approval_granted", "case", "agent_said"]));
    await s.hub.close();
  });

  it("blocks the model from approving its own action within the same turn", async () => {
    const s = await setup([
      { tools: [{ name: "request_user_approval", input: { action: "raise_dispute", summary: "x" } }] },
      { tools: [{ name: "raise_dispute", input: (req) => ({ txn_id: "txn-9002", reason: "x", approval_id: approvalIdFrom(req, "raise_dispute") }) }] },
      { text: "I need your confirmation first." },
    ]);
    await s.orch.runTurn(s.turn, "dispute it");
    expect(s.ctx.caseFile.disputes).toHaveLength(0);
    expect(s.seen.some((e) => e.type === "approval_rejected")).toBe(true);
    await s.hub.close();
  });

  it("speaks a filler line when a turn starts with silent tool calls", async () => {
    const s = await setup([{ tools: [{ name: "list_cards", input: {} }] }, { text: "You have two cards." }]);
    const out: string[] = [];
    await s.orch.runTurn(s.turn, "what cards do I have", (d) => out.push(d));
    expect(out[0]).toBe(FILLER_LINE);
    expect(out.join("")).toBe(`${FILLER_LINE}You have two cards.`);
    await s.hub.close();
  });

  it("recovers from an LLM failure with an apology and a clean history", async () => {
    const s = await setup([{ throws: new Error("overloaded") }, { text: "Back now." }]);
    const r = await s.orch.runTurn(s.turn, "hello");
    expect(r.stopReason).toBe("error");
    expect(r.text).toBe(APOLOGY_LINE);
    expect(s.turn.history).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: APOLOGY_LINE }] },
    ]);
    const r2 = await s.orch.runTurn(s.turn, "hello again");
    expect(r2.text).toBe("Back now.");
    expect(s.seen.some((e) => e.type === "error")).toBe(true);
    await s.hub.close();
  });

  it("stops after maxIterations and tells the user", async () => {
    const h = await makeHub();
    const llm = new FakeLlm(Array.from({ length: 3 }, () => ({ tools: [{ name: "list_cards", input: {} }] })));
    const orch = new Orchestrator(llm, 3);
    const r = await orch.runTurn({ history: [], system: "s", hub: h.hub, gate: h.gate, events: h.events }, "loop");
    expect(r.iterations).toBe(3);
    expect(r.text).toMatch(/several steps/);
    await h.hub.close();
  });
});

describe("appendUserText", () => {
  it("merges into a trailing user tool_result message", () => {
    const h: any[] = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "{}" }] }];
    appendUserText(h, "yes");
    expect(h).toHaveLength(1);
    expect(h[0].content[1]).toEqual({ type: "text", text: "yes" });
    const h2: any[] = [{ role: "user", content: "hi" }];
    appendUserText(h2, "there");
    expect(h2[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "there" },
    ]);
  });
});

describe("system prompt", () => {
  it("includes the workflow, approval rule and voice style", async () => {
    const { ctx } = (await makeHub()) as any;
    const p = buildSystemPrompt(ctx.caseFile);
    expect(p).toMatch(/request_user_approval/);
    expect(p).toMatch(/send_sms_block/);
    expect(p).toMatch(/No markdown/);
    expect(p).toContain("CASE-TEST");
  });
});
