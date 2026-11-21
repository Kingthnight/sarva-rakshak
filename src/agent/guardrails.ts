/**
 * Input guardrails applied to every user utterance BEFORE it reaches the LLM.
 * Sarva never needs full card numbers, CVV, PIN, OTP or full Aadhaar numbers,
 * so they are redacted server-side and the model is told to warn the user.
 */

export interface Redaction {
  kind: "card_number" | "aadhaar" | "otp_pin_cvv";
  sample: string; // masked preview, safe to log
}

const mask = (digits: string) => `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;

function luhnValid(num: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function redactSensitive(text: string): { text: string; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  let out = text;

  // OTP / PIN / CVV followed by digits (spoken or typed): "my OTP is 482913", "CVV 123", "pin: 4321"
  out = out.replace(/\b(otp|one[\s-]?time\s+password|pin|cvv|cvc|security\s+code)\b([^\d]{0,15})(\d[\d\s-]{1,8}\d)/gi, (_m, label: string, mid: string, digits: string) => {
    redactions.push({ kind: "otp_pin_cvv", sample: `${label} ••••` });
    return `${label}${mid}[REDACTED]`;
  });

  // Sequences of 12-19 digits with optional spaces/dashes.
  out = out.replace(/\b(?:\d[ -]?){11,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && luhnValid(digits)) {
      redactions.push({ kind: "card_number", sample: mask(digits) });
      return "[REDACTED CARD NUMBER]";
    }
    if (digits.length === 12) {
      redactions.push({ kind: "aadhaar", sample: mask(digits) });
      return "[REDACTED ID NUMBER]";
    }
    return m;
  });

  return { text: out, redactions };
}

export const GUARDRAIL_NOTE =
  "[Guardrail notice for the assistant: the user just said sensitive numbers, which were redacted before reaching you. Briefly remind them never to share full card numbers, CVV, PIN, OTP or Aadhaar numbers with anyone, including you. You only ever need the last 4 digits.]";
