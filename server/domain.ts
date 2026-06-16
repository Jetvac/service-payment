import type {
  AutoDeposit,
  AppData,
  BillingPeriod,
  Debit,
  Deposit,
  Membership,
  Notification,
  Service,
  ServiceConnectionSettings,
  ServiceSummary,
  User
} from "./types";

export const BALANCE_CURRENCY = "RUB";
export const nowIso = () => new Date().toISOString();

export const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function normalizeNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function defaultServiceConnection(): ServiceConnectionSettings {
  return {
    enabled: false,
    host: "",
    port: 8765,
    sshPort: 22,
    user: "",
    password: "",
    passwordSet: false,
    websocketPath: "/echo",
    useTls: false,
    lastStatus: "unknown",
    lastLatencyMs: null,
    lastCheckedAt: null,
    lastError: "",
    lastDeployStatus: "unknown",
    lastDeployAt: null,
    lastDeployOutput: ""
  };
}

export function seedData(): AppData {
  const createdAt = nowIso();
  const userA = id("usr");
  const userB = id("usr");
  const serviceId = id("svc");

  return {
    currencies: [
      { code: "RUB", name: "Российский рубль", symbol: "₽", rateToRub: 1, updatedAt: createdAt },
      { code: "USD", name: "Доллар США", symbol: "$", rateToRub: 90, updatedAt: createdAt },
      { code: "EUR", name: "Евро", symbol: "€", rateToRub: 98, updatedAt: createdAt }
    ],
    users: [
      {
        id: userA,
        name: "Алексей",
        balance: 240,
        telegramId: "",
        telegramUsername: "alex",
        avatarUrl: "",
        commandDepositsBlocked: false,
        botAdmin: false,
        notes: "",
        createdAt
      },
      {
        id: userB,
        name: "Мария",
        balance: 60,
        telegramId: "",
        telegramUsername: "maria",
        avatarUrl: "",
        commandDepositsBlocked: false,
        botAdmin: false,
        notes: "",
        createdAt
      }
    ],
    services: [
      {
        id: serviceId,
        name: "VPN Main",
        description: "Основной пул подписки",
        notes: "",
        monthlyCost: 600,
        currency: "RUB",
        active: true,
        connection: defaultServiceConnection(),
        billing: {
          period: "month",
          interval: 1,
          autoDebit: false,
          anchorDay: 1,
          anchorHour: 12,
          shiftDays: 0,
          lastChargedAt: null,
          nextChargeAt: buildNextChargeDate(new Date(), "month", 1, 1, 12, 0).toISOString(),
          lowBalanceThresholdPeriods: 1
        },
        createdAt
      }
    ],
    memberships: [
      { id: id("mem"), serviceId, userId: userA, active: true, joinedAt: createdAt },
      { id: id("mem"), serviceId, userId: userB, active: true, joinedAt: createdAt }
    ],
    autoDeposits: [],
    deposits: [],
    debits: [],
    notifications: [],
    settings: {
      telegram: {
        enabled: false,
        botToken: "",
        chatId: "",
        notificationTopicId: "",
        webhookSecret: id("tg").replace("tg_", ""),
        lowBalanceNotifications: true,
        monthlySummary: true,
        pollingEnabled: false,
        updateOffset: 0,
        lastUpdateAt: null,
        lastError: ""
      }
    }
  };
}

export function memberCount(data: AppData, serviceId: string) {
  return data.memberships.filter((item) => item.serviceId === serviceId && item.active).length;
}

export function periodLabel(period: BillingPeriod) {
  const labels: Record<BillingPeriod, string> = {
    month: "месяц",
    week: "неделю",
    day: "день",
    hour: "час"
  };
  return labels[period];
}

export function calculatePerMemberMonth(data: AppData, service: Service) {
  const count = memberCount(data, service.id);
  return count > 0 ? roundMoney(service.monthlyCost / count) : 0;
}

