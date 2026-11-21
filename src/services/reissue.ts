/**
 * Reissue / recovery guidance for common lost items in India.
 * Fees and portals are indicative; the agent must present them as guidance.
 */

export type DocumentKind = "driving_licence" | "aadhaar" | "pan" | "bank_card" | "phone_sim" | "voter_id";

export interface ReissueGuide {
  document: DocumentKind;
  title: string;
  needsPoliceReport: boolean;
  urgentActions: string[];
  steps: string[];
  portal: string;
  indicativeFee: string;
  typicalTime: string;
}

export const GUIDES: Record<DocumentKind, ReissueGuide> = {
  driving_licence: {
    document: "driving_licence",
    title: "Duplicate Driving Licence (Karnataka)",
    needsPoliceReport: true,
    urgentActions: [],
    steps: [
      "Keep a copy of the lost-article police report",
      "Apply for 'Duplicate DL' on the Parivahan Sarathi portal (Form LLD)",
      "Upload the police report copy, address proof and photo",
      "Pay the fee online and visit the RTO if biometric verification is requested",
    ],
    portal: "https://sarathi.parivahan.gov.in",
    indicativeFee: "≈ ₹200 + service charges",
    typicalTime: "7–30 days",
  },
  aadhaar: {
    document: "aadhaar",
    title: "Aadhaar reprint and biometric lock",
    needsPoliceReport: false,
    urgentActions: ["Lock Aadhaar biometrics via the mAadhaar app or myAadhaar portal to prevent misuse"],
    steps: [
      "Order an Aadhaar PVC card reprint on myAadhaar using your registered mobile OTP",
      "Download the e-Aadhaar immediately as a valid interim copy",
    ],
    portal: "https://myaadhaar.uidai.gov.in",
    indicativeFee: "₹50 (PVC reprint)",
    typicalTime: "≈ 2 weeks by speed post (e-Aadhaar instantly)",
  },
  pan: {
    document: "pan",
    title: "PAN card reprint",
    needsPoliceReport: false,
    urgentActions: [],
    steps: [
      "Request 'Reprint of PAN card' on the Protean (NSDL) or UTIITSL portal",
      "Download the free e-PAN in the meantime",
    ],
    portal: "https://www.protean-tinpan.com",
    indicativeFee: "≈ ₹50",
    typicalTime: "≈ 15 days",
  },
  bank_card: {
    document: "bank_card",
    title: "Replacement debit/credit card",
    needsPoliceReport: false,
    urgentActions: ["Block the card immediately (app, helpline or SMS)"],
    steps: [
      "Request a replacement card in the bank app or at the branch",
      "Set a new PIN once the card arrives and keep it frozen for online use until needed",
    ],
    portal: "Your bank's app / net banking",
    indicativeFee: "₹0–₹300 depending on the bank",
    typicalTime: "5–10 working days",
  },
  phone_sim: {
    document: "phone_sim",
    title: "Lost phone and SIM",
    needsPoliceReport: true,
    urgentActions: ["Block the SIM with your operator to stop OTP theft", "Remotely lock/erase the phone (Find My Device / Find My)"],
    steps: [
      "Get a replacement SIM from the operator store with ID proof",
      "Block the handset IMEI on the Sanchar Saathi (CEIR) portal using the police report number",
    ],
    portal: "https://www.sancharsaathi.gov.in",
    indicativeFee: "≈ ₹25–₹100 for SIM replacement",
    typicalTime: "SIM same day; IMEI block within 24 hours",
  },
  voter_id: {
    document: "voter_id",
    title: "Duplicate Voter ID (EPIC)",
    needsPoliceReport: true,
    urgentActions: [],
    steps: ["Apply with Form EPIC-002 on the Voters' Service Portal", "Download the e-EPIC in the meantime"],
    portal: "https://voters.eci.gov.in",
    indicativeFee: "Nominal",
    typicalTime: "≈ 30 days",
  },
};

const ALIASES: Array<[RegExp, DocumentKind]> = [
  [/driv|licen[cs]e|\bdl\b/i, "driving_licence"],
  [/aadha?ar|uid/i, "aadhaar"],
  [/\bpan\b|pan card/i, "pan"],
  [/card|debit|credit|atm/i, "bank_card"],
  [/phone|mobile|sim|imei/i, "phone_sim"],
  [/voter|epic/i, "voter_id"],
];

export function normaliseDocument(input: string): DocumentKind | null {
  if ((Object.keys(GUIDES) as string[]).includes(input)) return input as DocumentKind;
  for (const [re, kind] of ALIASES) if (re.test(input)) return kind;
  return null;
}

export function getGuides(documents: string[]): { guides: ReissueGuide[]; unknown: string[]; policeReportNeeded: boolean } {
  const guides: ReissueGuide[] = [];
  const unknown: string[] = [];
  for (const d of documents) {
    const kind = normaliseDocument(d);
    if (!kind) unknown.push(d);
    else if (!guides.some((g) => g.document === kind)) guides.push(GUIDES[kind]);
  }
  return { guides, unknown, policeReportNeeded: guides.some((g) => g.needsPoliceReport) };
}
