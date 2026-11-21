import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BankUnavailableError, NotFoundError } from "../services/bank.js";
import { fail, ok, type ServiceContext } from "./context.js";

export function createBankServer(ctx: ServiceContext): McpServer {
  const server = new McpServer({ name: "sarva-bank", version: "0.1.0" });
  const { bank, caseFile } = ctx;

  server.registerTool(
    "list_cards",
    {
      title: "List cards",
      description: "List the user's bank cards (bank, type, last 4 digits, current status). Simulated bank sandbox.",
      inputSchema: {},
    },
    async () => ok({ simulated: true, cards: bank.listCards() }),
  );

  server.registerTool(
    "freeze_card",
    {
      title: "Freeze card",
      description:
        "Immediately freeze (temporarily block) a card through the bank's card-control API. Protective and reversible, so no approval is needed. If the bank is unavailable this returns error BANK_UNAVAILABLE; then use send_sms_block.",
      inputSchema: { card_id: z.string().describe("Card id from list_cards, or the last 4 digits") },
    },
    async ({ card_id }) => {
      try {
        const r = bank.freezeCard(card_id);
        caseFile.cardActions.push({ cardId: r.cardId, bank: r.bank, last4: r.last4, method: "api", reference: r.reference, status: "frozen", at: r.frozenAt });
        return ok(r);
      } catch (e) {
        if (e instanceof BankUnavailableError)
          return fail("BANK_UNAVAILABLE", { bank: e.bank, message: e.message, suggestion: "Call send_sms_block for this card and tell the user." });
        if (e instanceof NotFoundError) return fail("CARD_NOT_FOUND", { message: e.message });
        throw e;
      }
    },
  );

  server.registerTool(
    "send_sms_block",
    {
      title: "Block card via SMS",
      description: "Fallback block: sends the bank's official SMS block command from the user's registered number. Use when freeze_card fails.",
      inputSchema: { card_id: z.string() },
    },
    async ({ card_id }) => {
      try {
        const r = bank.smsBlock(card_id);
        caseFile.cardActions.push({ cardId: r.cardId, bank: r.bank, last4: r.last4, method: "sms", reference: r.reference, status: "block requested", at: ctx.now().toISOString() });
        return ok(r);
      } catch (e) {
        if (e instanceof NotFoundError) return fail("CARD_NOT_FOUND", { message: e.message });
        throw e;
      }
    },
  );

  server.registerTool(
    "get_recent_transactions",
    {
      title: "Recent transactions",
      description: "Fetch recent transactions for a card with fraud flags (suspicious=true plus reason).",
      inputSchema: {
        card_id: z.string(),
        within_minutes: z.number().int().positive().max(10080).optional().describe("Look-back window, default 1440"),
      },
    },
    async ({ card_id, within_minutes }) => {
      try {
        const txns = bank.recentTransactions(card_id, within_minutes ?? 1440);
        for (const t of txns) {
          if (t.suspicious && !caseFile.flaggedTransactions.some((x) => x.id === t.id)) caseFile.flaggedTransactions.push(t);
        }
        return ok({ simulated: true, card_id, transactions: txns, suspiciousCount: txns.filter((t) => t.suspicious).length });
      } catch (e) {
        if (e instanceof NotFoundError) return fail("CARD_NOT_FOUND", { message: e.message });
        throw e;
      }
    },
  );

  server.registerTool(
    "raise_dispute",
    {
      title: "Raise transaction dispute",
      description: "File a fraud dispute (chargeback) for a transaction. Sensitive: requires explicit user approval.",
      inputSchema: { txn_id: z.string(), reason: z.string().min(3) },
    },
    async ({ txn_id, reason }) => {
      try {
        const d = bank.raiseDispute(txn_id, reason);
        if (!caseFile.disputes.some((x) => x.disputeId === d.disputeId)) caseFile.disputes.push(d);
        return ok(d);
      } catch (e) {
        if (e instanceof NotFoundError) return fail("TXN_NOT_FOUND", { message: e.message });
        throw e;
      }
    },
  );

  return server;
}
