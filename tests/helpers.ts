import type Anthropic from "@anthropic-ai/sdk";
import { ApprovalGate } from "../src/agent/approvals.js";
import type { LlmClient, LlmRequest, LlmStream } from "../src/agent/llm.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { newCaseFile } from "../src/domain/case.js";
import { SessionEvents, type StampedEvent } from "../src/events.js";
import type { ServiceContext } from "../src/mcp/context.js";
import { ToolHub } from "../src/mcp/hub.js";
import { BankSimulator } from "../src/services/bank.js";
import { DryRunEmailSender } from "../src/services/email.js";
import { GeoService } from "../src/services/geo.js";

export const FIXED_NOW = new Date("2026-11-21T09:30:00.000Z");

export function seqIds() {
  let n = 0;
  return (prefix: string) => `${prefix}-${String(100000 + ++n)}`;
}

export function makeCtx(over: Partial<ServiceContext> & { outages?: string[] } = {}) {
  const now = () => FIXED_NOW;
  const idGen = seqIds();
  const email = new DryRunEmailSender();
  const ctx: ServiceContext = {
    caseFile: newCaseFile({ caseId: "CASE-TEST", email: "demo@example.com", now: FIXED_NOW }),
    bank: new BankSimulator({ now, outages: over.outages ?? ["SBI"], idGen }),
    geo: new GeoService(async () => {
      throw new Error("network disabled in tests");
    }, "offline"),
    email,
    now,
    idGen,
    ...over,
  };
  return { ctx, email };
}

export async function makeHub(over: Parameters<typeof makeCtx>[0] = {}) {
  const { ctx, email } = makeCtx(over);
  const gate = new ApprovalGate();
  const events = new SessionEvents();
  const seen: StampedEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hub = await ToolHub.create(ctx, gate, events);
  return { hub, ctx, email, gate, events, seen };
}

export const parse = (s: string) => JSON.parse(s) as Record<string, any>;

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    AGORA_APP_ID: "appid123",
    AGORA_CUSTOMER_KEY: "ck",
    AGORA_CUSTOMER_SECRET: "cs",
    MURF_API_KEY: "murf-key",
    ANTHROPIC_API_KEY: "sk-test",
    PUBLIC_BASE_URL: "https://demo.trycloudflare.com/",
    LLM_PROXY_SECRET: "s3cret",
    DEMO_USER_EMAIL: "demo@example.com",
    ...env,
  });
}

// ---------- Scripted fake LLM ----------

export interface ScriptStep {
  text?: string;
  tools?: Array<{ name: string; input: Record<string, unknown> | ((req: LlmRequest) => Record<string, unknown>) }>;
  stop?: Anthropic.Message["stop_reason"];
  throws?: Error;
}

let toolSeq = 0;

export class FakeLlm implements LlmClient {
  readonly requests: Array<{ messages: Anthropic.MessageParam[]; toolNames: string[]; system: string }> = [];
  constructor(private readonly script: ScriptStep[]) {}

  get remaining() {
    return this.script.length;
  }

  stream(req: LlmRequest): LlmStream {
    this.requests.push({ messages: structuredClone(req.messages), toolNames: req.tools.map((t) => t.name), system: req.system });
    const step = this.script.shift();
    let textCb: (d: string) => void = () => {};
    return {
      on: (_event, cb) => {
        textCb = cb;
      },
      finalMessage: async () => {
        if (!step) throw new Error("FakeLlm script exhausted");
        if (step.throws) throw step.throws;
        const content: Anthropic.ContentBlock[] = [];
        if (step.text) {
          // stream in two pieces to exercise delta handling
          const mid = Math.ceil(step.text.length / 2);
          textCb(step.text.slice(0, mid));
          textCb(step.text.slice(mid));
          content.push({ type: "text", text: step.text, citations: null } as Anthropic.TextBlock);
        }
        for (const t of step.tools ?? []) {
          content.push({
            type: "tool_use",
            id: `toolu_${++toolSeq}`,
            name: t.name,
            input: typeof t.input === "function" ? t.input(req) : t.input,
          } as Anthropic.ToolUseBlock);
        }
        return {
          id: `msg_${toolSeq}`,
          type: "message",
          role: "assistant",
          model: "fake",
          content,
          stop_reason: step.stop ?? (step.tools?.length ? "tool_use" : "end_turn"),
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        } as unknown as Anthropic.Message;
      },
    };
  }
}

/** Finds the approval_id returned by the most recent request_user_approval for an action. */
export function approvalIdFrom(req: LlmRequest, action: string): string {
  const toolUseIds = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use" && b.name === "request_user_approval" && (b.input as any).action === action) toolUseIds.set(b.id, action);
  }
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && toolUseIds.has(b.tool_use_id)) return JSON.parse(String(b.content)).approval_id;
    }
  }
  throw new Error(`no approval for ${action}`);
}
