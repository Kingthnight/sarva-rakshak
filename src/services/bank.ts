/**
 * Simulated bank back-end. No public APIs exist for blocking Indian bank cards,
 * so this models realistic behaviour: API freeze, SMS fallback, call-only banks,
 * outages, fraud flags, declined attempts on frozen cards, and replacements.
 * Every result carries `simulated: true` so nothing is presented as real.
 */
import { defaultProfile, type CardProfile } from "../domain/profile.js";
import { bankInfo, telLink, type BlockChannel } from "./banks.js";

export type CardStatus = "active" | "frozen" | "block_requested" | "blocked";

export interface Card {
  id: string;
  bank: string;
  bankName: string;
  kind: CardProfile["kind"];
  network: string;
  last4: string;
  nickname?: string;
  status: CardStatus;
  channels: BlockChannel[];
  helpline: string;
  sms?: { number: string; body: string };
}

export interface Transaction {
  id: string;
  cardId: string;
  amountInr: number;
  merchant: string;
  channel: "online" | "pos" | "atm" | "upi";
  at: string; // ISO time
  city: string;
  knownMerchant: boolean;
  status: "approved" | "declined";
  declineReason?: string;
}

export interface FlaggedTransaction extends Transaction {
  suspicious: boolean;
  reason?: string;
}

export interface Dispute {
  disputeId: string;
  txnId: string;
  cardId: string;
  amountInr: number;
  reason: string;
  status: "filed";
  expectedResolution: string;
}

export class BankUnavailableError extends Error {
  constructor(public readonly bank: string) {
    super(`${bank} card-control service is temporarily unavailable (HTTP 503)`);
    this.name = "BankUnavailableError";
  }
}

export class CallRequiredError extends Error {
  constructor(public readonly card: Card) {
    super(`${card.bankName} does not support blocking this card online; the cardholder must call ${card.helpline || "the bank helpline"}`);
    this.name = "CallRequiredError";
  }
}

export class ChannelUnsupportedError extends Error {
  constructor(public readonly card: Card, channel: BlockChannel) {
    super(`${card.bankName} card ••${card.last4} cannot be blocked via ${channel}`);
    this.name = "ChannelUnsupportedError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export interface BankOptions {
  now?: () => Date;
  outages?: string[]; // bank codes whose freeze API is down
  idGen?: (prefix: string) => string;
  cards?: CardProfile[];
}

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000).toISOString();