export function calculatePerMemberPeriod(data: AppData, service: Service) {
  const monthly = calculatePerMemberMonth(data, service);
  const interval = Math.max(1, service.billing.interval || 1);

  if (service.billing.period === "month") return roundMoney(monthly * interval);
  if (service.billing.period === "week") return roundMoney((monthly * 12 * interval) / 52);
  if (service.billing.period === "day") return roundMoney((monthly * interval) / 30.4375);

  return roundMoney((monthly * interval) / 730.5);
}

export function getCurrency(data: AppData, code: string) {
  return data.currencies.find((currency) => currency.code === code);
}

export function convertCurrency(data: AppData, amount: number, fromCode: string, toCode: string) {
  const from = getCurrency(data, fromCode);
  const to = getCurrency(data, toCode);

  if (!from || !to) {
    throw new Error("Не найдена валюта для конвертации");
  }

  const amountRub = amount * from.rateToRub;
  return roundMoney(amountRub / to.rateToRub);
}

export function convertToBalanceCurrency(data: AppData, amount: number, fromCode: string) {
  return fromCode === BALANCE_CURRENCY ? roundMoney(amount) : convertCurrency(data, amount, fromCode, BALANCE_CURRENCY);
}

function findUser(data: AppData, userId: string) {
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw new Error("Пользователь не найден");
  user.balance = roundMoney(user.balance ?? 0);
  return user;
}

function ensureActiveMembership(data: AppData, serviceId: string, userId: string) {
  const membership = data.memberships.find((item) => item.serviceId === serviceId && item.userId === userId && item.active);
  if (!membership) throw new Error("Пользователь не закреплён за сервисом");
  return membership;
}

function rateSnapshot(data: AppData) {
  return Object.fromEntries(data.currencies.map((currency) => [currency.code, currency.rateToRub]));
}

function adjustUserBalance(user: User, delta: number) {
  user.balance = roundMoney((user.balance ?? 0) + delta);
  return user.balance;
}

export function addDeposit(
  data: AppData,
  input: {
    serviceId: string;
    userId: string;
    amount: number;
    currency: string;
    comment?: string;
    source: Deposit["source"];
  }
) {
  const service = data.services.find((item) => item.id === input.serviceId);

  if (!service) throw new Error("Сервис не найден");
  ensureActiveMembership(data, input.serviceId, input.userId);
  if (input.amount <= 0) throw new Error("Сумма должна быть больше нуля");

  const user = findUser(data, input.userId);
  const amountOriginal = roundMoney(input.amount);
  const amountServiceCurrency =
    input.currency === service.currency ? amountOriginal : convertCurrency(data, amountOriginal, input.currency, service.currency);
  const amountBalanceCurrency = convertToBalanceCurrency(data, amountOriginal, input.currency);

  const balanceAfter = adjustUserBalance(user, amountBalanceCurrency);

  const deposit: Deposit = {
    id: id("dep"),
    serviceId: service.id,
    userId: input.userId,
    amountOriginal,
    currencyOriginal: input.currency,
    amountServiceCurrency,
    serviceCurrency: service.currency,
    amountBalanceCurrency,
    balanceCurrency: BALANCE_CURRENCY,
    rateSnapshot: rateSnapshot(data),
    comment: input.comment ?? "",
    source: input.source,
    createdAt: nowIso(),
    balanceAfter,
    cancelledAt: null,
    reversalId: null,
    reversesId: null
  };

  data.deposits.unshift(deposit);
  return deposit;
}

