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
  avatarUrl: string;
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

export type ServiceHealthStatus = "unknown" | "online" | "offline" | "maintenance";
export type ServiceDeployStatus = "unknown" | "success" | "failed";

export type ServiceConnectionSettings = {
  enabled: boolean;
  host: string;
  port: number;
  sshPort: number;
  user: string;
  password: string;
  passwordSet?: boolean;
  websocketPath: string;
  useTls: boolean;
  lastStatus: ServiceHealthStatus;
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  lastError: string;
  lastDeployStatus: ServiceDeployStatus;
  lastDeployAt: string | null;
  lastDeployOutput: string;
};

export type Service = {
  id: string;
  name: string;
  description: string;
  notes: string;
  monthlyCost: number;
  currency: string;
  active: boolean;
  connection: ServiceConnectionSettings;
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
  comment: string;
  source: "manual" | "telegram" | "auto" | "reversal";
  createdAt: string;
  balanceAfter: number;
  cancelledAt?: string | null;
  cancellationReason?: string;
  reversalId?: string | null;
  reversesId?: string | null;
};

export type AutoDeposit = {
  id: string;
  userId: string;
  serviceId: string;
  amount: number;
  currency: string;
  dayOfMonth: number;
  hour: number;
  enabled: boolean;
  comment: string;
  lastDepositedAt: string | null;
  nextDepositAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Debit = {
  id: string;
  serviceId: string;
  userId: string;
  amount: number;
  currency: string;
  amountBalanceCurrency: number;
  balanceCurrency: string;
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

export type ServiceSummary = {
  serviceId: string;
  memberCount: number;
  perMemberMonth: number;
  perMemberPeriod: number;
  lowBalanceCount: number;
  debtCount: number;
  nextChargeAt: string | null;
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

export type AppState = {
  currencies: Currency[];
  users: User[];
  services: Service[];
  memberships: Membership[];
  autoDeposits: AutoDeposit[];
  deposits: Deposit[];
  debits: Debit[];
  notifications: Notification[];
  settings: { telegram: TelegramSettings };
  summaries: ServiceSummary[];
  serverTime: string;
};
