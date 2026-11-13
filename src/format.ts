import type { AppState, BillingPeriod, Service, User } from "./types";

const moneyFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTimeFormat = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const dayMonthFormat = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" });

export const CURRENCY_SIGNS: Record<string, string> = { RUB: "₽", USD: "$", EUR: "€" };

export function money(value: number, currency = "RUB") {
  return `${moneyFormat.format(Number(value) || 0)} ${CURRENCY_SIGNS[currency] ?? currency}`;
}

export function signedMoney(value: number, currency = "RUB") {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${money(Math.abs(value), currency)}`;
}

export function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFormat.format(date);
}

export function longDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormat.format(date);
}

export function dayMonth(value: string) {
  return dayMonthFormat.format(new Date(value));
}

/** "через 3 дня", "2 часа назад" */
export function relative(value: string | null | undefined, now = Date.now()) {
  if (!value) return "";
  const diff = new Date(value).getTime() - now;
  const format = new Intl.RelativeTimeFormat("ru-RU", { numeric: "auto" });
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export function fileSize(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ГБ`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  if (value >= 1024) return `${(value / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
  return `${value} Б`;
}

/** plural(5, ["участник", "участника", "участников"]) */
export function plural(count: number, forms: [string, string, string]) {
  const mod10 = Math.abs(count) % 10;
  const mod100 = Math.abs(count) % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export const PERIOD_NAMES: Record<BillingPeriod, string> = { month: "Месяц", week: "Неделя", day: "День", hour: "Час" };

const PERIOD_EVERY: Record<BillingPeriod, [string, string, string]> = {
  month: ["месяц", "месяца", "месяцев"],
  week: ["неделю", "недели", "недель"],
  day: ["день", "дня", "дней"],
  hour: ["час", "часа", "часов"]
};

export function periodPhrase(period: BillingPeriod, interval: number) {
  return interval <= 1 ? `каждый ${PERIOD_EVERY[period][0]}`.replace("каждый неделю", "каждую неделю") : `каждые ${interval} ${plural(interval, PERIOD_EVERY[period])}`;
}

export function telegramHandle(user: Pick<User, "telegramUsername" | "telegramId">) {
  return user.telegramUsername ? `@${user.telegramUsername}` : user.telegramId ? `ID ${user.telegramId}` : "";
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function toRub(state: AppState, amount: number, currency: string) {
  return amount * (state.currencies.find((item) => item.code === currency)?.rateToRub ?? 1);
}

export function activeServicesFor(state: AppState, userId: string) {
  const ids = new Set(state.memberships.filter((item) => item.userId === userId && item.active).map((item) => item.serviceId));
  return state.services.filter((service) => ids.has(service.id));
}

/** How much the participant should keep on balance to cover upcoming charges. */
export function balanceWarning(state: AppState, user: User) {
  const required = activeServicesFor(state, user.id)
    .filter((service) => service.active)
    .reduce((sum, service: Service) => {
      const summary = state.summaries.find((item) => item.serviceId === service.id);
      const periods = Math.max(1, service.billing.lowBalanceThresholdPeriods || 1);
      return sum + toRub(state, summary?.perMemberPeriod ?? 0, service.currency) * periods;
    }, 0);
  return { required, debt: user.balance < 0, low: required > 0 && user.balance >= 0 && user.balance < required };
}

export function classNames(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}
