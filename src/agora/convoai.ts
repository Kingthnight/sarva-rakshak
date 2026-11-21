import pkg from "agora-token";
import type { AppConfig } from "../config.js";
import type { FetchLike } from "../services/geo.js";

const { RtcTokenBuilder, RtcRole } = pkg;

export const AGENT_UID = "1001";
export const GREETING = "Hi, I'm Sarva Rakshak. Tell me what you lost and where, and I'll start securing things right away.";

/** RTC token for a uid. Returns "" when the project has no App Certificate (testing mode). */
export function rtcToken(cfg: AppConfig, channel: string, uid: number, ttlSeconds = 3600): string {
  if (!cfg.agora.appCertificate) return "";
  return RtcTokenBuilder.buildTokenWithUid(cfg.agora.appId, cfg.agora.appCertificate, channel, uid, RtcRole.PUBLISHER, ttlSeconds, ttlSeconds);
}

export function basicAuth(cfg: AppConfig): string {
  return "Basic " + Buffer.from(`${cfg.agora.customerKey}:${cfg.agora.customerSecret}`).toString("base64");
}

export interface JoinParams {
  sessionId: string;
  channel: string;
  userUid: number;
  token: string;
}

/** Builds the Conversational AI Engine `/join` body: ASR → our custom LLM → Murf Falcon TTS. */
export function buildJoinPayload(cfg: AppConfig, p: JoinParams) {
  return {
    name: `sarva-${p.sessionId}-${Date.now().toString(36)}`,
    properties: {
      channel: p.channel,
      token: p.token,
      agent_rtc_uid: AGENT_UID,
      remote_rtc_uids: [String(p.userUid)],
      enable_string_uid: false,
      idle_timeout: 120,
      asr: {
        vendor: "ares",
        language: cfg.agora.asrLanguage,
      },
      llm: {
        vendor: "custom",
        style: "openai",
        url: `${cfg.publicBaseUrl}/llm/${encodeURIComponent(p.sessionId)}/chat/completions`,
        api_key: cfg.llmProxySecret,
        params: { model: "sarva-rakshak" },
        system_messages: [],
        greeting_message: GREETING,
        failure_message: "Sorry, I lost my connection for a second. Could you repeat that?",
        max_history: 10,
      },
      tts: {
        vendor: "murf",
        params: {
          api_key: cfg.murf.apiKey,
          base_url: "wss://global.api.murf.ai/v1/speech/stream-input",
          voiceId: cfg.murf.voiceId,
          locale: cfg.murf.locale,
          model: "FALCON",
          sample_rate: 24000,
        },
      },
    },
  };
}

export class AgoraApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
    this.name = "AgoraApiError";
  }
}

const base = (cfg: AppConfig) => `https://api.agora.io/api/conversational-ai-agent/v2/projects/${cfg.agora.appId}`;

export async function startAgent(cfg: AppConfig, payload: ReturnType<typeof buildJoinPayload>, fetchFn: FetchLike = fetch) {
  const res = await fetchFn(`${base(cfg)}/join`, {
    method: "POST",
    headers: { Authorization: basicAuth(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const body = (await res.json().catch(() => ({}))) as { agent_id?: string; status?: string; message?: string; detail?: string };
  if (!res.ok || !body.agent_id) throw new AgoraApiError(`Agora join failed: ${body.message ?? body.detail ?? res.status}`, res.status, body);
  return { agentId: body.agent_id, status: body.status };
}

export async function stopAgent(cfg: AppConfig, agentId: string, fetchFn: FetchLike = fetch): Promise<void> {
  const res = await fetchFn(`${base(cfg)}/agents/${encodeURIComponent(agentId)}/leave`, {
    method: "POST",
    headers: { Authorization: basicAuth(cfg) },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok && res.status !== 404) throw new AgoraApiError(`Agora leave failed: ${res.status}`, res.status, await res.text().catch(() => ""));
}