export function addDebit(
  data: AppData,
  input: {
    serviceId: string;
    userId: string;
    amount: number;
    periodStart: string;
    periodEnd: string;
    comment?: string;
    source: Debit["source"];
  }
) {
  const service = data.services.find((item) => item.id === input.serviceId);

  if (!service) throw new Error("Сервис не найден");
  ensureActiveMembership(data, input.serviceId, input.userId);
  if (input.amount <= 0) throw new Error("Сумма должна быть больше нуля");

  const user = findUser(data, input.userId);
  const amount = roundMoney(input.amount);
  const amountBalanceCurrency = convertToBalanceCurrency(data, amount, service.currency);
  const balanceAfter = adjustUserBalance(user, -amountBalanceCurrency);

  const debit: Debit = {
    id: id("deb"),
    serviceId: service.id,
    userId: input.userId,
    amount,
    currency: service.currency,
    amountBalanceCurrency,
    balanceCurrency: BALANCE_CURRENCY,
    rateSnapshot: rateSnapshot(data),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    comment: input.comment ?? "",
    source: input.source,
    createdAt: nowIso(),
    balanceAfter,
    cancelledAt: null,
    reversalId: null,
    reversesId: null
  };

  data.debits.unshift(debit);
  return debit;
}

export function cancelDeposit(data: AppData, depositId: string, reason = "") {
  const deposit = data.deposits.find((item) => item.id === depositId);
  if (!deposit) throw new Error("Зачисление не найдено");
  if (deposit.cancelledAt) throw new Error("Зачисление уже отменено");
  if (deposit.reversesId) throw new Error("Корректирующую операцию нельзя отменить повторно");

  const user = findUser(data, deposit.userId);
  const amountBalanceCurrency =
    deposit.amountBalanceCurrency ?? convertToBalanceCurrency(data, deposit.amountServiceCurrency, deposit.serviceCurrency);
  const balanceAfter = adjustUserBalance(user, -amountBalanceCurrency);

  const reversal: Debit = {
    id: id("deb"),
    serviceId: deposit.serviceId,
    userId: deposit.userId,
    amount: deposit.amountServiceCurrency,
    currency: deposit.serviceCurrency,
    amountBalanceCurrency,
    balanceCurrency: BALANCE_CURRENCY,
    rateSnapshot: rateSnapshot(data),
    periodStart: deposit.createdAt,
    periodEnd: nowIso(),
    comment: reason || `Отмена зачисления ${deposit.id}`,
    source: "reversal",
    createdAt: nowIso(),
    balanceAfter,
    cancelledAt: null,
    reversalId: null,
    reversesId: deposit.id
  };

  deposit.cancelledAt = nowIso();
  deposit.cancellationReason = reason;
  deposit.reversalId = reversal.id;
  data.debits.unshift(reversal);
  return reversal;
}

export function cancelDebit(data: AppData, debitId: string, reason = "") {
  const debit = data.debits.find((item) => item.id === debitId);
  if (!debit) throw new Error("Списание не найдено");
  if (debit.cancelledAt) throw new Error("Списание уже отменено");
  if (debit.reversesId) throw new Error("Корректирующую операцию нельзя отменить повторно");

  const service = data.services.find((item) => item.id === debit.serviceId);
  if (!service) throw new Error("Сервис не найден");

  const user = findUser(data, debit.userId);
  const amountBalanceCurrency = debit.amountBalanceCurrency ?? convertToBalanceCurrency(data, debit.amount, debit.currency);
  const balanceAfter = adjustUserBalance(user, amountBalanceCurrency);

  const reversal: Deposit = {
    id: id("dep"),
    serviceId: debit.serviceId,
    userId: debit.userId,
    amountOriginal: debit.amount,
    currencyOriginal: debit.currency,
    amountServiceCurrency: debit.amount,
    serviceCurrency: service.currency,
    amountBalanceCurrency,
    balanceCurrency: BALANCE_CURRENCY,
    rateSnapshot: rateSnapshot(data),
    comment: reason || `Отмена списания ${debit.id}`,
    source: "reversal",
    createdAt: nowIso(),
    balanceAfter,
    cancelledAt: null,
    reversalId: null,
    reversesId: debit.id
  };

  debit.cancelledAt = nowIso();
  debit.cancellationReason = reason;
  debit.reversalId = reversal.id;
  data.deposits.unshift(reversal);
  return reversal;
}

