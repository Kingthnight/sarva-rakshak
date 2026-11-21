/**
 * Run one Sarva MCP server standalone over stdio, e.g. for Claude Desktop / MCP Inspector:
 *   npx tsx src/mcp/stdio.ts bank|civic|notify
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { newCaseFile } from "../domain/case.js";
import { BankSimulator } from "../services/bank.js";
import { DryRunEmailSender, ResendEmailSender } from "../services/email.js";
import { GeoService } from "../services/geo.js";
import { createBankServer } from "./bank-server.js";
import { createCivicServer } from "./civic-server.js";
import { defaultIdGen, type ServiceContext } from "./context.js";
import { createNotifyServer } from "./notify-server.js";

const which = process.argv[2];
const cfg = loadConfig();
const ctx: ServiceContext = {
  caseFile: newCaseFile({ caseId: defaultIdGen("CASE"), email: cfg.email.demoUserEmail }),
  bank: new BankSimulator({ outages: cfg.bankOutages }),
  geo: new GeoService(fetch, cfg.geoMode),
  email: cfg.email.mode === "live" ? new ResendEmailSender(cfg.email.resendApiKey, cfg.email.from) : new DryRunEmailSender(),
  now: () => new Date(),
  idGen: defaultIdGen,
};

const factories = { bank: createBankServer, civic: createCivicServer, notify: createNotifyServer } as const;
const factory = factories[which as keyof typeof factories];
if (!factory) {
  console.error("usage: tsx src/mcp/stdio.ts bank|civic|notify");
  process.exit(1);
}
await factory(ctx).connect(new StdioServerTransport());
