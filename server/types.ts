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
  password: string;
  passwordSet?: boolean;
  notes: string;
  createdAt: string;
};

export type LatencyCheck = {
  id: string;
  serviceId: string;
  userId: string | null;
  status: ServiceHealthStatus;
  latencyMs: number | null;
  checkedAt: string;
  error: string;
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
  rateSnapshot: Record<string, number>;
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
  kind: "low_balance" | "period_summary" | "telegram_reply" | "latency_report" | "system";
  message: string;
  status: "sent" | "skipped" | "failed";
  createdAt: string;
};

export type WallTag = {
  id: string;
  name: string;
  color: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
};

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

export type SecuritySettings = {
  adminPassword: string;
  adminPasswordSet?: boolean;
  sessions?: Record<string, { userId: string; createdAt: string }>;
};

export type AppSettings = {
  telegram: TelegramSettings;
  security: SecuritySettings;
};

export type AppCounts = {
  deposits: number;
  debits: number;
  latencyChecks: number;
  notifications: number;
};

export type AppData = {
  currencies: Currency[];
  users: User[];
  services: Service[];
  memberships: Membership[];
  autoDeposits: AutoDeposit[];
  deposits: Deposit[];
  debits: Debit[];
  latencyChecks: LatencyCheck[];
  notifications: Notification[];
  wallTags: WallTag[];
  wallFiles: WallFile[];
  wallPosts: WallPost[];
  wallComments: WallComment[];
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
