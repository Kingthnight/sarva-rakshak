import type { Dispute, FlaggedTransaction } from "../services/bank.js";
import type { ReissueGuide } from "../services/reissue.js";
import type { Place } from "../services/geo.js";
import { defaultProfile, type Profile } from "./profile.js";

export interface CardAction {
  cardId: string;
  bank: string;
  last4: string;
  method: "api" | "sms" | "call" | "app" | "branch";
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

export interface ActionNeeded {
  id: string;
  title: string;
  detail: string;
  tel?: string;
  cardId?: string;
  done: boolean;
}

export interface CardAlert {
  txnId: string;
  cardId: string;
  last4: string;
  bank: string;
  amountInr: number;
  merchant: string;
  outcome: "declined" | "approved";
  at: string;
}

export interface Replacement {
  requestId: string;
  cardId: string;
  bank: string;
  last4: string;
  deliverTo: string;
  expectedBy: string;
}

export interface CaseFile {
  caseId: string;
  createdAt: string;
  user: { name: string; email: string; phoneMasked: string; city: string; emergencyContact?: Profile["emergencyContact"]; documents: string[]; device?: Profile["device"] };
  incident: { items: string[]; location?: string; lostAt?: string };
  cardActions: CardAction[];
  flaggedTransactions: FlaggedTransaction[];
  disputes: Dispute[];
  nearestStation?: Place;
  report?: LostReport;
  reissue: ReissueGuide[];
  reminders: Reminder[];
  emails: SentEmail[];
  actionsNeeded: ActionNeeded[];
  cardAlerts: CardAlert[];
  replacements: Replacement[];
  phoneActions: Array<{ action: string; reference?: string; detail: string; at: string }>;
  contactMessages: Array<{ to: string; text: string; reference: string; at: string }>;
}

export function newCaseFile(opts: { caseId: string; email?: string; profile?: Profile; now?: Date }): CaseFile {
  const p = opts.profile ?? defaultProfile(opts.email ?? "");
  return {
    caseId: opts.caseId,
    createdAt: (opts.now ?? new Date()).toISOString(),
    user: { name: p.name, email: p.email || opts.email || "", phoneMasked: p.phone, city: p.city, emergencyContact: p.emergencyContact, documents: p.documents, device: p.device },
    incident: { items: [] },
    cardActions: [],
    flaggedTransactions: [],
    disputes: [],
    reissue: [],
    reminders: [],
    emails: [],
    actionsNeeded: [],
    cardAlerts: [],
    replacements: [],
    phoneActions: [],
    contactMessages: [],
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
    actionsNeeded: c.actionsNeeded.map((a) => ({ id: a.id, title: a.title, detail: a.detail, tel: a.tel, done: a.done })),
    cardAlerts: c.cardAlerts.map((a) => `${a.outcome === "declined" ? "Blocked" : "⚠ Went through"}: ₹${a.amountInr} at ${a.merchant} on ${a.bank} ••${a.last4}`),
    replacements: c.replacements.map((r) => `${r.bank} ••${r.last4} replacement ${r.requestId}, by ${r.expectedBy}`),
    phone: c.phoneActions.map((p) => `${p.detail}${p.reference ? ` (ref ${p.reference})` : ""}`),
    contacts: c.contactMessages.map((m) => `Messaged ${m.to} (ref ${m.reference})`),
  };
}
