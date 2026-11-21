import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { summarise, type CaseFile } from "../domain/case.js";
import { buildCaseFilePdf, buildIcs } from "../services/documents.js";
import type { EmailAttachment } from "../services/email.js";
import { fail, ok, type ServiceContext } from "./context.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function caseEmailHtml(c: CaseFile): string {
  const s = summarise(c);
  const block = (title: string, items: string[]) =>
    items.length ? `<h3 style="margin:18px 0 6px">${esc(title)}</h3><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
  const urgent = c.reissue.flatMap((g) => g.urgentActions);
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:640px;color:#111">
  <h2 style="margin:0">🛡️ Sarva Rakshak: case ${esc(c.caseId)}</h2>
  <p>Hi ${esc(c.user.name.split(" ")[0])}, here is everything we did after you reported losing: <b>${esc(s.items.join(", ") || "your belongings")}</b>${s.location ? ` near <b>${esc(s.location)}</b>` : ""}.</p>
  ${block("Cards secured", s.cards)}
  ${block("Suspicious transactions", s.flagged)}
  ${block("Disputes filed", s.disputes)}
  ${s.report ? block("Police report", [`Reference ${s.report}`, "PDF attached; carry a printed copy if the station asks."]) : ""}
  ${block("Still to do", [...c.actionsNeeded.filter((a) => !a.done).map((a) => `${a.title} (${a.detail})`), ...urgent])}
  ${block("Replacement cards", s.replacements)}
  ${block("Card watch", s.cardAlerts)}
  ${block("Reissue guides", c.reissue.map((g) => `${g.title}: ${g.portal}`))}
  ${block("Reminders (calendar invite attached)", s.reminders)}
  <p style="color:#666;font-size:12px;margin-top:24px">Bank and police integrations in this hackathon prototype are simulated. Emergency: 112 · Cyber fraud: 1930.</p>
</div>`;
}

export function createNotifyServer(ctx: ServiceContext): McpServer {
  const server = new McpServer({ name: "sarva-notify", version: "0.1.0" });
  const { caseFile } = ctx;

  server.registerTool(
    "schedule_reminder",
    {
      title: "Schedule reminder",
      description: "Schedule a follow-up reminder for the user (added to the case-file calendar invite).",
      inputSchema: {
        title: z.string().min(3),
        due_in_hours: z.number().positive().max(24 * 90).describe("Hours from now"),
        notes: z.string().optional(),
      },
    },
    async ({ title, due_in_hours, notes }) => {
      const r = { id: ctx.idGen("REM"), title, dueAt: new Date(ctx.now().getTime() + due_in_hours * 3_600_000).toISOString(), notes };
      caseFile.reminders.push(r);
      return ok({ scheduled: true, reminder: r });
    },
  );

  server.registerTool(
    "send_case_file",
    {
      title: "Email case file",
      description:
        "Email the complete case file (summary, case PDF, police report PDF if filed, reminders .ics) to the user's registered email. Call after the other steps are done.",
      inputSchema: {},
    },
    async () => {
      const to = caseFile.user.email;
      if (!to) return fail("NO_EMAIL_ON_FILE", { message: "User has no registered email; set DEMO_USER_EMAIL." });
      const attachments: EmailAttachment[] = [{ filename: `case-${caseFile.caseId}.pdf`, content: await buildCaseFilePdf(caseFile) }];
      if (caseFile.report) attachments.push({ filename: `lost-report-${caseFile.report.reference}.pdf`, content: Buffer.from(caseFile.report.pdfBase64, "base64") });
      if (caseFile.reminders.length) attachments.push({ filename: "sarva-reminders.ics", content: buildIcs(caseFile.reminders, ctx.now()) });
      const subject = `Sarva Rakshak case ${caseFile.caseId}: cards secured & next steps`;
      try {
        const res = await ctx.email.send({ to, subject, html: caseEmailHtml(caseFile), attachments });
        caseFile.emails.push({ to, subject, id: res.id, mode: res.mode, at: ctx.now().toISOString() });
        return ok({ sent: true, mode: res.mode, emailId: res.id, to, attachments: attachments.map((a) => a.filename) });
      } catch (e) {
        return fail("EMAIL_FAILED", { message: (e as Error).message });
      }
    },
  );

  return server;
}
