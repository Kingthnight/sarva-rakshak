import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { ApprovalGate } from "./agent/approvals.js";
import { Orchestrator, type TurnResult } from "./agent/orchestrator.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { newCaseFile, type CaseFile } from "./domain/case.js";
import { SessionEvents } from "./events.js";
import { defaultIdGen, type ServiceContext } from "./mcp/context.js";
import { ToolHub } from "./mcp/hub.js";
import { BankSimulator } from "./services/bank.js";
import type { EmailSender } from "./services/email.js";
import type { GeoService } from "./services/geo.js";

export interface SessionDeps {
  orchestrator: Orchestrator;
  geo: GeoService;
  email: EmailSender;
  userEmail: string;
  bankOutages: string[];
  now?: () => Date;
  idGen?: (prefix: string) => string;
}

export class Session {
  readonly history: Anthropic.MessageParam[] = [];
  agentId?: string;
  channel?: string;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly id: string,
    readonly caseFile: CaseFile,
    readonly hub: ToolHub,
    readonly gate: ApprovalGate,
    readonly events: SessionEvents,
    private readonly orchestrator: Orchestrator,
    readonly system: string,
  ) {}

  static async create(id: string, deps: SessionDeps): Promise<Session> {
    const now = deps.now ?? (() => new Date());
    const idGen = deps.idGen ?? defaultIdGen;
    const caseFile = newCaseFile({ caseId: idGen("CASE"), email: deps.userEmail, now: now() });
    const ctx: ServiceContext = {
      caseFile,
      bank: new BankSimulator({ now, outages: deps.bankOutages, idGen }),
      geo: deps.geo,
      email: deps.email,
      now,
      idGen,
    };
    const gate = new ApprovalGate();
    const events = new SessionEvents();
    const hub = await ToolHub.create(ctx, gate, events);
    return new Session(id, caseFile, hub, gate, events, deps.orchestrator, buildSystemPrompt(caseFile));
  }

  /** Serialises turns: a new utterance waits for the previous turn to finish. */
  say(userText: string, onText?: (d: string) => void): Promise<TurnResult> {
    const run = () =>
      this.orchestrator.runTurn({ history: this.history, system: this.system, hub: this.hub, gate: this.gate, events: this.events }, userText, onText);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.hub.close();
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly deps: SessionDeps) {}

  async create(id: string = randomUUID().slice(0, 8)): Promise<Session> {
    const s = await Session.create(id, this.deps);
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async getOrCreate(id: string): Promise<Session> {
    return this.get(id) ?? this.create(id);
  }

  async remove(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.close();
  }
}
