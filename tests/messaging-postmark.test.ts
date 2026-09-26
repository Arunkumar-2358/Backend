import { describe, it, expect, vi, afterEach } from "vitest";
import { PostmarkAdapter, adapterFor, ConsoleAdapter } from "@/modules/messaging/adapters";

const msg = { channel: "EMAIL" as const, to: "priya@example.com", subject: "Your interview", body: "Hi Priya" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Postmark email adapter", () => {
  it("POSTs to Postmark with the server token and returns the MessageID", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ErrorCode: 0, MessageID: "pm-123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await new PostmarkAdapter("tok-1", "Nextenti <no-reply@nextenti.ai>").send(msg);
    expect(r).toEqual({ providerRef: "pm-123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("tok-1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ From: "Nextenti <no-reply@nextenti.ai>", To: "priya@example.com", Subject: "Your interview", TextBody: "Hi Priya", MessageStream: "outbound" });
  });

  it("throws with the status on non-2xx, without leaking PII", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 300, Message: "Invalid 'To' address: 'priya@example.com'." }), { status: 422 })));
    const err = await new PostmarkAdapter("tok-1", "a@b.c").send(msg).catch((e) => e);
    expect(err.message).toBe("Postmark 422 (ErrorCode 300)");
    expect(err.message).not.toContain("priya");
  });

  it("reports network failures / timeouts without PII", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
    const err = await new PostmarkAdapter("tok-1", "a@b.c").send(msg).catch((e) => e);
    expect(err.message).toBe("Postmark request failed (timeout)");
  });

  it("is selected for EMAIL only under MESSAGING_PROVIDER=live with POSTMARK_SERVER_TOKEN and EMAIL_FROM", () => {
    vi.stubEnv("MESSAGING_PROVIDER", "mock");
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "tok-1");
    vi.stubEnv("EMAIL_FROM", "a@b.c");
    expect(adapterFor("EMAIL")).toBeInstanceOf(ConsoleAdapter);
    vi.stubEnv("MESSAGING_PROVIDER", "live");
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "");
    vi.stubEnv("EMAIL_FROM", "");
    expect(adapterFor("EMAIL")).toBeInstanceOf(ConsoleAdapter);
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "tok-1");
    expect(adapterFor("EMAIL")).toBeInstanceOf(ConsoleAdapter);
    vi.stubEnv("EMAIL_FROM", "a@b.c");
    expect(adapterFor("EMAIL")).toBeInstanceOf(PostmarkAdapter);
    expect(adapterFor("WHATSAPP")).not.toBeInstanceOf(PostmarkAdapter);
  });
});
