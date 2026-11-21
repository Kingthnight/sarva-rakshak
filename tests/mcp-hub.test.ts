import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../src/agent/approvals.js";
import { makeHub, parse } from "./helpers.js";

describe("ApprovalGate", () => {
  it("only accepts approvals after a new user turn, once, for the right action", () => {
    const g = new ApprovalGate();
    g.userTurn();
    const { approval_id } = g.request("raise_dispute", "dispute 4999");
    expect(g.consume(approval_id, "raise_dispute")).toMatchObject({ ok: false, reason: expect.stringMatching(/not answered/) });
    g.userTurn(); // user said "yes"
    expect(g.consume(approval_id, "file_lost_report")).toMatchObject({ ok: false });
    expect(g.consume(approval_id, "raise_dispute")).toEqual({ ok: true, summary: "dispute 4999" });
    expect(g.consume(approval_id, "raise_dispute")).toMatchObject({ ok: false, reason: expect.stringMatching(/already used/) });
    expect(g.consume(undefined, "raise_dispute").ok).toBe(false);
    expect(g.consume("APR-999", "raise_dispute").ok).toBe(false);
  });
});

describe("ToolHub + MCP servers", () => {
  it("exposes all MCP tools plus internal tools, with approval_id required on sensitive ones", async () => {
    const { hub } = await makeHub();
    const tools = hub.tools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "bank_call_verify",
        "call_bank_for_user",
        "start_call_copilot",
        "find_nearest_police_station",
        "file_lost_report",
        "freeze_card",
        "get_block_options",
        "get_recent_transactions",
        "get_reissue_steps",
        "list_cards",
        "raise_dispute",
        "record_incident",
        "record_manual_block",
        "request_replacement_card",
        "request_user_approval",
        "schedule_reminder",
        "send_case_file",
        "send_sms_block",
        "update_plan",
      ].sort(),
    );
    const dispute = tools.find((t) => t.name === "raise_dispute")!;
    expect(dispute.input_schema.required).toContain("approval_id");
    expect(dispute.description).toMatch(/^\[bank MCP\]/);
    expect(hub.serverOf("file_lost_report")).toBe("civic");
    expect(hub.serverOf("update_plan")).toBe("agent");
    await hub.close();
  });

  it("freeze_card succeeds for HDFC and reports BANK_UNAVAILABLE for SBI, then SMS fallback works", async () => {
    const { hub, ctx, seen } = await makeHub();
    const ok = await hub.execute("freeze_card", { card_id: "hdfc-cc-4821" }, "c1");
    expect(ok.isError).toBe(false);
    expect(parse(ok.content)).toMatchObject({ status: "frozen", bank: "HDFC Bank" });

    const down = await hub.execute("freeze_card", { card_id: "sbi-dc-1093" }, "c2");
    expect(down.isError).toBe(true);
    expect(parse(down.content)).toMatchObject({ error: "BANK_UNAVAILABLE", bank: "State Bank of India" });

    const sms = await hub.execute("send_sms_block", { card_id: "sbi-dc-1093" }, "c3");
    expect(parse(sms.content)).toMatchObject({ method: "sms", smsBody: "BLOCK 1093" });

    expect(ctx.caseFile.cardActions.map((a) => [a.bank, a.method])).toEqual([
      ["HDFC Bank", "api"],
      ["State Bank of India", "sms"],
    ]);
    const types = seen.map((e) => e.type);
    expect(types.filter((t) => t === "tool_start")).toHaveLength(3);
    expect(seen.find((e) => e.type === "tool_end" && e.id === "c2")).toMatchObject({ ok: false, server: "bank" });
    expect(types).toContain("case");
    await hub.close();
  });

  it("validates tool input via the MCP schema", async () => {
    const { hub } = await makeHub();
    const r = await hub.execute("freeze_card", {}, "bad");
    expect(r.isError).toBe(true);
    await hub.close();
  });

  it("blocks sensitive tools without a valid approval, allows them after the user's turn", async () => {
    const { hub, gate, ctx, seen } = await makeHub();
    gate.userTurn();
    const blocked = await hub.execute("raise_dispute", { txn_id: "txn-9002", reason: "not me" }, "d0");
    expect(parse(blocked.content).error).toBe("APPROVAL_REQUIRED");

    const req = await hub.execute("request_user_approval", { action: "raise_dispute", summary: "Dispute 4999" }, "a1");
    const { approval_id } = parse(req.content);
    const tooEarly = await hub.execute("raise_dispute", { txn_id: "txn-9002", reason: "not me", approval_id }, "d1");
    expect(parse(tooEarly.content).error).toBe("APPROVAL_REQUIRED");

    gate.userTurn(); // "yes"
    const done = await hub.execute("raise_dispute", { txn_id: "txn-9002", reason: "not me", approval_id }, "d2");
    expect(done.isError).toBe(false);
    expect(parse(done.content)).toMatchObject({ amountInr: 4999, status: "filed" });
    expect(ctx.caseFile.disputes).toHaveLength(1);
    expect(seen.map((e) => e.type)).toEqual(expect.arrayContaining(["approval_requested", "approval_rejected", "approval_granted"]));
    await hub.close();
  });

  it("civic: incident, police station (offline), report PDF and reissue steps", async () => {
    const { hub, gate, ctx } = await makeHub();
    await hub.execute("record_incident", { items: ["wallet", "driving licence"], location: "Majestic", lost_at: "30 min ago" }, "i1");
    const st = parse((await hub.execute("find_nearest_police_station", { location: "Majestic bus stand" }, "p1")).content);
    expect(st.stations[0].name).toBe("Upparpet Police Station");

    gate.userTurn();
    const { approval_id } = parse((await hub.execute("request_user_approval", { action: "file_lost_report", summary: "File at Upparpet" }, "a")).content);
    gate.userTurn();
    const rep = parse(
      (await hub.execute("file_lost_report", { items: ["wallet"], location: "Majestic", lost_at: "9am", narrative: "I lost my wallet near platform 3.", approval_id }, "r1")).content,
    );
    expect(rep).toMatchObject({ simulated: true, station: "Upparpet Police Station" });
    expect(ctx.caseFile.report?.pdfBase64.length).toBeGreaterThan(500);

    const guides = parse((await hub.execute("get_reissue_steps", { documents: ["DL", "aadhaar"] }, "g1")).content);
    expect(guides.policeReportFiled).toBe(true);
    expect(ctx.caseFile.reissue.map((g) => g.document)).toEqual(["driving_licence", "aadhaar"]);
    await hub.close();
  });

  it("notify: reminders + case file email with PDF and ICS attachments (dry-run)", async () => {
    const { hub, email, ctx } = await makeHub();
    await hub.execute("freeze_card", { card_id: "4821" }, "f");
    const rem = parse((await hub.execute("schedule_reminder", { title: "Follow up on police report", due_in_hours: 72 }, "r")).content);
    expect(rem.reminder.dueAt).toBe("2026-11-24T09:30:00.000Z");
    const sent = parse((await hub.execute("send_case_file", {}, "e")).content);
    expect(sent).toMatchObject({ sent: true, mode: "dry-run", to: "demo@example.com" });
    expect(sent.attachments).toEqual(["case-CASE-TEST.pdf", "sarva-reminders.ics"]);
    expect(email.outbox[0].html).toContain("HDFC Bank ••4821");
    expect(ctx.caseFile.emails).toHaveLength(1);
    await hub.close();
  });

  it("update_plan emits a plan event; unknown tools fail gracefully", async () => {
    const { hub, seen } = await makeHub();
    await hub.execute("update_plan", { steps: [{ title: "Freeze cards", status: "in_progress" }] }, "u");
    expect(seen.find((e) => e.type === "plan")).toMatchObject({ steps: [{ title: "Freeze cards", status: "in_progress" }] });
    const r = await hub.execute("launch_rocket", {}, "x");
    expect(r.isError).toBe(true);
    await hub.close();
  });
});
