import type { FetchLike } from "./geo.js";

export interface EmailAttachment {
  filename: string;
  content: Buffer | string; // raw bytes or utf-8 text
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  id: string;
  mode: "dry-run" | "live";
}

export interface EmailSender {
  readonly mode: "dry-run" | "live";
  send(msg: EmailMessage): Promise<EmailResult>;
}

/** Records emails in memory instead of sending them (default, costs nothing). */
export class DryRunEmailSender implements EmailSender {
  readonly mode = "dry-run" as const;
  readonly outbox: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<EmailResult> {
    this.outbox.push(msg);
    return { id: `dry-run-${this.outbox.length}`, mode: this.mode };
  }
}

export class EmailError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "EmailError";
  }
}

/** Sends via the Resend REST API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendEmailSender implements EmailSender {
  readonly mode = "live" as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async send(msg: EmailMessage): Promise<EmailResult> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content, "utf8").toString("base64"),
        })),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !body.id) throw new EmailError(body.message ?? `Resend HTTP ${res.status}`, res.status);
    return { id: body.id, mode: this.mode };
  }
}
