/**
 * Simulated telecom + device services for a lost phone: SIM block via the operator,
 * Find-My-Device style locate/ring/lock/erase, CEIR (Sanchar Saathi) IMEI block,
 * and replacement SIM. No public APIs exist for these, so results are `simulated: true`.
 * Helplines are indicative defaults.
 */
import type { Profile } from "../domain/profile.js";
import { defaultIdGen } from "../domain/refs.js";

export const OPERATORS: Record<string, { helpline: string; store: string }> = {
  Jio: { helpline: "1800 889 9999", store: "Jio Store / Reliance Digital" },
  Airtel: { helpline: "121 (from another Airtel number) / 1800 103 4444", store: "Airtel Store" },
  Vi: { helpline: "199 / 1800 123 9599", store: "Vi Store" },
  BSNL: { helpline: "1800 180 1503", store: "BSNL Customer Service Centre" },
  Other: { helpline: "your operator's helpline", store: "operator store" },
};

export type DeviceAction = "locate" | "ring" | "lock" | "erase";

export class TelecomSimulator {
  private simBlocked?: string;
  private imeiBlocked?: string;
  private locked = false;
  private erased = false;

  constructor(
    private readonly device: Profile["device"],
    private readonly now: () => Date = () => new Date(),
    private readonly idGen: (p: string) => string = defaultIdGen,
    private readonly lastSeenNear = "Majestic, Bengaluru",
  ) {}

  info() {
    const op = OPERATORS[this.device.operator] ?? OPERATORS.Other;
    return {
      simulated: true as const,
      model: this.device.model || "unknown model",
      os: this.device.os,
      operator: this.device.operator,
      numberEnding: this.device.numberLast4 || "unknown",
      operatorHelpline: op.helpline,
      findMyDevice: this.device.os === "ios" ? "Find My (icloud.com/find)" : "Google Find My Device (google.com/android/find)",
      status: { simBlocked: Boolean(this.simBlocked), locked: this.locked, erased: this.erased, imeiBlocked: Boolean(this.imeiBlocked) },
    };
  }

  blockSim() {
    if (this.simBlocked) return { simulated: true as const, alreadyBlocked: true, reference: this.simBlocked };
    this.simBlocked = this.idGen(`${this.device.operator.toUpperCase()}-SIM`);
    return {
      simulated: true as const,
      operator: this.device.operator,
      numberEnding: this.device.numberLast4,
      reference: this.simBlocked,
      effect: "Outgoing calls, SMS and OTPs stop on the lost SIM, so nobody can receive your bank OTPs.",
      replacement: `Get a replacement SIM with the same number at a ${(OPERATORS[this.device.operator] ?? OPERATORS.Other).store} with ID proof (usually same day).`,
    };
  }

  deviceAction(action: DeviceAction) {
    const base = { simulated: true as const, action, model: this.device.model, via: this.info().findMyDevice };
    if (this.erased && action !== "locate") return { ...base, ok: false, message: "The phone was already erased; it can no longer be rung or locked." };
    switch (action) {
      case "locate":
        return { ...base, ok: true, lastSeen: { near: this.lastSeenNear, at: new Date(this.now().getTime() - 18 * 60_000).toISOString(), accuracyM: 120, online: false } };
      case "ring":
        return { ...base, ok: true, message: "Ringing at full volume for 5 minutes, even on silent (once the phone comes online)." };
      case "lock":
        this.locked = true;
        return { ...base, ok: true, message: "Phone locked remotely with a 'lost phone' message and your emergency contact number on the lock screen." };
      case "erase":
        this.erased = true;
        this.locked = true;
        return { ...base, ok: true, reference: this.idGen("DEV-ERASE"), message: "Remote erase queued; it runs as soon as the phone connects. After this it can't be located." };
    }
  }

  blockImei(policeReference: string | undefined) {
    if (!policeReference) throw new Error("CEIR needs a police complaint number. File the lost report first (file_lost_report).");
    if (this.imeiBlocked) return { simulated: true as const, alreadyBlocked: true, requestId: this.imeiBlocked };
    this.imeiBlocked = this.idGen("CEIR-IMEI");
    return {
      simulated: true as const,
      portal: "Sanchar Saathi (CEIR) - sancharsaathi.gov.in",
      requestId: this.imeiBlocked,
      policeReference,
      effect: "The handset is blacklisted on all Indian networks within about 24 hours. It can be unblocked from the same portal if found.",
    };
  }
}
