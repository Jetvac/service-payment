import type { AppData, Service, User } from "./types";
import {
  addDeposit,
  addNotification,
  BALANCE_CURRENCY,
  calculatePerMemberPeriod,
  convertToBalanceCurrency,
  memberCount,
  periodLabel,
  roundMoney
} from "./domain";

type TelegramMessage = {
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; username?: string; first_name?: string };
  message_thread_id?: number;
  text?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type SendOptions = {
  commandKeyboard?: boolean;
  notificationTopic?: boolean;
  threadId?: string | number;
};

function telegramUrl(token: string, method: string) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export function formatMoney(amount: number, currency: string) {
  return `${roundMoney(amount).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mentionUser(user: User) {
  if (user.telegramUsername) return `@${user.telegramUsername.replace(/^@/, "")}`;
  if (user.telegramId) return `<a href="tg://user?id=${escapeHtml(user.telegramId)}">${escapeHtml(user.name)}</a>`;
  return escapeHtml(user.name);
}

function commandKeyboard() {
  return {
    keyboard: [["/balance", "/services"], ["/pay 600", "/help"]],
    resize_keyboard: true,
    is_persistent: true
  };
}

function resolveThreadId(data: AppData, options: SendOptions) {
  const raw = options.threadId ?? (options.notificationTopic ? data.settings.telegram.notificationTopicId : "");
  const threadId = Number(raw);
  return Number.isFinite(threadId) && threadId > 0 ? threadId : undefined;
}

async function telegramApi<TBody extends Record<string, unknown>>(token: string, method: string, body: TBody) {
  const response = await fetch(telegramUrl(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; description?: string; result?: unknown } | null;
  return { response, payload };
}

export async function sendTelegramMessage(data: AppData, text: string, chatId?: string | number, options: SendOptions = {}) {
  const settings = data.settings.telegram;
  const targetChat = chatId ?? settings.chatId;
  const messageThreadId = resolveThreadId(data, options);

  if (!settings.enabled || !settings.botToken || !targetChat) {
    addNotification(data, {
      serviceId: data.services[0]?.id ?? "",
      userId: null,
      kind: "system",
      message: text,
      status: "skipped"
    });
    return false;
  }

  const { response, payload } = await telegramApi(settings.botToken, "sendMessage", {
    chat_id: targetChat,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    ...(options.commandKeyboard ? { reply_markup: commandKeyboard() } : {})
  });

  if (!response.ok || payload?.ok === false) {
    addNotification(data, {
      serviceId: data.services[0]?.id ?? "",
      userId: null,
      kind: "system",
      message: `Telegram: ${response.status} ${payload?.description ?? response.statusText}`,
      status: "failed"
    });
    return false;
  }

  return true;
}

export async function configureTelegramIntegration(data: AppData, webhookUrl: string) {
  const settings = data.settings.telegram;
  if (!settings.botToken) throw new Error("Укажите Bot token");

  const privateCommands = [
    { command: "pay", description: "Зачислить средства: /pay 600" },
    { command: "deposit", description: "Зачислить на сервис: /deposit 600 VPN Main" },
    { command: "balance", description: "Показать баланс" },
    { command: "services", description: "Показать подключенные сервисы" },
    { command: "help", description: "Показать помощь" },
    { command: "settopic", description: "Назначить топик уведомлений" }
  ];
  const groupCommands = [
    { command: "settopic", description: "Назначить топик уведомлений" },
    { command: "help", description: "Показать помощь" }
  ];

  const privateCommandResult = await telegramApi(settings.botToken, "setMyCommands", {
    commands: privateCommands,
    scope: { type: "all_private_chats" }
  });
  const groupCommandResult = await telegramApi(settings.botToken, "setMyCommands", {
    commands: groupCommands,
    scope: { type: "all_group_chats" }
  });

  let webhookResult: Awaited<ReturnType<typeof telegramApi>> | null = null;
  const cleanWebhookUrl = webhookUrl.trim();
  if (cleanWebhookUrl) {
    webhookResult = await telegramApi(settings.botToken, "setWebhook", {
      url: cleanWebhookUrl,
      allowed_updates: ["message", "edited_message"],
      drop_pending_updates: false
    });
    settings.pollingEnabled = false;
  }

  const failed =
    !privateCommandResult.response.ok ||
    privateCommandResult.payload?.ok === false ||
    !groupCommandResult.response.ok ||
    groupCommandResult.payload?.ok === false ||
    Boolean(webhookResult && (!webhookResult.response.ok || webhookResult.payload?.ok === false));

  addNotification(data, {
    serviceId: data.services[0]?.id ?? "",
    userId: null,
    kind: "system",
    message: failed
      ? `Telegram configure failed: ${
          privateCommandResult.payload?.description ?? groupCommandResult.payload?.description ?? webhookResult?.payload?.description ?? "unknown"
        }`
      : `Telegram configured${cleanWebhookUrl ? `: ${cleanWebhookUrl}` : ""}`,
    status: failed ? "failed" : "sent"
  });

  return { commands: privateCommandResult.payload, groupCommands: groupCommandResult.payload, webhook: webhookResult?.payload ?? null };
}

export async function enableTelegramPolling(data: AppData) {
  const settings = data.settings.telegram;
  if (!settings.botToken) throw new Error("Укажите Bot token");

  await telegramApi(settings.botToken, "deleteWebhook", {
    drop_pending_updates: false
  });

  await configureTelegramIntegration(data, "");
  settings.pollingEnabled = true;
  settings.lastError = "";

  addNotification(data, {
    serviceId: data.services[0]?.id ?? "",
    userId: null,
    kind: "system",
    message: "Telegram polling enabled",
    status: "sent"
  });
}

export function disableTelegramPolling(data: AppData) {
  data.settings.telegram.pollingEnabled = false;
  addNotification(data, {
    serviceId: data.services[0]?.id ?? "",
    userId: null,
    kind: "system",
    message: "Telegram polling disabled",
    status: "sent"
  });
}

export async function pollTelegramUpdates(data: AppData) {
  const settings = data.settings.telegram;
  if (!settings.enabled || !settings.pollingEnabled || !settings.botToken) return 0;

  const result = await telegramApi(settings.botToken, "getUpdates", {
    offset: settings.updateOffset || undefined,
    timeout: 0,
    allowed_updates: ["message", "edited_message"]
  });

  if (!result.response.ok || result.payload?.ok === false) {
    settings.lastError = result.payload?.description ?? result.response.statusText;
    addNotification(data, {
      serviceId: data.services[0]?.id ?? "",
      userId: null,
      kind: "system",
      message: `Telegram polling: ${settings.lastError}`,
      status: "failed"
    });
    return 0;
  }

  const updates = (Array.isArray(result.payload?.result) ? result.payload?.result : []) as TelegramUpdate[];
  for (const update of updates) {
    settings.updateOffset = Math.max(settings.updateOffset || 0, update.update_id + 1);
    const message = update.message ?? update.edited_message;
    if (message) {
      await handleTelegramUpdate(data, message);
    }
  }

  if (updates.length) {
    settings.lastUpdateAt = new Date().toISOString();
    settings.lastError = "";
  }

  return updates.length;
}

export async function sendLowBalanceWarnings(data: AppData, service: Service) {
  if (!data.settings.telegram.lowBalanceNotifications) return;

  const amount = calculatePerMemberPeriod(data, service);
  const amountBalanceCurrency = convertToBalanceCurrency(data, amount, service.currency);
  const threshold = amountBalanceCurrency * Math.max(1, service.billing.lowBalanceThresholdPeriods || 1);
  const memberships = data.memberships.filter((item) => {
    const user = data.users.find((person) => person.id === item.userId);
    return item.serviceId === service.id && item.active && user && user.balance < threshold;
  });

  for (const membership of memberships) {
    const user = data.users.find((item) => item.id === membership.userId);
    if (!user) continue;

    const text = [
      `⚠️ <b>${escapeHtml(service.name)}</b>`,
      `${mentionUser(user)}, общий остаток: <b>${formatMoney(user.balance, BALANCE_CURRENCY)}</b>.`,
      `Следующее списание: <b>${formatMoney(amount, service.currency)}</b>${
        service.currency === BALANCE_CURRENCY ? "" : ` (${formatMoney(amountBalanceCurrency, BALANCE_CURRENCY)})`
      }.`
    ].join("\n");

    const sent = await sendTelegramMessage(data, text, undefined, { notificationTopic: true });
    addNotification(data, {
      serviceId: service.id,
      userId: user.id,
      kind: "low_balance",
      message: text,
      status: sent ? "sent" : "skipped"
    });
  }
}

export async function sendServiceBalanceSummary(data: AppData, service: Service) {
  const rows = data.memberships
    .filter((item) => item.serviceId === service.id && item.active)
    .map((membership) => {
      const user = data.users.find((item) => item.id === membership.userId);
      const label = user ? mentionUser(user) : "Пользователь";
      return `• ${label}: <b>${formatMoney(user?.balance ?? 0, BALANCE_CURRENCY)}</b>`;
    });

  const text = [`📊 <b>${escapeHtml(service.name)}</b>`, "Остатки после списания:", ...rows].join("\n");
  const sent = await sendTelegramMessage(data, text, undefined, { notificationTopic: true });

  addNotification(data, {
    serviceId: service.id,
    userId: null,
    kind: "period_summary",
    message: text,
    status: sent ? "sent" : "skipped"
  });
}

function commandParts(text: string) {
  const [commandRaw, ...rest] = text.trim().split(/\s+/);
  const command = commandRaw.toLowerCase().split("@")[0];
  return { command, rest };
}

function helpText(user: User, data: AppData) {
  const services = data.memberships
    .filter((item) => item.userId === user.id && item.active)
    .map((membership) => data.services.find((service) => service.id === membership.serviceId)?.name)
    .filter(Boolean)
    .join(", ");

  return [
    `ℹ️ <b>VPN Pay</b>`,
    `Команды для ${escapeHtml(user.name)}:`,
    `/pay 600 — зачислить 600 в основной валюте сервиса`,
    `/deposit 600 VPN Main — зачислить на конкретный сервис`,
    `/balance — показать текущий баланс`,
    `/services — показать подключенные сервисы и списания за период`,
    `/help — показать это сообщение`,
    `/settopic — назначить текущий топик общих уведомлений (только админ)`,
    services ? `Ваши сервисы: <b>${escapeHtml(services)}</b>` : "Активных сервисов нет"
  ].join("\n");
}

function userServicesText(data: AppData, user: User) {
  const rows = data.memberships
    .filter((item) => item.userId === user.id && item.active)
    .map((membership) => data.services.find((service) => service.id === membership.serviceId))
    .filter((service): service is Service => Boolean(service))
    .map((service) => {
      const charge = calculatePerMemberPeriod(data, service);
      const chargeBalanceCurrency = convertToBalanceCurrency(data, charge, service.currency);
      const converted = service.currency === BALANCE_CURRENCY ? "" : ` / ${formatMoney(chargeBalanceCurrency, BALANCE_CURRENCY)}`;
      return `• <b>${escapeHtml(service.name)}</b>: ${formatMoney(charge, service.currency)}${converted} за ${periodLabel(service.billing.period)}`;
    });

  return [
    `💼 <b>Ваши сервисы</b>`,
    `Общий баланс: <b>${formatMoney(user.balance, BALANCE_CURRENCY)}</b>`,
    rows.length ? rows.join("\n") : "Активных сервисов нет"
  ].join("\n");
}

function findServiceForCommand(data: AppData, user: User, rest: string[]) {
  const memberships = data.memberships.filter((item) => item.userId === user.id && item.active);
  if (memberships.length === 0) return null;

  const serviceQuery = rest.slice(1).join(" ").trim().toLowerCase();
  if (!serviceQuery) return data.services.find((service) => service.id === memberships[0].serviceId) ?? null;

  return (
    data.services.find(
      (service) =>
        memberships.some((membership) => membership.serviceId === service.id) &&
        (service.id.toLowerCase() === serviceQuery || service.name.toLowerCase().includes(serviceQuery))
    ) ?? null
  );
}

export async function handleTelegramUpdate(data: AppData, message: TelegramMessage) {
  const text = message.text?.trim() ?? "";
  const { command, rest } = commandParts(text);

  if (!["/pay", "/deposit", "/balance", "/services", "/start", "/help", "/settopic"].includes(command)) {
    return { handled: false };
  }

  const telegramId = String(message.from?.id ?? "");
  const user = data.users.find((item) => item.telegramId && item.telegramId === telegramId);

  if (!user) {
    const reply = `Профиль не найден. Передайте администратору ваш Telegram ID: ${telegramId}`;
    await sendTelegramMessage(data, reply, message.chat?.id, { commandKeyboard: message.chat?.type === "private", threadId: message.message_thread_id });
    return { handled: true, reply };
  }

  if (command === "/start" || command === "/help") {
    const reply = helpText(user, data);
    await sendTelegramMessage(data, reply, message.chat?.id, { commandKeyboard: message.chat?.type === "private", threadId: message.message_thread_id });
    return { handled: true, reply };
  }

  if (command === "/services") {
    const reply = userServicesText(data, user);
    await sendTelegramMessage(data, reply, message.chat?.id, { commandKeyboard: message.chat?.type === "private", threadId: message.message_thread_id });
    return { handled: true, reply };
  }

  if (command === "/settopic") {
    if (!user.botAdmin) {
      const reply = "Команда доступна только администратору бота.";
      await sendTelegramMessage(data, reply, message.chat?.id, { threadId: message.message_thread_id });
      return { handled: true, reply };
    }

    data.settings.telegram.chatId = String(message.chat?.id ?? data.settings.telegram.chatId);
    data.settings.telegram.notificationTopicId = message.message_thread_id ? String(message.message_thread_id) : "";

    const reply = message.message_thread_id
      ? `Готово. Общие уведомления будут идти в этот топик: <b>${message.message_thread_id}</b>.`
      : "Готово. Общие уведомления будут идти в этот чат без topic id.";

    await sendTelegramMessage(data, reply, message.chat?.id, { threadId: message.message_thread_id });
    addNotification(data, {
      serviceId: data.services[0]?.id ?? "",
      userId: user.id,
      kind: "system",
      message: `Telegram topic set: chat=${data.settings.telegram.chatId}, topic=${data.settings.telegram.notificationTopicId || "none"}`,
      status: "sent"
    });
    return { handled: true, reply };
  }

  const service = findServiceForCommand(data, user, rest);
  if (!service) {
    const reply = "У вас нет активных сервисов.";
    await sendTelegramMessage(data, reply, message.chat?.id, { commandKeyboard: message.chat?.type === "private", threadId: message.message_thread_id });
    return { handled: true, reply };
  }

  if (command === "/balance") {
    const amount = calculatePerMemberPeriod(data, service);
    const amountBalanceCurrency = convertToBalanceCurrency(data, amount, service.currency);
    const reply = [
      `💼 <b>${escapeHtml(service.name)}</b>`,
      `Общий баланс: <b>${formatMoney(user.balance, BALANCE_CURRENCY)}</b>`,
      `Списание за ${periodLabel(service.billing.period)}: <b>${formatMoney(amount, service.currency)}</b>${
        service.currency === BALANCE_CURRENCY ? "" : ` (${formatMoney(amountBalanceCurrency, BALANCE_CURRENCY)})`
      }`,
      `Участников: <b>${memberCount(data, service.id)}</b>`
    ].join("\n");
    await sendTelegramMessage(data, reply, message.chat?.id, { commandKeyboard: message.chat?.type === "private", threadId: message.message_thread_id });
    return { handled: true, reply };
  }

  if (user.commandDepositsBlocked) {
    const reply = "Пополнение через команду отключено.";
    await sendTelegramMessage(data, reply, message.chat?.id, { commandKeyboard: message.chat?.type === "private", threadId: message.message_thread_id });
    return { handled: true, reply };
  }

  const amount = Number(String(rest[0] ?? "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    const reply = "Укажите сумму: /pay 600";
    await sendTelegramMessage(data, reply, message.chat?.id, { commandKeyboard: message.chat?.type === "private", threadId: message.message_thread_id });
    return { handled: true, reply };
  }

  const deposit = addDeposit(data, {
    serviceId: service.id,
    userId: user.id,
    amount,
    currency: service.currency,
    comment: "Пополнение через Telegram",
    source: "telegram"
  });

  const reply = [
    `✅ <b>${escapeHtml(service.name)}</b>`,
    `Зачислено в общий баланс: <b>${formatMoney(deposit.amountBalanceCurrency, BALANCE_CURRENCY)}</b>`,
    `Новый общий баланс: <b>${formatMoney(deposit.balanceAfter, BALANCE_CURRENCY)}</b>`
  ].join("\n");

  await sendTelegramMessage(data, reply, message.chat?.id, { commandKeyboard: message.chat?.type === "private", threadId: message.message_thread_id });
  return { handled: true, reply };
}
