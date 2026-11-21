import { EventEmitter } from "node:events";

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "user_said"; text: string }
  | { type: "agent_said"; text: string }
  | { type: "plan"; steps: Array<{ title: string; status: string }> }
  | { type: "tool_start"; id: string; name: string; server: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; server: string; ok: boolean; result: unknown; ms: number }
  | { type: "approval_requested"; approvalId: string; action: string; summary: string }
  | { type: "approval_granted"; approvalId: string; action: string }
  | { type: "approval_rejected"; approvalId?: string; action: string; reason: string }
  | { type: "case"; summary: unknown }
  | { type: "guardrail"; message: string; kinds: string[] }
  | { type: "card_alert"; cardId: string; last4: string; bank: string; amountInr: number; merchant: string; outcome: "declined" | "approved"; spoken: boolean }
  | { type: "bank_call"; call: import("./services/bank-call.js").BankCall }
  | { type: "error"; message: string };

export type StampedEvent = AgentEvent & { at: string; seq: number };

/** Per-session event bus with a replay buffer so late UI subscribers catch up. */
export class SessionEvents {
  private readonly emitter = new EventEmitter();
  private readonly buffer: StampedEvent[] = [];
  private seq = 0;

  constructor(private readonly maxBuffer = 500) {
    this.emitter.setMaxListeners(50);
  }

  emit(e: AgentEvent): StampedEvent {
    const stamped = { ...e, at: new Date().toISOString(), seq: ++this.seq } as StampedEvent;
    this.buffer.push(stamped);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    this.emitter.emit("event", stamped);
    return stamped;
  }

  history(): StampedEvent[] {
    return [...this.buffer];
  }

  subscribe(fn: (e: StampedEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}
