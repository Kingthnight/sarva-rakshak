/**
 * Server-enforced human-in-the-loop gate.
 * An approval becomes usable only after a NEW user turn arrives following the
 * request, so the model cannot approve its own actions. Each approval works once.
 */

export const SENSITIVE_ACTIONS = ["raise_dispute", "file_lost_report", "request_replacement_card", "remote_erase_device", "block_imei_ceir", "notify_emergency_contact"] as const;
export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export const isSensitive = (name: string): name is SensitiveAction => (SENSITIVE_ACTIONS as readonly string[]).includes(name);

interface ApprovalRecord {
  id: string;
  action: SensitiveAction;
  summary: string;
  requestedAtTurn: number;
  used: boolean;
}

export type ConsumeResult = { ok: true; summary: string } | { ok: false; reason: string };

export class ApprovalGate {
  private turn = 0;
  private seq = 0;
  private readonly records = new Map<string, ApprovalRecord>();

  /** Call once per incoming user utterance. */
  userTurn(): void {
    this.turn++;
  }

  get currentTurn(): number {
    return this.turn;
  }

  request(action: SensitiveAction, summary: string): { approval_id: string; action: SensitiveAction; summary: string } {
    const id = `APR-${++this.seq}`;
    this.records.set(id, { id, action, summary, requestedAtTurn: this.turn, used: false });
    return { approval_id: id, action, summary };
  }

  consume(approvalId: string | undefined, action: string): ConsumeResult {
    if (!approvalId) return { ok: false, reason: "Missing approval_id. Call request_user_approval first, ask the user, and wait for their answer." };
    const r = this.records.get(approvalId);
    if (!r) return { ok: false, reason: `Unknown approval_id ${approvalId}.` };
    if (r.action !== action) return { ok: false, reason: `Approval ${approvalId} was for ${r.action}, not ${action}.` };
    if (r.used) return { ok: false, reason: `Approval ${approvalId} was already used.` };
    if (this.turn <= r.requestedAtTurn)
      return { ok: false, reason: "The user has not answered yet. Ask the yes/no question, end your turn and wait for their reply." };
    r.used = true;
    return { ok: true, summary: r.summary };
  }

  pending(): Array<Omit<ApprovalRecord, "used">> {
    return [...this.records.values()].filter((r) => !r.used).map(({ used: _u, ...rest }) => rest);
  }
}
