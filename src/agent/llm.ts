import Anthropic from "@anthropic-ai/sdk";

export interface LlmRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

/** Minimal streaming surface the orchestrator needs; lets tests script responses. */
export interface LlmStream {
  on(event: "text", cb: (delta: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
}

export interface LlmClient {
  stream(req: LlmRequest): LlmStream;
}

export interface AnthropicLlmOptions {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

/**
 * Claude via the official SDK. Streams so text reaches Agora/TTS as it is generated.
 * Server-side refusal fallback is enabled (beta) so a policy decline is retried on
 * a fallback model inside the same call instead of leaving the user in silence.
 */
export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicLlmOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 60_000 });
  }

  stream(req: LlmRequest): LlmStream {
    const stream = this.client.beta.messages.stream({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? 16000,
      system: req.system,
      cache_control: { type: "ephemeral" },
      messages: req.messages as Anthropic.Beta.Messages.BetaMessageParam[],
      tools: req.tools.map((t) => ({ ...t, eager_input_streaming: true })) as Anthropic.Beta.Messages.BetaToolUnion[],
      output_config: { effort: this.opts.effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    return {
      on: (event, cb) => stream.on(event, cb),
      finalMessage: async () => (await stream.finalMessage()) as unknown as Anthropic.Message,
    };
  }
}
