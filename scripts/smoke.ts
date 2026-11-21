/**
 * Real-API smoke checks, one service at a time, so credits are not exhausted.
 *   npm run smoke                 → free checks: agora, murf, geo
 *   npm run smoke -- claude       → 1 tiny Claude request (a fraction of a cent)
 *   npm run smoke -- email        → sends 1 real email to DEMO_USER_EMAIL (Resend free tier)
 *   npm run smoke -- agora murf geo claude email
 */
import Anthropic from "@anthropic-ai/sdk";
import { basicAuth } from "../src/agora/convoai.js";
import { loadConfig } from "../src/config.js";
import { ResendEmailSender } from "../src/services/email.js";
import { GeoService } from "../src/services/geo.js";

const cfg = loadConfig();
const wanted = process.argv.slice(2);
const checks = wanted.length ? wanted : ["agora", "murf", "geo"];

const results: Array<[string, boolean, string]> = [];
async function check(name: string, fn: () => Promise<string>) {
  if (!checks.includes(name)) return;
  try {
    results.push([name, true, await fn()]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
}

await check("agora", async () => {
  const res = await fetch("https://api.agora.io/dev/v1/projects", { headers: { Authorization: basicAuth(cfg) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { projects: Array<{ vendor_key: string; name: string; sign_key?: string }> };
  const p = body.projects.find((x) => x.vendor_key === cfg.agora.appId);
  if (!p) throw new Error("AGORA_APP_ID not found among your projects");
  return `project "${p.name}" found; certificate ${p.sign_key ? "enabled" : "disabled (testing mode, no tokens needed)"}`;
});

await check("murf", async () => {
  const res = await fetch("https://api.murf.ai/v1/speech/voices?model=falcon-2.1", { headers: { "api-key": cfg.murf.apiKey } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const voices = (await res.json()) as Array<{ voiceId: string }>;
  const found = voices.some((v) => v.voiceId === cfg.murf.voiceId);
  if (!found) throw new Error(`voice ${cfg.murf.voiceId} not in Falcon voice list`);
  return `${voices.length} Falcon voices; ${cfg.murf.voiceId} available`;
});

await check("geo", async () => {
  const r = await new GeoService(fetch, "live").nearestPoliceStations("Majestic bus stand");
  return `${r.source}: ${r.stations.map((s) => `${s.name} (${s.distanceKm} km)`).join(", ")}`;
});

await check("claude", async () => {
  const client = new Anthropic({ apiKey: cfg.claude.apiKey });
  const msg = await client.messages.create({
    model: cfg.claude.model,
    max_tokens: 2000,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Reply with exactly: Sarva online" }],
  });
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return `${cfg.claude.model}: "${text.trim()}" (${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out tokens)`;
});

await check("email", async () => {
  if (!cfg.email.demoUserEmail) throw new Error("DEMO_USER_EMAIL not set");
  const r = await new ResendEmailSender(cfg.email.resendApiKey, cfg.email.from).send({
    to: cfg.email.demoUserEmail,
    subject: "Sarva Rakshak smoke test",
    html: "<p>✅ Resend is wired up for Sarva Rakshak.</p>",
  });
  return `sent id=${r.id} → ${cfg.email.demoUserEmail}`;
});

for (const [name, ok, info] of results) console.log(`${ok ? "✅" : "❌"} ${name.padEnd(7)} ${info}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
