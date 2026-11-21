import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CaseFile } from "../domain/case.js";
import type { BankSimulator } from "../services/bank.js";
import type { GeoService } from "../services/geo.js";
import type { EmailSender } from "../services/email.js";
import { BankCallSimulator } from "../services/bank-call.js";
import { TelecomSimulator } from "../services/telecom.js";
import { defaultProfile, type Profile } from "../domain/profile.js";

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
  /** The user's saved profile (device, emergency contact…). */
  profile?: Profile;
  /** Simulated operator + Find-My-Device services. */
  telecom?: TelecomSimulator;
}

export function profileOf(ctx: ServiceContext): Profile {
  ctx.profile ??= defaultProfile(ctx.caseFile.user.email);
  return ctx.profile;
}

export function telecomOf(ctx: ServiceContext): TelecomSimulator {
  ctx.telecom ??= new TelecomSimulator(profileOf(ctx).device, ctx.now, ctx.idGen, ctx.caseFile.incident.location ?? "Majestic, Bengaluru");
  return ctx.telecom;
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

export { defaultIdGen } from "../domain/refs.js";
