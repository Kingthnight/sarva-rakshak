import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

/** OpenAI chat-completions message as sent by Agora's custom LLM integration. */
interface OpenAiMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }> | null;
}

export function lastUserText(messages: OpenAiMessage[] | undefined): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content.trim() || null;
    if (Array.isArray(m.content)) {
      const t = m.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ").trim();
      return t || null;
    }
  }
  return null;
}

export function authorised(header: string | undefined, secret: string): boolean {
  if (!secret) return true;
  const got = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export type SayFn = (sessionId: string, text: string, onText: (d: string) => void) => Promise<{ text: string }>;

/**
 * POST /llm/:sessionId/chat/completions. OpenAI-compatible (streaming or not), so
 * Agora's Conversational AI Engine can use Sarva's agent as its "LLM".
 */
export function llmProxyHandler(secret: string, say: SayFn) {
  return async (req: Request, res: Response) => {
    if (!authorised(req.header("authorization"), secret)) {
      res.status(401).json({ error: { message: "unauthorised" } });
      return;
    }
    const sessionId = String(req.params.sessionId);
    const body = (req.body ?? {}) as { messages?: OpenAiMessage[]; stream?: boolean; model?: string };
    const text = lastUserText(body.messages);
    const model = body.model ?? "sarva-rakshak";
    const id = `chatcmpl-${Date.now().toString(36)}`;
    if (!text) {
      res.status(400).json({ error: { message: "no user message" } });
      return;
    }

    if (body.stream === false) {
      const r = await say(sessionId, text, () => {});
      res.json({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
      });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    let open = true;
    res.on("close", () => {
      open = false;
    });
    const write = (obj: unknown) => {
      if (open) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    write(chunk(id, model, { role: "assistant", content: "" }));
    try {
      await say(sessionId, text, (d) => write(chunk(id, model, { content: d })));
    } finally {
      write(chunk(id, model, {}, "stop"));
      if (open) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  };
}
