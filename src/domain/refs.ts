/**
 * One reference format everywhere: CODE-KIND-NNNNNN (digits only, easy to read
 * aloud and type), e.g. AXIS-BLK-482913, ICICI-CALL-507216, SRK-LAR-118204.
 */

let seq = 0;

/** Default id generator: `${prefix}-` + 6 digits (time-derived + sequence, unique per process). */
export const defaultIdGen = (prefix: string) => {
  const n = (Math.floor(Date.now() / 7) % 9000 + 1000) * 100 + (++seq % 100);
  return `${prefix}-${String(n).padStart(6, "0")}`;
};

const WORDS: Record<string, string> = {
  BLK: "block", SMS: "S M S", CALL: "call", DSP: "dispute", RPL: "replacement", LAR: "lost report", REM: "reminder", CASE: "case",
  SIM: "SIM", IMEI: "I M E I", SRK: "S R K", DEV: "device", MSG: "message",
};
const DIGIT = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "AXIS-BLK-482913" → "A X I S, block, four eight two, nine one three" */
export function spokenRef(ref: string): string {
  return ref
    .split("-")
    .map((part) => {
      if (/^\d+$/.test(part)) {
        const groups = part.match(/\d{1,3}/g) ?? [];
        return groups.map((g) => g.split("").map((d) => DIGIT[Number(d)]).join(" ")).join(", ");
      }
      return WORDS[part] ?? part.split("").join(" ");
    })
    .join(", ");
}

export const REF_PATTERN = /^[A-Z]{2,6}(-[A-Z]{2,5})?-\d{4,8}$/;
