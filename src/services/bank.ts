/**
 * Simulated bank back-end. No public APIs exist for blocking Indian bank cards,
 * so this models realistic behaviour (including outages) for the demo.
 * Every result carries `simulated: true` so nothing is presented as real.
 */

export type CardStatus = "active" | "frozen" | "block_requested";

export interface Card {
  id: string;
  bank: string;
  kind: "credit" | "debit";
  network: string;
  last4: string;
  status: CardStatus;
  smsBlockNumber: string;
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

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export interface BankOptions {
  now?: () => Date;
  outages?: string[]; // bank names whose freeze API is down
  idGen?: (prefix: string) => string;
}

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000).toISOString();

let counter = 0;
const defaultId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${(++counter).toString(36).toUpperCase()}`;

export class BankSimulator {
  private readonly cards: Card[];
  private readonly txns: Transaction[];
  private readonly disputes: Dispute[] = [];
  private readonly now: () => Date;
  private readonly outages: Set<string>;
  private readonly idGen: (prefix: string) => string;

  constructor(opts: BankOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.outages = new Set((opts.outages ?? []).map((b) => b.toUpperCase()));
    this.idGen = opts.idGen ?? defaultId;
    const now = this.now();
    this.cards = [
      { id: "hdfc-cc-4821", bank: "HDFC", kind: "credit", network: "Visa", last4: "4821", status: "active", smsBlockNumber: "7308080808" },
      { id: "sbi-dc-1093", bank: "SBI", kind: "debit", network: "RuPay", last4: "1093", status: "active", smsBlockNumber: "567676" },
    ];
    this.txns = [
      { id: "txn-1001", cardId: "hdfc-cc-4821", amountInr: 340, merchant: "Swiggy", channel: "online", at: minutesAgo(now, 150), city: "Bengaluru", knownMerchant: true },
      { id: "txn-1002", cardId: "hdfc-cc-4821", amountInr: 4999, merchant: "ELECTRO MART ONLINE", channel: "online", at: minutesAgo(now, 12), city: "Unknown", knownMerchant: false },
      { id: "txn-2001", cardId: "sbi-dc-1093", amountInr: 200, merchant: "Namma Metro recharge", channel: "upi", at: minutesAgo(now, 26 * 60), city: "Bengaluru", knownMerchant: true },
    ];
  }

  listCards(): Card[] {
    return this.cards.map((c) => ({ ...c }));
  }

  private card(cardId: string): Card {
    const c = this.cards.find((x) => x.id === cardId || x.last4 === cardId);
    if (!c) throw new NotFoundError(`Card ${cardId}`);
    return c;
  }

  freezeCard(cardId: string) {
    const c = this.card(cardId);
    if (this.outages.has(c.bank.toUpperCase())) throw new BankUnavailableError(c.bank);
    c.status = "frozen";
    return {
      simulated: true as const,
      cardId: c.id,
      bank: c.bank,
      last4: c.last4,
      status: c.status,
      reference: this.idGen(`${c.bank}-BLK`),
      frozenAt: this.now().toISOString(),
    };
  }

  /** Fallback when the card-control API is down: the bank's official SMS block command. */
  smsBlock(cardId: string) {
    const c = this.card(cardId);
    c.status = "block_requested";
    return {
      simulated: true as const,
      cardId: c.id,
      bank: c.bank,
      last4: c.last4,
      status: c.status,
      method: "sms" as const,
      smsTo: c.smsBlockNumber,
      smsBody: `BLOCK ${c.last4}`,
      reference: this.idGen(`${c.bank}-SMS`),
      note: "Block request sent via SMS from the registered mobile number; bank confirms by SMS within minutes.",
    };
  }

  recentTransactions(cardId: string, withinMinutes = 24 * 60): FlaggedTransaction[] {
    const c = this.card(cardId);
    const cutoff = this.now().getTime() - withinMinutes * 60_000;
    return this.txns
      .filter((t) => t.cardId === c.id && new Date(t.at).getTime() >= cutoff)
      .map((t) => {
        const ageMin = Math.round((this.now().getTime() - new Date(t.at).getTime()) / 60_000);
        const suspicious = !t.knownMerchant && (t.channel === "online" || t.channel === "upi") && ageMin <= 120;
        return {
          ...t,
          suspicious,
          reason: suspicious
            ? `New merchant, card-not-present ${t.channel} payment ${ageMin} minutes ago, outside usual pattern`
            : undefined,
        };
      });
  }

  raiseDispute(txnId: string, reason: string): Dispute & { simulated: true } {
    const t = this.txns.find((x) => x.id === txnId);
    if (!t) throw new NotFoundError(`Transaction ${txnId}`);
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
