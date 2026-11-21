import { describe, expect, it, vi } from "vitest";
import { BankSimulator, BankUnavailableError, NotFoundError } from "../src/services/bank.js";
import { GeoService, haversineKm, offlineLookup } from "../src/services/geo.js";
import { getGuides, normaliseDocument } from "../src/services/reissue.js";
import { buildCaseFilePdf, buildIcs, buildLostReportPdf } from "../src/services/documents.js";
import { DryRunEmailSender, EmailError, ResendEmailSender } from "../src/services/email.js";
import { newCaseFile } from "../src/domain/case.js";
import { FIXED_NOW, seqIds } from "./helpers.js";

const now = () => FIXED_NOW;

describe("BankSimulator", () => {
  it("lists two demo cards, both active", () => {
    const b = new BankSimulator({ now });
    expect(b.listCards().map((c) => [c.bank, c.last4, c.status])).toEqual([
      ["HDFC", "4821", "active"],
      ["SBI", "1093", "active"],
    ]);
  });

  it("freezes a card by id or last4 and returns a reference", () => {
    const b = new BankSimulator({ now, idGen: seqIds() });
    const r = b.freezeCard("4821");
    expect(r).toMatchObject({ simulated: true, bank: "HDFC", status: "frozen", reference: "HDFC-BLK-T001" });
    expect(b.listCards()[0].status).toBe("frozen");
  });

  it("throws BankUnavailableError for banks in outage, and SMS fallback works", () => {
    const b = new BankSimulator({ now, outages: ["sbi"] });
    expect(() => b.freezeCard("sbi-dc-1093")).toThrow(BankUnavailableError);
    const sms = b.smsBlock("sbi-dc-1093");
    expect(sms).toMatchObject({ method: "sms", smsTo: "567676", smsBody: "BLOCK 1093", status: "block_requested" });
  });

  it("throws NotFoundError for unknown cards", () => {
    expect(() => new BankSimulator({ now }).freezeCard("9999")).toThrow(NotFoundError);
  });

  it("flags only the recent unknown online transaction as suspicious", () => {
    const b = new BankSimulator({ now });
    const hdfc = b.recentTransactions("hdfc-cc-4821");
    expect(hdfc.filter((t) => t.suspicious).map((t) => [t.id, t.amountInr])).toEqual([["txn-1002", 4999]]);
    expect(hdfc.find((t) => t.id === "txn-1002")!.reason).toMatch(/12 minutes ago/);
    expect(b.recentTransactions("sbi-dc-1093", 60)).toEqual([]); // the metro txn is 26h old
  });

  it("raises a dispute once (idempotent)", () => {
    const b = new BankSimulator({ now, idGen: seqIds() });
    const d1 = b.raiseDispute("txn-1002", "not me");
    const d2 = b.raiseDispute("txn-1002", "again");
    expect(d1.disputeId).toBe(d2.disputeId);
    expect(d1.amountInr).toBe(4999);
    expect(() => b.raiseDispute("nope", "x")).toThrow(NotFoundError);
  });
});

describe("GeoService", () => {
  it("haversine distance is sane", () => {
    expect(haversineKm({ lat: 12.9767, lon: 77.5713 }, { lat: 12.9767, lon: 77.5713 })).toBe(0);
    expect(haversineKm({ lat: 12.9767, lon: 77.5713 }, { lat: 12.9352, lon: 77.6245 })).toBeGreaterThan(6);
  });

  it("offline lookup picks Upparpet for Majestic", () => {
    const r = offlineLookup("lost near Majestic bus stand");
    expect(r.source).toBe("offline");
    expect(r.stations[0].name).toBe("Upparpet Police Station");
    expect(r.emergencyNumbers).toEqual({ police: "112", cyberFraud: "1930" });
  });

  it("uses Nominatim + Overpass in live mode and sorts by distance", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("nominatim")) return new Response(JSON.stringify([{ lat: "12.9767", lon: "77.5713", display_name: "Majestic, Bengaluru" }]));
      return new Response(
        JSON.stringify({
          elements: [
            { lat: 12.99, lon: 77.6, tags: { name: "Far Station" } },
            { center: { lat: 12.977, lon: 77.5715 }, tags: { name: "Near Station", phone: "080-1234" } },
            { tags: { name: "No coords" } },
          ],
        }),
      );
    });
    const r = await new GeoService(fetchFn as any, "live").nearestPoliceStations("Majestic");
    expect(r.source).toBe("openstreetmap");
    expect(r.stations.map((s) => s.name)).toEqual(["Near Station", "Far Station"]);
    expect(r.stations[0].phone).toBe("080-1234");
    const [firstUrl, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstUrl).toContain("Bengaluru");
    expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/sarva-rakshak/);
  });

  it("tries the next Overpass mirror, then Nominatim's bounded search", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("interpreter")) return new Response("timeout", { status: 504 });
      if (url.includes("q=police"))
        return new Response(
          JSON.stringify([
            { lat: "12.9771", lon: "77.5713", name: "Upparpet Police Station", display_name: "Upparpet Police Station, Gandhinagar, Bengaluru" },
            { lat: "12.97", lon: "77.58", name: "Halasuru Gate Traffic Police Station", display_name: "x" },
          ]),
        );
      return new Response(JSON.stringify([{ lat: "12.9767", lon: "77.5713", display_name: "Majestic" }]));
    });
    const r = await new GeoService(fetchFn as any, "live").nearestPoliceStations("Majestic");
    expect(r.source).toBe("openstreetmap");
    expect(r.stations.map((s) => s.name)).toEqual(["Upparpet Police Station"]);
    expect(fetchFn.mock.calls.filter(([u]) => String(u).includes("interpreter"))).toHaveLength(2);
  });

  it("falls back to offline data on network errors", async () => {
    const r = await new GeoService(async () => {
      throw new Error("ECONNRESET");
    }, "live").nearestPoliceStations("Koramangala");
    expect(r.source).toBe("offline");
    expect(r.stations[0].name).toBe("Koramangala Police Station");
  });

  it("falls back when the API returns an error status", async () => {
    const r = await new GeoService(async () => new Response("busy", { status: 429 }), "live").nearestPoliceStations("Majestic");
    expect(r.source).toBe("offline");
  });
});

