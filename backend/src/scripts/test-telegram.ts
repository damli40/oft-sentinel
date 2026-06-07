/**
 * Telegram delivery test — run with:
 *   cd backend && npx tsx src/scripts/test-telegram.ts
 *
 * What it does:
 *  1. Calls getUpdates → prints every chat ID the bot has seen (so you can find yours)
 *  2. Sends a test message to TELEGRAM_PUBLIC_ALERT_CHAT_ID (if set)
 *  3. Sends a test message to every chat in TELEGRAM_TEAM_ALERTS_JSON (if set)
 */
import "dotenv/config";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set in .env");
  process.exit(1);
}

const BASE = `https://api.telegram.org/bot${TOKEN}`;

async function tgGet(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = new URL(`${BASE}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  const body = await res.json() as { ok: boolean; result?: unknown; description?: string };
  if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description}`);
  return body.result;
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    await tgGet("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
    console.log(`  ✓ sent to ${chatId}`);
  } catch (e: any) {
    console.error(`  ✗ ${chatId}: ${e.message}`);
    if (chatId.startsWith("@")) {
      console.log(`    → Channels: make sure @oft_sentinel_bot is an admin with "Post Messages" permission`);
    } else {
      console.log(`    → Users: open the bot and send /start first, then grab your numeric ID from getUpdates below`);
    }
  }
}

// ── 1. getUpdates — show all chats the bot has seen ──────────────────────────
console.log("\n=== getUpdates (recent chats) ===");
let updates: any[] = [];
try {
  updates = (await tgGet("getUpdates", { limit: 100 })) as any[];
  if (updates.length === 0) {
    console.log("No updates yet. Open @oft_sentinel_bot in Telegram and send /start, then re-run this script.");
  } else {
    const seen = new Map<number, { type: string; name: string }>();
    for (const u of updates) {
      const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
      if (chat) seen.set(chat.id, { type: chat.type, name: chat.username ?? chat.title ?? chat.first_name ?? "?" });
    }
    for (const [id, info] of seen) {
      const handle = info.name.startsWith("@") ? info.name : `@${info.name}`;
      console.log(`  chat_id: ${id}  type: ${info.type}  name: ${handle}`);
      console.log(`    → set this in .env as the relevant TELEGRAM_*_CHAT_ID`);
    }
  }
} catch (e: any) {
  console.error("getUpdates failed:", e.message);
}

// ── 2. Public channel test ───────────────────────────────────────────────────
const publicId = process.env.TELEGRAM_PUBLIC_ALERT_CHAT_ID ?? process.env.TELEGRAM_ALERT_CHAT_ID ?? null;
console.log(`\n=== Public channel (TELEGRAM_PUBLIC_ALERT_CHAT_ID=${publicId ?? "not set"}) ===`);
if (!publicId) {
  console.log("  Not configured. Set TELEGRAM_PUBLIC_ALERT_CHAT_ID=@your_channel_username in .env");
} else {
  await sendMessage(publicId, "OFT Sentinel test message — public channel delivery check");
}

// ── 3. Team alerts test ──────────────────────────────────────────────────────
const teamRaw = process.env.TELEGRAM_TEAM_ALERTS_JSON;
console.log(`\n=== Team alerts (TELEGRAM_TEAM_ALERTS_JSON) ===`);
if (!teamRaw) {
  console.log("  Not configured.");
} else {
  let teamMap: Record<string, string[]> = {};
  try {
    const parsed = JSON.parse(teamRaw) as Record<string, string | string[]>;
    for (const [k, v] of Object.entries(parsed)) {
      teamMap[k] = Array.isArray(v) ? v : v.split(",").map((x) => x.trim());
    }
  } catch {
    console.error("  TELEGRAM_TEAM_ALERTS_JSON is not valid JSON");
  }
  for (const [ticker, ids] of Object.entries(teamMap)) {
    for (const id of ids) {
      console.log(`  ${ticker} → ${id}`);
      await sendMessage(id, `OFT Sentinel test — team alert for ${ticker}`);
    }
  }
}

console.log("\n=== Done ===");
console.log("If getUpdates is empty: open Telegram → find @oft_sentinel_bot → send /start");
console.log("Then use the numeric chat_id from this script in TELEGRAM_TEAM_ALERTS_JSON");
