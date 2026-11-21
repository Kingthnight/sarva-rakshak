# Sarva Rakshak: Requirements

> A voice AI agent you call when you've just lost your wallet or phone. It plans the recovery steps in the right order and carries them out: freezes cards, flags fraud, prepares the police report, lines up document reissue, and emails you a complete case file.

Hackathon: **Build with Agora BLR**, Track 3, "AI Agents That Get Things Done".

## 1. Problem
Losing a wallet or phone in India leads to a stressful hour:
- calling every bank's helpline and waiting on hold,
- not knowing whether to freeze cards or go to the police first,
- the police report is needed before you can reissue your driving licence, Aadhaar or PAN,
- fraud often happens within minutes, and nobody checks recent transactions.

The order of steps matters, and the person is panicking, often with their hands full. Voice is the natural interface.

## 2. Users and demo persona
- **Primary user:** anyone in a city who just lost a wallet or phone.
- **Demo persona:** "Arjun" in Bengaluru, who lost his wallet at Majestic bus stand. The wallet held an HDFC credit card, an SBI debit card, his driving licence and his Aadhaar.

## 3. How the requirements map to the track's demo flow
| Track 3 stage | Requirement | ID |
|---|---|---|
| Initiate | The user describes the loss in natural speech over Agora Conversational AI; the agent replies with Murf Falcon TTS | F1 |
| Plan | The agent announces an **ordered recovery plan** based on dependencies, and the plan is shown in the UI | F2 |
| Execute | The agent calls **at least 2 coordinated tools** across multiple MCP servers (bank, civic, notify) | F3 |
| Adapt | It handles a **bank outage** by falling back to the SMS block, flags a **suspicious transaction**, and asks for **approval** before sensitive actions | F4, F5 |
| Confirm & follow up | It verifies each outcome, emails a case file (PDF + .ics reminders) and schedules follow-ups | F6 |

## 4. Functional requirements
- **F1 Voice conversation.** Browser → Agora RTC channel. The Agora Conversational AI Engine handles speech-to-text, calls our custom LLM endpoint (OpenAI-compatible, streaming), and speaks the reply with Murf Falcon TTS.
- **F2 Planning.** On the first report, the agent calls `update_plan` with ordered steps. Default priority:
  1. freeze cards (money at risk)
  2. check for fraud
  3. lost-article police report (the reissue applications need it)
  4. reissue guidance
  5. case file and reminders
- **F3 Tool execution through MCP.**
  - **Bank MCP** (simulated): `list_cards`, `freeze_card`, `send_sms_block`, `get_recent_transactions`, `raise_dispute`.
  - **Civic MCP:** `find_nearest_police_station` (**real** OpenStreetMap lookup with an offline fallback), `file_lost_report` (prepares a report PDF and submits it to a simulated portal), `get_reissue_steps` (DL, Aadhaar, PAN, cards, SIM/phone).
  - **Notify MCP:** `send_case_file` (**real** email via Resend, with the PDF and .ics attached), `schedule_reminder`.
- **F4 Adapt and recover.** If `freeze_card` fails because the bank is unavailable, the agent must use `send_sms_block` and tell the user. If a tool errors, the agent explains and tries an alternative; it never pretends the action succeeded.
- **F5 Human in the loop.** `raise_dispute` and `file_lost_report` need an `approval_id`. The agent obtains one by calling `request_user_approval`. **The server enforces approval:** an approval only becomes valid after a *new user turn* following the request, and each approval works once.
- **F6 Confirm and follow up.** The agent reads back every reference number and emails the case file to the user. It schedules reminders (follow up on the police report, activate the new card, apply for the duplicate DL).
- **F7 Live activity panel.** The UI streams the plan, every tool call (which MCP server, the input, the result, the duration), approvals and the case summary through server-sent events.
- **F8 Text fallback.** Users can type instead of speak, for testing without spending voice or TTS minutes.

## 5. Non-functional requirements
- **N1 Latency.** Text streams to Agora as soon as Claude produces it. If a turn starts with tool calls, a short filler line goes out first ("On it.").
- **N2 Cost control.** All unit and integration tests use fakes, so they make no network calls. Email runs in `dry-run` mode by default. Real APIs run only through `npm run smoke`, one service at a time.
- **N3 Security.** The custom LLM endpoint requires a bearer secret, because it's exposed through a public tunnel. Secrets live only in `.env`, which git ignores. The App Certificate is only used on the server.
- **N4 Honesty.** Simulated systems (bank, police portal) are labelled "simulated" in tool results, the UI and the README. The generated report is a *prepared draft for submission*, not an official police record.
- **N5 Testability.** Every external dependency (LLM, fetch, email, clock) is injected.
- **N6 Reusability.** Each MCP server can also run on its own over stdio (`npm run mcp:bank`), for example in Claude Desktop.

## 6. Architecture
```
Browser (public/) ── Agora RTC ──▶ Agora Conversational AI Engine
   ▲  SSE activity feed              ASR (ares) → LLM (custom URL) → TTS (Murf Falcon)
   │                                               │  POST /llm/:session/chat/completions (SSE)
   │                                               ▼
 Express server (src/server.ts) ── Orchestrator (Claude, streaming tool loop, approval gate)
                                                   │ MCP (in-memory transport)
                     ┌─────────────────────────────┼──────────────────────────┐
                 Bank MCP (sim)            Civic MCP (OSM real + sim)    Notify MCP (Resend real)
```

## 7. External services and credentials
| Service | Used for | Env var | Status |
|---|---|---|---|
| Agora Conversational AI (REST) | start and stop the voice agent | `AGORA_APP_ID`, `AGORA_CUSTOMER_KEY/SECRET` | ✅ have |
| Agora App Certificate | RTC tokens | `AGORA_APP_CERTIFICATE` | optional (not enabled on the project) |
| Murf Falcon TTS | agent voice (configured in the Agora join request) | `MURF_API_KEY` | ✅ have |
| Anthropic Claude | planner and tool calling | `ANTHROPIC_API_KEY` | ✅ have |
| Resend | case-file email | `RESEND_API_KEY`, `DEMO_USER_EMAIL` | ✅ have |
| OpenStreetMap Nominatim/Overpass | nearest police station | none | free, no key |
| cloudflared | public URL for the LLM endpoint | none | ✅ installed |

## 8. Out of scope
- Real bank or government integrations: no public APIs exist for them, so they are simulated.
- Login and multiple users. One demo persona per session.

## 9. Acceptance criteria
1. `npm test` passes with no network access.
2. `npm run chat` (text mode, real Claude) completes the full workflow: plan → freeze (with the SBI fallback) → fraud flag → approval → report → reissue steps → email → reminders.
3. A voice session completes the same workflow, and the case-file email arrives in the demo inbox.
