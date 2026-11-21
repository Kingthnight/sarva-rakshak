# Hackathon runbook: Sarva Rakshak (Track 3)

## Status
- [x] Requirements: `REQUIREMENTS.md`
- [x] Code: agent, 3 MCP servers, Agora integration, UI
- [x] Tests: 48 offline tests (`npm test`)
- [x] Free real-API smoke tests: Agora ✅ Murf ✅ OpenStreetMap ✅
- [x] One real Claude turn through MCP ✅
- [ ] Full text-mode demo with real Claude: `npm run chat -- --demo`
- [ ] Real email test: `npm run smoke -- email`
- [ ] Voice session: tunnel → `PUBLIC_BASE_URL` → `npm run dev` → Start emergency call
- [ ] Set `EMAIL_MODE=live` for the final demo
- [ ] Make the repo public, record a backup video, submit

## Demo script (about 3 minutes)
1. **Hook (15 s):** "Losing your wallet in India means an hour of helplines, police and paperwork, in the wrong order. Sarva does it in two minutes, by voice."
2. **Call:** "I just lost my wallet at Majestic bus stand, about 20 minutes ago. It had my HDFC credit card, SBI debit card, driving licence and Aadhaar."
3. Point at the **plan** panel, then at **MCP activity**: HDFC frozen, SBI's API down, SMS fallback used.
4. Sarva flags the **₹4,999 charge** and asks: "Shall I dispute it and file the report at the nearest station?" Say **"Yes."**
5. Show the dispute and report references, the reissue steps and reminders, then the **email arriving on your phone** with the PDFs and calendar invite.
6. **Close:** the architecture slide (Agora → Claude → 3 MCP servers → Murf), with human approval enforced on the server.

## If something breaks on stage
- Voice fails: use the text box in the same UI. It runs the same agent and shows the same activity panel.
- The tunnel URL changed: update `PUBLIC_BASE_URL` and restart `npm run dev`.
- Slow replies: set `CLAUDE_MODEL=claude-haiku-5-5` in `.env`.
