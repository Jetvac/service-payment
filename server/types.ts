export type BillingPeriod = "month" | "week" | "day" | "hour";

export type Currency = {
  code: string;
  name: string;
  symbol: string;
  rateToRub: number;
  updatedAt: string;
};

export type User = {
  id: string;
  name: string;
  balance: number;
  telegramId: string;
  telegramUsername: string;
  commandDepositsBlocked: boolean;
  botAdmin: boolean;
  notes: string;
  createdAt: string;
};

export type BillingSettings = {
  period: BillingPeriod;
  interval: number;
  autoDebit: boolean;
  anchorDay: number;
  anchorHour: number;
  shiftDays: number;
  lastChargedAt: string | null;
  nextChargeAt: string | null;
  lowBalanceThresholdPeriods: number;
};

export type Service = {
  id: string;
  name: string;
  description: string;
  notes: string;
  monthlyCost: number;
  currency: string;
  active: boolean;
  billing: BillingSettings;
  createdAt: string;
};

export type Membership = {
  id: string;
  serviceId: string;
  userId: string;
  balance?: number;
  active: boolean;
  joinedAt: string;
};

export type Deposit = {
  id: string;
  serviceId: string;
  userId: string;
  amountOriginal: number;
  currencyOriginal: string;
  amountServiceCurrency: number;
  serviceCurrency: string;
  amountBalanceCurrency: number;
  balanceCurrency: string;
  rateSnapshot: Record<string, number>;
  comment: string;
  source: "manual" | "telegram" | "reversal";
  createdAt: string;
  balanceAfter: number;
  cancelledAt?: string | null;
  cancellationReason?: string;
  reversalId?: string | null;
  reversesId?: string | null;
};

export type Debit = {
  id: string;
  serviceId: string;
  userId: string;
  amount: number;
  currency: string;
  amountBalanceCurrency: number;
  balanceCurrency: string;
  rateSnapshot: Record<string, number>;
  periodStart: string;
  periodEnd: string;
  comment: string;
  source: "manual" | "auto" | "reversal";
  createdAt: string;
  balanceAfter: number;
  cancelledAt?: string | null;
  cancellationReason?: string;
  reversalId?: string | null;
  reversesId?: string | null;
};

export type Notification = {
  id: string;
  serviceId: string;
  userId: string | null;
  kind: "low_balance" | "period_summary" | "telegram_reply" | "system";
  message: string;
  status: "sent" | "skipped" | "failed";
  createdAt: string;
};

export type TelegramSettings = {
  enabled: boolean;
  botToken: string;
  chatId: string;
  notificationTopicId: string;
  webhookSecret: string;
  lowBalanceNotifications: boolean;
  monthlySummary: boolean;
  pollingEnabled: boolean;
  updateOffset: number;
  lastUpdateAt: string | null;
  lastError: string;
};

export type AppSettings = {
  telegram: TelegramSettings;
};

export type AppData = {
  currencies: Currency[];
  users: User[];
  services: Service[];
  memberships: Membership[];
  deposits: Deposit[];
  debits: Debit[];
  notifications: Notification[];
  settings: AppSettings;
};

export type ServiceSummary = {
  serviceId: string;
  memberCount: number;
  perMemberMonth: number;
  perMemberPeriod: number;
  lowBalanceCount: number;
  debtCount: number;
  nextChargeAt: string | null;
};