let counter = 0;
const defaultId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${(++counter).toString(36).toUpperCase()}`;

const KNOWN_MERCHANTS: Array<[string, Transaction["channel"], number]> = [
  ["Swiggy", "online", 340],
  ["Namma Metro recharge", "upi", 200],
  ["BigBasket", "online", 1260],
  ["Indian Oil, Indiranagar", "pos", 1500],
];

export function toCard(p: CardProfile): Card {
  const info = bankInfo(p.bank);
  const channels = p.channels ?? info.channels;
  const smsNumber = p.smsNumber ?? info.sms?.number;
  const smsFormat = p.smsFormat ?? info.sms?.format ?? "BLOCK {last4}";
  return {
    id: p.id,
    bank: p.bank.toUpperCase(),
    bankName: info.name,
    kind: p.kind,
    network: p.network,
    last4: p.last4,
    nickname: p.nickname,
    status: "active",
    channels,
    helpline: p.helpline ?? info.helpline,
    sms: channels.includes("sms") && smsNumber ? { number: smsNumber, body: smsFormat.replace("{last4}", p.last4) } : undefined,
  };
}

export class BankSimulator {
  private readonly cards: Card[];
  private readonly txns: Transaction[] = [];
  private readonly disputes: Dispute[] = [];
  private readonly now: () => Date;
  private readonly outages: Set<string>;
  private readonly idGen: (prefix: string) => string;
  private attemptSeq = 0;

  constructor(opts: BankOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.outages = new Set((opts.outages ?? []).map((b) => b.toUpperCase()));
    this.idGen = opts.idGen ?? defaultId;
    this.cards = (opts.cards ?? defaultProfile().cards).map(toCard);
    const now = this.now();
    this.cards.forEach((c, i) => {
      const [merchant, channel, amount] = KNOWN_MERCHANTS[i % KNOWN_MERCHANTS.length];
      this.txns.push({ id: `txn-${i + 1}001`, cardId: c.id, amountInr: amount, merchant, channel, at: minutesAgo(now, 150 + i * 600), city: "Bengaluru", knownMerchant: true, status: "approved" });
    });
    // The demo's fraud: a fresh online charge on the first credit card (or the first card).
    const target = this.cards.find((c) => c.kind === "credit") ?? this.cards[0];
    if (target) {
      this.txns.push({ id: "txn-9002", cardId: target.id, amountInr: 4999, merchant: "ELECTRO MART ONLINE", channel: "online", at: minutesAgo(now, 12), city: "Unknown", knownMerchant: false, status: "approved" });
    }
  }

  listCards(): Card[] {
    return this.cards.map((c) => ({ ...c }));
  }

  private card(cardId: string): Card {
    const q = cardId.trim().toLowerCase();
    const c = this.cards.find((x) => x.id.toLowerCase() === q || x.last4 === q);
    if (!c) throw new NotFoundError(`Card ${cardId}`);
    return c;
  }

  blockOptions(cardId: string) {
    const c = this.card(cardId);
    return {
      simulated: true as const,
      cardId: c.id,
      bank: c.bankName,
      last4: c.last4,
      status: c.status,
      channels: c.channels,
      helpline: c.helpline,
      tel: telLink(c.helpline),
      sms: c.sms ? { to: c.sms.number, body: c.sms.body } : undefined,
      callScript: `Hello, I'm calling to block my ${c.bankName} ${c.kind} card ending ${c.last4.split("").join(" ")}. It was lost or stolen. Please block it immediately and give me the complaint reference number. I'd also like to report any transactions after the loss as unauthorised.`,
    };
  }

  freezeCard(cardId: string) {
    const c = this.card(cardId);
    if (!c.channels.includes("api")) throw new CallRequiredError(c);
    if (this.outages.has(c.bank)) throw new BankUnavailableError(c.bankName);
    c.status = "frozen";
    return { simulated: true as const, cardId: c.id, bank: c.bankName, last4: c.last4, status: c.status, reference: this.idGen(`${c.bank}-BLK`), frozenAt: this.now().toISOString() };
  }

  /** Fallback when the card-control API is down: the bank's official SMS block command. */
  smsBlock(cardId: string) {
    const c = this.card(cardId);
    if (!c.sms) throw new ChannelUnsupportedError(c, "sms");
    c.status = "block_requested";
    return {
      simulated: true as const,
      cardId: c.id,
      bank: c.bankName,
      last4: c.last4,
      status: c.status,
      method: "sms" as const,
      smsTo: c.sms.number,
      smsBody: c.sms.body,
      reference: this.idGen(`${c.bank}-SMS`),
      note: "Block request sent via SMS from the registered mobile number; the bank confirms by SMS within minutes.",
    };
  }

  /** The user blocked the card themselves (helpline call, branch or app); record their reference. */
  recordManualBlock(cardId: string, method: "call" | "app" | "branch", reference: string) {
    const c = this.card(cardId);
    c.status = "blocked";
    return { simulated: true as const, cardId: c.id, bank: c.bankName, last4: c.last4, status: c.status, method, reference, recordedAt: this.now().toISOString() };
  }

  requestReplacement(cardId: string, deliverTo: string) {
    const c = this.card(cardId);
    if (c.status === "active") throw new Error(`Card ••${c.last4} is still active; block it before requesting a replacement`);
    const eta = new Date(this.now().getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    return { simulated: true as const, requestId: this.idGen(`${c.bank}-RPL`), cardId: c.id, bank: c.bankName, last4: c.last4, deliverTo, expectedBy: eta };
  }

  recentTransactions(cardId: string, withinMinutes = 24 * 60): FlaggedTransaction[] {
    const c = this.card(cardId);
    const cutoff = this.now().getTime() - withinMinutes * 60_000;
    return this.txns
      .filter((t) => t.cardId === c.id && new Date(t.at).getTime() >= cutoff)
      .map((t) => this.flag(t));
  }

  private flag(t: Transaction): FlaggedTransaction {
    const ageMin = Math.round((this.now().getTime() - new Date(t.at).getTime()) / 60_000);
    const suspicious = !t.knownMerchant && t.channel !== "pos" && ageMin <= 120;
    const what = t.status === "declined" ? `attempt was DECLINED (${t.declineReason})` : `payment went through ${ageMin} minutes ago`;
    return { ...t, suspicious, reason: suspicious ? `New merchant, card-not-present ${t.channel}; ${what}` : undefined };
  }

  /**
   * Card watch demo: a new charge attempt arrives. Declined if the card is already
   * frozen/blocked; otherwise it goes through and is flagged.
   */
  simulateAttempt(opts: { cardId?: string; amountInr?: number; merchant?: string } = {}): FlaggedTransaction {
    const c = opts.cardId ? this.card(opts.cardId) : this.cards[0];
    if (!c) throw new NotFoundError("Card");
    const blocked = c.status !== "active";
    const t: Transaction = {
      id: `txn-w${++this.attemptSeq}`,
      cardId: c.id,
      amountInr: opts.amountInr ?? 12499,
      merchant: opts.merchant ?? "QUICKGADGETS.IN",
      channel: "online",
      at: this.now().toISOString(),
      city: "Unknown",
      knownMerchant: false,
      status: blocked ? "declined" : "approved",
      declineReason: blocked ? `card ${c.status.replace("_", " ")}` : undefined,
    };
    this.txns.push(t);
    return this.flag(t);
  }

  raiseDispute(txnId: string, reason: string): Dispute & { simulated: true } {
    const t = this.txns.find((x) => x.id === txnId);
    if (!t) throw new NotFoundError(`Transaction ${txnId}`);
    if (t.status === "declined") throw new Error(`Transaction ${txnId} was declined; no money left the account, so there is nothing to dispute`);
    const existing = this.disputes.find((d) => d.txnId === txnId);
    if (existing) return { ...existing, simulated: true };
    const d: Dispute = {
      disputeId: this.idGen("DSP"),
      txnId,
      cardId: t.cardId,
      amountInr: t.amountInr,
      reason,
      status: "filed",
      expectedResolution: "Provisional credit within 10 working days (RBI limited-liability rules apply when reported within 3 days)",
    };
    this.disputes.push(d);
    return { ...d, simulated: true };
  }
}