describe("reissue guides", () => {
  it("normalises spoken document names", () => {
    expect(normaliseDocument("my DL")).toBe("driving_licence");
    expect(normaliseDocument("Aadhar card")).toBe("aadhaar");
    expect(normaliseDocument("SBI debit card")).toBe("bank_card");
    expect(normaliseDocument("iPhone")).toBe("phone_sim");
    expect(normaliseDocument("gym membership")).toBeNull();
  });

  it("dedupes and reports whether a police report is needed", () => {
    const r = getGuides(["driving licence", "DL", "aadhaar", "gym card?"]);
    expect(r.guides.map((g) => g.document)).toEqual(["driving_licence", "aadhaar", "bank_card"]);
    expect(r.policeReportNeeded).toBe(true);
    expect(getGuides(["aadhaar"]).policeReportNeeded).toBe(false);
    expect(getGuides(["passport"]).unknown).toEqual(["passport"]);
  });
});

describe("documents", () => {
  const c = newCaseFile({ caseId: "CASE-1", email: "a@b.c", now: FIXED_NOW });

  it("renders the lost report and case file as PDFs", async () => {
    const report = await buildLostReportPdf(c, {
      reference: "SRK-LAR-1",
      items: ["wallet"],
      location: "Majestic",
      lostAt: "9am",
      narrative: "I lost my wallet on the bus.",
      submittedAt: FIXED_NOW.toISOString(),
      portal: "simulated-police-portal",
    });
    expect(report.subarray(0, 4).toString()).toBe("%PDF");
    const cf = await buildCaseFilePdf(c);
    expect(cf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("builds a valid ICS with alarms and escaping", () => {
    const ics = buildIcs([{ id: "R1", title: "Follow up, police", dueAt: "2026-11-24T09:30:00.000Z", notes: "Line1\nLine2" }], FIXED_NOW);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART:20261124T093000Z");
    expect(ics).toContain("SUMMARY:Follow up\\, police");
    expect(ics).toContain("DESCRIPTION:Line1\\nLine2");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics.split("\r\n").length).toBeGreaterThan(10);
  });
});

describe("email senders", () => {
  it("dry-run records messages", async () => {
    const s = new DryRunEmailSender();
    const r = await s.send({ to: "x@y.z", subject: "hi", html: "<p>hi</p>" });
    expect(r).toEqual({ id: "dry-run-1", mode: "dry-run" });
    expect(s.outbox).toHaveLength(1);
  });

  it("Resend sender posts the right payload with base64 attachments", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: "em_123" }), { status: 200 }));
    const s = new ResendEmailSender("re_key", "Sarva <onboarding@resend.dev>", fetchFn as any);
    const r = await s.send({ to: "x@y.z", subject: "S", html: "<b>h</b>", attachments: [{ filename: "a.txt", content: "hello" }] });
    expect(r).toEqual({ id: "em_123", mode: "live" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: "Sarva <onboarding@resend.dev>", to: ["x@y.z"], subject: "S" });
    expect(Buffer.from(body.attachments[0].content, "base64").toString()).toBe("hello");
  });

  it("Resend sender surfaces API errors", async () => {
    const s = new ResendEmailSender("bad", "f", (async () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 })) as any);
    await expect(s.send({ to: "x@y.z", subject: "S", html: "" })).rejects.toThrow(EmailError);
  });
});
