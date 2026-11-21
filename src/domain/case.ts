import type { Dispute, FlaggedTransaction } from "../services/bank.js";
import type { ReissueGuide } from "../services/reissue.js";
import type { Place } from "../services/geo.js";

export interface CardAction {
  cardId: string;
  bank: string;
  last4: string;
  method: "api" | "sms";
  reference: string;
  status: string;
  at: string;
}

export interface Reminder {
  id: string;
  title: string;
  dueAt: string;
  notes?: string;
}

export interface LostReport {
  reference: string;
  station?: Place;
  items: string[];
  location: string;
  lostAt: string;
  narrative: string;
  submittedAt: string;
  portal: "simulated-police-portal";
  pdfBase64: string;
}

export interface SentEmail {
  to: string;
  subject: string;
  id: string;
  mode: "dry-run" | "live";
  at: string;
}

export interface CaseFile {
  caseId: string;
  createdAt: string;
  user: { name: string; email: string; phoneMasked: string; city: string };
  incident: { items: string[]; location?: string; lostAt?: string };
  cardActions: CardAction[];
  flaggedTransactions: FlaggedTransaction[];
  disputes: Dispute[];
  nearestStation?: Place;
  report?: LostReport;
  reissue: ReissueGuide[];
  reminders: Reminder[];
  emails: SentEmail[];
}

export function newCaseFile(opts: { caseId: string; email: string; now?: Date }): CaseFile {
  return {
    caseId: opts.caseId,
    createdAt: (opts.now ?? new Date()).toISOString(),
    user: { name: "Arjun Rao", email: opts.email, phoneMasked: "+91 98XXXX4210", city: "Bengaluru" },
    incident: { items: [] },
    cardActions: [],
    flaggedTransactions: [],
    disputes: [],
    reissue: [],
    reminders: [],
    emails: [],
  };
}

/** Compact summary used by the UI and the case-file email. */
export function summarise(c: CaseFile) {
  return {
    caseId: c.caseId,
    items: c.incident.items,
    location: c.incident.location,
    cards: c.cardActions.map((a) => `${a.bank} ••${a.last4}: ${a.status} via ${a.method} (ref ${a.reference})`),
    flagged: c.flaggedTransactions.filter((t) => t.suspicious).map((t) => `₹${t.amountInr} at ${t.merchant} (${t.id})`),
    disputes: c.disputes.map((d) => `${d.disputeId} for ₹${d.amountInr}`),
    report: c.report ? `${c.report.reference}${c.report.station ? ` (${c.report.station.name})` : ""}` : undefined,
    reissue: c.reissue.map((g) => g.title),
    reminders: c.reminders.map((r) => `${r.title} @ ${r.dueAt}`),
    emails: c.emails.map((e) => `${e.subject} → ${e.to} [${e.mode}]`),
  };
}