export function addNotification(
  data: AppData,
  input: Omit<Notification, "id" | "createdAt">
) {
  const notification: Notification = {
    ...input,
    id: id("ntf"),
    createdAt: nowIso()
  };

  data.notifications.unshift(notification);
  data.notifications = data.notifications.slice(0, 200);
  return notification;
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function buildMonthlyDate(year: number, month: number, anchorDay: number, anchorHour: number, shiftDays: number) {
  const day = Math.min(Math.max(1, anchorDay), daysInMonth(year, month));
  const date = new Date(year, month, day, Math.max(0, Math.min(23, anchorHour)), 0, 0, 0);
  date.setDate(date.getDate() + shiftDays);
  return date;
}

export function buildNextAutoDepositDate(from: Date, dayOfMonth: number, hour: number) {
  let cursor = buildMonthlyDate(from.getFullYear(), from.getMonth(), dayOfMonth, hour, 0);

  while (cursor <= from) {
    cursor = buildMonthlyDate(cursor.getFullYear(), cursor.getMonth() + 1, dayOfMonth, hour, 0);
  }

  return cursor;
}

export function advanceAutoDepositDate(schedule: Pick<AutoDeposit, "dayOfMonth" | "hour">, from: Date) {
  let cursor = buildMonthlyDate(from.getFullYear(), from.getMonth() + 1, schedule.dayOfMonth, schedule.hour, 0);

  while (cursor <= from) {
    cursor = buildMonthlyDate(cursor.getFullYear(), cursor.getMonth() + 1, schedule.dayOfMonth, schedule.hour, 0);
  }

  return cursor;
}

export function buildNextChargeDate(
  from: Date,
  period: BillingPeriod,
  interval: number,
  anchorDay: number,
  anchorHour: number,
  shiftDays: number
) {
  const safeInterval = Math.max(1, interval || 1);

  if (period === "month") {
    let cursor = buildMonthlyDate(from.getFullYear(), from.getMonth(), anchorDay, anchorHour, shiftDays);

    while (cursor <= from) {
      cursor = buildMonthlyDate(cursor.getFullYear(), cursor.getMonth() + safeInterval, anchorDay, anchorHour, shiftDays);
    }

    return cursor;
  }

  const next = new Date(from);
  next.setHours(Math.max(0, Math.min(23, anchorHour)), 0, 0, 0);
  if (next <= from) {
    if (period === "week") next.setDate(next.getDate() + 7 * safeInterval);
    if (period === "day") next.setDate(next.getDate() + safeInterval);
    if (period === "hour") next.setHours(next.getHours() + safeInterval);
  }

  return next;
}

export function advanceChargeDate(service: Service, from: Date) {
  const { period, interval, anchorDay, anchorHour, shiftDays } = service.billing;

  if (period === "month") {
    const base = new Date(from);
    base.setMonth(base.getMonth() + Math.max(1, interval || 1));
    return buildNextChargeDate(base, period, interval, anchorDay, anchorHour, shiftDays);
  }

  const next = new Date(from);
  if (period === "week") next.setDate(next.getDate() + 7 * Math.max(1, interval || 1));
  if (period === "day") next.setDate(next.getDate() + Math.max(1, interval || 1));
  if (period === "hour") next.setHours(next.getHours() + Math.max(1, interval || 1));
  return next;
}

function resolveAutoDepositService(data: AppData, schedule: AutoDeposit) {
  const hasActiveMembership = (serviceId: string) =>
    data.memberships.some((membership) => membership.userId === schedule.userId && membership.serviceId === serviceId && membership.active);
  const serviceIsActive = (serviceId: string) => data.services.some((service) => service.id === serviceId && service.active);

  if (schedule.serviceId && hasActiveMembership(schedule.serviceId) && serviceIsActive(schedule.serviceId)) {
    return schedule.serviceId;
  }

  const fallback = data.memberships.find(
    (membership) => membership.userId === schedule.userId && membership.active && serviceIsActive(membership.serviceId)
  );

  if (!fallback) {
    throw new Error("Для автоплатежа нужен активный сервис участника");
  }

  schedule.serviceId = fallback.serviceId;
  return fallback.serviceId;
}

export function runAutoDepositSchedule(data: AppData, scheduleId: string, options: { advance: boolean }) {
  const schedule = data.autoDeposits.find((item) => item.id === scheduleId);
  if (!schedule) throw new Error("Автоплатеж не найден");
  if (!schedule.enabled && options.advance) return null;

  const serviceId = resolveAutoDepositService(data, schedule);
  const dueAt = new Date(schedule.nextDepositAt ?? nowIso());
  const deposit = addDeposit(data, {
    serviceId,
    userId: schedule.userId,
    amount: schedule.amount,
    currency: schedule.currency,
    comment: schedule.comment || "Автоплатеж",
    source: "auto"
  });

  schedule.lastDepositedAt = deposit.createdAt;
  schedule.updatedAt = nowIso();
  if (options.advance) {
    schedule.nextDepositAt = advanceAutoDepositDate(schedule, dueAt).toISOString();
  }

  return deposit;
}

export function getPeriodRange(service: Service, chargeDate: Date) {
  const periodEnd = chargeDate.toISOString();
  const periodStart = new Date(chargeDate);
  const interval = Math.max(1, service.billing.interval || 1);

  if (service.billing.period === "month") periodStart.setMonth(periodStart.getMonth() - interval);
  if (service.billing.period === "week") periodStart.setDate(periodStart.getDate() - 7 * interval);
  if (service.billing.period === "day") periodStart.setDate(periodStart.getDate() - interval);
  if (service.billing.period === "hour") periodStart.setHours(periodStart.getHours() - interval);

  return { periodStart: periodStart.toISOString(), periodEnd };
}

export function runDebitForService(data: AppData, serviceId: string, source: Debit["source"]) {
  const service = data.services.find((item) => item.id === serviceId);
  if (!service) throw new Error("Сервис не найден");

  const members = data.memberships.filter((item) => item.serviceId === service.id && item.active);
  const amount = calculatePerMemberPeriod(data, service);
  const chargeDate = new Date(service.billing.nextChargeAt ?? nowIso());
  const { periodStart, periodEnd } = getPeriodRange(service, chargeDate);

  const debits = members.map((membership) =>
    addDebit(data, {
      serviceId: service.id,
      userId: membership.userId,
      amount,
      periodStart,
      periodEnd,
      comment: `Списание за ${service.billing.interval} ${periodLabel(service.billing.period)}`,
      source
    })
  );

  service.billing.lastChargedAt = nowIso();
  service.billing.nextChargeAt = advanceChargeDate(service, chargeDate).toISOString();

  return debits;
}

export function computeSummaries(data: AppData): ServiceSummary[] {
  return data.services.map((service) => {
    const perMemberPeriod = calculatePerMemberPeriod(data, service);
    const lowBorder = convertToBalanceCurrency(data, perMemberPeriod * Math.max(1, service.billing.lowBalanceThresholdPeriods || 1), service.currency);
    const memberships = data.memberships.filter((item) => item.serviceId === service.id && item.active);
    const users = memberships
      .map((membership) => data.users.find((user) => user.id === membership.userId))
      .filter((user): user is User => Boolean(user));

    return {
      serviceId: service.id,
      memberCount: memberships.length,
      perMemberMonth: calculatePerMemberMonth(data, service),
      perMemberPeriod,
      lowBalanceCount: users.filter((user) => user.balance > 0 && user.balance < lowBorder).length,
      debtCount: users.filter((user) => user.balance < 0).length,
      nextChargeAt: service.billing.nextChargeAt
    };
  });
}

export function ensureMembership(data: AppData, serviceId: string, userId: string) {
  const existing = data.memberships.find((item) => item.serviceId === serviceId && item.userId === userId);
  if (existing) {
    existing.active = true;
    return existing;
  }

  const membership: Membership = {
    id: id("mem"),
    serviceId,
    userId,
    active: true,
    joinedAt: nowIso()
  };
  data.memberships.push(membership);
  return membership;
}
