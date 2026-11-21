/**
 * Talk to the real agent (real Claude) in the terminal, no voice/Agora minutes used.
 *   npm run chat              → interactive
 *   npm run chat -- --demo    → plays the scripted demo conversation
 * Email stays in dry-run unless EMAIL_MODE=live.
 */
import readline from "node:readline/promises";
import { AnthropicLlm } from "../src/agent/llm.js";
import { Orchestrator } from "../src/agent/orchestrator.js";
import { loadConfig } from "../src/config.js";
import { summarise } from "../src/domain/case.js";
import { DryRunEmailSender, ResendEmailSender } from "../src/services/email.js";
import { GeoService } from "../src/services/geo.js";
import { SessionStore } from "../src/session.js";

const cfg = loadConfig();
const store = new SessionStore({
  orchestrator: new Orchestrator(new AnthropicLlm({ apiKey: cfg.claude.apiKey, model: cfg.claude.model, effort: cfg.claude.effort })),
  geo: new GeoService(fetch, cfg.geoMode),
  email: cfg.email.mode === "live" ? new ResendEmailSender(cfg.email.resendApiKey, cfg.email.from) : new DryRunEmailSender(),
  userEmail: cfg.email.demoUserEmail,
  bankOutages: cfg.bankOutages,
});
const session = await store.create("cli");

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
session.events.subscribe((e) => {
  if (e.type === "tool_start") console.log(dim(`  → [${e.server}] ${e.name} ${JSON.stringify(e.input).slice(0, 140)}`));
  if (e.type === "tool_end") console.log(dim(`  ${e.ok ? "✓" : "✗"} ${e.name} (${e.ms}ms) ${JSON.stringify(e.result).slice(0, 160)}`));
  if (e.type === "plan") console.log(dim(`  📋 ${e.steps.map((s) => `${s.title}[${s.status}]`).join(" → ")}`));
  if (e.type === "approval_requested") console.log(`  ⏳ approval needed: ${e.summary}`);
  if (e.type === "approval_granted") console.log(`  ✅ approved: ${e.action}`);
  if (e.type === "error") console.log(`  ⚠️ ${e.message}`);
});

async function turn(text: string) {
  console.log(`\n🧑 ${text}`);
  process.stdout.write("🛡️  ");
  const t0 = Date.now();
  let first = 0;
  const r = await session.say(text, (d) => {
    if (!first) first = Date.now() - t0;
    process.stdout.write(d);
  });
  console.log(dim(`\n  [first words ${first}ms · total ${Date.now() - t0}ms · ${r.toolCalls} tool calls · ${r.iterations} LLM rounds]`));
}

const DEMO = [
  "Help! I just lost my wallet at Majestic bus stand, maybe 20 minutes ago. It had my HDFC credit card, SBI debit card, my driving licence and Aadhaar.",
  "Yes, please do both.",
  "No, that's everything. Thank you!",
];

console.log(`Sarva Rakshak text mode · ${cfg.claude.model} (effort ${cfg.claude.effort}) · email ${cfg.email.mode} · case ${session.caseFile.caseId}`);
if (process.argv.includes("--demo")) {
  for (const line of DEMO) await turn(line);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("\nyou> ")).trim();
    if (!line || line === "exit" || line === "quit") break;
    await turn(line);
  }
  rl.close();
}
console.log("\n📁 Case summary:", JSON.stringify(summarise(session.caseFile), null, 2));
await store.remove("cli");
