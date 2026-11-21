import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { ApprovalGate } from "./agent/approvals.js";
import { Orchestrator, type TurnResult } from "./agent/orchestrator.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { newCaseFile, summarise, type CaseFile } from "./domain/case.js";
import { defaultProfile, type Profile } from "./domain/profile.js";
import { SessionEvents } from "./events.js";
import { defaultIdGen, type ServiceContext } from "./mcp/context.js";
import { ToolHub } from "./mcp/hub.js";
import { BankSimulator } from "./services/bank.js";
import { BankCallSimulator } from "./services/bank-call.js";
import type { EmailSender } from "./services/email.js";
import type { GeoService } from "./services/geo.js";

export interface SessionDeps {
  orchestrator: Orchestrator;
  geo: GeoService;
  email: EmailSender;
  /** Current profile; read when each session starts so Settings changes apply to new sessions. */
  profile?: () => Profile;
  userEmail?: string;
  bankOutages: string[];
  now?: () => Date;
  idGen?: (prefix: string) => string;
  /** Delay between simulated call steps (ms); 0 in tests. */
  callStepDelayMs?: number;
}

/** Speaks a line into the live call (Agora `speak` API); injected by the app. */
export type Announcer = (session: Session, text: string) => Promise<boolean>;

export class Session {
  readonly history: Anthropic.MessageParam[] = [];
  agentId?: string;
  channel?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pendingAlerts: string[] = [];

  private constructor(
    readonly id: string,
    readonly caseFile: CaseFile,
    readonly hub: ToolHub,
    readonly gate: ApprovalGate,
    readonly events: SessionEvents,
    readonly bank: BankSimulator,
    readonly calls: BankCallSimulator,
    readonly profile: Profile,
    private readonly orchestrator: Orchestrator,
    readonly system: string,
  ) {}

  static async create(id: string, deps: SessionDeps): Promise<Session> {
    const now = deps.now ?? (() => new Date());
    const idGen = deps.idGen ?? defaultIdGen;
    const profile = deps.profile?.() ?? defaultProfile(deps.userEmail ?? "");
    if (!profile.email && deps.userEmail) profile.email = deps.userEmail;
    const caseFile = newCaseFile({ caseId: idGen("CASE"), profile, now: now() });
    const bank = new BankSimulator({ now, outages: deps.bankOutages, idGen, cards: profile.cards });
    const gate = new ApprovalGate();
    const events = new SessionEvents();
    const calls = new BankCallSimulator({ now, idGen, stepDelayMs: deps.callStepDelayMs, onUpdate: (call) => events.emit({ type: "bank_call", call }) });
    const ctx: ServiceContext = { caseFile, bank, geo: deps.geo, email: deps.email, now, idGen, calls };
    const hub = await ToolHub.create(ctx, gate, events);
    const system = buildSystemPrompt(caseFile, bank.listCards());
    return new Session(id, caseFile, hub, gate, events, bank, calls, profile, deps.orchestrator, system);
  }

  /** Serialises turns: a new utterance waits for the previous turn to finish. */
  say(userText: string, onText?: (d: string) => void): Promise<TurnResult> {
    const run = () =>
      this.orchestrator.runTurn(
        { history: this.history, system: this.system, hub: this.hub, gate: this.gate, events: this.events, takeAlerts: () => this.pendingAlerts.splice(0) },
        userText,
        onText,
      );
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Card watch: a new charge attempt hit one of the user's cards. Records it, shows it
   * in the UI, speaks it into the live call if one is running, and queues it so the
   * agent reacts on the next turn.
   */
  async cardWatchEvent(opts: { cardId?: string; amountInr?: number; merchant?: string } = {}, announce?: Announcer) {
    const t = this.bank.simulateAttempt(opts);
    const card = this.bank.listCards().find((c) => c.id === t.cardId)!;
    const outcome = t.status === "declined" ? "declined" : "approved";
    this.caseFile.cardAlerts.push({ txnId: t.id, cardId: card.id, last4: card.last4, bank: card.bankName, amountInr: t.amountInr, merchant: t.merchant, outcome, at: t.at });
    if (t.suspicious && !this.caseFile.flaggedTransactions.some((x) => x.id === t.id)) this.caseFile.flaggedTransactions.push(t);

    const spokenText =
      outcome === "declined"
        ? `Card watch: someone just tried to charge ${t.amountInr} rupees at ${t.merchant} on your ${card.bankName} card ending ${card.last4}. It was declined because the card is already blocked. You're safe.`
        : `Card watch alert: a ${t.amountInr} rupee charge at ${t.merchant} just went through on your ${card.bankName} card ending ${card.last4}, which is still active. Say "freeze it" and I'll block it now.`;
    this.pendingAlerts.push(`[Card watch alert, from the monitoring system and not the user: ${t.id}, ₹${t.amountInr} at ${t.merchant} on ${card.bankName} ••${card.last4} (card id ${card.id}) was ${outcome.toUpperCase()}. Card status: ${card.status}. The user has already been told this aloud.]`);

    let spoken = false;
    if (announce && this.agentId) spoken = await announce(this, spokenText).catch(() => false);
    this.events.emit({ type: "card_alert", cardId: card.id, last4: card.last4, bank: card.bankName, amountInr: t.amountInr, merchant: t.merchant, outcome, spoken });
    this.events.emit({ type: "case", summary: summarise(this.caseFile) });
    return { transaction: t, outcome, spoken, spokenText };
  }

  /** User tapped "I'll call myself": hang up Sarva's call and tell the agent. */
  switchToCopilot(callId: string) {
    const call = this.calls.cancel(callId);
    if (!call) throw new Error("call not found");
    this.pendingAlerts.push(`[System note, not the user: the user tapped "I'll call myself" for the ${call.bank} card ending ${call.last4} (card id ${call.cardId}). Call start_call_copilot for it, guide them briefly, and record_manual_block when they tell you the reference.]`);
    return call;
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
