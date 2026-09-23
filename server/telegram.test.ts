import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { runDebitForService, seedData } from "./domain";
import {
  configureTelegramIntegration,
  disableTelegramPolling,
  enableTelegramPolling,
  handleTelegramUpdate,
  pollTelegramUpdates,
  sendLowBalanceWarnings,
  sendServiceBalanceSummary
} from "./telegram";
import type { AppData } from "./types";

const originalFetch = globalThis.fetch;
const originalTelegramTransport = process.env.TELEGRAM_API_TRANSPORT;

beforeEach(() => {
  process.env.TELEGRAM_API_TRANSPORT = "fetch";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTelegramTransport === undefined) delete process.env.TELEGRAM_API_TRANSPORT;
  else process.env.TELEGRAM_API_TRANSPORT = originalTelegramTransport;
});

function telegramData() {
  const data = seedData();
  data.settings.telegram.enabled = true;
  data.settings.telegram.botToken = "test-token";
  data.settings.telegram.chatId = "-100500";
  data.settings.telegram.pollingEnabled = true;
  data.users[0].telegramId = "101";
  data.users[0].botAdmin = true;
  data.users[1].telegramId = "202";
  return data;
}

function okResponse(result: unknown = true) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function captureTelegramRequests() {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1) ?? "";
    requests.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return okResponse();
  };
  return requests;
}

async function command(data: AppData, telegramId: string, text: string, extra: Record<string, unknown> = {}) {
  const result = await handleTelegramUpdate(data, {
    chat: { id: 777, type: "private" },
    from: { id: telegramId },
    text,
    ...extra
  });
  return result as { handled: boolean; reply?: string };
}

test("balance, services and admin users commands read the latest price and post-debit balances", async () => {
  const data = telegramData();
  const requests = captureTelegramRequests();
  data.services[0].monthlyCost = 1_000;
  runDebitForService(data, data.services[0].id, "manual");

  const balance = await command(data, "101", "/balance");
  const services = await command(data, "101", "/services");
  const users = await command(data, "101", "/users");

  assert.equal(balance.handled, true);
  assert.match(balance.reply ?? "", /-260,00 RUB/);
  assert.match(balance.reply ?? "", /500,00 RUB/);
  assert.match(services.reply ?? "", /500,00 RUB/);
  assert.match(services.reply ?? "", /-260,00 RUB/);
  assert.match(users.reply ?? "", /Тариф: 500,00 RUB/);
  assert.match(users.reply ?? "", /-260,00 RUB/);
  assert.match(users.reply ?? "", /-440,00 RUB/);
  const sentMessages = requests.filter((item) => item.method === "sendMessage");
  assert.equal(sentMessages.length, 3);
  assert.ok(
    sentMessages.every(
      (item) =>
        (item.body.reply_markup as { remove_keyboard?: boolean } | undefined)?.remove_keyboard === true &&
        !("keyboard" in ((item.body.reply_markup as Record<string, unknown> | undefined) ?? {}))
    )
  );
});

test("deposit commands, restrictions, help and admin permissions work on one state", async () => {
  const data = telegramData();
  const requests = captureTelegramRequests();

  assert.match((await command(data, "101", "/help")).reply ?? "", /Команды для Алексей/);
  assert.equal((await command(data, "101", "/pay 100")).handled, true);
  assert.equal(data.users[0].balance, 340);
  assert.match((await command(data, "101", "/deposit 60 VPN Main")).reply ?? "", /400,00 RUB/);
  assert.equal(data.users[0].balance, 400);

  data.users[1].commandDepositsBlocked = true;
  assert.match((await command(data, "202", "/pay 50")).reply ?? "", /отключено/);
  assert.equal(data.users[1].balance, 60);
  assert.match((await command(data, "202", "/users")).reply ?? "", /только администратору/);
  assert.match((await command(data, "101", "/pay zero")).reply ?? "", /Укажите сумму/);

  const topic = await command(data, "101", "/settopic", {
    chat: { id: -999, type: "supergroup" },
    message_thread_id: 42
  });
  assert.match(topic.reply ?? "", /42/);
  assert.equal(data.settings.telegram.chatId, "-999");
  assert.equal(data.settings.telegram.notificationTopicId, "42");
  const topicMessage = requests.filter((item) => item.method === "sendMessage").at(-1)?.body;
  assert.deepEqual(topicMessage?.reply_markup, { remove_keyboard: true });
  assert.deepEqual(await command(data, "101", "/unknown"), { handled: false });
});

