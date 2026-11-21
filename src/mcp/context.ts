import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CaseFile } from "../domain/case.js";
import type { BankSimulator } from "../services/bank.js";
import type { GeoService } from "../services/geo.js";
import type { EmailSender } from "../services/email.js";
import { BankCallSimulator } from "../services/bank-call.js";

/** Everything an MCP server needs; injected so tests can swap in fakes. */
export interface ServiceContext {
  caseFile: CaseFile;
  bank: BankSimulator;
  geo: GeoService;
  email: EmailSender;
  now: () => Date;
  idGen: (prefix: string) => string;
  /** Simulated outbound bank calls ("Sarva calls for you"). */
  calls?: BankCallSimulator;
}

export function callsOf(ctx: ServiceContext): BankCallSimulator {
  ctx.calls ??= new BankCallSimulator({ now: ctx.now, idGen: ctx.idGen, stepDelayMs: 0 });
  return ctx.calls;
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function fail(error: string, details: Record<string, unknown> = {}): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error, ...details }) }], isError: true };
}

let seq = 0;
export const defaultIdGen = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).slice(-5).toUpperCase()}${(++seq).toString().padStart(2, "0")}`;
