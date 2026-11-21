import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildLostReportPdf } from "../services/documents.js";
import { getGuides } from "../services/reissue.js";
import { fail, ok, type ServiceContext } from "./context.js";

export function createCivicServer(ctx: ServiceContext): McpServer {
  const server = new McpServer({ name: "sarva-civic", version: "0.1.0" });
  const { caseFile } = ctx;

  server.registerTool(
    "record_incident",
    {
      title: "Record incident",
      description: "Record what was lost, where and roughly when. Call as soon as you know the basics.",
      inputSchema: {
        items: z.array(z.string()).min(1).describe("e.g. ['wallet', 'HDFC credit card', 'driving licence']"),
        location: z.string().optional(),
        lost_at: z.string().optional().describe("Approximate time, free text, e.g. 'about 30 minutes ago'"),
      },
    },
    async ({ items, location, lost_at }) => {
      const merged = Array.from(new Set([...caseFile.incident.items, ...items]));
      caseFile.incident = { items: merged, location: location ?? caseFile.incident.location, lostAt: lost_at ?? caseFile.incident.lostAt };
      return ok({ caseId: caseFile.caseId, incident: caseFile.incident });
    },
  );

  server.registerTool(
    "find_nearest_police_station",
    {
      title: "Nearest police station",
      description: "Find the nearest police stations to a place (OpenStreetMap). Returns name, distance and emergency numbers.",
      inputSchema: { location: z.string().min(2).describe("Landmark or area, e.g. 'Majestic bus stand'") },
    },
    async ({ location }) => {
      const r = await ctx.geo.nearestPoliceStations(location, 3);
      if (r.stations[0]) caseFile.nearestStation = r.stations[0];
      return ok(r);
    },
  );

  server.registerTool(
    "file_lost_report",
    {
      title: "File lost-article report",
      description:
        "Prepare the lost-article police report PDF and submit it to the police e-lost portal (simulated in this prototype). Sensitive: requires explicit user approval. Call find_nearest_police_station first so the jurisdiction is filled in.",
      inputSchema: {
        items: z.array(z.string()).min(1),
        location: z.string().min(2),
        lost_at: z.string().min(2),
        narrative: z.string().min(10).describe("Short first-person statement of what happened"),
      },
    },
    async ({ items, location, lost_at, narrative }) => {
      if (caseFile.report) return ok({ alreadyFiled: true, reference: caseFile.report.reference, station: caseFile.report.station?.name });
      const base = {
        reference: ctx.idGen("SRK-LAR"),
        station: caseFile.nearestStation,
        items,
        location,
        lostAt: lost_at,
        narrative,
        submittedAt: ctx.now().toISOString(),
        portal: "simulated-police-portal" as const,
      };
      try {
        const pdf = await buildLostReportPdf(caseFile, base);
        caseFile.report = { ...base, pdfBase64: pdf.toString("base64") };
      } catch (e) {
        return fail("REPORT_GENERATION_FAILED", { message: (e as Error).message });
      }
      return ok({
        simulated: true,
        reference: base.reference,
        station: base.station?.name ?? "not determined",
        submittedAt: base.submittedAt,
        pdfAttachedToCaseFile: true,
        nextStep: "Carry a printed copy to the station if asked; use the reference for document reissue.",
      });
    },
  );

  server.registerTool(
    "get_reissue_steps",
    {
      title: "Document reissue steps",
      description: "Get urgent actions and reissue steps for lost documents (driving licence, Aadhaar, PAN, bank card, phone/SIM, voter ID).",
      inputSchema: { documents: z.array(z.string()).min(1) },
    },
    async ({ documents }) => {
      const r = getGuides(documents);
      for (const g of r.guides) if (!caseFile.reissue.some((x) => x.document === g.document)) caseFile.reissue.push(g);
      return ok({ ...r, policeReportFiled: Boolean(caseFile.report), reportReference: caseFile.report?.reference });
    },
  );

  return server;
}
