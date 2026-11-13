export type BillingPeriod = "month" | "week" | "day" | "hour";

export type Currency = {
  code: string;
  name: string;
  symbol: string;
  rateToRub: number;
  updatedAt: string;
};

/** Participant as the server exposes it (no password hash). */
export type User = {
  id: string;
  name: string;
  balance: number;
  telegramId: string;
  telegramUsername: string;
  avatarUrl: string;
  commandDepositsBlocked: boolean;
  botAdmin: boolean;
  passwordSet: boolean;
  notes: string;
  createdAt: string;
};

export type AuthUser = Pick<User, "id" | "name" | "avatarUrl" | "botAdmin" | "passwordSet">;

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
  active: boolean;
  joinedAt: string;
};

type OperationState = {
  cancelledAt?: string | null;
  cancellationReason?: string;
  reversalId?: string | null;
  reversesId?: string | null;
};

export type Deposit = OperationState & {
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
  source: "manual" | "telegram" | "auto" | "payment" | "reversal";
  createdAt: string;
  balanceAfter: number;
};

export type Debit = OperationState & {
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

export type Notification = {
  id: string;
  serviceId: string;
  userId: string | null;
  kind: "low_balance" | "period_summary" | "telegram_reply" | "payment" | "system";
  message: string;
  status: "sent" | "skipped" | "failed";
  createdAt: string;
};

export type WallTag = { id: string; name: string; color: string; pinned: boolean; archived: boolean; createdAt: string };

export type WallFile = {
  id: string;
  originalName: string;
  storageName: string;
  mimeType: string;
  size: number;
  url: string;
  uploadedBy: string;
  createdAt: string;
};

export type WallPost = {
  id: string;
  title: string;
  previewFileId: string | null;
  content: string;
  authorId: string;
  serviceId: string | null;
  tagIds: string[];
  fileIds: string[];
  views: number;
  commentCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type WallComment = {
  id: string;
  postId: string;
  parentId: string | null;
  authorId: string;
  content: string;
  fileIds: string[];
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

/** Telegram settings as seen by an administrator; secrets are only flagged. */
export type TelegramSettings = {
  enabled: boolean;
  botTokenSet: boolean;
  chatId: string;
  notificationTopicId: string;
  webhookSecretSet: boolean;
  webhookUrl: string;
  lowBalanceNotifications: boolean;
  monthlySummary: boolean;
  pollingEnabled: boolean;
  lastUpdateAt: string | null;
  lastError: string;
};

/** Recipient details shown to participants who pay by hand. */
export type PaymentSettings = {
  manualEnabled: boolean;
  recipientName: string;
  bankName: string;
  phone: string;
  account: string;
  paymentPurpose: string;
};

/** "sbp" / "sberbank" only appear in history imported from older versions. */
export type PaymentMethod = "manual" | "sbp" | "sberbank";

export type PaymentIntent = {
  id: string;
  userId: string;
  serviceId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  provider: "manual" | "yookassa";
  status: "pending" | "succeeded" | "canceled" | "failed";
  description: string;
  comment: string;
  depositId: string | null;
  failureReason: string;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
};

export type AppState = {
  viewerId: string;
  currencies: Currency[];
  users: User[];
  services: Service[];
  memberships: Membership[];
  autoDeposits: AutoDeposit[];
  summaries: ServiceSummary[];
  botEnabled: boolean;
  settings: { payments: PaymentSettings; telegram: TelegramSettings | null };
  counts: { deposits: number; debits: number; notifications: number; payments: number };
  serverTime: string;
};

export type PageResult<T> = { rows: T[]; total: number; offset: number; limit: number; hasMore: boolean };

export type DashboardData = {
  currency: string;
  chart: Array<{ date: string; deposits: number; debits: number }>;
  notifications: PageResult<Notification>;
};

export type WallListData = { posts: PageResult<WallPost>; tags: WallTag[]; files: WallFile[] };
