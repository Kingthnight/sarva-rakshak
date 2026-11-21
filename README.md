# 🛡️ Sarva Rakshak

**A voice AI agent you call when you've just lost your wallet or phone.** Tell it what happened and it gets to work: it freezes your cards, catches fraud, prepares the police report, lines up your document reissues, and emails you a complete case file with calendar reminders.

Built for **Build with Agora BLR**, Track 3: *AI Agents That Get Things Done*.

> "I just lost my wallet at Majestic bus stand. It had my HDFC and SBI cards, my DL and Aadhaar."
>
> Sarva then plans, freezes both cards (falling back to SMS when SBI's API is down), flags a ₹4,999 fraud charge, asks for your OK, disputes the charge and files the report at the nearest station, gives you reissue steps, schedules follow-ups, and emails the case file.

## How it maps to the Track 3 demo flow
| Stage | What Sarva does |
|---|---|
| **Initiate** | You speak in the browser. Agora Conversational AI handles speech recognition, and Murf Falcon voices the reply. |
| **Plan** | Claude builds an ordered recovery plan (money first; the police report before the documents that depend on it), shown live in the UI. |
| **Execute** | Coordinated tool calls across **3 MCP servers**: bank, civic and notify. |
| **Adapt** | SBI's card API is down, so Sarva uses the SMS block. A tool failure leads to an alternative, never a fake success. |
| **Approve** | Disputes and police reports need your spoken **"yes"**. This is **enforced on the server**: the model can't approve itself. |
| **Confirm & follow up** | Sarva reads back reference numbers and emails a case PDF, the report PDF and an `.ics` file of reminders. |

## Settings, card monitoring and guardrails
- **Settings (⚙️ in the UI):** name, email, phone, city, emergency contact, the documents you usually carry, and your **cards** (bank, type, last 4, nickname, and how each can be blocked: app, SMS or phone call only). Saved to `data/profile.json`, which git ignores. Each new session uses the saved profile.
- **How a card gets blocked:**
  1. **App/API freeze**, instant.
  2. **SMS block** if the bank's API is down.
  3. **Phone call only** for some banks. The agent can't phone the bank itself, so it shows a **Call now** button (`tel:` link) with the helpline and a one-line script. Afterwards it records the reference you were given with `record_manual_block`.
- **One lost card vs a whole wallet:** for a single card, the agent asks which one if unclear, acts only on that card, checks its recent transactions and offers a replacement (approval needed). For a wallet, it acts on all saved cards and documents.
- **Card watch (monitoring):** new charge attempts appear live. Attempts on frozen cards show as **declined** ("the freeze worked"). A charge on an active card raises an alert, and the agent says it out loud mid-call through Agora's `speak` API, then offers to freeze. Demo it with the **Simulate fraud attempt** button.
- **Guardrails:**
  - Full card numbers, CVV, PIN, OTP and Aadhaar numbers are **redacted on the server before the AI sees them**, and the agent warns you.
  - The agent **can never unfreeze** a card.
  - It acts only on saved cards.
  - Disputes, police reports and replacements need your spoken "yes", enforced on the server.
  - The public tunnel exposes **only** the Agora LLM endpoint; UI, profile and controls are local-only.
- **Speech recognition:** Deepgram Nova-3 tuned for Indian English (`en-IN`), via Agora's managed credentials. The prompt reads misheard Bengaluru landmarks by how they sound.

## Architecture
```
Browser ── Agora RTC ──▶ Agora Conversational AI Engine
  ▲ SSE live activity        ASR (ares) → LLM = our endpoint → TTS (Murf Falcon)
  │                                         │ POST /llm/:session/chat/completions (OpenAI-compatible SSE)
  │                                         ▼
Express (src/app.ts) ── Orchestrator (Claude streaming tool loop + approval gate)
                                            │  MCP over in-memory transport
                 ┌──────────────────────────┼───────────────────────────┐
           Bank MCP (simulated)     Civic MCP (OpenStreetMap +      Notify MCP (Resend email,
           freeze / SMS block /     simulated police portal,        reminders, .ics)
           fraud / dispute          reissue guides, PDF report)
```
| Path | What it is |
|---|---|
| `src/agent/` | Orchestrator, Claude client, system prompt, approval gate |
| `src/mcp/` | MCP servers, the hub that routes tool calls, and a stdio runner |
| `src/services/` | Bank simulator, geo lookup, reissue guides, PDF/ICS documents, email |
| `src/agora/convoai.ts` | Builds the `/join` payload and starts and stops the agent |
| `src/llm-proxy.ts` | The OpenAI-compatible endpoint Agora calls |
| `public/` | The console UI: call button, transcript, plan, approvals, case file, live MCP activity |

## Quick start
```bash
npm install
cp .env.example .env              # fill in keys (see REQUIREMENTS.md §7)
npm test                          # 63 tests, all offline, costs nothing
npm run smoke                     # free real-API checks: Agora, Murf, OpenStreetMap
npm run chat -- --demo            # full workflow in text mode with real Claude (no voice minutes)
npm run dev                       # http://localhost:8790 (type in the box; text mode)
```

### Voice mode
```bash
npm run tunnel                    # copy the https://….trycloudflare.com URL
# put it in .env as PUBLIC_BASE_URL=https://….trycloudflare.com, then:
npm run dev                       # open http://localhost:8790 → "Start emergency call"
```

### Testing in stages (keeps costs down)
1. `npm test`: unit and integration tests with a scripted fake LLM, fake fetch, and a dry-run email sender.
2. `npm run smoke`: free checks. `npm run smoke -- claude` makes one tiny request. `npm run smoke -- email` sends one email.
3. `npm run chat -- --demo`: the full agent in text mode. Email stays dry-run unless `EMAIL_MODE=live`.
4. Voice: a full Agora + Murf session.

### Use the MCP servers elsewhere
Each server runs on its own over stdio, for example in Claude Desktop or MCP Inspector:
```bash
npm run mcp:bank   # or mcp:civic / mcp:notify
```

## Honesty notes
- Bank and police systems are **simulated**, because no public APIs exist for them. Results say `simulated: true`, and the report PDF is marked as a *prepared draft*.
- **Real:** Agora voice, Murf TTS, Claude reasoning, OpenStreetMap station lookup, Resend email.

## Tech
Agora Conversational AI Engine + RTC Web SDK · Murf Falcon TTS · Anthropic Claude (`claude-opus-5-5`, streaming, server-side refusal fallback) · Model Context Protocol · Express · pdfkit · Vitest.
