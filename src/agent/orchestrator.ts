import type Anthropic from "@anthropic-ai/sdk";
import type { SessionEvents } from "../events.js";
import type { ToolHub } from "../mcp/hub.js";
import type { ApprovalGate } from "./approvals.js";
import type { LlmClient } from "./llm.js";
import { APOLOGY_LINE, FILLER_LINE } from "./prompt.js";

export interface TurnContext {
  history: Anthropic.MessageParam[];
  system: string;
  hub: ToolHub;
  gate: ApprovalGate;
  events: SessionEvents;
}

export interface TurnResult {
  text: string;
  toolCalls: number;
  iterations: number;
  stopReason: string | null;
}

/**
 * Streaming agentic loop: Claude → tool calls (via MCP hub) → results → Claude …
 * Text deltas are forwarded immediately (onText) so Agora can start speaking.
 */
export class Orchestrator {
  constructor(
    private readonly llm: LlmClient,
    private readonly maxIterations = 10,
  ) {}

  async runTurn(ctx: TurnContext, userText: string, onText: (delta: string) => void = () => {}): Promise<TurnResult> {
    const { history, hub, gate, events } = ctx;
    const checkpoint = history.length;
    gate.userTurn();
    events.emit({ type: "user_said", text: userText });
    appendUserText(history, userText);

    let spoken = "";
    let toolCalls = 0;
    let iterations = 0;
    let stopReason: string | null = null;
    const say = (d: string) => {
      spoken += d;
      onText(d);
    };

    try {
      while (iterations < this.maxIterations) {
        iterations++;
        let iterText = "";
        const stream = this.llm.stream({ system: ctx.system, messages: history, tools: hub.tools() });
        stream.on("text", (d) => {
          iterText += d;
          say(d);
        });
        const msg = await stream.finalMessage();
        stopReason = msg.stop_reason;
        history.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });

        if (msg.stop_reason === "pause_turn") continue;
        const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (msg.stop_reason !== "tool_use" || toolUses.length === 0) break;

        // Keep the voice channel alive while tools run, and separate sentences across iterations.
        if (!spoken.trim()) say(FILLER_LINE);
        else if (iterText && !/\s$/.test(iterText)) say(" ");

        toolCalls += toolUses.length;
        const results = await Promise.all(toolUses.map((t) => hub.execute(t.name, t.input, t.id)));
        history.push({
          role: "user",
          content: toolUses.map(
            (t, i): Anthropic.ToolResultBlockParam => ({
              type: "tool_result",
              tool_use_id: t.id,
              content: results[i].content,
              is_error: results[i].isError || undefined,
            }),
          ),
        });
      }

      if (iterations >= this.maxIterations && stopReason === "tool_use") {
        say(" I've done several steps; tell me when you're ready and I'll continue.");
      }
      if (!spoken.trim()) say("Okay.");
    } catch (e) {
      // Roll back the partial turn so history stays a valid, append-only transcript.
      history.length = checkpoint;
      appendUserText(history, userText);
      history.push({ role: "assistant", content: [{ type: "text", text: APOLOGY_LINE }] });
      events.emit({ type: "error", message: (e as Error).message });
      say((spoken ? " " : "") + APOLOGY_LINE);
      stopReason = "error";
    }

    events.emit({ type: "agent_said", text: spoken.trim() });
    return { text: spoken.trim(), toolCalls, iterations, stopReason };
  }
}

/** Adds user text, merging into a trailing user message (e.g. tool results) to keep roles alternating. */
export function appendUserText(history: Anthropic.MessageParam[], text: string): void {
  const last = history[history.length - 1];
  if (last && last.role === "user") {
    const blocks: Anthropic.ContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
    blocks.push({ type: "text", text });
    last.content = blocks;
  } else {
    history.push({ role: "user", content: text });
  }
}
