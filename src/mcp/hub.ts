import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApprovalGate, isSensitive, SENSITIVE_ACTIONS } from "../agent/approvals.js";
import { summarise } from "../domain/case.js";
import { REF_PATTERN, spokenRef } from "../domain/refs.js";
import type { SessionEvents } from "../events.js";
import { createBankServer } from "./bank-server.js";
import { createCivicServer } from "./civic-server.js";
import { createNotifyServer } from "./notify-server.js";
import { createTelecomServer } from "./telecom-server.js";
import type { ServiceContext } from "./context.js";

/** Hides personal answers (e.g. date of birth) from the activity feed. */
export function maskForDisplay(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = /dob|date_of_birth|birth/i.test(k) ? "••/••/••••" : v;
  return out;
}

/** Adds `<key>Spoken` next to every reference-looking value so the agent reads them consistently. */
export function withSpokenRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSpokenRefs);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = withSpokenRefs(v);
    if (typeof v === "string" && REF_PATTERN.test(v)) out[`${k}Spoken`] = spokenRef(v);
  }
  return out;
}

export interface HubHooks {
  /** Called when the agent decides the conversation is over. */
  endCall?: (reason: string) => Promise<void> | void;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

type InternalTool = {
  def: Anthropic.Tool;
  run: (input: Record<string, unknown>) => Promise<ToolOutcome>;
};

const PLAN_STATUSES = ["pending", "in_progress", "done", "skipped"] as const;

/**
 * Connects to the MCP servers over in-memory transports, exposes their tools to
 * Claude, routes calls, enforces approvals and emits activity events.
 */
export class ToolHub {
  private readonly clients: Client[] = [];
  private readonly route = new Map<string, { client: Client; server: string }>();
  private readonly internal = new Map<string, InternalTool>();
  private toolDefs: Anthropic.Tool[] = [];
  readonly hooks: HubHooks = {};

  private constructor(
    private readonly ctx: ServiceContext,
    private readonly gate: ApprovalGate,
    private readonly events: SessionEvents,
  ) {}

  static async create(ctx: ServiceContext, gate: ApprovalGate, events: SessionEvents): Promise<ToolHub> {
    const hub = new ToolHub(ctx, gate, events);
    await hub.connect("bank", createBankServer(ctx));
    await hub.connect("civic", createCivicServer(ctx));
    await hub.connect("notify", createNotifyServer(ctx));
    await hub.connect("telecom", createTelecomServer(ctx));
    hub.registerInternalTools();
    return hub;
  }

  private async connect(label: string, server: McpServer): Promise<void> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `sarva-orchestrator-${label}`, version: "0.1.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    this.clients.push(client);
    const { tools } = await client.listTools();
    for (const t of tools) {
      if (this.route.has(t.name)) throw new Error(`Duplicate tool name ${t.name}`);
      this.route.set(t.name, { client, server: label });
      const schema = { ...(t.inputSchema as Record<string, unknown>) } as Anthropic.Tool.InputSchema;
      if (isSensitive(t.name)) {
        schema.properties = {
          ...(schema.properties as Record<string, unknown>),
          approval_id: { type: "string", description: "approval_id from request_user_approval, valid only after the user said yes" },
        };
        schema.required = [...((schema.required as string[]) ?? []), "approval_id"];
      }
      this.toolDefs.push({ name: t.name, description: `[${label} MCP] ${t.description ?? ""}`, input_schema: schema });
    }
  }