test("polling resumes against current settings after an in-flight state replacement", async () => {
  const data = telegramData();
  let resolveUpdates: ((response: Response) => void) | undefined;
  let getUpdatesStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    getUpdatesStarted = resolve;
  });

  globalThis.fetch = async (input) => {
    const method = String(input).split("/").at(-1);
    if (method === "getUpdates") {
      getUpdatesStarted?.();
      return await new Promise<Response>((resolve) => {
        resolveUpdates = resolve;
      });
    }
    return okResponse();
  };

  const polling = pollTelegramUpdates(data);
  await started;
  data.services[0].monthlyCost = 1_200;
  data.settings.telegram = { ...data.settings.telegram, lastUpdateAt: null };
  resolveUpdates?.(
    okResponse([
      {
        update_id: 14,
        message: { chat: { id: 777, type: "private" }, from: { id: 101 }, text: "/balance" }
      }
    ])
  );

  assert.equal(await polling, 1);
  assert.equal(data.settings.telegram.updateOffset, 15);
  assert.ok(data.settings.telegram.lastUpdateAt);
});

test("configuration surfaces Telegram API rejections and records diagnostics", async () => {
  const data = telegramData();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, description: "Bad Request: invalid token" }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json" }
    });

  await assert.rejects(configureTelegramIntegration(data, ""), /invalid token/);
  assert.match(data.settings.telegram.lastError, /invalid token/);
  assert.equal(data.notifications.at(-1)?.status, "failed");
});

test("webhook and polling setup register the right Telegram API methods", async () => {
  const data = telegramData();
  const requests = captureTelegramRequests();

  await configureTelegramIntegration(data, "https://example.test/api/telegram/webhook/secret");
  assert.equal(data.settings.telegram.pollingEnabled, false);
  assert.deepEqual(requests.map((item) => item.method), ["setMyCommands", "setMyCommands", "setWebhook"]);
  assert.equal(requests.at(-1)?.body.url, "https://example.test/api/telegram/webhook/secret");

  requests.length = 0;
  await enableTelegramPolling(data);
  assert.equal(data.settings.telegram.pollingEnabled, true);
  assert.deepEqual(requests.map((item) => item.method), ["deleteWebhook", "setMyCommands", "setMyCommands"]);
  disableTelegramPolling(data);
  assert.equal(data.settings.telegram.pollingEnabled, false);
});

test("post-debit summaries and low-balance warnings contain current balances and use the configured topic", async () => {
  const data = telegramData();
  const requests = captureTelegramRequests();
  data.settings.telegram.notificationTopicId = "88";
  data.services[0].monthlyCost = 1_000;
  runDebitForService(data, data.services[0].id, "manual");

  await sendServiceBalanceSummary(data, data.services[0]);
  await sendLowBalanceWarnings(data, data.services[0]);

  const messages = requests.filter((item) => item.method === "sendMessage").map((item) => item.body);
  assert.equal(messages.length, 3);
  assert.ok(messages.every((body) => body.message_thread_id === 88));
  assert.match(String(messages[0].text), /-260,00 RUB/);
  assert.match(String(messages[0].text), /-440,00 RUB/);
  assert.match(String(messages[1].text), /500,00 RUB/);
  assert.ok(data.notifications.every((notification) => notification.status === "sent"));
});

test("network failures name the Telegram method instead of returning a generic fetch error", async () => {
  const data = telegramData();
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(pollTelegramUpdates(data), /Telegram API недоступен \(getUpdates\): fetch: fetch failed/);
});

test("a sendMessage network failure is recorded and does not escape as an unhandled fetch error", async () => {
  const data = telegramData();
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const result = await command(data, "101", "/balance");
  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /Общий баланс/);
  assert.match(data.settings.telegram.lastError, /Telegram API недоступен \(sendMessage\): fetch: fetch failed/);
  assert.equal(data.notifications.at(-1)?.status, "failed");
});
