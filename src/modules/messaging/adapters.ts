import type { Channel } from "@prisma/client";

export type OutboundMessage = { channel: Channel; to: string; subject?: string | null; body: string };
export type SendResult = { providerRef: string };

/** Provider adapter interface (WhatsApp Business Cloud, MSG91, SES/SMTP, …). */
export interface MessagingAdapter {
  readonly name: string;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** Default dev adapter: prints to the server console and records in `messages`. */
export class ConsoleAdapter implements MessagingAdapter {
  readonly name = "console";
  async send(msg: OutboundMessage): Promise<SendResult> {
    if (process.env.NODE_ENV !== "test") console.log(`[messaging:${msg.channel}] → ${msg.to}\n${msg.subject ? msg.subject + "\n" : ""}${msg.body}`);
    return { providerRef: `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
}

/** In-memory adapter for tests. */
export class MemoryAdapter implements MessagingAdapter {
  readonly name = "memory";
  sent: OutboundMessage[] = [];
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    return { providerRef: `mem-${this.sent.length}` };
  }
}

/** WhatsApp Business Cloud API (Phase 7 — enable by setting MESSAGING_PROVIDER=live and WHATSAPP_* env). */
export class WhatsAppCloudAdapter implements MessagingAdapter {
  readonly name = "whatsapp-cloud";
  constructor(private token: string, private phoneNumberId: string) {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    const res = await fetch(`https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: `91${msg.to}`, type: "text", text: { body: msg.body } }),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { messages?: { id: string }[] };
    return { providerRef: json.messages?.[0]?.id ?? "unknown" };
  }
}

/** MSG91 SMS (Phase 7). */
export class Msg91Adapter implements MessagingAdapter {
  readonly name = "msg91";
  constructor(private authKey: string, private senderId: string) {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    const res = await fetch("https://control.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: { authkey: this.authKey, "Content-Type": "application/json" },
      body: JSON.stringify({ sender: this.senderId, mobiles: `91${msg.to}`, message: msg.body }),
    });
    if (!res.ok) throw new Error(`MSG91 ${res.status}`);
    return { providerRef: `msg91-${Date.now()}` };
  }
}

let override: Partial<Record<Channel, MessagingAdapter>> | null = null;
const consoleAdapter = new ConsoleAdapter();

export function setAdapters(a: Partial<Record<Channel, MessagingAdapter>> | null) {
  override = a;
}

export function adapterFor(channel: Channel): MessagingAdapter {
  if (override?.[channel]) return override[channel]!;
  if (process.env.MESSAGING_PROVIDER === "live") {
    if (channel === "WHATSAPP" && process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
      return new WhatsAppCloudAdapter(process.env.WHATSAPP_TOKEN, process.env.WHATSAPP_PHONE_NUMBER_ID);
    if (channel === "SMS" && process.env.MSG91_AUTH_KEY) return new Msg91Adapter(process.env.MSG91_AUTH_KEY, process.env.MSG91_SENDER_ID ?? "NXTNTI");
  }
  return consoleAdapter;
}