  private registerInternalTools(): void {
    this.internal.set("update_plan", {
      def: {
        name: "update_plan",
        description:
          "Show the ordered recovery plan in the user's screen. Call once at the start with all steps, then again (in parallel with other tools) to update statuses.",
        input_schema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: { title: { type: "string" }, status: { type: "string", enum: [...PLAN_STATUSES] } },
                required: ["title", "status"],
              },
            },
          },
          required: ["steps"],
        },
      },
      run: async (input) => {
        const steps = Array.isArray(input.steps) ? (input.steps as Array<{ title: string; status: string }>) : [];
        this.events.emit({ type: "plan", steps });
        return { content: JSON.stringify({ shown: true, steps: steps.length }), isError: false };
      },
    });

    this.internal.set("end_call", {
      def: {
        name: "end_call",
        description:
          "Hang up the voice call. Use only when the user clearly wants to finish (e.g. 'that's all, thanks, bye') AND nothing urgent is pending, or they explicitly ask you to end the call. Say a short warm goodbye in the same turn BEFORE calling this; the line closes a few seconds later, after your goodbye is spoken.",
        input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
      },
      run: async (input) => {
        const reason = String(input.reason ?? "conversation finished");
        await this.hooks.endCall?.(reason);
        return { content: JSON.stringify({ ending: true, reason, note: "Don't say anything else after the goodbye." }), isError: false };
      },
    });

    this.internal.set("request_user_approval", {
      def: {
        name: "request_user_approval",
        description:
          "Register a pending approval for a sensitive action. Afterwards ask the user ONE clear yes/no question and end your turn. Use the returned approval_id only after they say yes.",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...SENSITIVE_ACTIONS] },
            summary: { type: "string", description: "What exactly will be done, e.g. 'Dispute ₹4,999 at ELECTRO MART ONLINE on HDFC ••4821'" },
          },
          required: ["action", "summary"],
        },
      },
      run: async (input) => {
        const action = String(input.action);
        if (!isSensitive(action)) return { content: JSON.stringify({ error: `Unknown sensitive action ${action}` }), isError: true };
        const r = this.gate.request(action, String(input.summary ?? ""));
        this.events.emit({ type: "approval_requested", approvalId: r.approval_id, action, summary: r.summary });
        return { content: JSON.stringify({ ...r, instruction: "Now ask the user a yes/no question and end your turn." }), isError: false };
      },
    });
  }

  tools(): Anthropic.Tool[] {
    return [...this.toolDefs, ...[...this.internal.values()].map((t) => t.def)];
  }

  serverOf(name: string): string {
    return this.route.get(name)?.server ?? "agent";
  }

  async execute(name: string, rawInput: unknown, callId: string): Promise<ToolOutcome> {
    const input = (rawInput && typeof rawInput === "object" ? { ...(rawInput as Record<string, unknown>) } : {}) as Record<string, unknown>;
    const server = this.serverOf(name);
    const started = Date.now();
    this.events.emit({ type: "tool_start", id: callId, name, server, input: maskForDisplay(input) });

    let outcome: ToolOutcome;
    try {
      outcome = await this.dispatch(name, input);
    } catch (e) {
      outcome = { content: JSON.stringify({ error: "TOOL_CRASHED", message: (e as Error).message }), isError: true };
    }

    let parsed: unknown = outcome.content;
    try {
      parsed = withSpokenRefs(JSON.parse(outcome.content));
      outcome = { ...outcome, content: JSON.stringify(parsed) };
    } catch {
      /* keep raw text */
    }
    this.events.emit({ type: "tool_end", id: callId, name, server, ok: !outcome.isError, result: parsed, ms: Date.now() - started });
    if (server !== "agent") this.events.emit({ type: "case", summary: summarise(this.ctx.caseFile) });
    return outcome;
  }

  private async dispatch(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const internal = this.internal.get(name);
    if (internal) return internal.run(input);

    const target = this.route.get(name);
    if (!target) return { content: JSON.stringify({ error: `Unknown tool ${name}` }), isError: true };

    if (isSensitive(name)) {
      const approvalId = typeof input.approval_id === "string" ? input.approval_id : undefined;
      const verdict = this.gate.consume(approvalId, name);
      if (!verdict.ok) {
        this.events.emit({ type: "approval_rejected", approvalId, action: name, reason: verdict.reason });
        return { content: JSON.stringify({ error: "APPROVAL_REQUIRED", message: verdict.reason }), isError: true };
      }
      this.events.emit({ type: "approval_granted", approvalId: approvalId!, action: name });
    }
    delete input.approval_id;

    const res = await target.client.callTool({ name, arguments: input });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { content: text || "{}", isError: Boolean(res.isError) };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }
}
