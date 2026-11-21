/**
 * Bank directory: how each bank lets you block a card.
 * Helplines/SMS formats are indicative defaults and editable per card in Settings,
 * because banks change them. Always verify with your bank.
 */

export type BlockChannel = "api" | "sms" | "call";

export interface BankInfo {
  name: string;
  helpline: string;
  sms?: { number: string; format: string }; // format uses {last4}
  /** Where to block it yourself in the bank's app (indicative; menus change). */
  appSteps?: string;
  /** Channels this bank supports for blocking, in preferred order. */
  channels: BlockChannel[];
}

export const BANK_DIRECTORY: Record<string, BankInfo> = {
  HDFC: { name: "HDFC Bank", appSteps: "HDFC MyCards app or NetBanking → Cards → Block card", helpline: "1800 202 6161", sms: { number: "7308080808", format: "BLOCK {last4}" }, channels: ["api", "sms", "call"] },
  SBI: { name: "State Bank of India", appSteps: "YONO SBI → Services → Debit card → Block", helpline: "1800 1234", sms: { number: "567676", format: "BLOCK {last4}" }, channels: ["api", "sms", "call"] },
  ICICI: { name: "ICICI Bank", appSteps: "iMobile Pay → Cards → Block card", helpline: "1800 1080", sms: { number: "9215676766", format: "BLOCK {last4}" }, channels: ["api", "sms", "call"] },
  AXIS: { name: "Axis Bank", appSteps: "Axis Mobile → Cards → Block card", helpline: "1860 419 5555", channels: ["api", "call"] },
  KOTAK: { name: "Kotak Mahindra Bank", appSteps: "Kotak app → Cards → Block card", helpline: "1860 266 2666", channels: ["api", "call"] },
  OTHER: { name: "Other bank", helpline: "", channels: ["call"] },
};

export function bankInfo(bank: string): BankInfo {
  return BANK_DIRECTORY[bank.toUpperCase()] ?? { ...BANK_DIRECTORY.OTHER, name: bank };
}

export const telLink = (phone: string) => (phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : "");
