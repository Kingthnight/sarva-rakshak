import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BankUnavailableError, CallRequiredError, ChannelUnsupportedError, NotFoundError } from "../services/bank.js";
import { callsOf, fail, ok, type ServiceContext } from "./context.js";

export function createBankServer(ctx: ServiceContext): McpServer {
  const server = new McpServer({ name: "sarva-bank", version: "0.2.0" });
  const { bank, caseFile } = ctx;

  /** Adds (once) a "you need to call the bank" task for the UI and case file. */
  const needCall = (cardId: string) => {
    const o = bank.blockOptions(cardId);
    const id = `call-${o.cardId}`;
    if (!caseFile.actionsNeeded.some((a) => a.id === id)) {
      const detail = [`Helpline ${o.helpline || "on the back of your card / bank website"} (24×7)`, o.selfServe ? `or ${o.selfServe.replace("You can also block it yourself from another device: ", "in the app: ")}` : ""].filter(Boolean).join(" · ");
      caseFile.actionsNeeded.push({ id, cardId: o.cardId, title: `Call ${o.bank} to block ••${o.last4}`, detail, tel: o.tel || undefined, done: false });
    }
    return o;
  };

  const known = (e: unknown) => {
    if (e instanceof NotFoundError) return fail("CARD_NOT_FOUND", { message: e.message, hint: "Use list_cards; only cards in the user's profile can be acted on." });
    if (e instanceof ChannelUnsupportedError) return fail("CHANNEL_UNSUPPORTED", { message: e.message, suggestion: "Call get_block_options and guide the user to call the helpline." });
    return null;
  };

  server.registerTool(
    "list_cards",
    {
      title: "List cards",
      description: "List the user's saved cards: bank, type, last 4 digits, nickname, status and the channels that can block it (api, sms, call). Simulated bank sandbox.",
      inputSchema: {},
    },
    async () => ok({ simulated: true, cards: bank.listCards().map(({ sms, ...c }) => ({ ...c, smsBlockAvailable: Boolean(sms) })) }),
  );

  server.registerTool(
    "get_block_options",
    {
      title: "How to block a card",
      description: "For one card: supported block channels, helpline number with a tel: link, SMS command, and a short script for the user to read when they call.",
      inputSchema: { card_id: z.string().describe("Card id from list_cards, or the last 4 digits") },
    },
    async ({ card_id }) => {
      try {
        return ok(bank.blockOptions(card_id));
      } catch (e) {
        return known(e) ?? Promise.reject(e);
      }
    },
  );

  server.registerTool(
    "freeze_card",
    {
      title: "Freeze card",
      description:
        "Immediately freeze a card through the bank's card-control API. Protective and reversible, so no approval is needed. Errors: BANK_UNAVAILABLE (use send_sms_block), CALL_REQUIRED (the bank only blocks by phone: give the user the helpline and script, then record_manual_block once they've called).",
      inputSchema: { card_id: z.string().describe("Card id from list_cards, or the last 4 digits") },
    },
    async ({ card_id }) => {
      try {
        const r = bank.freezeCard(card_id);
        caseFile.cardActions.push({ cardId: r.cardId, bank: r.bank, last4: r.last4, method: "api", reference: r.reference, status: "frozen", at: r.frozenAt });
        return ok(r);
      } catch (e) {
        if (e instanceof BankUnavailableError) {
          const o = bank.blockOptions(card_id);
          return fail("BANK_UNAVAILABLE", {
            bank: e.bank,
            message: e.message,
            smsBlockAvailable: Boolean(o.sms),
            suggestion: o.sms
              ? "Call send_sms_block for this card, unless the user's phone was also lost (SMS must come from the registered number); then guide them to call the helpline from another phone."
              : "Guide the user to call the helpline (get_block_options).",
          });
        }
        if (e instanceof CallRequiredError) {
          const o = needCall(e.card.id);
          return fail("CALL_REQUIRED", { message: e.message, helpline: o.helpline, tel: o.tel, callScript: o.callScript, selfServe: o.selfServe, suggestion: "Tell the user to call now (a call button is on their screen). Ask them for the reference number afterwards and call record_manual_block." });
        }
        return known(e) ?? Promise.reject(e);
      }
    },
  );

  server.registerTool(
    "send_sms_block",
    {
      title: "Block card via SMS",
      description: "Fallback block: sends the bank's official SMS block command from the user's registered number. Use when freeze_card returns BANK_UNAVAILABLE.",
      inputSchema: { card_id: z.string() },
    },
    async ({ card_id }) => {
      try {
        const r = bank.smsBlock(card_id);
        caseFile.cardActions.push({ cardId: r.cardId, bank: r.bank, last4: r.last4, method: "sms", reference: r.reference, status: "block requested", at: ctx.now().toISOString() });
        return ok(r);
      } catch (e) {
        if (e instanceof ChannelUnsupportedError) needCall(e.card.id);
        return known(e) ?? Promise.reject(e);
      }
    },
  );

  server.registerTool(
    "record_manual_block",
    {
      title: "Record a block the user did themselves",
      description: "After the user blocked a card by calling the helpline, in the bank app or at a branch, record their reference number so the case file is complete.",
      inputSchema: {
        card_id: z.string(),
        method: z.enum(["call", "app", "branch"]),
        reference: z.string().min(2).max(40).describe("Reference/complaint number the bank gave the user; use 'not provided' if they don't have one"),
      },
    },
    async ({ card_id, method, reference }) => {
      try {
        const r = bank.recordManualBlock(card_id, method, reference);
        caseFile.cardActions.push({ cardId: r.cardId, bank: r.bank, last4: r.last4, method, reference, status: "blocked", at: r.recordedAt });
        caseFile.actionsNeeded.filter((a) => a.cardId === r.cardId).forEach((a) => (a.done = true));
        return ok(r);
      } catch (e) {
        return known(e) ?? Promise.reject(e);
      }
    },
  );

  server.registerTool(
    "call_bank_for_user",
    {
      title: "Call the bank for the user",
      description:
        "Sarva phones the bank's helpline on the user's behalf (simulated call in this prototype), works through the phone menu and holds for an agent. It returns when the bank asks to verify the cardholder (date of birth). Then ask the user for their date of birth and call bank_call_verify. Use for CALL_REQUIRED cards, or when SMS isn't possible. Protective action, so no approval needed.",
      inputSchema: { card_id: z.string() },
    },
    async ({ card_id }) => {
      try {
        const card = bank.getCard(card_id);
        if (card.status === "blocked" || card.status === "frozen") return ok({ alreadyBlocked: true, status: card.status, last4: card.last4 });
        const call = await callsOf(ctx).start(card);
        const id = `call-${card.id}`;
        const action = caseFile.actionsNeeded.find((a) => a.id === id);
        if (action) action.detail = `Sarva is on the call with ${card.bankName} (call ${call.callId})`;
        return ok({
          simulated: true,
          callId: call.callId,
          state: call.state,
          bankSays: call.steps.at(-1)?.label,
          next: call.state === "verifying" ? "Ask the user for their date of birth (day, month, year), then call bank_call_verify. Never ask for OTP, PIN or CVV." : undefined,
        });
      } catch (e) {
        return known(e) ?? fail("CALL_FAILED", { message: (e as Error).message });
      }
    },
  );

  server.registerTool(
    "bank_call_verify",
    {
      title: "Answer the bank's verification on the call",
      description: "Pass the cardholder's date of birth to the bank on the ongoing call. On success the bank blocks the card and gives a reference, which is saved automatically.",
      inputSchema: { call_id: z.string(), date_of_birth: z.string().min(4).max(40) },
    },
    async ({ call_id, date_of_birth }) => {
      try {
        const call = await callsOf(ctx).verify(call_id, date_of_birth);
        const r = bank.recordManualBlock(call.cardId, "call", call.reference!);
        caseFile.cardActions.push({ cardId: r.cardId, bank: r.bank, last4: r.last4, method: "call", reference: call.reference!, status: "blocked", at: r.recordedAt });
        caseFile.actionsNeeded.filter((a) => a.cardId === r.cardId).forEach((a) => {
          a.done = true;
          a.title = `${r.bank} ••${r.last4} blocked by Sarva's call`;
          a.detail = `Reference ${call.reference}`;
        });
        return ok({ simulated: true, blocked: true, last4: r.last4, bank: r.bank, reference: call.reference });
      } catch (e) {
        return fail("VERIFICATION_FAILED", { message: (e as Error).message });
      }
    },
  );

  server.registerTool(
    "start_call_copilot",
    {
      title: "Co-pilot the user's own call",
      description: "The user prefers to call the bank themselves: show a live guide (call button, what to say, typical phone-menu path). When they read out the reference number, call record_manual_block.",
      inputSchema: { card_id: z.string() },
    },
    async ({ card_id }) => {
      try {
        const o = needCall(card_id);
        const running = callsOf(ctx).forCard(o.cardId);
        if (running) callsOf(ctx).cancel(running.callId);
        return ok({
          mode: "copilot",
          bank: o.bank,
          last4: o.last4,
          helpline: o.helpline,
          tel: o.tel,
          menuHint: "Menus vary. Usually: choose language → Cards → Report lost or stolen card. Say 'agent' or press 0 to reach a person.",
          say: `Please block my ${o.bank} card ending ${o.last4.split("").join(" ")}. It was lost.`,
          never: "Never share OTP, PIN or CVV on the call. Banks don't need them to block a card.",
          selfServe: o.selfServe,
        });
      } catch (e) {
        return known(e) ?? Promise.reject(e);
      }
    },
  );

  server.registerTool(
    "get_recent_transactions",
    {
      title: "Recent transactions",
      description: "Fetch recent transactions for a card with fraud flags (suspicious=true plus reason). Declined attempts on frozen cards are included.",
      inputSchema: {
        card_id: z.string(),
        within_minutes: z.number().int().positive().max(10080).optional().describe("Look-back window, default 1440"),
      },
    },
    async ({ card_id, within_minutes }) => {
      try {
        const txns = bank.recentTransactions(card_id, within_minutes ?? 1440);
        for (const t of txns) if (t.suspicious && !caseFile.flaggedTransactions.some((x) => x.id === t.id)) caseFile.flaggedTransactions.push(t);
        return ok({ simulated: true, card_id, transactions: txns, suspiciousCount: txns.filter((t) => t.suspicious).length });
      } catch (e) {
        return known(e) ?? Promise.reject(e);
      }
    },
  );

  server.registerTool(
    "raise_dispute",
    {
      title: "Raise transaction dispute",
      description: "File a fraud dispute (chargeback) for an approved transaction. Sensitive: requires explicit user approval. Declined attempts cannot be disputed (no money moved).",
      inputSchema: { txn_id: z.string(), reason: z.string().min(3) },
    },
    async ({ txn_id, reason }) => {
      try {
        const d = bank.raiseDispute(txn_id, reason);
        if (!caseFile.disputes.some((x) => x.disputeId === d.disputeId)) caseFile.disputes.push(d);
        return ok(d);
      } catch (e) {
        if (e instanceof NotFoundError) return fail("TXN_NOT_FOUND", { message: e.message });
        return fail("DISPUTE_REJECTED", { message: (e as Error).message });
      }
    },
  );

  server.registerTool(
    "request_replacement_card",
    {
      title: "Request replacement card",
      description: "Order a replacement for a blocked/frozen card, delivered to the registered address. Sensitive (may carry a fee): requires explicit user approval.",
      inputSchema: { card_id: z.string(), deliver_to: z.enum(["registered address", "home branch"]).default("registered address") },
    },
    async ({ card_id, deliver_to }) => {
      try {
        const r = bank.requestReplacement(card_id, deliver_to);
        caseFile.replacements.push({ requestId: r.requestId, cardId: r.cardId, bank: r.bank, last4: r.last4, deliverTo: r.deliverTo, expectedBy: r.expectedBy });
        return ok(r);
      } catch (e) {
        return known(e) ?? fail("REPLACEMENT_REJECTED", { message: (e as Error).message });
      }
    },
  );

  return server;
}
