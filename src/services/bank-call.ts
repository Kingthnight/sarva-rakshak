/**
 * "Sarva calls the bank for you": a SIMULATED outbound helpline call.
 * Real calling would use a SIP trunk (e.g. Twilio via Agora Studio) plus
 * phone-menu (keypad) navigation; this models the same states so the UX and
 * agent flow are real while the bank side is clearly labelled as simulated.
 */
import type { Card } from "./bank.js";

export type CallState = "dialing" | "menu" | "on_hold" | "verifying" | "blocking" | "completed" | "cancelled" | "failed";

export interface CallStep {
  label: string;
  status: "done" | "active" | "waiting_user";
  at: string;
}

export interface BankCall {
  callId: string;
  cardId: string;
  bank: string;
  last4: string;
  helpline: string;
  state: CallState;
  steps: CallStep[];
  reference?: string;
  simulated: true;
  mode: "sarva_calls" | "copilot";
}

export interface BankCallOptions {
  now?: () => Date;
  idGen?: (prefix: string) => string;
  stepDelayMs?: number; // 0 in tests
  onUpdate?: (call: BankCall) => void;
  refDigits?: () => string;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Plausible date of birth: DD/MM/YYYY, "12 March 1998", "1998-03-12", etc. Not validated against anything. */
export function looksLikeDob(answer: string): boolean {
  const a = answer.trim();
  return /\b(19|20)\d{2}\b/.test(a) && (/\d{1,2}[\/\-. ]\d{1,2}[\/\-. ](19|20)\d{2}/.test(a) || /(19|20)\d{2}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(a) || /[a-z]{3,}/i.test(a));
}

export class BankCallSimulator {
  private readonly calls = new Map<string, BankCall>();
  private readonly now: () => Date;
  private readonly idGen: (prefix: string) => string;
  private readonly delay: number;
  onUpdate: (call: BankCall) => void;
  private readonly refDigits: () => string;

  constructor(opts: BankCallOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.idGen = opts.idGen ?? ((p) => `${p}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`);
    this.delay = opts.stepDelayMs ?? 1100;
    this.onUpdate = opts.onUpdate ?? (() => {});
    this.refDigits = opts.refDigits ?? (() => String(10000 + Math.floor(Math.random() * 90000)));
  }

  get(callId: string): BankCall | undefined {
    const c = this.calls.get(callId);
    return c && structuredClone(c);
  }

  forCard(cardId: string): BankCall | undefined {
    return [...this.calls.values()].reverse().find((c) => c.cardId === cardId);
  }

  private push(call: BankCall, label: string, state: CallState, status: CallStep["status"] = "done") {
    call.steps.forEach((s) => s.status === "active" && (s.status = "done"));
    call.steps.push({ label, status, at: this.now().toISOString() });
    call.state = state;
    this.onUpdate(structuredClone(call));
  }

  /** Dials and navigates the phone menu until the bank asks to verify the cardholder. */
  async start(card: Card): Promise<BankCall> {
    const existing = this.forCard(card.id);
    if (existing && !["completed", "cancelled", "failed"].includes(existing.state)) return structuredClone(existing);
    const call: BankCall = {
      callId: this.idGen("CALL"),
      cardId: card.id,
      bank: card.bankName,
      last4: card.last4,
      helpline: card.helpline,
      state: "dialing",
      steps: [],
      simulated: true,
      mode: "sarva_calls",
    };
    this.calls.set(call.callId, call);
    this.push(call, `Dialing ${card.bankName} · ${card.helpline}`, "dialing", "active");
    await sleep(this.delay);
    for (const [label, state] of [
      ["Phone menu: selected English", "menu"],
      ["Phone menu: Cards → Report lost or stolen card", "menu"],
      ["On hold for an agent…", "on_hold"],
    ] as const) {
      if (call.state === "cancelled") return structuredClone(call);
      this.push(call, label, state, state === "on_hold" ? "active" : "done");
      await sleep(this.delay);
    }
    if (call.state === "cancelled") return structuredClone(call);
    this.push(call, `Bank agent: "To verify the cardholder of the card ending ${card.last4}, please confirm the date of birth."`, "verifying", "waiting_user");
    return structuredClone(call);
  }

  /** Passes the cardholder's answer to the bank and completes the block. */
  async verify(callId: string, dateOfBirth: string): Promise<BankCall> {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Unknown call ${callId}`);
    if (call.state !== "verifying") throw new Error(`Call ${callId} is not waiting for verification (state: ${call.state})`);
    if (!looksLikeDob(dateOfBirth)) {
      this.push(call, "Bank agent: \"Sorry, I didn't get that date. Could you repeat the date of birth?\"", "verifying", "waiting_user");
      throw new Error("The bank couldn't understand the date of birth; ask the user to repeat it, as day, month and year");
    }
    this.push(call, "Verified the cardholder (date of birth confirmed)", "blocking", "done");
    await sleep(this.delay);
    this.push(call, `Bank agent is blocking the card ending ${call.last4}…`, "blocking", "active");
    await sleep(this.delay);
    // Short and easy to say aloud, like real helpline complaint numbers: "ICI-48213".
    call.reference = `${call.bank.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}-${this.refDigits()}`;
    this.push(call, `Card ending ${call.last4} BLOCKED · reference ${call.reference}`, "completed");
    return structuredClone(call);
  }

  /** User decided to call themselves: hang up and switch to co-pilot mode. */
  cancel(callId: string): BankCall | undefined {
    const call = this.calls.get(callId);
    if (!call || ["completed", "cancelled"].includes(call.state)) return call && structuredClone(call);
    call.mode = "copilot";
    this.push(call, "Sarva hung up. You're calling the bank yourself; co-pilot mode is on", "cancelled");
    return structuredClone(call);
  }
}
