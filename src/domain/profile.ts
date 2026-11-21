import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const Last4 = z.string().regex(/^\d{4}$/, "last 4 digits only");
const Phone = z.string().max(20).regex(/^[+\d\sX()-]*$/, "digits, spaces, +, - only");

export const CardSchema = z.object({
  id: z.string().min(1).max(40),
  bank: z.string().min(2).max(30),
  kind: z.enum(["credit", "debit", "prepaid", "forex"]),
  network: z.string().max(20).default("Visa"),
  last4: Last4,
  nickname: z.string().max(40).optional(),
  /** Override how this card can be blocked: api (bank app), sms, call (helpline only). */
  channels: z.array(z.enum(["api", "sms", "call"])).min(1).optional(),
  helpline: Phone.optional(),
  smsNumber: z.string().max(15).optional(),
  smsFormat: z.string().max(40).optional(),
});

export const ProfileSchema = z.object({
  name: z.string().min(1).max(60),
  email: z.string().email().or(z.literal("")),
  phone: Phone,
  city: z.string().min(2).max(40),
  language: z.string().default("en-IN"),
  emergencyContact: z.object({ name: z.string().max(60), phone: Phone, relation: z.string().max(30) }).partial().default({}),
  documents: z.array(z.string().max(40)).max(20).default([]),
  device: z
    .object({
      model: z.string().max(40).default(""),
      os: z.enum(["android", "ios"]).default("android"),
      operator: z.enum(["Jio", "Airtel", "Vi", "BSNL", "Other"]).default("Jio"),
      numberLast4: z.string().regex(/^(\d{4})?$/, "last 4 digits only").default(""),
    })
    .default({ model: "", os: "android", operator: "Jio", numberLast4: "" }),
  cards: z.array(CardSchema).max(12),
  guardrails: z
    .object({
      /** Disputes above this need approval (all disputes need approval; this adds a spoken warning). */
      highValueInr: z.number().int().positive().default(10000),
      /** Watch cards for new transactions during the session. */
      cardWatch: z.boolean().default(true),
    })
    .default({ highValueInr: 10000, cardWatch: true }),
});

export type CardProfile = z.infer<typeof CardSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

/** PII-free placeholder defaults; the real profile lives in data/profile.json (git-ignored). */
export function defaultProfile(email = ""): Profile {
  return {
    name: "Koushik",
    email,
    phone: "+91 98XXX X4210",
    city: "Bengaluru",
    language: "en-IN",
    emergencyContact: { name: "", phone: "", relation: "" },
    documents: ["Driving licence", "Aadhaar", "PAN"],
    device: { model: "Pixel 8", os: "android", operator: "Jio", numberLast4: "4210" },
    cards: [
      { id: "hdfc-cc-4821", bank: "HDFC", kind: "credit", network: "Visa", last4: "4821", nickname: "HDFC Regalia" },
      { id: "sbi-dc-1093", bank: "SBI", kind: "debit", network: "RuPay", last4: "1093", nickname: "SBI salary account" },
      { id: "icici-cc-7710", bank: "ICICI", kind: "credit", network: "Mastercard", last4: "7710", nickname: "ICICI Amazon Pay", channels: ["call"] },
    ],
    guardrails: { highValueInr: 10000, cardWatch: true },
  };
}

export const cardIdFor = (bank: string, kind: string, last4: string) =>
  `${bank.toLowerCase().replace(/[^a-z0-9]/g, "")}-${kind === "credit" ? "cc" : kind === "debit" ? "dc" : kind}-${last4}`;

/** Fills missing ids and rejects duplicates. */
export function normaliseProfile(input: unknown): Profile {
  const raw = (input ?? {}) as { cards?: Array<Record<string, unknown>> };
  if (Array.isArray(raw.cards)) {
    raw.cards = raw.cards.map((c) => ({ ...c, id: c.id || cardIdFor(String(c.bank ?? "bank"), String(c.kind ?? "card"), String(c.last4 ?? "0000")) }));
  }
  const p = ProfileSchema.parse(raw);
  const ids = new Set<string>();
  for (const c of p.cards) {
    if (ids.has(c.id)) throw new z.ZodError([{ code: "custom", path: ["cards"], message: `Duplicate card ${c.bank} ••${c.last4}`, input: c }]);
    ids.add(c.id);
  }
  return p;
}

export class ProfileStore {
  private cache: Profile;

  constructor(
    private readonly file: string | null,
    fallbackEmail = "",
  ) {
    this.cache = defaultProfile(fallbackEmail);
    if (file && fs.existsSync(file)) {
      try {
        this.cache = normaliseProfile(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch (e) {
        console.warn(`Ignoring invalid profile at ${file}: ${(e as Error).message}`);
      }
    }
  }

  get(): Profile {
    return structuredClone(this.cache);
  }

  save(input: unknown): Profile {
    const p = normaliseProfile(input);
    this.cache = p;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(p, null, 2));
    }
    return this.get();
  }
}
