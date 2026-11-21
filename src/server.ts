import { AnthropicLlm } from "./agent/llm.js";
import { Orchestrator } from "./agent/orchestrator.js";
import { createApp } from "./app.js";
import { loadConfig, missingFor } from "./config.js";
import { DryRunEmailSender, ResendEmailSender } from "./services/email.js";
import { GeoService } from "./services/geo.js";
import { SessionStore } from "./session.js";
import { ProfileStore } from "./domain/profile.js";
import path from "node:path";

const config = loadConfig();

const llmMissing = missingFor(config, "llm");
if (llmMissing.length) {
  console.error(`Missing ${llmMissing.join(", ")}; set it in .env`);
  process.exit(1);
}

const email =
  config.email.mode === "live" ? new ResendEmailSender(config.email.resendApiKey, config.email.from) : new DryRunEmailSender();

const profiles = new ProfileStore(path.resolve("data/profile.json"), config.email.demoUserEmail);

const store = new SessionStore({
  orchestrator: new Orchestrator(new AnthropicLlm({ apiKey: config.claude.apiKey, model: config.claude.model, effort: config.claude.effort })),
  geo: new GeoService(fetch, config.geoMode),
  email,
  profile: () => profiles.get(),
  userEmail: config.email.demoUserEmail,
  bankOutages: config.bankOutages,
});

createApp({ config, store, profiles }).listen(config.port, () => {
  const voiceMissing = missingFor(config, "voice");
  console.log(`\n🛡️  Sarva Rakshak running at http://localhost:${config.port}`);
  console.log(`   model=${config.claude.model} effort=${config.claude.effort} email=${config.email.mode} asr=${config.agora.asrVendor}/${config.agora.asrLanguage} geo=${config.geoMode} outages=${config.bankOutages.join(",") || "none"}`);
  if (voiceMissing.length) console.log(`   Voice disabled until set: ${voiceMissing.join(", ")} (text mode works)`);
});
