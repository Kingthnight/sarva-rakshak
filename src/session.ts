import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { ApprovalGate } from "./agent/approvals.js";
import { Orchestrator, type TurnResult } from "./agent/orchestrator.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { newCaseFile, summarise, type CaseFile } from "./domain/case.js";
import { defaultProfile, type Profile } from "./domain/profile.js";
import { SessionEvents } from "./events.js";
import type { SayMeta } from "./llm-proxy.js";
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
  /** What the agent generated in the most recent voice turn, and where the user cut in. */
  private lastTurn?: { generated: string; cutAt?: number; done: boolean };

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
    const ctx: ServiceContext = { caseFile, bank, geo: deps.geo, email: deps.email, now, idGen, calls, profile };
    const hub = await ToolHub.create(ctx, gate, events);
    const system = buildSystemPrompt(caseFile, bank.listCards());
    return new Session(id, caseFile, hub, gate, events, bank, calls, profile, deps.orchestrator, system);
  }

  /**
   * Serialises turns: a new utterance waits for the previous turn to finish (so tool work
   * is never lost). If the user spoke over the agent, the unheard part of the last reply
   * is handed to the agent so it can briefly finish anything important.
   */
  say(userText: string, onText?: (d: string) => void, meta: SayMeta = {}): Promise<TurnResult> {
    // Barge-in: a new utterance while the previous reply is still being produced.
    if (this.lastTurn && !this.lastTurn.done) this.lastTurn.cutAt ??= this.lastTurn.generated.length;
    const run = () => {
      const missed = this.unheardFromLastTurn(meta.heard);
      if (missed) {
        this.pendingAlerts.push(
          `[Interruption note, not from the user: they spoke over you, so they did NOT hear this part of your previous reply: "${missed}". If any of it matters (a reference number, a warning, an instruction or a question you asked), open with "Quickly, before I forget," and give it in one short sentence, then respond to what they just said. If their new message makes it irrelevant, skip it. Don't repeat anything they already heard.]`,
        );
        this.events.emit({ type: "interrupted", missed });
      }
      const turn = { generated: "", done: false } as NonNullable<Session["lastTurn"]>;
      this.lastTurn = turn;
      meta.signal?.addEventListener("abort", () => (turn.cutAt ??= turn.generated.length), { once: true });
      return this.orchestrator
        .runTurn(
          { history: this.history, system: this.system, hub: this.hub, gate: this.gate, events: this.events, takeAlerts: () => this.pendingAlerts.splice(0) },
          userText,
          (d) => {
            turn.generated += d;
            onText?.(d);
          },
        )
        .finally(() => (turn.done = true));
    };
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

  /** Text of the previous reply the user didn't hear, or "" if they heard it all. */
  private unheardFromLastTurn(heard?: string): string {
    const t = this.lastTurn;
    if (!t || !t.generated.trim()) return "";
    let missed = t.cutAt != null ? t.generated.slice(t.cutAt) : "";
    // Agora's own record of the last reply is truncated to what was spoken when interrupted.
    if (heard != null) {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const g = norm(t.generated);
      const h = norm(heard);
      if (h && g.startsWith(h) && g.length - h.length > 20) missed = g.slice(h.length);
    }
    missed = missed.trim();
    return missed.length > 15 ? missed.slice(0, 600) : "";
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
  /** Set by the app: how to actually hang up a voice call (Agora leave). */
  onEndCall?: (s: Session, reason: string) => Promise<void> | void;
  constructor(private readonly deps: SessionDeps) {}

  async create(id: string = randomUUID().slice(0, 8)): Promise<Session> {
    const s = await Session.create(id, this.deps);
    s.hub.hooks.endCall = async (reason) => {
      s.events.emit({ type: "call_ended", reason });
      await this.onEndCall?.(s, reason);
    };
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
