import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, telecomOf, type ServiceContext } from "./context.js";

export function createTelecomServer(ctx: ServiceContext): McpServer {
  const server = new McpServer({ name: "sarva-telecom", version: "0.1.0" });
  const { caseFile } = ctx;
  const log = (action: string, detail: string, reference?: string) => caseFile.phoneActions.push({ action, detail, reference, at: ctx.now().toISOString() });

  server.registerTool(
    "get_device_info",
    {
      title: "Lost phone: device info",
      description: "The user's saved phone: model, OS, operator, number ending, operator helpline, which Find-My service applies, and what's already been done.",
      inputSchema: {},
    },
    async () => ok(telecomOf(ctx).info()),
  );

  server.registerTool(
    "block_sim",
    {
      title: "Block the SIM",
      description: "Ask the operator to suspend the lost SIM so OTPs and calls stop reaching it. Protective, so no approval needed. Do this FIRST for a lost phone, because bank OTPs go to it.",
      inputSchema: {},
    },
    async () => {
      const r = telecomOf(ctx).blockSim();
      if (!("alreadyBlocked" in r)) log("block_sim", `${r.operator} SIM ending ${r.numberEnding} suspended`, r.reference);
      return ok(r);
    },
  );

  server.registerTool(
    "device_locate_ring_lock",
    {
      title: "Locate, ring or lock the phone",
      description: "Use Find My Device to locate the phone (last seen), make it ring, or lock it with a lost-phone message. All protective, so no approval needed. For erasing use remote_erase_device.",
      inputSchema: { action: z.enum(["locate", "ring", "lock"]) },
    },
    async ({ action }) => {
      const r = telecomOf(ctx).deviceAction(action);
      if (r.ok) log(action, action === "locate" ? `Phone last seen near ${(r as { lastSeen?: { near: string } }).lastSeen?.near}` : `Phone ${action === "lock" ? "locked remotely" : "ringing"}`);
      return r.ok ? ok(r) : fail("DEVICE_ACTION_FAILED", r);
    },
  );

  server.registerTool(
    "remote_erase_device",
    {
      title: "Erase the phone remotely",
      description: "Permanently wipe the lost phone. Irreversible, and the phone can't be located afterwards. Sensitive: requires explicit user approval. Suggest it only if the phone holds sensitive data and recovery looks unlikely.",
      inputSchema: {},
    },
    async () => {
      const r = telecomOf(ctx).deviceAction("erase");
      if (r.ok) log("erase", "Remote erase queued", (r as { reference?: string }).reference);
      return r.ok ? ok(r) : fail("DEVICE_ACTION_FAILED", r);
    },
  );

  server.registerTool(
    "block_imei_ceir",
    {
      title: "Block the handset (CEIR / Sanchar Saathi)",
      description: "Blacklist the handset's IMEI on all Indian networks through the government CEIR portal. Needs the police lost-report reference first (dependency). Sensitive: requires explicit user approval.",
      inputSchema: {},
    },
    async () => {
      try {
        const r = telecomOf(ctx).blockImei(caseFile.report?.reference);
        if (!("alreadyBlocked" in r)) log("block_imei", "IMEI block requested on CEIR", r.requestId);
        return ok(r);
      } catch (e) {
        return fail("POLICE_REPORT_REQUIRED", { message: (e as Error).message });
      }
    },
  );

  return server;
}
