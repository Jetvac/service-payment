import type { Request } from "express";
import { BALANCE_CURRENCY, computeSummaries, convertToBalanceCurrency, nowIso } from "./domain";
import { pageResult, readPage } from "./http";
import type { Store } from "./store";
import type { AppData, Debit, Deposit, User } from "./types";

/** Public base URL of the site, used for Telegram webhooks. */
export function publicBaseUrl(req: Request) {
  return String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

export function webhookUrl(req: Request, data: AppData) {
  const secret = data.settings.telegram.webhookSecret;
  return secret ? `${publicBaseUrl(req)}/api/telegram/webhook/${encodeURIComponent(secret)}` : "";
}

export function publicUser(user: User, viewer: User) {
  const canSeePrivate = viewer.botAdmin || viewer.id === user.id;
  return {
    id: user.id,
    name: user.name,
    balance: user.balance,
    telegramId: user.telegramId,
    telegramUsername: user.telegramUsername,
    avatarUrl: user.avatarUrl,
    commandDepositsBlocked: user.commandDepositsBlocked,
    botAdmin: user.botAdmin,
    passwordSet: Boolean(user.password),
    notes: canSeePrivate ? user.notes : "",
    createdAt: user.createdAt
  };
}

export type PublicUser = ReturnType<typeof publicUser>;

/** Everything the web client needs, filtered by what the viewer may see. */
export function apiState(store: Store, viewer: User, req: Request) {
  const data = store.read();
  const isAdmin = viewer.botAdmin;
  const telegram = data.settings.telegram;

  return {
    viewerId: viewer.id,
    currencies: data.currencies,
    users: data.users.map((user) => publicUser(user, viewer)),
    services: data.services,
    memberships: data.memberships,
    autoDeposits: isAdmin ? data.autoDeposits : data.autoDeposits.filter((item) => item.userId === viewer.id),
    summaries: computeSummaries(data),
    botEnabled: telegram.enabled,
    settings: {
      payments: data.settings.payments,
      telegram: isAdmin
        ? {
            enabled: telegram.enabled,
            botTokenSet: Boolean(telegram.botToken),
            chatId: telegram.chatId,
            notificationTopicId: telegram.notificationTopicId,
            webhookSecretSet: Boolean(telegram.webhookSecret),
            webhookUrl: webhookUrl(req, data),
            lowBalanceNotifications: telegram.lowBalanceNotifications,
            monthlySummary: telegram.monthlySummary,
            pollingEnabled: telegram.pollingEnabled,
            lastUpdateAt: telegram.lastUpdateAt,
            lastError: telegram.lastError
          }
        : null
    },
    counts: {
      deposits: data.deposits.length,
      debits: data.debits.length,
      notifications: data.notifications.length,
      payments: data.payments.length
    },
    serverTime: nowIso()
  };
}

const isEffective = (operation: { cancelledAt?: string | null; reversesId?: string | null }) =>
  !operation.cancelledAt && !operation.reversesId;

function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Daily credited / charged totals (in RUB) for the last `days` days,
 * oldest first, with empty days included so the chart has a stable x-axis.
 */
export function moneyFlow(data: AppData, userId: string | null, days = 14) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));

  const buckets = new Map<string, { date: string; deposits: number; debits: number }>();
  for (let index = 0; index < days; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    buckets.set(dayKey(day), { date: dayKey(day), deposits: 0, debits: 0 });
  }

  const add = (operation: Deposit | Debit, key: "deposits" | "debits", amount: number) => {
    if (userId && operation.userId !== userId) return;
    if (!isEffective(operation)) return;
    const createdAt = new Date(operation.createdAt);
    if (createdAt < start) return;
    const bucket = buckets.get(dayKey(createdAt));
    if (bucket) bucket[key] = Math.round((bucket[key] + amount) * 100) / 100;
  };

  for (const deposit of data.deposits) {
    add(deposit, "deposits", deposit.amountBalanceCurrency ?? convertToBalanceCurrency(data, deposit.amountServiceCurrency, deposit.serviceCurrency));
  }
  for (const debit of data.debits) {
    add(debit, "debits", debit.amountBalanceCurrency ?? convertToBalanceCurrency(data, debit.amount, debit.currency));
  }

  return Array.from(buckets.values());
}

/** Dashboard: admins see everything, participants only their own data. */
export function dashboardData(data: AppData, viewer: User, query: Record<string, unknown>) {
  const personal = !viewer.botAdmin || query.scope === "me";
  const { offset, limit } = readPage({ offset: query.notificationOffset, limit: query.notificationLimit }, 8, 50);
  const notifications = personal ? data.notifications.filter((item) => item.userId === viewer.id) : data.notifications;

  return {
    currency: BALANCE_CURRENCY,
    chart: moneyFlow(data, personal ? viewer.id : null),
    notifications: pageResult(notifications, offset, limit)
  };
}
