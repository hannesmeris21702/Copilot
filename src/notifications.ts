/**
 * Notifications – send alerts via Telegram or generic webhook.
 */

import axios from "axios";
import { getLogger } from "./logger";

export interface NotificationPayload {
  type: "rebalance_start" | "rebalance_success" | "rebalance_failure" | "info";
  message: string;
  txDigest?: string;
  network?: "mainnet" | "testnet";
}

const EXPLORER_BASE: Record<string, string> = {
  mainnet: "https://suiscan.xyz/mainnet/tx",
  testnet: "https://suiscan.xyz/testnet/tx",
};

function buildMessage(payload: NotificationPayload): string {
  const emoji = {
    rebalance_start: "🔄",
    rebalance_success: "✅",
    rebalance_failure: "❌",
    info: "ℹ️",
  }[payload.type];

  let text = `${emoji} *Cetus Rebalance Bot*\n${payload.message}`;

  if (payload.txDigest) {
    const base = EXPLORER_BASE[payload.network || "mainnet"];
    text += `\n[View TX](${base}/${payload.txDigest})`;
  }
  return text;
}

export async function sendNotification(
  webhookUrl: string,
  payload: NotificationPayload
): Promise<void> {
  const text = buildMessage(payload);

  // Detect if this is a Telegram bot API URL by parsing the hostname
  try {
    const parsed = new URL(webhookUrl);
    if (parsed.hostname === "api.telegram.org") {
      const chatId = parsed.searchParams.get("chat_id");
      const botToken = parsed.pathname.match(/\/bot([^/]+)\//)?.[1];
      if (chatId && botToken) {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        });
        return;
      }
    }
  } catch (_) {
    // Fall through to generic POST
  }

  // Generic webhook POST
  await axios.post(webhookUrl, { text, payload });
}

export async function notify(
  webhookUrl: string | undefined,
  payload: NotificationPayload
): Promise<void> {
  if (!webhookUrl) return;
  try {
    await sendNotification(webhookUrl, payload);
  } catch (err) {
    getLogger().warn({ err }, "Failed to send notification");
  }
}
