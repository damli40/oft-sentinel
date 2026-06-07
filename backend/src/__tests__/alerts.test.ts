import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTeamTelegramContacts, telegramRecipients } from "../services/alerts.js";
import type { SentinelVerdict } from "../types.js";

const verdict: SentinelVerdict = {
  oft: "0x1111111111111111111111111111111111111111",
  chainId: 5000,
  ticker: "cmETH",
  score: 25,
  riskLevel: "CRITICAL",
  verdict: "Config drifted into CRITICAL.",
  reasons: ["ethereum: required DVN count dropped 2 to 1"],
  verdictHash: "0xabc",
  capturedAt: 1,
};

describe("Telegram alert routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses ticker/address contact maps with comma-separated or array chat ids", () => {
    const contacts = parseTeamTelegramContacts(JSON.stringify({
      cmETH: ["123", "@cmeth_team"],
      "0x1111111111111111111111111111111111111111": "456, @ops",
    }));

    expect(contacts.cmeth).toEqual(["123", "@cmeth_team"]);
    expect(contacts["0x1111111111111111111111111111111111111111"]).toEqual(["456", "@ops"]);
  });

  it("returns an empty map for missing or invalid JSON", () => {
    expect(parseTeamTelegramContacts()).toEqual({});
    expect(parseTeamTelegramContacts("{not-json")).toEqual({});
  });

  it("resolves public channel plus OFT team contacts by ticker and address", () => {
    vi.stubEnv("TELEGRAM_PUBLIC_ALERT_CHAT_ID", "@oft_public");
    vi.stubEnv("TELEGRAM_TEAM_ALERTS_JSON", JSON.stringify({
      cmeth: ["123", "123"],
      "0x1111111111111111111111111111111111111111": ["456"],
    }));

    expect(telegramRecipients(verdict)).toEqual({
      publicChatId: "@oft_public",
      teamChatIds: ["123", "456"],
    });
  });

  it("keeps the legacy TELEGRAM_ALERT_CHAT_ID as public-channel fallback", () => {
    vi.stubEnv("TELEGRAM_ALERT_CHAT_ID", "@legacy_public");

    expect(telegramRecipients(verdict)).toEqual({
      publicChatId: "@legacy_public",
      teamChatIds: [],
    });
  });
});
