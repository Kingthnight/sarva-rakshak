import dotenv from "dotenv";

// The project .env wins over variables inherited from the shell.
dotenv.config({ override: true, quiet: true });

export type EmailMode = "dry-run" | "live";
export type GeoMode = "live" | "offline";

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  llmProxySecret: string;
  agora: {
    appId: string;
    appCertificate: string;
    customerKey: string;
    customerSecret: string;
    asrLanguage: string;
    asrVendor: "deepgram" | "ares";
    asrKeyterms: boolean;
  };
  murf: { apiKey: string; voiceId: string; locale: string };
  claude: { apiKey: string; model: string; effort: "low" | "medium" | "high" | "xhigh" | "max" };
  email: { mode: EmailMode; resendApiKey: string; from: string; demoUserEmail: string };
  geoMode: GeoMode;
  bankOutages: string[];
}

type Env = Record<string, string | undefined>;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function loadConfig(env: Env = process.env): AppConfig {
  const effort = (env.CLAUDE_EFFORT ?? "low") as AppConfig["claude"]["effort"];
  return {
    port: Number(env.PORT ?? 8790),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
    llmProxySecret: env.LLM_PROXY_SECRET ?? "",
    agora: {
      appId: env.AGORA_APP_ID ?? "",
      appCertificate: env.AGORA_APP_CERTIFICATE ?? "",
      customerKey: env.AGORA_CUSTOMER_KEY ?? "",
      customerSecret: env.AGORA_CUSTOMER_SECRET ?? "",
      asrLanguage: env.ASR_LANGUAGE || "en-IN",
      asrVendor: env.ASR_VENDOR === "ares" ? "ares" : "deepgram",
      asrKeyterms: env.ASR_KEYTERMS !== "0",
    },
    murf: {
      apiKey: env.MURF_API_KEY ?? "",
      voiceId: env.MURF_VOICE_ID || "en-IN-isha",
      locale: env.MURF_LOCALE || "en-IN",
    },
    claude: {
      apiKey: env.ANTHROPIC_API_KEY ?? "",
      model: env.CLAUDE_MODEL || "claude-opus-5-5",
      effort: EFFORTS.includes(effort) ? effort : "low",
    },
    email: {
      mode: env.EMAIL_MODE === "live" ? "live" : "dry-run",
      resendApiKey: env.RESEND_API_KEY ?? "",
      from: env.RESEND_FROM || "Sarva Rakshak <onboarding@resend.dev>",
      demoUserEmail: env.DEMO_USER_EMAIL ?? "",
    },
    geoMode: env.GEO_MODE === "offline" ? "offline" : "live",
    bankOutages: (env.SCENARIO_BANK_OUTAGE ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  };
}

/** Lists config keys that are required for a given capability but missing. */
export function missingFor(cfg: AppConfig, capability: "voice" | "llm" | "email"): string[] {
  const missing: string[] = [];
  if (capability === "llm" && !cfg.claude.apiKey) missing.push("ANTHROPIC_API_KEY");
  if (capability === "email" && cfg.email.mode === "live") {
    if (!cfg.email.resendApiKey) missing.push("RESEND_API_KEY");
    if (!cfg.email.demoUserEmail) missing.push("DEMO_USER_EMAIL");
  }
  if (capability === "voice") {
    if (!cfg.agora.appId) missing.push("AGORA_APP_ID");
    if (!cfg.agora.customerKey) missing.push("AGORA_CUSTOMER_KEY");
    if (!cfg.agora.customerSecret) missing.push("AGORA_CUSTOMER_SECRET");
    if (!cfg.murf.apiKey) missing.push("MURF_API_KEY");
    if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
    if (!cfg.llmProxySecret) missing.push("LLM_PROXY_SECRET");
  }
  return missing;
}
