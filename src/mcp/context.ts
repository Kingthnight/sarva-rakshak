import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CaseFile } from "../domain/case.js";
import type { BankSimulator } from "../services/bank.js";
import type { GeoService } from "../services/geo.js";
import type { EmailSender } from "../services/email.js";

/** Everything an MCP server needs; injected so tests can swap in fakes. */
export interface ServiceContext {
  caseFile: CaseFile;
  bank: BankSimulator;
  geo: GeoService;
  email: EmailSender;
  now: () => Date;
  idGen: (prefix: string) => string;
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
