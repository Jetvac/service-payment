import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Archive,
  ArchiveRestore,
  BellRing,
  BookOpen,
  Bot,
  CalendarClock,
  CalendarPlus,
  Check,
  CircleDollarSign,
  Clock3,
  Coins,
  CreditCard,
  Download,
  Eye,
  FileText,
  Gauge,
  History,
  Image,
  Link,
  LogOut,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RefreshCcw,
  Send,
  Settings2,
  Shield,
  Tag,
  Trash2,
  Upload,
  Wallet,
  Wrench,
  X,
  UserPlus,
  Users
} from "lucide-react";
import { type CSSProperties, type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type {
  AppState,
  BillingPeriod,
  Currency,
  Debit,
  Deposit,
  LatencyCheck,
  Notification as AppNotification,
  Service,
  ServiceConnectionSettings,
  ServiceHealthStatus,
  TelegramSettings,
  User,
  WallComment,
  WallFile,
  WallPost,
  WallTag
} from "./types";
import type { AutoDeposit } from "./types";

type View = "dashboard" | "wall" | "services" | "people" | "ledger" | "bot";

type DepositForm = {
  serviceId: string;
  userId: string;
  amount: number;
  currency: string;
  comment: string;
};

type AutoDepositForm = {
  userId: string;
  serviceId: string;
  amount: number;
  currency: string;
  dayOfMonth: number;
  hour: number;
  enabled: boolean;
  comment: string;
};

type CurrencyDraft = Omit<Currency, "updatedAt"> & { updatedAt?: string };

type ApiResult = {
  ok: boolean;
  payload?: unknown;
  error?: string;
};

type SystemUpdateResult = {
  steps: Array<{ command: string; output: string }>;
  restart: { scheduled: boolean; serviceUnit?: string; reason?: string };
};

type ClientHealth = {
  status: ServiceHealthStatus | "checking";
  latencyMs: number | null;
  checkedAt: string | null;
  error: string;
};

type PageResult<T> = {
  rows: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

type DashboardData = {
  chart: Array<{ date: string; deposits: number; debits: number }>;
  latencyTimeline: Array<Record<string, string | number>>;
  latencySeries: Array<{ key: string; name: string; color: string }>;
  latencyRecent: PageResult<LatencyCheck>;
  latencyByUser: Array<{ name: string; avg: number; count: number }>;
  notifications: PageResult<AppNotification>;
};

type OperationPages = {
  deposits: PageResult<Deposit>;
  debits: PageResult<Debit>;
};

type WallListData = {
  posts: PageResult<WallPost>;
  tags: WallTag[];
  files: WallFile[];
};

type AuthUser = Pick<User, "id" | "name" | "avatarUrl" | "botAdmin" | "passwordSet">;

type AuthLoginResult = {
  token: string;
  userId: string;
  state: AppState;
};

type WallPostDraft = {
  id?: string;
  title: string;
  previewFileId: string | null;
  content: string;
  serviceId: string;
  tagIds: string[];
  fileIds: string[];
};

const authStorageKey = "vpn-payment-current-user-id";
const authTokenStorageKey = "vpn-payment-auth-token";
const ledgerPageLimit = 20;
const wallPageLimit = 20;

const periodNames: Record<BillingPeriod, string> = {
  month: "Месяц",
  week: "Неделя",
  day: "День",
  hour: "Час"
};

const operationSourceNames: Record<string, string> = {
  manual: "Ручной",
  telegram: "Telegram",
  auto: "Авто",
  reversal: "Коррекция"
};

const healthLabels: Record<ServiceHealthStatus | "checking", string> = {
  online: "Онлайн",
  offline: "Недоступен",
  maintenance: "Обслуживание",
  unknown: "Нет данных",
  checking: "Проверка"
};

const navItems = [
  { id: "dashboard", label: "Обзор", icon: Gauge },
  { id: "wall", label: "Стена", icon: BookOpen },
  { id: "services", label: "Сервисы", icon: Shield },
  { id: "people", label: "Участники", icon: Users },
  { id: "ledger", label: "История", icon: History },
  { id: "bot", label: "Telegram", icon: Bot }
] satisfies Array<{ id: View; label: string; icon: typeof Gauge }>;

const blankService = {
  name: "",
  description: "",
  notes: "",
  monthlyCost: 600,
  currency: "RUB",
  connection: {
    enabled: false,
    host: "",
    port: 8765,
    sshPort: 22,
    user: "",
    password: "",
    passwordSet: false,
    websocketPath: "/echo",
    useTls: false,
    lastStatus: "unknown" as ServiceHealthStatus,
    lastLatencyMs: null,
    lastCheckedAt: null,
    lastError: "",
    lastDeployStatus: "unknown",
    lastDeployAt: null,
    lastDeployOutput: ""
  },
  period: "month" as BillingPeriod,
  interval: 1,
  anchorDay: 1,
  anchorHour: 12,
  shiftDays: 0,
  autoDebit: false,
  lowBalanceThresholdPeriods: 1
};

const blankUser = {
  name: "",
  balance: 0,
  telegramId: "",
  telegramUsername: "",
  avatarUrl: "",
  notes: "",
  commandDepositsBlocked: false,
  botAdmin: false,
  password: "",
  passwordSet: false
};

const blankAutoDeposit = {
  userId: "",
  serviceId: "",
  amount: 600,
  currency: "RUB",
  dayOfMonth: 1,
  hour: 12,
  enabled: true,
  comment: ""
};

const emptyPage = <T,>(limit = ledgerPageLimit): PageResult<T> => ({
  rows: [],
  total: 0,
  offset: 0,
  limit,
  hasMore: false
});

const emptyDashboardData: DashboardData = {
  chart: [],
  latencyTimeline: [],
  latencySeries: [],
  latencyRecent: emptyPage<LatencyCheck>(20),
  latencyByUser: [],
  notifications: emptyPage<AppNotification>(8)
};

const emptyOperationPages: OperationPages = {
  deposits: emptyPage<Deposit>(),
  debits: emptyPage<Debit>()
};

const emptyWallData: WallListData = {
  posts: emptyPage<WallPost>(wallPageLimit),
  tags: [],
  files: []
};

const blankWallPostDraft: WallPostDraft = {
  title: "",
  previewFileId: null,
  content: "",
  serviceId: "",
  tagIds: [],
  fileIds: []
};

function money(value: number, currency: string) {
  return `${Number(value || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function fileSize(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ГБ`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  if (value >= 1024) return `${(value / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
  return `${value} Б`;
}

function wallPostIdFromHash() {
  const match = window.location.hash.match(/^#\/wall\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function setWallHash(postId?: string) {
  window.location.hash = postId ? `#/wall/${encodeURIComponent(postId)}` : "#/wall";
}

function currencyRate(state: AppState, code: string) {
  return state.currencies.find((currency) => currency.code === code)?.rateToRub ?? 1;
}

function toRub(state: AppState, amount: number, currency: string) {
  return amount * currencyRate(state, currency);
}

function dateTime(value: string | null | undefined) {
  if (!value) return "Не задано";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function serviceConnection(service: Service): ServiceConnectionSettings {
  return { ...blankService.connection, ...(service.connection ?? {}) };
}

function serviceHealth(service: Service, clientHealth?: ClientHealth): ClientHealth {
  const connection = serviceConnection(service);
  if (connection.lastStatus === "maintenance") {
    return {
      status: "maintenance",
      latencyMs: null,
      checkedAt: connection.lastCheckedAt ?? null,
      error: connection.lastError ?? ""
    };
  }

  return (
    clientHealth ?? {
      status: connection.lastStatus ?? "unknown",
      latencyMs: connection.lastLatencyMs ?? null,
      checkedAt: connection.lastCheckedAt ?? null,
      error: connection.lastError ?? ""
    }
  );
}

function healthTone(status: ServiceHealthStatus | "checking"): "good" | "warn" | "bad" | undefined {
  if (status === "online") return "good";
  if (status === "offline") return "bad";
  if (status === "checking" || status === "maintenance") return "warn";
  return undefined;
}

function healthValue(health: ClientHealth) {
  const latency = health.latencyMs !== null ? ` · ${health.latencyMs} мс` : "";
  return `${healthLabels[health.status]}${latency}`;
}

function buildServiceWebSocketUrl(service: Service) {
  const connection = serviceConnection(service);
  const rawHost = connection.host.trim();
  let host = rawHost.replace(/^wss?:\/\//i, "").replace(/\/.*$/, "");
  let port = String(connection.port || 8765);
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(rawHost) ? rawHost : `ws://${rawHost}`);
    host = parsed.hostname;
    port = parsed.port || port;
  } catch {
    const hostMatch = host.match(/^(.*):(\d+)$/);
    host = hostMatch?.[1] || host;
    port = hostMatch?.[2] || port;
  }
  const hostForUrl = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const path = (connection.websocketPath || "/echo").startsWith("/")
    ? connection.websocketPath || "/echo"
    : `/${connection.websocketPath}`;
  const protocol = connection.useTls || window.location.protocol === "https:" ? "wss" : "ws";

  return `${protocol}://${hostForUrl}:${port}${path}`;
}

function checkServiceFromClient(service: Service) {
  const connection = serviceConnection(service);
  const checkedAt = new Date().toISOString();

  if (!connection.enabled || !connection.host.trim()) {
    return Promise.resolve({ status: "unknown" as ServiceHealthStatus, latencyMs: null, checkedAt, error: "" });
  }

  return new Promise<{ status: ServiceHealthStatus; latencyMs: number | null; checkedAt: string; error: string }>((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const started = performance.now();
    const payload = `vpn-pay:${service.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    const finish = (status: ServiceHealthStatus, latencyMs: number | null, error = "") => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try {
        socket?.close();
      } catch {
        // ignore close errors after failed handshakes
      }
      resolve({ status, latencyMs, checkedAt: new Date().toISOString(), error });
    };

    const timeout = window.setTimeout(() => finish("offline", null, "timeout"), 5000);

    try {
      socket = new WebSocket(buildServiceWebSocketUrl(service));
      socket.addEventListener("open", () => socket?.send(payload));
      socket.addEventListener("message", () => finish("online", Math.round(performance.now() - started)));
      socket.addEventListener("error", () => finish("offline", null, "websocket error"));
      socket.addEventListener("close", () => finish("offline", null, "connection closed"));
    } catch (error) {
      finish("offline", null, error instanceof Error ? error.message : "connection failed");
    }
  });
}

function activeServicesForUser(state: AppState, userId: string) {
  return state.memberships
    .filter((membership) => membership.userId === userId && membership.active)
    .map((membership) => state.services.find((service) => service.id === membership.serviceId))
    .filter((service): service is Service => Boolean(service));
}

function userBalanceWarning(state: AppState, user: User) {
  const required = activeServicesForUser(state, user.id).reduce((sum, service) => {
    const summary = state.summaries.find((item) => item.serviceId === service.id);
    const periods = Math.max(1, service.billing.lowBalanceThresholdPeriods || 1);
    return sum + toRub(state, summary?.perMemberPeriod ?? 0, service.currency) * periods;
  }, 0);

  return {
    required,
    low: required > 0 && user.balance < required
  };
}

function autoDepositDefaults(state: AppState, preferredUserId = ""): AutoDepositForm {
  const userId = preferredUserId && state.users.some((user) => user.id === preferredUserId) ? preferredUserId : state.users[0]?.id ?? "";
  const service = activeServicesForUser(state, userId)[0];

  return {
    ...blankAutoDeposit,
    userId,
    serviceId: service?.id ?? "",
    currency: service?.currency ?? state.currencies[0]?.code ?? "RUB"
  };
}

async function api<T = AppState>(path: string, options: RequestInit = {}) {
  const token = window.localStorage.getItem(authTokenStorageKey);
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-auth-token": token } : {}),
      ...(options.headers ?? {})
    }
  });
  if (response.status === 401 && !path.startsWith("/api/auth/login")) {
    throw new Error("AUTH_REQUIRED");
  }
  const result = (await response.json()) as ApiResult;

  if (!result.ok) {
    throw new Error(result.error ?? "Ошибка API");
  }

  return result.payload! as T;
}

function classNames(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

function Stat({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <div className="stat">
      <span className={classNames("stat-icon", tone)}>
        <Icon size={18} />
      </span>
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ServiceHealthBadge({ health, compact = false }: { health: ClientHealth; compact?: boolean }) {
  return (
    <span className={classNames("service-health", health.status, compact && "compact")} title={health.error || undefined}>
      <span className={classNames("status-dot", health.status)} />
      <span>{healthValue(health)}</span>
    </span>
  );
}

function PaginationControls<T>({ page, onChange }: { page: PageResult<T>; onChange: (offset: number) => void }) {
  const pageNumber = Math.floor(page.offset / page.limit) + 1;
  const pageCount = Math.max(1, Math.ceil(page.total / page.limit));
  const previousOffset = Math.max(0, page.offset - page.limit);
  const nextOffset = page.offset + page.limit;

  if (page.total <= page.limit && page.offset === 0) return null;

  return (
    <div className="pagination-controls">
      <button className="ghost compact" type="button" disabled={page.offset === 0} onClick={() => onChange(previousOffset)}>
        Назад
      </button>
      <span>
        {pageNumber} / {pageCount}
      </span>
      <button className="ghost compact" type="button" disabled={!page.hasMore} onClick={() => onChange(nextOffset)}>
        Вперёд
      </button>
    </div>
  );
}

function UserAvatar({ user, size = "normal" }: { user: Pick<User, "name" | "avatarUrl">; size?: "normal" | "large" }) {
  const initials = (user.name || "?").slice(0, 2).toUpperCase();
  return (
    <span className={classNames("avatar", size === "large" && "large")}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initials}
    </span>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="empty">{label}</div>;
}

function ModalShell({
  title,
  subtitle,
  wide = false,
  children,
  footer,
  onClose
}: {
  title: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={classNames("modal-panel", wide && "wide-modal")}
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <small>{subtitle}</small>}
          </div>
          <button className="icon-button" type="button" title="Закрыть" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{footer}</div>
      </section>
    </div>
  );
}

function AuthScreen({ users, onLogin }: { users: AuthUser[]; onLogin: (userId: string, password: string) => Promise<void> }) {
  const [selectedUserId, setSelectedUserId] = useState(users[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const selectedUser = users.find((user) => user.id === selectedUserId) ?? users[0];

  useEffect(() => {
    if (!selectedUserId && users[0]?.id) setSelectedUserId(users[0].id);
  }, [selectedUserId, users]);

  const submit = async () => {
    if (!selectedUser || !password) return;
    try {
      setSubmitting(true);
      setError("");
      await onLogin(selectedUser.id, password);
    } catch (error) {
      setError(error instanceof Error && error.message !== "AUTH_REQUIRED" ? error.message : "Не удалось войти");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div className="brand auth-brand">
          <span className="brand-mark">
            <Shield size={18} />
          </span>
          <div>
            <strong>VPN Pay</strong>
            <small>Control</small>
          </div>
        </div>
        <div className="auth-heading">
          <h1>Вход</h1>
          <span className="muted">Выберите участника</span>
        </div>
        {selectedUser ? (
          <>
            <label className="auth-combobox">
              Участник
              <div className="auth-combobox-control">
                <UserAvatar user={selectedUser} />
                <select value={selectedUser.id} onChange={(event) => setSelectedUserId(event.target.value)}>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            <div className="auth-user-preview">
              <UserAvatar user={selectedUser} size="large" />
              <div>
                <strong>{selectedUser.name}</strong>
                <small>{selectedUser.passwordSet ? "Пароль настроен" : "Пароль не задан"}</small>
              </div>
              {selectedUser.botAdmin && <span className="status-pill reversal">админ</span>}
            </div>
            <label>
              Пароль
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="primary auth-login" type="button" disabled={!password || submitting || !selectedUser.passwordSet} onClick={() => void submit()}>
              <Shield size={16} />
              {submitting ? "Проверка..." : "Войти"}
            </button>
          </>
        ) : (
          <Empty label="Участников пока нет" />
        )}
      </section>
    </main>
  );
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [authUsers, setAuthUsers] = useState<AuthUser[]>([]);
  const [view, setView] = useState<View>("dashboard");
  const [currentUserId, setCurrentUserId] = useState(() => window.localStorage.getItem(authStorageKey) ?? "");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [toast, setToast] = useState("");
  const [serviceForm, setServiceForm] = useState(blankService);
  const [userForm, setUserForm] = useState(blankUser);
  const [currencyForm, setCurrencyForm] = useState({ code: "", name: "", symbol: "", rateToRub: 1 });
  const [clientHealth, setClientHealth] = useState<Record<string, ClientHealth>>({});
  const [deployingServiceId, setDeployingServiceId] = useState("");
  const [depositForm, setDepositForm] = useState({
    serviceId: "",
    userId: "",
    amount: 0,
    currency: "RUB",
    comment: ""
  });
  const [dashboardData, setDashboardData] = useState<DashboardData>(emptyDashboardData);
  const [dashboardNotificationOffset, setDashboardNotificationOffset] = useState(0);
  const [dashboardLatencyOffset, setDashboardLatencyOffset] = useState(0);
  const [operationPages, setOperationPages] = useState<OperationPages>(emptyOperationPages);
  const [operationOffsets, setOperationOffsets] = useState({ deposits: 0, debits: 0 });
  const [wallPostId, setWallPostId] = useState(() => wallPostIdFromHash());
  const [wallRefreshKey, setWallRefreshKey] = useState(0);

  const currentUser = useMemo(() => state?.users.find((user) => user.id === currentUserId), [currentUserId, state?.users]);
  const isAdmin = Boolean(currentUser?.botAdmin);
  const visibleNavItems = useMemo(() => navItems.filter((item) => isAdmin || item.id !== "bot"), [isAdmin]);

  const clearAuth = () => {
    window.localStorage.removeItem(authStorageKey);
    window.localStorage.removeItem(authTokenStorageKey);
    setCurrentUserId("");
    setState(null);
  };

  const loadAuthUsers = async () => {
    const users = await api<AuthUser[]>("/api/auth/users");
    setAuthUsers(users);
    return users;
  };

  const load = async () => {
    const nextState = await api("/api/state");
    setState(nextState);
    setSelectedServiceId((current) => current || nextState.services[0]?.id || "");
    setDepositForm((current) => ({
      ...current,
      serviceId: current.serviceId || nextState.services[0]?.id || "",
      userId: current.userId || nextState.users[0]?.id || "",
      currency: current.currency || nextState.services[0]?.currency || "RUB"
    }));
  };

  const loadDashboardData = async (notificationOffset = dashboardNotificationOffset, latencyOffset = dashboardLatencyOffset) => {
    const query = new URLSearchParams({
      notificationOffset: String(notificationOffset),
      notificationLimit: "8",
      latencyOffset: String(latencyOffset),
      latencyLimit: "20"
    });
    const nextDashboard = await api<DashboardData>(`/api/dashboard?${query.toString()}`);
    setDashboardData(nextDashboard);
    setDashboardNotificationOffset(notificationOffset);
    setDashboardLatencyOffset(latencyOffset);
    return nextDashboard;
  };

  const loadOperationData = async (depositOffset = operationOffsets.deposits, debitOffset = operationOffsets.debits) => {
    if (!currentUser) return emptyOperationPages;
    const depositQuery = new URLSearchParams({
      offset: String(depositOffset),
      limit: String(ledgerPageLimit)
    });
    const debitQuery = new URLSearchParams({
      offset: String(debitOffset),
      limit: String(ledgerPageLimit)
    });
    if (!isAdmin) {
      depositQuery.set("userId", currentUser.id);
      debitQuery.set("userId", currentUser.id);
    }
    const [deposits, debits] = await Promise.all([
      api<PageResult<Deposit>>(`/api/deposits?${depositQuery.toString()}`),
      api<PageResult<Debit>>(`/api/debits?${debitQuery.toString()}`)
    ]);
    const nextPages = { deposits, debits };
    setOperationPages(nextPages);
    setOperationOffsets({ deposits: depositOffset, debits: debitOffset });
    return nextPages;
  };

  const refreshOpenViewData = async (reset = false) => {
    if (view === "dashboard") {
      await loadDashboardData(reset ? 0 : dashboardNotificationOffset, reset ? 0 : dashboardLatencyOffset);
    }
    if (view === "ledger") {
      await loadOperationData(reset ? 0 : operationOffsets.deposits, reset ? 0 : operationOffsets.debits);
    }
    if (view === "wall") {
      setWallRefreshKey((current) => current + 1);
    }
  };

  useEffect(() => {
    if (window.localStorage.getItem(authTokenStorageKey)) {
      load().catch((error) => {
        if (error instanceof Error && error.message === "AUTH_REQUIRED") {
          clearAuth();
          loadAuthUsers().catch((authError) => setToast(authError.message));
          return;
        }
        setToast(error instanceof Error ? error.message : "Ошибка загрузки");
      });
      return;
    }
    loadAuthUsers().catch((error) => setToast(error.message));
  }, []);

  useEffect(() => {
    const syncWallHash = () => {
      const nextPostId = wallPostIdFromHash();
      setWallPostId(nextPostId);
      if (window.location.hash.startsWith("#/wall")) setView("wall");
    };

    syncWallHash();
    window.addEventListener("hashchange", syncWallHash);
    return () => window.removeEventListener("hashchange", syncWallHash);
  }, []);

  useEffect(() => {
    if (!state || !currentUser || view !== "dashboard") return;
    loadDashboardData(0, 0).catch((error) => setToast(error.message));
  }, [view, currentUser?.id]);

  useEffect(() => {
    if (!state || !currentUser || view !== "ledger") return;
    loadOperationData(0, 0).catch((error) => setToast(error.message));
  }, [view, currentUser?.id, isAdmin]);

  useEffect(() => {
    if (!state) return;
    if (currentUserId && !state.users.some((user) => user.id === currentUserId)) {
      clearAuth();
      loadAuthUsers().catch((error) => setToast(error.message));
    }
  }, [currentUserId, state]);

  useEffect(() => {
    if (!isAdmin && view === "bot") {
      setView("dashboard");
    }
  }, [isAdmin, view]);

  const showWallList = () => {
    setWallPostId("");
    if (window.location.hash !== "#/wall") setWallHash();
  };

  const healthConfigKey = useMemo(
    () =>
      state?.services
        .map((service) => {
          const connection = serviceConnection(service);
          return [
            service.id,
            connection.enabled,
            connection.host,
            connection.port,
            connection.websocketPath,
            connection.useTls
          ].join(":");
        })
        .join("|") ?? "",
    [currentUser?.id, state?.services]
  );

  const probeService = async (service: Service) => {
    const connection = serviceConnection(service);
    if (!currentUser || !connection.enabled || !connection.host.trim() || connection.lastStatus === "maintenance") return;

    setClientHealth((current) => ({
      ...current,
      [service.id]: { status: "checking", latencyMs: null, checkedAt: new Date().toISOString(), error: "" }
    }));

    const result = await checkServiceFromClient(service);
    setClientHealth((current) => ({
      ...current,
      [service.id]: result
    }));

    try {
      const nextState = await api(`/api/services/${service.id}/health`, {
        method: "POST",
        body: JSON.stringify({ ...result, userId: currentUser.id })
      });
      setState(nextState);
    } catch (error) {
      setClientHealth((current) => ({
        ...current,
        [service.id]: {
          ...result,
          status: "offline",
          error: error instanceof Error ? error.message : result.error
        }
      }));
    }
  };

  useEffect(() => {
    if (!state || !currentUser) return;
    const services = state.services.filter((service) => {
      const connection = serviceConnection(service);
      return connection.enabled && connection.host.trim() && connection.lastStatus !== "maintenance";
    });
    if (!services.length) return;

    let cancelled = false;
    const run = () => {
      for (const service of services) {
        if (!cancelled) void probeService(service);
      }
    };

    run();
    const timer = window.setInterval(run, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [healthConfigKey, currentUser?.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedService = useMemo(
    () => state?.services.find((service) => service.id === selectedServiceId) ?? state?.services[0],
    [selectedServiceId, state]
  );

  const selectedSummary = useMemo(
    () => state?.summaries.find((summary) => summary.serviceId === selectedService?.id),
    [selectedService?.id, state]
  );

  const activeMemberships = useMemo(() => {
    if (!state || !selectedService) return [];
    return state.memberships.filter((membership) => membership.serviceId === selectedService.id && membership.active);
  }, [selectedService, state]);

  const inactiveUsers = useMemo(() => {
    if (!state || !selectedService) return [];
    const active = new Set(activeMemberships.map((membership) => membership.userId));
    return state.users.filter((user) => !active.has(user.id));
  }, [activeMemberships, selectedService, state]);

  const serviceById = (id: string) => state?.services.find((service) => service.id === id);
  const userById = (id: string) => state?.users.find((user) => user.id === id);

  const mutate = async (path: string, body?: unknown, method = "POST") => {
    try {
      const nextState = await api(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      setState(nextState);
      setToast("Сохранено");
      return nextState;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Ошибка");
      throw error;
    }
  };

  const exportDatabase = async () => {
    try {
      const token = window.localStorage.getItem(authTokenStorageKey);
      const response = await fetch("/api/database/export", {
        headers: token ? { "x-auth-token": token } : undefined
      });
      if (!response.ok) throw new Error("Не удалось выгрузить базу");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? `service-payment-backup-${Date.now()}.json`;

      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setToast("База выгружена");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Ошибка выгрузки");
    }
  };

  const importDatabase = async (file: File) => {
    try {
      const backup = JSON.parse(await file.text());
      await mutate("/api/database/import", backup);
      setToast("База загружена");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Ошибка загрузки базы");
    }
  };

  const updateApplication = async () => {
    try {
      setToast("Обновление запущено");
      const result = await api<SystemUpdateResult>("/api/system/update", {
        method: "POST",
        body: JSON.stringify({})
      });
      setToast(result.restart.scheduled ? `Обновлено, перезапуск: ${result.restart.serviceUnit}` : `Обновлено: ${result.restart.reason}`);
      return result;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Ошибка обновления");
      throw error;
    }
  };

  const dashboard = useMemo(() => {
    if (!state) {
      return {
        totalMonthly: 0,
        totalBalanceRub: 0,
        lowBalance: 0,
        debt: 0,
        chart: [],
        balances: [],
        latencyTimeline: emptyDashboardData.latencyTimeline,
        latencySeries: emptyDashboardData.latencySeries,
        latencyRecent: emptyDashboardData.latencyRecent,
        latencyByUser: emptyDashboardData.latencyByUser,
        notifications: emptyDashboardData.notifications
      };
    }

    const rate = (code: string) => state.currencies.find((currency) => currency.code === code)?.rateToRub ?? 1;
    const totalMonthly = state.services.reduce((sum, service) => sum + service.monthlyCost * rate(service.currency), 0);
    const totalBalanceRub = state.users.reduce((sum, user) => sum + user.balance, 0);

    const balances = state.users
      .map((user) => ({
        name: user.name,
        balance: user.balance
      }))
      .slice(0, 10);

    return {
      totalMonthly,
      totalBalanceRub,
      lowBalance: state.summaries.reduce((sum, summary) => sum + summary.lowBalanceCount, 0),
      debt: state.summaries.reduce((sum, summary) => sum + summary.debtCount, 0),
      chart: dashboardData.chart,
      balances,
      latencyTimeline: dashboardData.latencyTimeline,
      latencySeries: dashboardData.latencySeries,
      latencyRecent: dashboardData.latencyRecent,
      latencyByUser: dashboardData.latencyByUser,
      notifications: dashboardData.notifications
    };
  }, [dashboardData, state]);

  if (!state) {
    if (!window.localStorage.getItem(authTokenStorageKey)) {
      return (
        <AuthScreen
          users={authUsers}
          onLogin={async (userId, password) => {
            const result = await api<AuthLoginResult>("/api/auth/login", {
              method: "POST",
              body: JSON.stringify({ userId, password })
            });
            window.localStorage.setItem(authStorageKey, result.userId);
            window.localStorage.setItem(authTokenStorageKey, result.token);
            setCurrentUserId(result.userId);
            setState(result.state);
            setAuthUsers([]);
          }}
        />
      );
    }
    return (
      <main className="loading-screen">
        <Shield size={34} />
        <span>Загрузка</span>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <AuthScreen
        users={authUsers.length ? authUsers : state.users.map((user) => ({
          id: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
          botAdmin: user.botAdmin,
          passwordSet: user.passwordSet
        }))}
        onLogin={async (userId, password) => {
          const result = await api<AuthLoginResult>("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ userId, password })
          });
          window.localStorage.setItem(authStorageKey, result.userId);
          window.localStorage.setItem(authTokenStorageKey, result.token);
          setCurrentUserId(result.userId);
          setState(result.state);
          setAuthUsers([]);
        }}
      />
    );
  }

  const saveService = (service: Service) =>
    mutate(
      `/api/services/${service.id}`,
      {
        name: service.name,
        description: service.description,
        notes: service.notes,
        monthlyCost: service.monthlyCost,
        currency: service.currency,
        active: service.active,
        connection: service.connection,
        ...service.billing
      },
      "PUT"
    );

  const toggleServiceMaintenance = async (service: Service, maintenance: boolean) => {
    try {
      setToast(maintenance ? "Перевожу сервис на обслуживание" : "Возвращаю сервис в работу");
      const nextState = await api(`/api/services/${service.id}/maintenance`, {
        method: "POST",
        body: JSON.stringify({ maintenance })
      });
      setState(nextState);
      setClientHealth((current) => {
        const next = { ...current };
        delete next[service.id];
        return next;
      });
      setToast(maintenance ? "Сервис на обслуживании" : "Сервис возвращён в работу");
      return nextState;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Ошибка переключения обслуживания");
      throw error;
    }
  };

  const deployEchoServer = async (serviceId: string) => {
    try {
      setDeployingServiceId(serviceId);
      setToast("Запускаю деплой echo-сервера");
      const nextState = await mutate(`/api/services/${serviceId}/deploy-echo`, {});
      const service = nextState.services.find((item) => item.id === serviceId);
      setToast(service && serviceConnection(service).lastDeployStatus === "failed" ? "Деплой не удался" : "Echo-сервер развёрнут");
      return nextState;
    } finally {
      setDeployingServiceId("");
    }
  };

  const saveUser = (user: User & { adminPassword?: string }) => mutate(`/api/users/${user.id}`, user, "PUT");
  const saveTelegram = (telegram: TelegramSettings) => mutate("/api/settings/telegram", telegram, "PUT");
  const saveCurrency = (currency: Currency) => mutate(`/api/currencies/${currency.code}`, currency, "PUT");

  const content = {
    dashboard: (
      <Dashboard
        state={state}
        dashboard={dashboard}
        clientHealth={clientHealth}
        serviceById={serviceById}
        userById={userById}
        onLatencyPageChange={(offset) => loadDashboardData(dashboardNotificationOffset, offset).catch((error) => setToast(error.message))}
        onNotificationPageChange={(offset) => loadDashboardData(offset, dashboardLatencyOffset).catch((error) => setToast(error.message))}
      />
    ),
    wall: (
      <WallView
        state={state}
        currentUser={currentUser}
        isAdmin={isAdmin}
        selectedPostId={wallPostId}
        refreshKey={wallRefreshKey}
        onShowList={showWallList}
        setToast={setToast}
        userById={userById}
        serviceById={serviceById}
      />
    ),
    services: (
      <ServicesView
        state={state}
        serviceForm={serviceForm}
        setServiceForm={setServiceForm}
        selectedService={selectedService}
        selectedSummary={selectedSummary}
        activeMemberships={activeMemberships}
        inactiveUsers={inactiveUsers}
        userById={userById}
        mutate={mutate}
        setSelectedServiceId={setSelectedServiceId}
        clientHealth={clientHealth}
        probeService={probeService}
        toggleServiceMaintenance={toggleServiceMaintenance}
        deployingServiceId={deployingServiceId}
        deployEchoServer={deployEchoServer}
        saveService={saveService}
      />
    ),
    people: (
      <PeopleView
        state={state}
        userForm={userForm}
        setUserForm={setUserForm}
        userById={userById}
        serviceById={serviceById}
        mutate={mutate}
        saveUser={saveUser}
        isAdmin={isAdmin}
      />
    ),
    ledger: (
      <LedgerView
        state={state}
        depositForm={depositForm}
        setDepositForm={setDepositForm}
        mutate={mutate}
        serviceById={serviceById}
        userById={userById}
        currentUser={currentUser}
        isAdmin={isAdmin}
        operationPages={operationPages}
        reloadOperations={() => loadOperationData()}
        onOperationPageChange={(kind, offset) => {
          const nextDepositOffset = kind === "deposits" ? offset : operationOffsets.deposits;
          const nextDebitOffset = kind === "debits" ? offset : operationOffsets.debits;
          loadOperationData(nextDepositOffset, nextDebitOffset).catch((error) => setToast(error.message));
        }}
      />
    ),
    bot: (
      <BotView
        state={state}
        currencyForm={currencyForm}
        setCurrencyForm={setCurrencyForm}
        saveTelegram={saveTelegram}
        saveCurrency={saveCurrency}
        mutate={mutate}
        exportDatabase={exportDatabase}
        importDatabase={importDatabase}
        updateApplication={updateApplication}
      />
    )
  }[view];

  const warning = userBalanceWarning(state, currentUser);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Shield size={18} />
          </span>
          <div>
            <strong>VPN Pay</strong>
            <small>Control</small>
          </div>
        </div>

        <nav>
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={classNames("nav-item", view === item.id && "active")}
                onClick={() => {
                  if (item.id === "wall") showWallList();
                  else if (window.location.hash.startsWith("#/wall")) {
                    setWallPostId("");
                    window.history.replaceState(null, "", window.location.pathname);
                  }
                  setView(item.id);
                }}
                type="button"
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="account-card">
          <UserAvatar user={currentUser} />
          <div>
            <strong>{currentUser.name}</strong>
            <small>{money(currentUser.balance, "RUB")}</small>
          </div>
          <button
            className="icon-button"
            type="button"
            title="Выйти"
            onClick={() => {
              api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }).catch(() => undefined);
              clearAuth();
              loadAuthUsers().catch((error) => setToast(error.message));
            }}
          >
            <LogOut size={15} />
          </button>
        </div>

        <div className="sidebar-footer">
          <span className={classNames("status-dot", state.settings.telegram.enabled && "enabled")} />
          <span>{state.settings.telegram.enabled ? "Bot online" : "Bot off"}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">VPN Payment Control</span>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
          </div>
        </header>

        {warning.low && (
          <div className="balance-alert">
            <AlertTriangle size={18} />
            <div>
              <strong>Малый остаток</strong>
              <span>
                Текущий баланс {money(currentUser.balance, "RUB")}, ближайший порог оплат {money(warning.required, "RUB")}
              </span>
            </div>
          </div>
        )}

        {content}
      </main>

      {toast && (
        <div className="toast">
          <Check size={16} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

function Dashboard({
  state,
  dashboard,
  clientHealth,
  serviceById,
  userById,
  onLatencyPageChange,
  onNotificationPageChange
}: {
  state: AppState;
  dashboard: {
    totalMonthly: number;
    totalBalanceRub: number;
    lowBalance: number;
    debt: number;
    chart: Array<{ date: string; deposits: number; debits: number }>;
    balances: Array<{ name: string; balance: number }>;
    latencyTimeline: Array<Record<string, string | number>>;
    latencySeries: Array<{ key: string; name: string; color: string }>;
    latencyRecent: PageResult<LatencyCheck>;
    latencyByUser: Array<{ name: string; avg: number; count: number }>;
    notifications: PageResult<AppNotification>;
  };
  clientHealth: Record<string, ClientHealth>;
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
  onLatencyPageChange: (offset: number) => void;
  onNotificationPageChange: (offset: number) => void;
}) {
  return (
    <section className="page-grid">
      <div className="stats-grid">
        <Stat icon={CircleDollarSign} label="Сервисы в месяц" value={money(dashboard.totalMonthly, "RUB")} />
        <Stat icon={Coins} label="Остатки участников" value={money(dashboard.totalBalanceRub, "RUB")} tone="good" />
        <Stat icon={BellRing} label="Малый остаток" value={String(dashboard.lowBalance)} tone="warn" />
        <Stat icon={Activity} label="Просрочка" value={String(dashboard.debt)} tone={dashboard.debt ? "bad" : "good"} />
      </div>

      <div className="panel chart-panel wide">
        <div className="panel-head">
          <h2>Движение средств</h2>
          <span className="chip">14 дней</span>
        </div>
        <div className="chart-wrap">
          {dashboard.chart.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dashboard.chart}>
                <defs>
                  <linearGradient id="deposits" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#47d18c" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="#47d18c" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="debits" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ff6f61" stopOpacity={0.45} />
                    <stop offset="95%" stopColor="#ff6f61" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: "#8a8f98", fontSize: 12 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#8a8f98", fontSize: 12 }} />
                <Tooltip contentStyle={{ background: "#111318", border: "1px solid #272a33", borderRadius: 8 }} />
                <Area type="monotone" dataKey="deposits" stroke="#47d18c" fill="url(#deposits)" name="Зачисления" />
                <Area type="monotone" dataKey="debits" stroke="#ff6f61" fill="url(#debits)" name="Списания" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <Empty label="Журнал пуст" />
          )}
        </div>
      </div>

      <div className="panel chart-panel">
        <div className="panel-head">
          <h2>Остатки</h2>
          <span className="chip">{dashboard.balances.length}</span>
        </div>
        <div className="chart-wrap compact">
          {dashboard.balances.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dashboard.balances} layout="vertical" margin={{ left: 12, right: 12 }}>
                <CartesianGrid stroke="rgba(255,255,255,.06)" horizontal={false} />
                <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: "#8a8f98", fontSize: 12 }} />
                <YAxis
                  type="category"
                  width={116}
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#c6cad2", fontSize: 12 }}
                />
                <Tooltip contentStyle={{ background: "#111318", border: "1px solid #272a33", borderRadius: 8 }} />
                <Bar dataKey="balance" fill="#7aa8ff" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty label="Нет участников" />
          )}
        </div>
      </div>

      <div className="panel wide">
        <div className="panel-head">
          <h2>Сервисы</h2>
          <span className="chip">{state.services.length}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Стоимость</th>
                <th>Участники</th>
                <th>Период</th>
                <th>Сервер</th>
                <th>Следующее списание</th>
              </tr>
            </thead>
            <tbody>
              {state.services.map((service) => {
                const summary = state.summaries.find((item) => item.serviceId === service.id);
                return (
                  <tr key={service.id}>
                    <td>
                      <strong>{service.name}</strong>
                      <small>{service.description}</small>
                    </td>
                    <td>{money(service.monthlyCost, service.currency)}</td>
                    <td>{summary?.memberCount ?? 0}</td>
                    <td>{periodNames[service.billing.period]}</td>
                    <td>
                      <ServiceHealthBadge health={serviceHealth(service, clientHealth[service.id])} compact />
                    </td>
                    <td>{dateTime(summary?.nextChargeAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel chart-panel">
        <div className="panel-head">
          <h2>Пинг пользователей</h2>
          <span className="chip">{dashboard.latencyByUser.length}</span>
        </div>
        <div className="chart-wrap compact">
          {dashboard.latencyByUser.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dashboard.latencyByUser} layout="vertical" margin={{ left: 12, right: 12 }}>
                <CartesianGrid stroke="rgba(255,255,255,.06)" horizontal={false} />
                <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: "#8a8f98", fontSize: 12 }} />
                <YAxis
                  type="category"
                  width={116}
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#c6cad2", fontSize: 12 }}
                />
                <Tooltip contentStyle={{ background: "#111318", border: "1px solid #272a33", borderRadius: 8 }} />
                <Bar dataKey="avg" fill="#47d18c" radius={[0, 4, 4, 0]} name="Средний пинг, мс" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty label="Замеров пока нет" />
          )}
        </div>
      </div>

      <div className="panel chart-panel wide">
        <div className="panel-head">
          <h2>История задержки</h2>
          <span className="chip">{dashboard.latencySeries.length}</span>
        </div>
        <div className="chart-wrap latency-history">
          {dashboard.latencyTimeline.length && dashboard.latencySeries.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dashboard.latencyTimeline}>
                <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: "#8a8f98", fontSize: 12 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#8a8f98", fontSize: 12 }} />
                <Tooltip contentStyle={{ background: "#111318", border: "1px solid #272a33", borderRadius: 8 }} />
                <Legend wrapperStyle={{ color: "#c6cad2", fontSize: 12 }} />
                {dashboard.latencySeries.map((series) => (
                  <Line
                    key={series.key}
                    type="monotone"
                    dataKey={series.key}
                    name={series.name}
                    stroke={series.color}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <Empty label="История замеров пока пуста" />
          )}
        </div>
      </div>

      <div className="panel wide">
        <div className="panel-head">
          <h2>Последние замеры</h2>
          <span className="chip">{dashboard.latencyRecent.total}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Пользователь</th>
                <th>Сервис</th>
                <th>Статус</th>
                <th>Задержка</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.latencyRecent.rows.map((check) => (
                <tr key={check.id}>
                  <td>{dateTime(check.checkedAt)}</td>
                  <td>{userById(check.userId ?? "")?.name ?? "Не выбран"}</td>
                  <td>{serviceById(check.serviceId)?.name ?? "Сервис"}</td>
                  <td>{healthLabels[check.status]}</td>
                  <td>{check.latencyMs === null ? "нет данных" : `${check.latencyMs} мс`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!dashboard.latencyRecent.rows.length && <Empty label="Замеров пока нет" />}
        </div>
        <PaginationControls page={dashboard.latencyRecent} onChange={onLatencyPageChange} />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Уведомления</h2>
          <span className="chip">{dashboard.notifications.total}</span>
        </div>
        <div className="feed">
          {dashboard.notifications.rows.map((notification) => (
            <article key={notification.id} className="feed-item">
              <span className={classNames("feed-status", notification.status)} />
              <div>
                <strong>{serviceById(notification.serviceId)?.name ?? "Система"}</strong>
                <p>{notification.message.replace(/<[^>]*>/g, "")}</p>
                <small>
                  {userById(notification.userId ?? "")?.name ?? "Все"} · {dateTime(notification.createdAt)}
                </small>
              </div>
            </article>
          ))}
          {!dashboard.notifications.rows.length && <Empty label="Нет уведомлений" />}
        </div>
        <PaginationControls page={dashboard.notifications} onChange={onNotificationPageChange} />
      </div>
    </section>
  );
}

function WallView({
  state,
  currentUser,
  isAdmin,
  selectedPostId,
  refreshKey,
  onShowList,
  setToast,
  userById,
  serviceById
}: {
  state: AppState;
  currentUser: User;
  isAdmin: boolean;
  selectedPostId: string;
  refreshKey: number;
  onShowList: () => void;
  setToast: (value: string) => void;
  userById: (id: string) => User | undefined;
  serviceById: (id: string) => Service | undefined;
}) {
  const [wallData, setWallData] = useState<WallListData>(emptyWallData);
  const [search, setSearch] = useState("");
  const [tagId, setTagId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [archive, setArchive] = useState(false);
  const [offset, setOffset] = useState(0);
  const [editingPost, setEditingPost] = useState<WallPost | null>(null);
  const [creating, setCreating] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [selectedPost, setSelectedPost] = useState<WallPost | null>(null);
  const [comments, setComments] = useState<WallComment[]>([]);

  const loadWall = async (nextOffset = offset) => {
    const query = new URLSearchParams({
      offset: String(nextOffset),
      limit: String(wallPageLimit),
      archive: String(archive)
    });
    if (search.trim()) query.set("search", search.trim());
    if (tagId) query.set("tagId", tagId);
    if (serviceId) query.set("serviceId", serviceId);

    const next = await api<WallListData>(`/api/wall?${query.toString()}`);
    setWallData(next);
    setOffset(nextOffset);
    return next;
  };

  useEffect(() => {
    loadWall(0).catch((error) => setToast(error.message));
  }, [search, tagId, serviceId, archive, refreshKey]);

  useEffect(() => {
    if (!selectedPostId) {
      setSelectedPost(null);
      setComments([]);
      return;
    }

    api<WallPost>(`/api/wall/posts/${selectedPostId}`)
      .then((post) => {
        setSelectedPost(post);
        return Promise.all([
          Promise.resolve(post),
          api<WallComment[]>(`/api/wall/posts/${selectedPostId}/comments`),
          api<WallPost>(`/api/wall/posts/${selectedPostId}/view`, {
            method: "POST",
            body: JSON.stringify({})
          })
        ]);
      })
      .then(([initialPost, nextComments, viewedPost]) => {
        setComments(nextComments);
        const post = viewedPost ?? initialPost;
        setSelectedPost(post);
        setWallData((current) => ({
          ...current,
          posts: {
            ...current.posts,
            rows: current.posts.rows.map((item) => (item.id === post.id ? post : item))
          }
        }));
      })
      .catch((error) => setToast(error.message));
  }, [selectedPostId]);

  useEffect(() => {
    const token = window.localStorage.getItem(authTokenStorageKey);
    if (!token) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/api/realtime?token=${encodeURIComponent(token)}`);

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data) as { type?: string; postId?: string; comments?: WallComment[] };
        if (
          (message.type === "wall-comment-created" || message.type === "wall-comments-changed") &&
          message.postId === selectedPostId &&
          Array.isArray(message.comments)
        ) {
          setComments(message.comments);
        }
      } catch {
        // Ignore malformed realtime events.
      }
    });

    return () => socket.close();
  }, [selectedPostId]);

  const loadComments = async (postId = selectedPostId) => {
    if (!postId) return [];
    const next = await api<WallComment[]>(`/api/wall/posts/${postId}/comments`);
    setComments(next);
    return next;
  };

  const saveComment = async (postId: string, content: string, fileIds: string[], parentId: string | null) => {
    const next = await api<WallComment[]>(`/api/wall/posts/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ authorId: currentUser.id, content, fileIds, parentId })
    });
    setComments(next);
    return next;
  };

  const updateComment = async (postId: string, commentId: string, content: string, fileIds: string[]) => {
    const next = await api<WallComment[]>(`/api/wall/posts/${postId}/comments/${commentId}`, {
      method: "PUT",
      body: JSON.stringify({ authorId: currentUser.id, content, fileIds })
    });
    setComments(next);
    return next;
  };

  const deleteComment = async (postId: string, comment: WallComment) => {
    if (!window.confirm("Удалить комментарий? Ответы к нему тоже будут удалены.")) return comments;
    const next = await api<WallComment[]>(`/api/wall/posts/${postId}/comments/${comment.id}?userId=${encodeURIComponent(currentUser.id)}`, {
      method: "DELETE"
    });
    setComments(next);
    setToast("Комментарий удалён");
    return next;
  };

  const savePost = async (draft: WallPostDraft) => {
    const body = { ...draft, serviceId: draft.serviceId || null, authorId: currentUser.id };
    const path = draft.id ? `/api/wall/posts/${draft.id}` : "/api/wall/posts";
    const method = draft.id ? "PUT" : "POST";
    const next = await api<WallListData>(path, { method, body: JSON.stringify(body) });
    setWallData(next);
    setCreating(false);
    setEditingPost(null);
    setToast("Пост сохранён");
  };

  const deletePost = async (post: WallPost) => {
    if (!window.confirm(`Удалить пост "${post.title}"?`)) return;
    const next = await api<WallListData>(`/api/wall/posts/${post.id}?userId=${encodeURIComponent(currentUser.id)}`, {
      method: "DELETE"
    });
    setWallData(next);
    if (selectedPost?.id === post.id) setWallHash();
    setToast("Пост удалён");
  };

  const createTag = async (tag: Pick<WallTag, "name" | "color" | "pinned" | "archived">) => {
    const next = await api<WallListData>("/api/wall/tags", {
      method: "POST",
      body: JSON.stringify(tag)
    });
    setWallData(next);
  };

  const updateTag = async (tag: WallTag) => {
    const next = await api<WallListData>(`/api/wall/tags/${tag.id}`, {
      method: "PUT",
      body: JSON.stringify(tag)
    });
    setWallData(next);
  };

  const deleteTag = async (targetTagId: string) => {
    const next = await api<WallListData>(`/api/wall/tags/${targetTagId}`, { method: "DELETE" });
    setWallData(next);
    if (tagId === targetTagId) setTagId("");
  };

  const uploadWallFile = async (file: File) => {
    const response = await fetch("/api/wall/files", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        ...(window.localStorage.getItem(authTokenStorageKey) ? { "x-auth-token": window.localStorage.getItem(authTokenStorageKey)! } : {}),
        "x-author-id": currentUser.id,
        "x-file-name": encodeURIComponent(file.name)
      },
      body: file
    });
    const result = (await response.json()) as ApiResult;
    if (!result.ok) throw new Error(result.error ?? "Не удалось загрузить файл");
    const uploaded = result.payload as WallFile;
    setWallData((current) => ({ ...current, files: [uploaded, ...current.files] }));
    return uploaded;
  };

  const deleteWallFile = async (file: WallFile) => {
    if (!window.confirm(`Удалить файл "${file.originalName}"?`)) return;
    const next = await api<WallListData>(`/api/wall/files/${file.id}?userId=${encodeURIComponent(currentUser.id)}`, {
      method: "DELETE"
    });
    setWallData(next);
    setToast("Файл удалён");
  };

  const cleanupWallFiles = async (fileIds: string[] = []) => {
    if (!fileIds.length) return;
    const next = await api<WallListData>(`/api/wall/files/cleanup?userId=${encodeURIComponent(currentUser.id)}`, {
      method: "POST",
      body: JSON.stringify({ userId: currentUser.id, fileIds })
    });
    setWallData(next);
  };

  const closeWallPostModal = (draft?: WallPostDraft) => {
    setCreating(false);
    setEditingPost(null);
    const draftFileIds = Array.from(new Set([...(draft?.fileIds ?? []), draft?.previewFileId ?? ""].filter(Boolean)));
    cleanupWallFiles(draftFileIds).catch((error) => setToast(error.message));
  };

  return (
    <section className={classNames("wall-layout", selectedPost && "post-open")}>
      {selectedPost ? (
        <WallPostDetail
          post={selectedPost}
          comments={comments}
          tags={wallData.tags}
          files={wallData.files}
          currentUser={currentUser}
          serviceById={serviceById}
          userById={userById}
          canManage={isAdmin || selectedPost.authorId === currentUser.id}
          onBack={onShowList}
          onEdit={(post) => setEditingPost(post)}
          onDelete={(post) => deletePost(post).catch((error) => setToast(error.message))}
          onUpload={uploadWallFile}
          onDeleteFile={deleteWallFile}
          onSaveComment={saveComment}
          onUpdateComment={updateComment}
          onDeleteComment={deleteComment}
          onReloadComments={() => loadComments(selectedPost.id)}
          setToast={setToast}
        />
      ) : (
      <div className="panel wall-list-panel">
        <div className="panel-head wall-toolbar">
          <div className="wall-head-actions">
            <button className="ghost" type="button" onClick={() => setTagsOpen(true)}>
              <Tag size={16} />
              Теги
            </button>
            <button className="primary" type="button" onClick={() => setCreating(true)}>
              <Plus size={16} />
              Пост
            </button>
          </div>
        </div>

        <div className="wall-filters">
          <input placeholder="Поиск по стене" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select value={tagId} onChange={(event) => setTagId(event.target.value)}>
            <option value="">Все теги</option>
            {wallData.tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
            <option value="">Все сервисы</option>
            {state.services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
          <button className={classNames("ghost", archive && "active-filter")} type="button" onClick={() => setArchive((value) => !value)}>
            <Archive size={16} />
            Архив
          </button>
        </div>

        <div className="wall-rows">
          {wallData.posts.rows.map((post) => (
            <WallPostRow
              key={post.id}
              post={post}
              tags={wallData.tags}
              files={wallData.files}
              service={post.serviceId ? serviceById(post.serviceId) : undefined}
              author={userById(post.authorId)}
              selected={selectedPostId === post.id}
              canManage={isAdmin || post.authorId === currentUser.id}
              onOpen={() => setWallHash(post.id)}
              onEdit={() => setEditingPost(post)}
              onDelete={() => deletePost(post).catch((error) => setToast(error.message))}
            />
          ))}
          {!wallData.posts.rows.length && <Empty label="Постов пока нет" />}
        </div>

        <PaginationControls page={wallData.posts} onChange={(nextOffset) => loadWall(nextOffset).catch((error) => setToast(error.message))} />
      </div>
      )}

      {(creating || editingPost) && (
        <WallPostModal
          state={state}
          currentUser={currentUser}
          post={editingPost}
          tags={wallData.tags}
          files={wallData.files}
          onUpload={uploadWallFile}
          onDeleteFile={deleteWallFile}
          onClose={closeWallPostModal}
          onSave={savePost}
          setToast={setToast}
        />
      )}

      {tagsOpen && (
        <WallTagsModal
          tags={wallData.tags}
          onCreate={(tag) => createTag(tag).catch((error) => setToast(error.message))}
          onUpdate={(tag) => updateTag(tag).catch((error) => setToast(error.message))}
          onDelete={(targetTagId) => deleteTag(targetTagId).catch((error) => setToast(error.message))}
          onClose={() => setTagsOpen(false)}
        />
      )}
    </section>
  );
}

function isWallPostPinned(post: WallPost, tags: WallTag[]) {
  return tags.some((tag) => post.tagIds.includes(tag.id) && tag.pinned);
}

function isWallPostArchived(post: WallPost, tags: WallTag[]) {
  return tags.some((tag) => post.tagIds.includes(tag.id) && tag.archived);
}

function wallPostPreviewFile(post: WallPost, files: WallFile[]) {
  return (post.previewFileId ? files.find((file) => file.id === post.previewFileId) : undefined) ??
    files.find((file) => post.fileIds.includes(file.id) && file.mimeType.startsWith("image/"));
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the textarea fallback for embedded browsers.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function WallPostRow({
  post,
  tags,
  files,
  service,
  author,
  selected,
  canManage,
  onOpen,
  onEdit,
  onDelete
}: {
  post: WallPost;
  tags: WallTag[];
  files: WallFile[];
  service?: Service;
  author?: User;
  selected: boolean;
  canManage: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const postTags = tags.filter((tag) => post.tagIds.includes(tag.id));
  const previewImage = wallPostPreviewFile(post, files);
  const pinned = isWallPostPinned(post, tags);
  const archived = isWallPostArchived(post, tags);
  const excerpt = post.content.replace(/\s+/g, " ").trim().slice(0, 160);

  return (
    <article className={classNames("wall-row", pinned && "pinned", selected && "selected")} onClick={onOpen}>
      <div className="wall-preview">
        {previewImage ? <img src={previewImage.url} alt="" /> : <FileText size={22} />}
      </div>
      <div className="wall-row-main">
        <div className="wall-row-title">
          {pinned && <Pin size={14} />}
          <strong>{post.title}</strong>
          {archived && <span className="status-pill cancelled">Архив</span>}
        </div>
        <p>{excerpt || "Без описания"}</p>
        <div className="wall-meta">
          <span>{author?.name ?? "Автор"}</span>
          <span>{dateTime(post.updatedAt)}</span>
          <span>
            <Eye size={13} />
            {post.views}
          </span>
          {service && <span>{service.name}</span>}
        </div>
      </div>
      <div className="wall-tag-strip">
        {postTags.slice(0, 4).map((tag) => (
          <span key={tag.id} className="wall-tag" style={{ "--tag-color": tag.color } as CSSProperties}>
            {tag.name}
          </span>
        ))}
      </div>
      {canManage && (
        <div className="wall-row-actions" onClick={(event) => event.stopPropagation()}>
          <button className="icon-button" type="button" title="Редактировать" onClick={onEdit}>
            <Pencil size={15} />
          </button>
          <button className="icon-button danger" type="button" title="Удалить" onClick={onDelete}>
            <Trash2 size={15} />
          </button>
        </div>
      )}
    </article>
  );
}

function WallPostDetail({
  post,
  comments,
  tags,
  files,
  currentUser,
  serviceById,
  userById,
  canManage,
  onBack,
  onEdit,
  onDelete,
  onUpload,
  onDeleteFile,
  onSaveComment,
  onUpdateComment,
  onDeleteComment,
  onReloadComments,
  setToast
}: {
  post: WallPost;
  comments: WallComment[];
  tags: WallTag[];
  files: WallFile[];
  currentUser: User;
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
  canManage: boolean;
  onBack: () => void;
  onEdit: (post: WallPost) => void;
  onDelete: (post: WallPost) => void;
  onUpload: (file: File) => Promise<WallFile>;
  onDeleteFile: (file: WallFile) => Promise<void>;
  onSaveComment: (postId: string, content: string, fileIds: string[], parentId: string | null) => Promise<WallComment[]>;
  onUpdateComment: (postId: string, commentId: string, content: string, fileIds: string[]) => Promise<WallComment[]>;
  onDeleteComment: (postId: string, comment: WallComment) => Promise<WallComment[]>;
  onReloadComments: () => Promise<WallComment[]>;
  setToast: (value: string) => void;
}) {
  const postTags = tags.filter((tag) => post.tagIds.includes(tag.id));
  const attachments = files.filter((file) => post.fileIds.includes(file.id));
  const service = post.serviceId ? serviceById(post.serviceId) : undefined;
  const author = userById(post.authorId);
  const displayAuthor = author ?? { name: "Автор", avatarUrl: "" };
  const pinned = isWallPostPinned(post, tags);
  const archived = isWallPostArchived(post, tags);

  return (
    <article className="panel wall-detail-panel">
      <div className="wall-detail-head">
        <button className="ghost compact" type="button" onClick={onBack}>
          <ArrowLeft size={15} />
          Назад
        </button>
        <div className="wall-detail-title">
          <div className="wall-detail-title-line">
            <div className="wall-row-title">
              {pinned && <Pin size={15} />}
              <h2>{post.title}</h2>
              {archived && <span className="status-pill cancelled">Архив</span>}
            </div>
            <div className="wall-detail-author">
              <UserAvatar user={displayAuthor} />
              <span>{displayAuthor.name}</span>
            </div>
          </div>
          <div className="wall-meta">
            <span>{service?.name ?? "Общий пост"}</span>
            <span>{dateTime(post.updatedAt)}</span>
            <span>
              <Eye size={13} />
              {post.views}
            </span>
          </div>
        </div>
        {canManage && (
          <div className="wall-post-actions inline-actions">
            <button className="ghost" type="button" onClick={() => onEdit(post)}>
              <Pencil size={16} />
              Править
            </button>
            <button className="ghost danger" type="button" onClick={() => onDelete(post)}>
              <Trash2 size={16} />
              Удалить
            </button>
          </div>
        )}
      </div>

      <div className="wall-tag-strip full">
        {postTags.map((tag) => (
          <span key={tag.id} className="wall-tag" style={{ "--tag-color": tag.color } as CSSProperties}>
            {tag.name}
          </span>
        ))}
      </div>

      <div className="wall-content detail-content">{renderWallContent(post.content, files)}</div>

      {attachments.length > 0 && (
        <div className="wall-attachments">
          <strong>Файлы</strong>
          {attachments.map((file) => (
            <WallAttachment key={file.id} file={file} />
          ))}
        </div>
      )}

      <section className="comments-panel">
        <div className="comments-head">
          <h2>Комментарии</h2>
          <button className="ghost compact" type="button" onClick={() => onReloadComments().catch((error) => setToast(error.message))}>
            <RefreshCcw size={14} />
            Обновить
          </button>
        </div>
        <CommentComposer
          currentUser={currentUser}
          files={files}
          onUpload={onUpload}
          onDeleteFile={onDeleteFile}
          onSave={(content, fileIds) => onSaveComment(post.id, content, fileIds, null)}
          setToast={setToast}
        />
        <CommentTree
          comments={comments}
          files={files}
          currentUser={currentUser}
          userById={userById}
          postId={post.id}
          onUpload={onUpload}
          onDeleteFile={onDeleteFile}
          onSaveComment={onSaveComment}
          onUpdateComment={onUpdateComment}
          onDeleteComment={onDeleteComment}
          setToast={setToast}
        />
      </section>
    </article>
  );
}

function WallAttachment({ file }: { file: WallFile }) {
  const isImage = file.mimeType.startsWith("image/");
  if (isImage) {
    return (
      <a className="wall-image-attachment" href={file.url} target="_blank" rel="noreferrer" title={file.originalName}>
        <img src={file.url} alt={file.originalName} />
      </a>
    );
  }

  return (
    <a className="wall-file-link" href={file.url} download>
      <Paperclip size={15} />
      <span>{file.originalName}</span>
      <small>{fileSize(file.size)}</small>
    </a>
  );
}

function CommentTree({
  comments,
  files,
  currentUser,
  userById,
  postId,
  onUpload,
  onDeleteFile,
  onSaveComment,
  onUpdateComment,
  onDeleteComment,
  setToast
}: {
  comments: WallComment[];
  files: WallFile[];
  currentUser: User;
  userById: (id: string) => User | undefined;
  postId: string;
  onUpload: (file: File) => Promise<WallFile>;
  onDeleteFile: (file: WallFile) => Promise<void>;
  onSaveComment: (postId: string, content: string, fileIds: string[], parentId: string | null) => Promise<WallComment[]>;
  onUpdateComment: (postId: string, commentId: string, content: string, fileIds: string[]) => Promise<WallComment[]>;
  onDeleteComment: (postId: string, comment: WallComment) => Promise<WallComment[]>;
  setToast: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const byParent = useMemo(() => {
    const map = new Map<string, WallComment[]>();
    for (const comment of comments) {
      const key = comment.parentId ?? "root";
      map.set(key, [...(map.get(key) ?? []), comment]);
    }
    return map;
  }, [comments]);

  const renderBranch = (parentId: string | null, depth = 0): ReactNode => {
    const children = byParent.get(parentId ?? "root") ?? [];
    const visible = expanded.has(parentId ?? "root") || children.length <= 3 ? children : children.slice(0, 3);
    return (
      <div className={classNames("comment-branch", depth > 0 && "nested")}>
        {visible.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            files={files}
            currentUser={currentUser}
            author={userById(comment.authorId)}
            onUpload={onUpload}
            onDeleteFile={onDeleteFile}
            onReply={(content, fileIds) => onSaveComment(postId, content, fileIds, comment.id)}
            onEdit={(content, fileIds) => onUpdateComment(postId, comment.id, content, fileIds)}
            onDelete={() => onDeleteComment(postId, comment)}
            setToast={setToast}
          >
            {renderBranch(comment.id, depth + 1)}
          </CommentItem>
        ))}
        {children.length > 3 && !expanded.has(parentId ?? "root") && (
          <button className="ghost compact show-more-replies" type="button" onClick={() => setExpanded((current) => new Set(current).add(parentId ?? "root"))}>
            Показать ещё {children.length - 3}
          </button>
        )}
      </div>
    );
  };

  return <div className="comments-list">{comments.length ? renderBranch(null) : <Empty label="Комментариев пока нет" />}</div>;
}

function CommentItem({
  comment,
  files,
  currentUser,
  author,
  onUpload,
  onDeleteFile,
  onReply,
  onEdit,
  onDelete,
  setToast,
  children
}: {
  comment: WallComment;
  files: WallFile[];
  currentUser: User;
  author?: User;
  onUpload: (file: File) => Promise<WallFile>;
  onDeleteFile: (file: WallFile) => Promise<void>;
  onReply: (content: string, fileIds: string[]) => Promise<WallComment[]>;
  onEdit: (content: string, fileIds: string[]) => Promise<WallComment[]>;
  onDelete: () => Promise<WallComment[]>;
  setToast: (value: string) => void;
  children: ReactNode;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const attached = files.filter((file) => comment.fileIds.includes(file.id));
  const displayAuthor = author ?? { name: "Участник", avatarUrl: "" };
  const canManage = currentUser.botAdmin || comment.authorId === currentUser.id;
  const edited = comment.updatedAt !== comment.createdAt;

  return (
    <div className="comment-item">
      <div className="comment-card">
        <UserAvatar user={displayAuthor} />
        <div className="comment-body">
          <div className="comment-meta">
            <strong>{displayAuthor.name}</strong>
            <span>{dateTime(comment.createdAt)}</span>
            {edited && <span>Изменено</span>}
            {canManage && !editing && (
              <span className="comment-meta-actions">
                <button className="comment-reply-button" type="button" onClick={() => {
                  setReplying(false);
                  setEditing(true);
                }}>
                  Править
                </button>
                <button className="comment-reply-button danger" type="button" onClick={() => onDelete().catch((error) => setToast(error.message))}>
                  Удалить
                </button>
              </span>
            )}
          </div>
          {editing ? (
            <CommentComposer
              compact
              currentUser={currentUser}
              files={files}
              onUpload={onUpload}
              onDeleteFile={onDeleteFile}
              initialContent={comment.content}
              initialFileIds={comment.fileIds}
              submitLabel="Сохранить"
              onCancel={() => setEditing(false)}
              onSave={(content, fileIds) => onEdit(content, fileIds).then((result) => {
                setEditing(false);
                return result;
              })}
              setToast={setToast}
            />
          ) : (
            <>
              {comment.content && <p>{comment.content}</p>}
              {attached.length > 0 && (
                <div className="comment-attachments">
                  {attached.map((file) => (
                    <WallAttachment key={file.id} file={file} />
                  ))}
                </div>
              )}
              <button className="comment-reply-button" type="button" onClick={() => setReplying((value) => !value)}>
                Ответить
              </button>
              {replying && (
                <CommentComposer
                  compact
                  currentUser={currentUser}
                  files={files}
                  onUpload={onUpload}
                  onDeleteFile={onDeleteFile}
                  onSave={(content, fileIds) => onReply(content, fileIds).then((result) => {
                    setReplying(false);
                    return result;
                  })}
                  setToast={setToast}
                />
              )}
            </>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function CommentComposer({
  currentUser,
  files,
  compact = false,
  initialContent = "",
  initialFileIds = [],
  submitLabel = "Отправить",
  onUpload,
  onDeleteFile,
  onSave,
  onCancel,
  setToast
}: {
  currentUser: User;
  files: WallFile[];
  compact?: boolean;
  initialContent?: string;
  initialFileIds?: string[];
  submitLabel?: string;
  onUpload: (file: File) => Promise<WallFile>;
  onDeleteFile: (file: WallFile) => Promise<void>;
  onSave: (content: string, fileIds: string[]) => Promise<unknown>;
  onCancel?: () => void;
  setToast: (value: string) => void;
}) {
  const [content, setContent] = useState(initialContent);
  const [fileIds, setFileIds] = useState<string[]>(initialFileIds);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const attached = files.filter((file) => fileIds.includes(file.id));

  const upload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    try {
      setUploading(true);
      const uploadedIds: string[] = [];
      for (const file of Array.from(fileList)) {
        const uploaded = await onUpload(file);
        uploadedIds.push(uploaded.id);
      }
      setFileIds((current) => Array.from(new Set([...current, ...uploadedIds])));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Ошибка загрузки файла");
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!content.trim() && !fileIds.length) return;
    try {
      setSaving(true);
      await onSave(content, fileIds);
      setContent("");
      setFileIds([]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Не удалось отправить комментарий");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={classNames("comment-composer", compact && "compact")}>
      <UserAvatar user={currentUser} />
      <div>
        <textarea
          rows={compact ? 2 : 3}
          placeholder={compact ? "Ответ" : "Комментарий"}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void upload(event.dataTransfer.files);
          }}
        />
        {attached.length > 0 && (
          <div className="comment-attachments editor">
            {attached.map((file) => (
              <span key={file.id} className="wall-file-chip attached">
                <span>{file.originalName}</span>
                <button className="ghost compact" type="button" onClick={() => setFileIds((current) => current.filter((id) => id !== file.id))}>
                  Убрать
                </button>
                <button className="ghost compact danger" type="button" onClick={() => onDeleteFile(file).catch((error) => setToast(error.message))}>
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="comment-actions">
          <label className="file-action">
            <Upload size={14} />
            {uploading ? "Загрузка..." : "Файл"}
            <input multiple type="file" disabled={uploading} onChange={(event) => upload(event.target.files)} />
          </label>
          <button className="primary" type="button" disabled={saving || (!content.trim() && !fileIds.length)} onClick={() => void submit()}>
            <Send size={15} />
            {submitLabel}
          </button>
          {onCancel && (
            <button className="ghost" type="button" disabled={saving} onClick={onCancel}>
              Отмена
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WallPostPanel({
  post,
  tags,
  files,
  serviceById,
  userById,
  canManage,
  onEdit,
  onDelete,
  setToast
}: {
  post: WallPost | null;
  tags: WallTag[];
  files: WallFile[];
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
  canManage: boolean;
  onEdit: (post: WallPost) => void;
  onDelete: (post: WallPost) => void;
  setToast: (value: string) => void;
}) {
  if (!post) {
    return (
      <aside className="panel wall-post-panel empty-post">
        <BookOpen size={28} />
        <strong>Выберите пост</strong>
        <span>Откройте гайд из списка или создайте новый.</span>
      </aside>
    );
  }

  const postTags = tags.filter((tag) => post.tagIds.includes(tag.id));
  const attachments = files.filter((file) => post.fileIds.includes(file.id));
  const service = post.serviceId ? serviceById(post.serviceId) : undefined;
  const author = userById(post.authorId);
  const pinned = isWallPostPinned(post, tags);
  const archived = isWallPostArchived(post, tags);

  return (
    <aside className="panel wall-post-panel">
      <div className="wall-post-head">
        <div>
          <div className="wall-row-title">
            {pinned && <Pin size={15} />}
            <h2>{post.title}</h2>
          </div>
          <div className="wall-meta">
            <span>{author?.name ?? "Автор"}</span>
            <span>{service?.name ?? "Общий пост"}</span>
            <span>{dateTime(post.updatedAt)}</span>
            <span>
              <Eye size={13} />
              {post.views}
            </span>
          </div>
        </div>
        <button
          className="ghost compact"
          type="button"
          onClick={async () => {
            const url = `${window.location.origin}${window.location.pathname}#/wall/${post.id}`;
            const copied = await copyText(url);
            if (!copied) window.prompt("Ссылка на пост", url);
            setToast(copied ? "Ссылка скопирована" : "Ссылка готова для копирования");
          }}
        >
          <Link size={14} />
          Ссылка
        </button>
      </div>

      <div className="wall-tag-strip full">
        {archived && <span className="status-pill cancelled">Архив</span>}
        {postTags.map((tag) => (
          <span key={tag.id} className="wall-tag" style={{ "--tag-color": tag.color } as CSSProperties}>
            {tag.name}
          </span>
        ))}
      </div>

      <div className="wall-content">{renderWallContent(post.content, files)}</div>

      {attachments.length > 0 && (
        <div className="wall-attachments">
          <strong>Файлы для установки</strong>
          {attachments.map((file) => (
            <a key={file.id} className="wall-file-link" href={file.url} download>
              <Paperclip size={15} />
              <span>{file.originalName}</span>
              <small>{fileSize(file.size)}</small>
            </a>
          ))}
        </div>
      )}

      {canManage && (
        <div className="wall-post-actions">
          <button className="ghost" type="button" onClick={() => onEdit(post)}>
            <Pencil size={16} />
            Править
          </button>
          <button className="ghost danger" type="button" onClick={() => onDelete(post)}>
            <Trash2 size={16} />
            Удалить
          </button>
        </div>
      )}
    </aside>
  );
}

function renderWallContent(content: string, files: WallFile[]) {
  const fileByUrl = new Map(files.map((file) => [file.url, file]));
  const tokenPattern = /!\[([^\]|]+)(?:\|(\d{2,4}))?\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)/g;

  return (content || "Пост пока пуст").split("\n").map((line, lineIndex) => {
    const parts: ReactNode[] = [];
    let cursor = 0;
    for (const match of line.matchAll(tokenPattern)) {
      if (match.index === undefined) continue;
      if (match.index > cursor) parts.push(line.slice(cursor, match.index));

      if (match[3]) {
        const width = Math.min(1200, Math.max(120, Number(match[2] ?? 720)));
        parts.push(<img key={`${lineIndex}-${match.index}`} className="wall-inline-image" src={match[3]} alt={match[1]} style={{ width }} />);
      } else {
        const file = fileByUrl.get(match[5]);
        parts.push(
          <a key={`${lineIndex}-${match.index}`} href={match[5]} download={Boolean(file)}>
            {match[4]}
          </a>
        );
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < line.length) parts.push(line.slice(cursor));
    return <p key={lineIndex}>{parts.length ? parts : "\u00A0"}</p>;
  });
}

function WallPostModal({
  state,
  currentUser,
  post,
  tags,
  files,
  onUpload,
  onDeleteFile,
  onClose,
  onSave,
  setToast
}: {
  state: AppState;
  currentUser: User;
  post: WallPost | null;
  tags: WallTag[];
  files: WallFile[];
  onUpload: (file: File) => Promise<WallFile>;
  onDeleteFile: (file: WallFile) => Promise<void>;
  onClose: (draft?: WallPostDraft) => void;
  onSave: (draft: WallPostDraft) => Promise<void>;
  setToast: (value: string) => void;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<WallPostDraft>(
    post
      ? {
          id: post.id,
          title: post.title,
          previewFileId: post.previewFileId,
          content: post.content,
          serviceId: post.serviceId ?? "",
          tagIds: post.tagIds,
          fileIds: post.fileIds
        }
      : blankWallPostDraft
  );
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [imageWidth, setImageWidth] = useState(720);
  const [brokenPreviewIds, setBrokenPreviewIds] = useState<Set<string>>(() => new Set());

  const attachedFiles = files.filter((file) => draft.fileIds.includes(file.id));
  const previewFile = draft.previewFileId ? files.find((file) => file.id === draft.previewFileId) : undefined;
  const previewVisible = Boolean(previewFile && !brokenPreviewIds.has(previewFile.id));

  const insertText = (value: string, fileId?: string) => {
    const textarea = textRef.current;
    const start = textarea?.selectionStart ?? draft.content.length;
    const end = textarea?.selectionEnd ?? draft.content.length;
    const nextContent = `${draft.content.slice(0, start)}${value}${draft.content.slice(end)}`;
    setDraft((current) => ({
      ...current,
      content: nextContent,
      fileIds: fileId && !current.fileIds.includes(fileId) ? [...current.fileIds, fileId] : current.fileIds
    }));
    window.setTimeout(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + value.length, start + value.length);
    });
  };

  const insertFileLink = (file: WallFile) => insertText(`[${file.originalName}](${file.url})`, file.id);
  const insertImage = (file: WallFile) => insertText(`![${file.originalName}|${imageWidth}](${file.url})`, file.id);
  const removeFileFromDraft = (fileId: string) =>
    setDraft((current) => ({
      ...current,
      previewFileId: current.previewFileId === fileId ? null : current.previewFileId,
      fileIds: current.fileIds.filter((item) => item !== fileId)
    }));

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    try {
      setUploading(true);
      for (const file of Array.from(fileList)) {
        const uploaded = await onUpload(file);
        setDraft((current) => ({
          ...current,
          fileIds: current.fileIds.includes(uploaded.id) ? current.fileIds : [...current.fileIds, uploaded.id]
        }));
      }
      setToast("Файлы загружены");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Ошибка загрузки файла");
    } finally {
      setUploading(false);
    }
  };

  const uploadPreview = async (fileList: FileList | null) => {
    const file = Array.from(fileList ?? []).find((item) => item.type.startsWith("image/"));
    if (!file) {
      setToast("Выберите изображение для превью");
      return;
    }

    try {
      setUploading(true);
      const uploaded = await onUpload(file);
      setDraft((current) => ({ ...current, previewFileId: uploaded.id }));
      setToast("Превью загружено");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Ошибка загрузки превью");
    } finally {
      setUploading(false);
    }
  };

  const handleContentDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);

    if (event.dataTransfer.files.length) {
      void uploadFiles(event.dataTransfer.files);
      return;
    }

    const draggedFileId = event.dataTransfer.getData("text/plain").replace("wall-file:", "");
    const file = files.find((item) => item.id === draggedFileId);
    if (file) insertFileLink(file);
  };

  const deleteFile = async (file: WallFile) => {
    await onDeleteFile(file);
    removeFileFromDraft(file.id);
  };

  return (
    <ModalShell
      title={post ? "Редактирование поста" : "Новый пост"}
      subtitle={`Автор: ${currentUser.name}`}
      wide
      onClose={() => onClose(draft)}
      footer={
        <>
          <button className="ghost" type="button" onClick={() => onClose(draft)}>
            Отмена
          </button>
          <button className="primary" type="button" disabled={!draft.title.trim()} onClick={() => onSave(draft)}>
            <Check size={16} />
            Сохранить
          </button>
        </>
      }
    >
      <div className="wall-editor">
        <div className="form-grid modal-form">
          <label>
            Название
            <input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          <label>
            Сервис
            <select value={draft.serviceId} onChange={(event) => setDraft({ ...draft, serviceId: event.target.value })}>
              <option value="">Общий пост</option>
              {state.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>
          <div className="wall-preview-picker wide-field">
            Превью
            <label
              className={classNames("wall-preview-drop", previewVisible && "has-image")}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void uploadPreview(event.dataTransfer.files);
              }}
            >
              {previewFile && previewVisible ? (
                <img
                  src={`${previewFile.url}?v=${encodeURIComponent(previewFile.createdAt)}`}
                  alt=""
                  onError={() => setBrokenPreviewIds((current) => new Set(current).add(previewFile.id))}
                />
              ) : (
                <span>
                  <Image size={18} />
                  {previewFile ? "Файл недоступен" : "Обложка поста"}
                </span>
              )}
              <input accept="image/*" type="file" disabled={uploading} onChange={(event) => uploadPreview(event.target.files)} />
            </label>
            {previewFile && (
              <button className="ghost compact" type="button" onClick={() => setDraft((current) => ({ ...current, previewFileId: null }))}>
                Убрать превью
              </button>
            )}
          </div>
        </div>

        <div className="wall-editor-tags">
          {tags.map((tag) => (
            <button
              key={tag.id}
              className={classNames("wall-tag selectable", draft.tagIds.includes(tag.id) && "selected")}
              style={{ "--tag-color": tag.color } as CSSProperties}
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  tagIds: current.tagIds.includes(tag.id)
                    ? current.tagIds.filter((item) => item !== tag.id)
                    : [...current.tagIds, tag.id]
                }))
              }
            >
              {tag.name}
            </button>
          ))}
          {!tags.length && <span className="muted">Теги пока не созданы</span>}
        </div>

        <div className="wall-editor-grid">
          <label className="wall-content-field">
            Текст поста
            <div
              className={classNames("wall-drop-zone", dragActive && "dragging")}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
              }}
              onDrop={handleContentDrop}
            >
              <textarea
                ref={textRef}
                rows={14}
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
              <span className="wall-drop-hint">
                <Upload size={14} />
                Перетащите файл в текст
              </span>
            </div>
          </label>

          <aside className="wall-file-box">
            <div className="wall-file-tools">
              <label className="file-action">
                <Upload size={15} />
                {uploading ? "Загрузка..." : "Загрузить"}
                <input multiple type="file" disabled={uploading} onChange={(event) => uploadFiles(event.target.files)} />
              </label>
              <label>
                Ширина картинки
                <input type="number" min="120" max="1200" step="20" value={imageWidth} onChange={(event) => setImageWidth(Number(event.target.value))} />
              </label>
            </div>
            <div className="wall-file-list">
              {files.map((file) => {
                const attached = draft.fileIds.includes(file.id);
                const isImage = file.mimeType.startsWith("image/");
                return (
                  <div key={file.id} className={classNames("wall-file-chip", attached && "attached")} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", `wall-file:${file.id}`)}>
                    <div className="wall-file-chip-main">
                      <Paperclip size={14} />
                      <span>{file.originalName}</span>
                      <small>{fileSize(file.size)}</small>
                    </div>
                    <div className="wall-file-actions">
                      <button className="ghost compact" type="button" title="Вставить ссылку" onClick={() => insertFileLink(file)}>
                        <Link size={13} />
                      </button>
                      {isImage && (
                        <button className="ghost compact" type="button" title="Вставить изображение" onClick={() => insertImage(file)}>
                          <Image size={13} />
                        </button>
                      )}
                      {isImage && (
                        <button className="ghost compact" type="button" onClick={() => setDraft((current) => ({ ...current, previewFileId: file.id }))}>
                          Превью
                        </button>
                      )}
                      <button
                        className="ghost compact"
                        type="button"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            fileIds: attached ? current.fileIds.filter((item) => item !== file.id) : [...current.fileIds, file.id]
                          }))
                        }
                      >
                        {attached ? "Убрать" : "Прикрепить"}
                      </button>
                      <button className="ghost compact danger" type="button" title="Удалить файл" onClick={() => deleteFile(file).catch((error) => setToast(error.message))}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {!files.length && <Empty label="Файлов пока нет" />}
            </div>
          </aside>
        </div>

        {attachedFiles.length > 0 && (
          <div className="wall-attached-summary">
            <strong>Прикреплено</strong>
            {attachedFiles.map((file) => (
              <span key={file.id} className="chip">
                {file.originalName}
              </span>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function WallTagsModal({
  tags,
  onCreate,
  onUpdate,
  onDelete,
  onClose
}: {
  tags: WallTag[];
  onCreate: (tag: Pick<WallTag, "name" | "color" | "pinned" | "archived">) => void;
  onUpdate: (tag: WallTag) => void;
  onDelete: (tagId: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7aa8ff");
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);

  return (
    <ModalShell
      title="Теги стены"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Закрыть
          </button>
          <button
            className="primary"
            type="button"
            disabled={!name.trim()}
            onClick={() => {
              onCreate({ name, color, pinned, archived });
              setName("");
              setPinned(false);
              setArchived(false);
            }}
          >
            <Plus size={16} />
            Создать
          </button>
        </>
      }
    >
      <div className="form-grid modal-form">
        <label>
          Название
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Цвет
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </label>
        <label className="toggle-row">
          <input checked={pinned} type="checkbox" onChange={(event) => setPinned(event.target.checked)} />
          Закрепляющий тег
        </label>
        <label className="toggle-row">
          <input checked={archived} type="checkbox" onChange={(event) => setArchived(event.target.checked)} />
          Архивный тег
        </label>
      </div>
      <div className="wall-tag-manager">
        {tags.map((tag) => (
          <div key={tag.id} className="wall-tag-row">
            <span className="wall-tag" style={{ "--tag-color": tag.color } as CSSProperties}>
              {tag.name}
            </span>
            <label className="toggle-row compact-toggle">
              <input checked={tag.pinned} type="checkbox" onChange={(event) => onUpdate({ ...tag, pinned: event.target.checked })} />
              Закрепляет
            </label>
            <label className="toggle-row compact-toggle">
              <input checked={tag.archived} type="checkbox" onChange={(event) => onUpdate({ ...tag, archived: event.target.checked })} />
              Архив
            </label>
            <button className="icon-button danger" type="button" title="Удалить" onClick={() => onDelete(tag.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {!tags.length && <Empty label="Теги пока не созданы" />}
      </div>
    </ModalShell>
  );
}

function ServicesView({
  state,
  serviceForm,
  setServiceForm,
  selectedService,
  selectedSummary,
  activeMemberships,
  inactiveUsers,
  userById,
  mutate,
  setSelectedServiceId,
  clientHealth,
  probeService,
  toggleServiceMaintenance,
  deployingServiceId,
  deployEchoServer,
  saveService
}: {
  state: AppState;
  serviceForm: typeof blankService;
  setServiceForm: (value: typeof blankService) => void;
  selectedService?: Service;
  selectedSummary?: AppState["summaries"][number];
  activeMemberships: AppState["memberships"];
  inactiveUsers: User[];
  userById: (id: string) => User | undefined;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  setSelectedServiceId: (id: string) => void;
  clientHealth: Record<string, ClientHealth>;
  probeService: (service: Service) => Promise<void>;
  toggleServiceMaintenance: (service: Service, maintenance: boolean) => Promise<AppState>;
  deployingServiceId: string;
  deployEchoServer: (serviceId: string) => Promise<AppState>;
  saveService: (service: Service) => Promise<AppState>;
}) {
  const [draft, setDraft] = useState<Service | null>(selectedService ?? null);
  const [depositDraft, setDepositDraft] = useState<DepositForm | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    setDraft(selectedService ?? null);
  }, [selectedService]);

  const selectedHealth = selectedService ? serviceHealth(selectedService, clientHealth[selectedService.id]) : null;

  const openDeposit = (membership: AppState["memberships"][number]) => {
    setDepositDraft({
      serviceId: membership.serviceId,
      userId: membership.userId,
      amount: 0,
      currency: selectedService?.currency ?? "RUB",
      comment: ""
    });
  };

  const deploySelectedEchoServer = async () => {
    if (!draft) return;
    const savedState = await saveService(draft);
    const savedService = savedState.services.find((service) => service.id === draft.id);
    if (!savedService) return;
    const nextState = await deployEchoServer(savedService.id);
    const nextService = nextState.services.find((service) => service.id === savedService.id);
    if (nextService) {
      setDraft(nextService);
      if (serviceConnection(nextService).lastDeployStatus === "success") {
        void probeService(nextService);
      }
    }
  };

  const toggleSelectedMaintenance = async () => {
    if (!draft) return;
    const maintenance = serviceConnection(draft).lastStatus !== "maintenance";
    const nextState = await toggleServiceMaintenance(draft, maintenance);
    const nextService = nextState.services.find((service) => service.id === draft.id);
    if (nextService) {
      setDraft(nextService);
      if (!maintenance) {
        void probeService(nextService);
      }
    }
  };

  return (
    <section className="page-grid">
      <div className="panel wide">
        <div className="panel-head">
          <h2>Список сервисов</h2>
          <button
            className="primary"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={16} />
            Добавить
          </button>
        </div>
        <div className="form-grid service-create service-edit-hidden" aria-hidden="true">
          <label>
            Название
            <input value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} />
          </label>
          <label>
            Стоимость в месяц
            <input
              type="number"
              min="0"
              step="0.01"
              value={serviceForm.monthlyCost}
              onChange={(event) => setServiceForm({ ...serviceForm, monthlyCost: Number(event.target.value) })}
            />
          </label>
          <label>
            Валюта
            <select value={serviceForm.currency} onChange={(event) => setServiceForm({ ...serviceForm, currency: event.target.value })}>
              {state.currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            Интервал
            <select
              value={serviceForm.period}
              onChange={(event) => setServiceForm({ ...serviceForm, period: event.target.value as BillingPeriod })}
            >
              {Object.entries(periodNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="wide-field">
            Заметки
            <input value={serviceForm.notes} onChange={(event) => setServiceForm({ ...serviceForm, notes: event.target.value })} />
          </label>
        </div>
        <div className="service-strip">
          {state.services.map((service) => {
            const summary = state.summaries.find((item) => item.serviceId === service.id);
            return (
              <button
                className={classNames("service-pill", selectedService?.id === service.id && "active", !service.active && "archived")}
                key={service.id}
                onClick={() => setSelectedServiceId(service.id)}
                type="button"
              >
                <span>{service.name}</span>
                <small>
                  {summary?.memberCount ?? 0} · {money(summary?.perMemberPeriod ?? 0, service.currency)}
                </small>
                <ServiceHealthBadge health={serviceHealth(service, clientHealth[service.id])} compact />
              </button>
            );
          })}
        </div>
      </div>

      {draft && selectedService && (
        <>
          <div className="panel wide">
            <div className="panel-head">
              <h2>
                {selectedService.name}
                {!draft.active && <span className="inline-chip">Архив</span>}
              </h2>
              <div className="actions">
                <button className="ghost" type="button" onClick={() => saveService({ ...draft, active: !draft.active })}>
                  {draft.active ? <Archive size={16} /> : <ArchiveRestore size={16} />}
                  {draft.active ? "В архив" : "Вернуть"}
                </button>
                <button
                  className="ghost"
                  type="button"
                  disabled={
                    !serviceConnection(draft).enabled ||
                    !serviceConnection(draft).host ||
                    selectedHealth?.status === "checking" ||
                    serviceConnection(draft).lastStatus === "maintenance"
                  }
                  onClick={() => probeService(draft)}
                >
                  <Activity size={16} />
                  Проверить
                </button>
                <button className="ghost" type="button" onClick={toggleSelectedMaintenance}>
                  <Wrench size={16} />
                  {serviceConnection(draft).lastStatus === "maintenance" ? "Вернуть в работу" : "На обслуживание"}
                </button>
                <button className="ghost" type="button" onClick={() => mutate(`/api/debits/manual`, { serviceId: selectedService.id })}>
                  <CreditCard size={16} />
                  Списать
                </button>
                <button className="primary" type="button" onClick={() => setEditOpen(true)}>
                  <Settings2 size={16} />
                  Настройки
                </button>
              </div>
            </div>

            <div className="stats-grid small">
              <Stat icon={Users} label="Участников" value={String(selectedSummary?.memberCount ?? 0)} />
              <Stat icon={CircleDollarSign} label="С человека в месяц" value={money(selectedSummary?.perMemberMonth ?? 0, draft.currency)} />
              <Stat icon={Clock3} label="Списание за период" value={money(selectedSummary?.perMemberPeriod ?? 0, draft.currency)} />
              <Stat icon={CalendarClock} label="Следующее списание" value={dateTime(draft.billing.nextChargeAt)} />
              <Stat icon={Activity} label="Сервер" value={selectedHealth ? healthValue(selectedHealth) : "Нет данных"} tone={selectedHealth ? healthTone(selectedHealth.status) : undefined} />
            </div>

            <div className="service-overview">
              <div>
                <span className="muted">Заметки</span>
                <p>{draft.notes || "Заметок пока нет"}</p>
              </div>
              <div>
                <span className="muted">Мониторинг</span>
                <p>
                  {serviceConnection(draft).enabled && serviceConnection(draft).host
                    ? `${serviceConnection(draft).host}:${serviceConnection(draft).port}${serviceConnection(draft).websocketPath}`
                    : "Не настроен"}
                </p>
              </div>
            </div>

            <div className="form-grid service-edit service-edit-hidden" aria-hidden="true">
              <label>
                Название
                <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label>
                Описание
                <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
              </label>
              <label className="wide-field">
                Заметки
                <textarea value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
              </label>
              <label>
                Стоимость
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.monthlyCost}
                  onChange={(event) => setDraft({ ...draft, monthlyCost: Number(event.target.value) })}
                />
              </label>
              <label>
                Валюта
                <select value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value })}>
                  {state.currencies.map((currency) => (
                    <option key={currency.code} value={currency.code}>
                      {currency.code}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Период
                <select
                  value={draft.billing.period}
                  onChange={(event) =>
                    setDraft({ ...draft, billing: { ...draft.billing, period: event.target.value as BillingPeriod } })
                  }
                >
                  {Object.entries(periodNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Шаг
                <input
                  type="number"
                  min="1"
                  value={draft.billing.interval}
                  onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, interval: Number(event.target.value) } })}
                />
              </label>
              <label>
                День месяца
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={draft.billing.anchorDay}
                  onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, anchorDay: Number(event.target.value) } })}
                />
              </label>
              <label>
                Час
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={draft.billing.anchorHour}
                  onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, anchorHour: Number(event.target.value) } })}
                />
              </label>
              <label>
                Смещение, дней
                <input
                  type="number"
                  value={draft.billing.shiftDays}
                  onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, shiftDays: Number(event.target.value) } })}
                />
              </label>
              <label>
                Порог периодов
                <input
                  type="number"
                  min="1"
                  value={draft.billing.lowBalanceThresholdPeriods}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      billing: { ...draft.billing, lowBalanceThresholdPeriods: Number(event.target.value) }
                    })
                  }
                />
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={draft.billing.autoDebit}
                  onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, autoDebit: event.target.checked } })}
                />
                Автосписание
              </label>
              <label className="toggle-row">
                <input checked={draft.active} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />
                Активен
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={serviceConnection(draft).enabled}
                  onChange={(event) =>
                    setDraft({ ...draft, connection: { ...serviceConnection(draft), enabled: event.target.checked } })
                  }
                />
                Мониторинг
              </label>
              <label>
                IP / host
                <input
                  value={serviceConnection(draft).host}
                  onChange={(event) => setDraft({ ...draft, connection: { ...serviceConnection(draft), host: event.target.value } })}
                />
              </label>
              <label>
                SSH port
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={serviceConnection(draft).sshPort}
                  onChange={(event) =>
                    setDraft({ ...draft, connection: { ...serviceConnection(draft), sshPort: Number(event.target.value) } })
                  }
                />
              </label>
              <label>
                WS port
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={serviceConnection(draft).port}
                  onChange={(event) => setDraft({ ...draft, connection: { ...serviceConnection(draft), port: Number(event.target.value) } })}
                />
              </label>
              <label>
                SSH user
                <input
                  value={serviceConnection(draft).user}
                  onChange={(event) => setDraft({ ...draft, connection: { ...serviceConnection(draft), user: event.target.value } })}
                />
              </label>
              <label>
                SSH pass
                <input
                  type="password"
                  placeholder={serviceConnection(draft).passwordSet ? "сохранён" : ""}
                  value={serviceConnection(draft).password}
                  onChange={(event) => setDraft({ ...draft, connection: { ...serviceConnection(draft), password: event.target.value } })}
                />
              </label>
              <label>
                WS path
                <input
                  value={serviceConnection(draft).websocketPath}
                  onChange={(event) =>
                    setDraft({ ...draft, connection: { ...serviceConnection(draft), websocketPath: event.target.value } })
                  }
                />
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={serviceConnection(draft).useTls}
                  onChange={(event) => setDraft({ ...draft, connection: { ...serviceConnection(draft), useTls: event.target.checked } })}
                />
                WSS
              </label>
              <div className="deploy-control">
                <button
                  className="ghost"
                  type="button"
                  disabled={
                    deployingServiceId === draft.id ||
                    !serviceConnection(draft).host.trim() ||
                    !serviceConnection(draft).user.trim() ||
                    (!serviceConnection(draft).password && !serviceConnection(draft).passwordSet)
                  }
                  onClick={deploySelectedEchoServer}
                >
                  <Upload size={16} />
                  {deployingServiceId === draft.id ? "Развёртывание..." : "Развернуть echo-сервер"}
                </button>
                {serviceConnection(draft).lastDeployStatus !== "unknown" && (
                  <details className={classNames("deploy-log", serviceConnection(draft).lastDeployStatus)}>
                    <summary>
                      {serviceConnection(draft).lastDeployStatus === "success" ? "Последний деплой успешен" : "Последний деплой не удался"} ·{" "}
                      {dateTime(serviceConnection(draft).lastDeployAt)}
                    </summary>
                    <pre>{serviceConnection(draft).lastDeployOutput || "Лог пуст"}</pre>
                  </details>
                )}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Участники</h2>
              <span className="chip">{activeMemberships.length}</span>
            </div>
            <div className="add-member">
              <select
                disabled={!inactiveUsers.length}
                onChange={(event) => {
                  if (event.target.value) {
                    mutate(`/api/services/${selectedService.id}/members`, { userId: event.target.value });
                    event.currentTarget.value = "";
                  }
                }}
                defaultValue=""
              >
                <option value="">Добавить участника</option>
                {inactiveUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="member-list">
              {activeMemberships.map((membership) => {
                const user = userById(membership.userId);
                return (
                  <article key={membership.id} className="member-row">
                    <div>
                      <strong>{user?.name ?? "Участник"}</strong>
                      <small>
                        Тариф: {money(selectedSummary?.perMemberPeriod ?? 0, selectedService.currency)} ·{" "}
                        {user?.telegramUsername ? `@${user.telegramUsername}` : user?.telegramId || "Telegram не задан"}
                      </small>
                    </div>
                    <span className={classNames("balance", (user?.balance ?? 0) < 0 && "negative")}>
                      {money(user?.balance ?? 0, "RUB")}
                    </span>
                    <button
                      className="icon-button"
                      type="button"
                      title="Зачислить"
                      onClick={() => openDeposit(membership)}
                    >
                      <Wallet size={15} />
                    </button>
                    <button
                      className="icon-button danger"
                      type="button"
                      title="Убрать"
                      onClick={() => mutate(`/api/services/${selectedService.id}/members/${membership.userId}`, undefined, "DELETE")}
                    >
                      <Trash2 size={15} />
                    </button>
                  </article>
                );
              })}
              {!activeMemberships.length && <Empty label="Нет участников" />}
            </div>
          </div>
          {depositDraft && (
            <DepositModal
              state={state}
              depositForm={depositDraft}
              setDepositForm={setDepositDraft}
              mutate={mutate}
              serviceById={(id) => state.services.find((service) => service.id === id)}
              userById={userById}
              onClose={() => setDepositDraft(null)}
            />
          )}
          {createOpen && (
            <ServiceCreateModal
              state={state}
              serviceForm={serviceForm}
              setServiceForm={setServiceForm}
              mutate={mutate}
              onClose={() => setCreateOpen(false)}
            />
          )}
          {editOpen && draft && (
            <ServiceEditModal
              state={state}
              draft={draft}
              setDraft={setDraft}
              deploying={deployingServiceId === draft.id}
              deploySelectedEchoServer={deploySelectedEchoServer}
              saveService={saveService}
              onClose={() => {
                setDraft(selectedService);
                setEditOpen(false);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function ServiceCreateModal({
  state,
  serviceForm,
  setServiceForm,
  mutate,
  onClose
}: {
  state: AppState;
  serviceForm: typeof blankService;
  setServiceForm: (value: typeof blankService) => void;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title="Новый сервис"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => mutate("/api/services", serviceForm).then(() => {
              setServiceForm(blankService);
              onClose();
            })}
          >
            <Plus size={16} />
            Добавить
          </button>
        </>
      }
    >
      <div className="form-grid modal-form">
        <label>
          Название
          <input autoFocus value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} />
        </label>
        <label>
          Стоимость в месяц
          <input
            type="number"
            min="0"
            step="0.01"
            value={serviceForm.monthlyCost}
            onChange={(event) => setServiceForm({ ...serviceForm, monthlyCost: Number(event.target.value) })}
          />
        </label>
        <label>
          Валюта
          <select value={serviceForm.currency} onChange={(event) => setServiceForm({ ...serviceForm, currency: event.target.value })}>
            {state.currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Интервал
          <select value={serviceForm.period} onChange={(event) => setServiceForm({ ...serviceForm, period: event.target.value as BillingPeriod })}>
            {Object.entries(periodNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="wide-field">
          Заметки
          <textarea value={serviceForm.notes} onChange={(event) => setServiceForm({ ...serviceForm, notes: event.target.value })} />
        </label>
      </div>
    </ModalShell>
  );
}

function ServiceEditModal({
  state,
  draft,
  setDraft,
  deploying,
  deploySelectedEchoServer,
  saveService,
  onClose
}: {
  state: AppState;
  draft: Service;
  setDraft: (service: Service) => void;
  deploying: boolean;
  deploySelectedEchoServer: () => Promise<void>;
  saveService: (service: Service) => Promise<AppState>;
  onClose: () => void;
}) {
  const connection = serviceConnection(draft);
  const setConnection = (next: Partial<ServiceConnectionSettings>) =>
    setDraft({ ...draft, connection: { ...connection, ...next } });

  return (
    <ModalShell
      title="Настройки сервиса"
      subtitle={draft.name}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" type="button" onClick={() => saveService(draft).then(onClose)}>
            <Check size={16} />
            Сохранить
          </button>
        </>
      }
    >
      <div className="form-grid modal-form service-settings-form">
        <label>
          Название
          <input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label>
          Описание
          <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        </label>
        <label className="wide-field">
          Заметки
          <textarea value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
        </label>
        <label>
          Стоимость
          <input type="number" min="0" step="0.01" value={draft.monthlyCost} onChange={(event) => setDraft({ ...draft, monthlyCost: Number(event.target.value) })} />
        </label>
        <label>
          Валюта
          <select value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value })}>
            {state.currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>{currency.code}</option>
            ))}
          </select>
        </label>
        <label>
          Период
          <select value={draft.billing.period} onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, period: event.target.value as BillingPeriod } })}>
            {Object.entries(periodNames).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          Шаг
          <input type="number" min="1" value={draft.billing.interval} onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, interval: Number(event.target.value) } })} />
        </label>
        <label>
          День месяца
          <input type="number" min="1" max="31" value={draft.billing.anchorDay} onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, anchorDay: Number(event.target.value) } })} />
        </label>
        <label>
          Час
          <input type="number" min="0" max="23" value={draft.billing.anchorHour} onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, anchorHour: Number(event.target.value) } })} />
        </label>
        <label>
          Смещение, дней
          <input type="number" value={draft.billing.shiftDays} onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, shiftDays: Number(event.target.value) } })} />
        </label>
        <label>
          Порог периодов
          <input type="number" min="1" value={draft.billing.lowBalanceThresholdPeriods} onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, lowBalanceThresholdPeriods: Number(event.target.value) } })} />
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={draft.billing.autoDebit} onChange={(event) => setDraft({ ...draft, billing: { ...draft.billing, autoDebit: event.target.checked } })} />
          Автосписание
        </label>
        <label className="toggle-row">
          <input checked={draft.active} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />
          Активен
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={connection.enabled} onChange={(event) => setConnection({ enabled: event.target.checked })} />
          Мониторинг
        </label>
        <label>
          IP / host
          <input value={connection.host} onChange={(event) => setConnection({ host: event.target.value })} />
        </label>
        <label>
          SSH port
          <input type="number" min="1" max="65535" value={connection.sshPort} onChange={(event) => setConnection({ sshPort: Number(event.target.value) })} />
        </label>
        <label>
          WS port
          <input type="number" min="1" max="65535" value={connection.port} onChange={(event) => setConnection({ port: Number(event.target.value) })} />
        </label>
        <label>
          SSH user
          <input value={connection.user} onChange={(event) => setConnection({ user: event.target.value })} />
        </label>
        <label>
          SSH pass
          <input type="password" placeholder={connection.passwordSet ? "сохранён" : ""} value={connection.password} onChange={(event) => setConnection({ password: event.target.value })} />
        </label>
        <label>
          WS path
          <input value={connection.websocketPath} onChange={(event) => setConnection({ websocketPath: event.target.value })} />
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={connection.useTls} onChange={(event) => setConnection({ useTls: event.target.checked })} />
          WSS
        </label>
        <div className="deploy-control">
          <button
            className="ghost"
            type="button"
            disabled={deploying || !connection.host.trim() || !connection.user.trim() || (!connection.password && !connection.passwordSet)}
            onClick={deploySelectedEchoServer}
          >
            <Upload size={16} />
            {deploying ? "Развёртывание..." : "Развернуть echo-сервер"}
          </button>
          {connection.lastDeployStatus !== "unknown" && (
            <details className={classNames("deploy-log", connection.lastDeployStatus)}>
              <summary>
                {connection.lastDeployStatus === "success" ? "Последний деплой успешен" : "Последний деплой не удался"} · {dateTime(connection.lastDeployAt)}
              </summary>
              <pre>{connection.lastDeployOutput || "Лог пуст"}</pre>
            </details>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function DepositModal({
  state,
  depositForm,
  setDepositForm,
  mutate,
  serviceById,
  userById,
  onClose,
  targetMode = "none",
  serviceOptions,
  onSaved
}: {
  state: AppState;
  depositForm: DepositForm;
  setDepositForm: (value: DepositForm) => void;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
  onClose: () => void;
  targetMode?: "none" | "service" | "all";
  serviceOptions?: Service[];
  onSaved?: () => Promise<unknown>;
}) {
  const availableServices = serviceOptions ?? state.services;
  const service = serviceById(depositForm.serviceId);
  const members = state.memberships.filter((membership) => membership.serviceId === depositForm.serviceId && membership.active);
  const selectedUserIsMember = members.some((membership) => membership.userId === depositForm.userId);
  const depositUserId = targetMode === "all" ? (selectedUserIsMember ? depositForm.userId : members[0]?.userId ?? "") : depositForm.userId;
  const user = userById(depositUserId);

  return (
    <ModalShell
      title="Зачисление"
      subtitle={`${service?.name ?? "Сервис"} · ${user?.name ?? "Участник"}`}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="primary"
            type="button"
            disabled={!depositUserId || depositForm.amount <= 0}
            onClick={() =>
              mutate("/api/deposits", { ...depositForm, userId: depositUserId })
                .then(() => onSaved?.())
                .then(onClose)
            }
          >
            <Plus size={16} />
            Зачислить
          </button>
        </>
      }
    >
      <div className="form-grid modal-form">
        {targetMode !== "none" && (
          <>
            <label>
              Сервис
              <select
                autoFocus
                value={depositForm.serviceId}
                onChange={(event) => {
                  const nextService = serviceById(event.target.value);
                  const member = state.memberships.find((membership) => membership.serviceId === event.target.value && membership.active);
                  setDepositForm({
                    ...depositForm,
                    serviceId: event.target.value,
                    userId: targetMode === "all" ? member?.userId ?? "" : depositForm.userId,
                    currency: nextService?.currency ?? depositForm.currency
                  });
                }}
              >
                {availableServices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {targetMode === "all" && (
              <label>
                Участник
                <select value={depositUserId} onChange={(event) => setDepositForm({ ...depositForm, userId: event.target.value })}>
                  {members.map((membership) => (
                    <option key={membership.id} value={membership.userId}>
                      {userById(membership.userId)?.name ?? "Участник"}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <label>
          Сумма
          <input
            autoFocus={targetMode === "none"}
            type="number"
            min="0"
            step="0.01"
            value={depositForm.amount}
            onChange={(event) => setDepositForm({ ...depositForm, amount: Number(event.target.value) })}
          />
        </label>
        <label>
          Валюта
          <select value={depositForm.currency} onChange={(event) => setDepositForm({ ...depositForm, currency: event.target.value })}>
            {state.currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code}
              </option>
            ))}
          </select>
        </label>
        <label className="wide-field">
          Комментарий
          <input value={depositForm.comment} onChange={(event) => setDepositForm({ ...depositForm, comment: event.target.value })} />
        </label>
      </div>
    </ModalShell>
  );
}

function PeopleView({
  state,
  userForm,
  setUserForm,
  userById,
  serviceById,
  mutate,
  saveUser,
  isAdmin
}: {
  state: AppState;
  userForm: typeof blankUser;
  setUserForm: (value: typeof blankUser) => void;
  userById: (id: string) => User | undefined;
  serviceById: (id: string) => Service | undefined;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  saveUser: (user: User & { adminPassword?: string }) => Promise<AppState>;
  isAdmin: boolean;
}) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <section className="page-grid">
      <div className="panel wide">
        <div className="panel-head">
          <h2>Новый участник</h2>
          <button
            className="primary"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            <UserPlus size={16} />
            Добавить
          </button>
        </div>
        <div className="form-grid user-create service-edit-hidden" aria-hidden="true">
          <label>
            Имя
            <input value={userForm.name} onChange={(event) => setUserForm({ ...userForm, name: event.target.value })} />
          </label>
          <label>
            Telegram ID
            <input value={userForm.telegramId} onChange={(event) => setUserForm({ ...userForm, telegramId: event.target.value })} />
          </label>
          <label>
            Username
            <input
              value={userForm.telegramUsername}
              onChange={(event) => setUserForm({ ...userForm, telegramUsername: event.target.value })}
            />
          </label>
          <label>
            Заметка
            <input value={userForm.notes} onChange={(event) => setUserForm({ ...userForm, notes: event.target.value })} />
          </label>
        </div>
      </div>

      {createOpen && (
        <UserEditModal
          title="Новый участник"
          draft={userForm}
          setDraft={setUserForm}
          wasAdmin={false}
          canEditPassword={isAdmin}
          onClose={() => setCreateOpen(false)}
          onSave={(nextUser) =>
            mutate("/api/users", nextUser).then((nextState) => {
              setUserForm(blankUser);
              setCreateOpen(false);
              return nextState;
            })
          }
        />
      )}

      <div className="panel wide">
        <div className="panel-head">
          <h2>Участники</h2>
          <span className="chip">{state.users.length}</span>
        </div>
        <div className="people-grid">
          {state.users.map((user) => (
            <UserCard
              key={user.id}
              user={user}
              state={state}
              serviceById={serviceById}
              onSave={saveUser}
              canEditPassword={isAdmin}
              onDelete={() => {
                if (!window.confirm(`Удалить участника "${user.name}" и его историю замеров пинга?`)) return Promise.resolve(state);
                return mutate(`/api/users/${user.id}`, undefined, "DELETE");
              }}
            />
          ))}
        </div>
      </div>

      <AutoDepositsPanel state={state} userById={userById} serviceById={serviceById} mutate={mutate} />
    </section>
  );
}

function AutoDepositsPanel({
  state,
  userById,
  serviceById,
  mutate
}: {
  state: AppState;
  userById: (id: string) => User | undefined;
  serviceById: (id: string) => Service | undefined;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
}) {
  const [form, setForm] = useState<AutoDepositForm>(() => autoDepositDefaults(state));
  const [createOpen, setCreateOpen] = useState(false);
  const serviceOptions = activeServicesForUser(state, form.userId);

  useEffect(() => {
    setForm((current) => {
      const userId = current.userId && state.users.some((user) => user.id === current.userId) ? current.userId : state.users[0]?.id ?? "";
      const services = activeServicesForUser(state, userId);
      const serviceId = services.some((service) => service.id === current.serviceId) ? current.serviceId : services[0]?.id ?? "";
      const currency = current.currency || services[0]?.currency || state.currencies[0]?.code || "RUB";
      return { ...current, userId, serviceId, currency };
    });
  }, [state.users, state.memberships, state.services, state.currencies]);

  const createAutoDeposit = () =>
    mutate("/api/auto-deposits", form).then((nextState) => setForm(autoDepositDefaults(nextState, form.userId)));

  return (
    <div className="panel wide">
      <div className="panel-head">
        <h2>Автоплатежи</h2>
        <button className="primary" type="button" disabled={!form.userId || !form.serviceId} onClick={() => setCreateOpen(true)}>
          <CalendarPlus size={16} />
          Добавить
        </button>
      </div>
      <div className="form-grid auto-payment-form service-edit-hidden" aria-hidden="true">
        <label>
          Участник
          <select
            value={form.userId}
            onChange={(event) => {
              const services = activeServicesForUser(state, event.target.value);
              setForm({
                ...form,
                userId: event.target.value,
                serviceId: services[0]?.id ?? "",
                currency: services[0]?.currency ?? form.currency
              });
            }}
          >
            {state.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Сервис для истории
          <select
            value={form.serviceId}
            disabled={!serviceOptions.length}
            onChange={(event) => setForm({ ...form, serviceId: event.target.value })}
          >
            {serviceOptions.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Сумма
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.amount}
            onChange={(event) => setForm({ ...form, amount: Number(event.target.value) })}
          />
        </label>
        <label>
          Валюта
          <select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
            {state.currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          День месяца
          <input
            type="number"
            min="1"
            max="31"
            value={form.dayOfMonth}
            onChange={(event) => setForm({ ...form, dayOfMonth: Number(event.target.value) })}
          />
        </label>
        <label>
          Час
          <input
            type="number"
            min="0"
            max="23"
            value={form.hour}
            onChange={(event) => setForm({ ...form, hour: Number(event.target.value) })}
          />
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
          Активен
        </label>
        <label className="wide-field">
          Комментарий
          <input value={form.comment} onChange={(event) => setForm({ ...form, comment: event.target.value })} />
        </label>
      </div>
      {createOpen && (
        <AutoDepositModal
          title="Новый автоплатеж"
          state={state}
          form={form}
          setForm={setForm}
          serviceOptions={serviceOptions}
          onClose={() => setCreateOpen(false)}
          onSave={() => createAutoDeposit().then(() => setCreateOpen(false))}
        />
      )}
      <div className="auto-payment-list">
        {(state.autoDeposits ?? []).map((schedule) => (
          <AutoDepositRow
            key={schedule.id}
            schedule={schedule}
            state={state}
            userById={userById}
            serviceById={serviceById}
            mutate={mutate}
          />
        ))}
        {!state.autoDeposits?.length && <Empty label="Автоплатежи не настроены" />}
      </div>
    </div>
  );
}

function AutoDepositRow({
  schedule,
  state,
  userById,
  serviceById,
  mutate
}: {
  schedule: AutoDeposit;
  state: AppState;
  userById: (id: string) => User | undefined;
  serviceById: (id: string) => Service | undefined;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
}) {
  const [draft, setDraft] = useState<AutoDeposit>(schedule);
  const [editing, setEditing] = useState(false);
  const serviceOptions = activeServicesForUser(state, draft.userId);

  useEffect(() => setDraft(schedule), [schedule]);

  useEffect(() => {
    if (!serviceOptions.length) return;
    if (!serviceOptions.some((service) => service.id === draft.serviceId)) {
      setDraft((current) => ({ ...current, serviceId: serviceOptions[0].id }));
    }
  }, [draft.serviceId, serviceOptions]);

  return (
    <article className={classNames("auto-payment-row", !draft.enabled && "disabled")}>
      <div className="auto-payment-summary">
        <strong>
          {userById(schedule.userId)?.name ?? "Участник"} · {money(schedule.amount, schedule.currency)}
        </strong>
        <small>
          {serviceById(schedule.serviceId)?.name ?? "Сервис"} · {schedule.dayOfMonth} число, {schedule.hour}:00 ·{" "}
          {schedule.enabled ? "активен" : "выключен"}
        </small>
        <small>Следующий: {dateTime(schedule.nextDepositAt)}</small>
      </div>
      <div className="auto-payment-actions">
        <button className="ghost compact" type="button" disabled={!schedule.serviceId || schedule.amount <= 0} onClick={() => mutate(`/api/auto-deposits/${schedule.id}/run`, {})}>
          Сейчас
        </button>
        <button className="ghost compact" type="button" onClick={() => setEditing(true)}>
          Изменить
        </button>
        <button className="icon-button danger" type="button" title="Удалить" onClick={() => mutate(`/api/auto-deposits/${schedule.id}`, undefined, "DELETE")}>
          <Trash2 size={15} />
        </button>
      </div>
      {editing && (
        <AutoDepositModal
          title="Автоплатеж"
          state={state}
          form={draft}
          setForm={setDraft}
          serviceOptions={serviceOptions}
          onClose={() => {
            setDraft(schedule);
            setEditing(false);
          }}
          onSave={() => mutate(`/api/auto-deposits/${draft.id}`, draft, "PUT").then(() => setEditing(false))}
        />
      )}
    </article>
  );
}

function AutoDepositModal({
  title,
  state,
  form,
  setForm,
  serviceOptions,
  onSave,
  onClose
}: {
  title: string;
  state: AppState;
  form: AutoDepositForm | AutoDeposit;
  setForm: (value: any) => void;
  serviceOptions: Service[];
  onSave: () => Promise<unknown>;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" type="button" disabled={!form.serviceId || form.amount <= 0} onClick={() => onSave()}>
            <Check size={16} />
            Сохранить
          </button>
        </>
      }
    >
      <div className="form-grid modal-form">
        <label>
          Участник
          <select
            value={form.userId}
            onChange={(event) => {
              const services = activeServicesForUser(state, event.target.value);
              setForm({
                ...form,
                userId: event.target.value,
                serviceId: services[0]?.id ?? "",
                currency: services[0]?.currency ?? form.currency
              });
            }}
          >
            {state.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Сервис
          <select value={form.serviceId} disabled={!serviceOptions.length} onChange={(event) => setForm({ ...form, serviceId: event.target.value })}>
            {serviceOptions.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Сумма
          <input type="number" min="0" step="0.01" value={form.amount} onChange={(event) => setForm({ ...form, amount: Number(event.target.value) })} />
        </label>
        <label>
          Валюта
          <select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
            {state.currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          День месяца
          <input type="number" min="1" max="31" value={form.dayOfMonth} onChange={(event) => setForm({ ...form, dayOfMonth: Number(event.target.value) })} />
        </label>
        <label>
          Час
          <input type="number" min="0" max="23" value={form.hour} onChange={(event) => setForm({ ...form, hour: Number(event.target.value) })} />
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
          Активен
        </label>
        <label className="wide-field">
          Комментарий
          <textarea value={form.comment} onChange={(event) => setForm({ ...form, comment: event.target.value })} />
        </label>
      </div>
    </ModalShell>
  );
}

function UserCard({
  user,
  state,
  serviceById,
  onSave,
  canEditPassword,
  onDelete
}: {
  user: User;
  state: AppState;
  serviceById: (id: string) => Service | undefined;
  onSave: (user: User) => Promise<AppState>;
  canEditPassword: boolean;
  onDelete: () => Promise<AppState>;
}) {
  const [draft, setDraft] = useState(user);
  const [editing, setEditing] = useState(false);

  useEffect(() => setDraft(user), [user]);

  const memberships = state.memberships.filter((membership) => membership.userId === user.id && membership.active);

  return (
    <article className="person-card compact-person">
      <div className="person-head compact">
        <UserAvatar user={user} />
        <div>
          <strong>{user.name}</strong>
          <small>{user.telegramUsername ? `@${user.telegramUsername}` : user.telegramId || "Telegram не задан"}</small>
        </div>
        <div className="person-flags">
          {user.commandDepositsBlocked && <span className="status-pill cancelled">команда закрыта</span>}
          {user.botAdmin && <span className="status-pill reversal">админ</span>}
        </div>
      </div>
      <div className="balance-stack">
        <div className="balance-row">
          <span>Общий баланс</span>
          <strong className={classNames(user.balance < 0 && "text-danger")}>{money(user.balance, "RUB")}</strong>
        </div>
        {memberships.map((membership) => {
          const service = serviceById(membership.serviceId);
          return (
            <div className="balance-row" key={membership.id}>
              <span>{service?.name ?? "Сервис"}</span>
              <strong>{periodNames[service?.billing.period ?? "month"]}</strong>
            </div>
          );
        })}
        {!memberships.length && <span className="muted">Нет сервисов</span>}
      </div>
      <div className="actions split">
        <button className="ghost danger-text" type="button" onClick={onDelete}>
          <Trash2 size={15} />
          Удалить
        </button>
        <button className="primary" type="button" onClick={() => setEditing(true)}>
          <Settings2 size={15} />
          Изменить
        </button>
      </div>
      {editing && (
        <UserEditModal
          title="Участник"
          draft={draft}
          setDraft={setDraft}
          wasAdmin={user.botAdmin}
          canEditPassword={canEditPassword}
          onClose={() => {
            setDraft(user);
            setEditing(false);
          }}
          onSave={(nextUser) => onSave(nextUser as User).then((nextState) => {
            setEditing(false);
            return nextState;
          })}
        />
      )}
    </article>
  );
}

function UserEditModal({
  title,
  draft,
  setDraft,
  wasAdmin,
  canEditPassword,
  onSave,
  onClose
}: {
  title: string;
  draft: User | typeof blankUser;
  setDraft: (value: any) => void;
  wasAdmin: boolean;
  canEditPassword: boolean;
  onSave: (user: (User | typeof blankUser) & { adminPassword?: string }) => Promise<AppState>;
  onClose: () => void;
}) {
  const [adminPassword, setAdminPassword] = useState("");
  const [participantPassword, setParticipantPassword] = useState("");
  const needsAdminPassword = draft.botAdmin && !wasAdmin;

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="primary"
            type="button"
            disabled={needsAdminPassword && !adminPassword}
            onClick={() => onSave({ ...draft, password: participantPassword, adminPassword })}
          >
            <Check size={16} />
            Сохранить
          </button>
        </>
      }
    >
      <div className="person-modal-head">
        <UserAvatar user={draft} size="large" />
        <div>
          <strong>{draft.name || "Новый участник"}</strong>
          <small>{draft.telegramUsername ? `@${draft.telegramUsername}` : draft.telegramId || "Telegram не задан"}</small>
        </div>
      </div>
      <div className="form-grid modal-form">
        <label>
          Имя
          <input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label>
          Баланс, RUB
          <input type="number" step="0.01" value={draft.balance} onChange={(event) => setDraft({ ...draft, balance: Number(event.target.value) })} />
        </label>
        <label>
          Telegram ID
          <input value={draft.telegramId} onChange={(event) => setDraft({ ...draft, telegramId: event.target.value })} />
        </label>
        <label>
          Username
          <input value={draft.telegramUsername} onChange={(event) => setDraft({ ...draft, telegramUsername: event.target.value })} />
        </label>
        {canEditPassword && (
          <label>
            Пароль входа
            <input
              autoComplete="new-password"
              placeholder={draft.passwordSet ? "оставьте пустым, чтобы не менять" : "задайте пароль"}
              type="password"
              value={participantPassword}
              onChange={(event) => setParticipantPassword(event.target.value)}
            />
          </label>
        )}
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={draft.commandDepositsBlocked}
            onChange={(event) => setDraft({ ...draft, commandDepositsBlocked: event.target.checked })}
          />
          Запретить пополнение через бота
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={draft.botAdmin} onChange={(event) => setDraft({ ...draft, botAdmin: event.target.checked })} />
          Администратор бота
        </label>
        {needsAdminPassword && (
          <label className="wide-field">
            Пароль администратора
            <input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} />
          </label>
        )}
        <label className="wide-field">
          Заметка
          <textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
        </label>
      </div>
    </ModalShell>
  );
}

function LedgerView({
  state,
  depositForm,
  setDepositForm,
  mutate,
  serviceById,
  userById,
  currentUser,
  isAdmin,
  operationPages,
  reloadOperations,
  onOperationPageChange
}: {
  state: AppState;
  depositForm: DepositForm;
  setDepositForm: (value: DepositForm) => void;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
  currentUser: User;
  isAdmin: boolean;
  operationPages: OperationPages;
  reloadOperations: () => Promise<OperationPages>;
  onOperationPageChange: (kind: keyof OperationPages, offset: number) => void;
}) {
  const availableServices = useMemo(
    () => (isAdmin ? state.services : activeServicesForUser(state, currentUser.id)),
    [currentUser.id, isAdmin, state.memberships, state.services]
  );
  const selectedService = serviceById(depositForm.serviceId);
  const members = state.memberships.filter((membership) => membership.serviceId === depositForm.serviceId && membership.active);
  const selectedUserIsMember = members.some((membership) => membership.userId === depositForm.userId);
  const depositUserId = isAdmin ? (selectedUserIsMember ? depositForm.userId : members[0]?.userId ?? "") : currentUser.id;
  const [depositOpen, setDepositOpen] = useState(false);

  useEffect(() => {
    const serviceAllowed = availableServices.some((service) => service.id === depositForm.serviceId);
    if ((!depositForm.serviceId || !serviceAllowed) && availableServices[0]) {
      const service = availableServices[0];
      const member = state.memberships.find((membership) => membership.serviceId === service.id && membership.active);
      setDepositForm({ ...depositForm, serviceId: service.id, userId: isAdmin ? member?.userId ?? "" : currentUser.id, currency: service.currency });
      return;
    }

    if (depositForm.serviceId && depositForm.userId !== depositUserId) {
      setDepositForm({ ...depositForm, userId: depositUserId, currency: selectedService?.currency ?? depositForm.currency });
    }
  }, [availableServices, currentUser.id, depositForm.serviceId, depositForm.userId, depositUserId, isAdmin, selectedService?.currency, state.memberships]);

  return (
    <section className="page-grid">
      <div className="panel wide">
        <div className="panel-head">
          <h2>Зачисление</h2>
          <button
            className="primary"
            type="button"
            disabled={!depositUserId || !availableServices.length}
            onClick={() => setDepositOpen(true)}
          >
            <Plus size={16} />
            Добавить
          </button>
        </div>
        <div className="form-grid deposit-form service-edit-hidden" aria-hidden="true">
          <label>
            Сервис
            <select
              value={depositForm.serviceId}
              onChange={(event) => {
                const service = serviceById(event.target.value);
                const member = state.memberships.find((membership) => membership.serviceId === event.target.value && membership.active);
                setDepositForm({
                  ...depositForm,
                  serviceId: event.target.value,
                  userId: member?.userId ?? "",
                  currency: service?.currency ?? depositForm.currency
                });
              }}
            >
              {state.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Участник
            <select value={depositUserId} onChange={(event) => setDepositForm({ ...depositForm, userId: event.target.value })}>
              {members.map((membership) => (
                <option key={membership.id} value={membership.userId}>
                  {userById(membership.userId)?.name ?? "Участник"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Сумма
            <input
              type="number"
              min="0"
              step="0.01"
              value={depositForm.amount}
              onChange={(event) => setDepositForm({ ...depositForm, amount: Number(event.target.value) })}
            />
          </label>
          <label>
            Валюта
            <select value={depositForm.currency} onChange={(event) => setDepositForm({ ...depositForm, currency: event.target.value })}>
              {state.currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code}
                </option>
              ))}
            </select>
          </label>
          <label className="wide-field">
            Комментарий
            <input value={depositForm.comment} onChange={(event) => setDepositForm({ ...depositForm, comment: event.target.value })} />
          </label>
        </div>
        {depositOpen && (
          <DepositModal
            state={state}
            depositForm={depositForm}
            setDepositForm={setDepositForm}
            mutate={mutate}
            serviceById={serviceById}
            userById={userById}
            targetMode={isAdmin ? "all" : "service"}
            serviceOptions={availableServices}
            onSaved={reloadOperations}
            onClose={() => setDepositOpen(false)}
          />
        )}
      </div>

      <HistoryTable
        title="Зачисления"
        page={operationPages.deposits}
        onPageChange={(offset) => onOperationPageChange("deposits", offset)}
        columns={["Дата", "Сервис", "Участник", "Исходно", "В баланс", "Источник", "Баланс"]}
        render={(deposit) => [
          dateTime(deposit.createdAt),
          serviceById(deposit.serviceId)?.name ?? "Сервис",
          userById(deposit.userId)?.name ?? "Участник",
          money(deposit.amountOriginal, deposit.currencyOriginal),
          money(deposit.amountBalanceCurrency ?? deposit.amountServiceCurrency, deposit.balanceCurrency ?? "RUB"),
          <OperationCell source={deposit.source} cancelledAt={deposit.cancelledAt} reversesId={deposit.reversesId}>
            <CancelOperationButton
              disabled={!isAdmin || Boolean(deposit.cancelledAt || deposit.reversesId)}
              onCancel={() => mutate(`/api/deposits/${deposit.id}/cancel`, { reason: "Отмена из истории" }).then(() => reloadOperations())}
            />
          </OperationCell>,
          money(deposit.balanceAfter, deposit.balanceCurrency ?? "RUB")
        ]}
      />

      <HistoryTable
        title="Списания"
        page={operationPages.debits}
        onPageChange={(offset) => onOperationPageChange("debits", offset)}
        columns={["Дата", "Сервис", "Участник", "Сумма сервиса", "С баланса", "Период", "Источник", "Баланс"]}
        render={(debit) => [
          dateTime(debit.createdAt),
          serviceById(debit.serviceId)?.name ?? "Сервис",
          userById(debit.userId)?.name ?? "Участник",
          money(debit.amount, debit.currency),
          money(debit.amountBalanceCurrency ?? debit.amount, debit.balanceCurrency ?? "RUB"),
          `${dateTime(debit.periodStart)} - ${dateTime(debit.periodEnd)}`,
          <OperationCell source={debit.source} cancelledAt={debit.cancelledAt} reversesId={debit.reversesId}>
            <CancelOperationButton
              disabled={!isAdmin || Boolean(debit.cancelledAt || debit.reversesId)}
              onCancel={() => mutate(`/api/debits/${debit.id}/cancel`, { reason: "Отмена из истории" }).then(() => reloadOperations())}
            />
          </OperationCell>,
          money(debit.balanceAfter, debit.balanceCurrency ?? "RUB")
        ]}
      />
    </section>
  );
}

function OperationCell({
  source,
  cancelledAt,
  reversesId,
  children
}: {
  source: string;
  cancelledAt?: string | null;
  reversesId?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="operation-cell">
      <span>{operationSourceNames[source] ?? source}</span>
      {cancelledAt && <span className="status-pill cancelled">Отменено</span>}
      {reversesId && <span className="status-pill reversal">Коррекция</span>}
      {!cancelledAt && !reversesId && <span className="status-pill">Активно</span>}
      {children}
    </div>
  );
}

function CancelOperationButton({ disabled, onCancel }: { disabled: boolean; onCancel: () => Promise<unknown> }) {
  return (
    <button className="ghost compact" type="button" disabled={disabled} onClick={onCancel}>
      Отменить
    </button>
  );
}

function HistoryTable<T extends { id: string }>({
  title,
  page,
  columns,
  render,
  onPageChange
}: {
  title: string;
  page: PageResult<T>;
  columns: string[];
  render: (row: T) => ReactNode[];
  onPageChange: (offset: number) => void;
}) {
  return (
    <div className="panel wide">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="chip">{page.total}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.id}>
                {render(row).map((cell, index) => (
                  <td key={`${row.id}-${index}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!page.rows.length && <Empty label="Нет записей" />}
      </div>
      <PaginationControls page={page} onChange={onPageChange} />
    </div>
  );
}

function BotView({
  state,
  currencyForm,
  setCurrencyForm,
  saveTelegram,
  saveCurrency,
  mutate,
  exportDatabase,
  importDatabase,
  updateApplication
}: {
  state: AppState;
  currencyForm: { code: string; name: string; symbol: string; rateToRub: number };
  setCurrencyForm: (value: { code: string; name: string; symbol: string; rateToRub: number }) => void;
  saveTelegram: (telegram: TelegramSettings) => Promise<AppState>;
  saveCurrency: (currency: Currency) => Promise<AppState>;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  exportDatabase: () => Promise<void>;
  importDatabase: (file: File) => Promise<void>;
  updateApplication: () => Promise<SystemUpdateResult>;
}) {
  const [telegram, setTelegram] = useState(state.settings.telegram);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [securityForm, setSecurityForm] = useState({ currentPassword: "", newPassword: "" });
  const [updating, setUpdating] = useState(false);
  const webhookUrl = `${window.location.origin.replace(/\/$/, "")}/api/telegram/webhook/${telegram.webhookSecret}`;
  const [publicWebhookUrl, setPublicWebhookUrl] = useState(webhookUrl);

  useEffect(() => {
    setTelegram(state.settings.telegram);
    setPublicWebhookUrl(`${window.location.origin.replace(/\/$/, "")}/api/telegram/webhook/${state.settings.telegram.webhookSecret}`);
  }, [state.settings.telegram]);

  const saveAndConfigure = () =>
    saveTelegram(telegram).then(() => mutate("/api/telegram/configure", { webhookUrl: publicWebhookUrl }));

  const saveAndTest = () => saveTelegram(telegram).then(() => mutate("/api/telegram/test", { chatId: telegram.chatId }));
  const startPolling = () => saveTelegram({ ...telegram, pollingEnabled: true }).then(() => mutate("/api/telegram/polling/start"));
  const stopPolling = () => mutate("/api/telegram/polling/stop");
  const saveSecurity = () =>
    mutate("/api/settings/security", securityForm, "PUT").then((nextState) => {
      setSecurityForm({ currentPassword: "", newPassword: "" });
      setSecurityOpen(false);
      return nextState;
    });
  const runUpdate = async () => {
    setUpdating(true);
    try {
      await updateApplication();
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className="page-grid">
      <div className="panel wide">
        <div className="panel-head">
          <h2>Настройки бота</h2>
          <button className="primary" type="button" onClick={() => setTelegramOpen(true)}>
            <Settings2 size={16} />
            Настройки
          </button>
        </div>
        <div className="bot-quick-actions">
          <button className="ghost" type="button" onClick={saveAndConfigure}>
            <Settings2 size={16} />
            Webhook
          </button>
          <button className="ghost" type="button" onClick={saveAndTest}>
            <Send size={16} />
            Тест
          </button>
          <button className="ghost" type="button" onClick={telegram.pollingEnabled ? stopPolling : startPolling}>
            <RefreshCcw size={16} />
            {telegram.pollingEnabled ? "Stop polling" : "Polling"}
          </button>
        </div>
        <div className="form-grid bot-form service-edit-hidden" aria-hidden="true">
          <label className="toggle-row">
            <input checked={telegram.enabled} type="checkbox" onChange={(event) => setTelegram({ ...telegram, enabled: event.target.checked })} />
            Включён
          </label>
          <label className="toggle-row">
            <input
              checked={telegram.lowBalanceNotifications}
              type="checkbox"
              onChange={(event) => setTelegram({ ...telegram, lowBalanceNotifications: event.target.checked })}
            />
            Малый остаток
          </label>
          <label>
            Chat ID
            <input value={telegram.chatId} onChange={(event) => setTelegram({ ...telegram, chatId: event.target.value })} />
          </label>
          <label>
            Topic ID
            <input
              value={telegram.notificationTopicId}
              onChange={(event) => setTelegram({ ...telegram, notificationTopicId: event.target.value })}
            />
          </label>
          <label className="wide-field">
            Bot token
            <input
              type="password"
              value={telegram.botToken}
              onChange={(event) => setTelegram({ ...telegram, botToken: event.target.value })}
            />
          </label>
          <label className="wide-field">
            Webhook secret
            <input value={telegram.webhookSecret} onChange={(event) => setTelegram({ ...telegram, webhookSecret: event.target.value })} />
          </label>
          <label className="wide-field">
            Webhook URL
            <input value={publicWebhookUrl} onChange={(event) => setPublicWebhookUrl(event.target.value)} />
          </label>
          <div className="bot-diagnostics wide-field">
            <span className={classNames("status-pill", telegram.pollingEnabled && "reversal")}>
              {telegram.pollingEnabled ? "Polling включён" : "Polling выключен"}
            </span>
            <span>Топик уведомлений: {telegram.notificationTopicId || "не задан"}</span>
            <span>Последний update: {dateTime(telegram.lastUpdateAt)}</span>
            {telegram.lastError && <span className="text-danger">{telegram.lastError}</span>}
          </div>
        </div>
        {telegramOpen && (
          <TelegramSettingsModal
            telegram={telegram}
            setTelegram={setTelegram}
            publicWebhookUrl={publicWebhookUrl}
            setPublicWebhookUrl={setPublicWebhookUrl}
            onClose={() => setTelegramOpen(false)}
            onSave={() => saveTelegram(telegram).then(() => setTelegramOpen(false))}
          />
        )}
      </div>

      <div className="panel wide">
        <div className="panel-head">
          <h2>Система</h2>
          <span className="chip">backup / update</span>
        </div>
        <div className="bot-quick-actions system-actions">
          <button className="ghost" type="button" onClick={exportDatabase}>
            <Download size={16} />
            Скачать БД
          </button>
          <label className="ghost file-action">
            <Upload size={16} />
            Загрузить БД
            <input
              accept="application/json,.json"
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) {
                  importDatabase(file);
                }
              }}
            />
          </label>
          <button className="ghost" type="button" disabled={updating} onClick={runUpdate}>
            <RefreshCcw size={16} />
            {updating ? "Обновление..." : "Обновить приложение"}
          </button>
          <button className="ghost" type="button" onClick={() => setSecurityOpen(true)}>
            <Shield size={16} />
            Пароль админки
          </button>
        </div>
        {securityOpen && (
          <SecurityModal
            form={securityForm}
            setForm={setSecurityForm}
            onClose={() => setSecurityOpen(false)}
            onSave={saveSecurity}
          />
        )}
      </div>

      <div className="panel wide">
        <div className="panel-head">
          <h2>Валюты</h2>
          <button
            className="primary"
            type="button"
            onClick={() => setCurrencyOpen(true)}
          >
            <Plus size={16} />
            Добавить
          </button>
        </div>
        <div className="form-grid currency-form service-edit-hidden" aria-hidden="true">
          <label>
            Код
            <input value={currencyForm.code} onChange={(event) => setCurrencyForm({ ...currencyForm, code: event.target.value })} />
          </label>
          <label>
            Название
            <input value={currencyForm.name} onChange={(event) => setCurrencyForm({ ...currencyForm, name: event.target.value })} />
          </label>
          <label>
            Символ
            <input value={currencyForm.symbol} onChange={(event) => setCurrencyForm({ ...currencyForm, symbol: event.target.value })} />
          </label>
          <label>
            Курс к RUB
            <input
              type="number"
              min="0"
              step="0.0001"
              value={currencyForm.rateToRub}
              onChange={(event) => setCurrencyForm({ ...currencyForm, rateToRub: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="currency-list">
          {state.currencies.map((currency) => (
            <CurrencyRow key={currency.code} currency={currency} onSave={saveCurrency} />
          ))}
        </div>
        {currencyOpen && (
          <CurrencyModal
            title="Новая валюта"
            currency={currencyForm}
            setCurrency={setCurrencyForm}
            onClose={() => setCurrencyOpen(false)}
            onSave={() =>
              mutate("/api/currencies", currencyForm).then((nextState) => {
                setCurrencyForm({ code: "", name: "", symbol: "", rateToRub: 1 });
                setCurrencyOpen(false);
                return nextState;
              })
            }
          />
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Команды</h2>
          <span className="chip">private / admin</span>
        </div>
        <div className="command-list">
          <code>/pay 600</code>
          <code>/deposit 600 VPN Main</code>
          <code>/balance</code>
          <code>/services</code>
          <code>/status</code>
          <code>/users</code>
          <code>/help</code>
          <code>/settopic</code>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Состояние</h2>
          <span className={classNames("chip", telegram.enabled && "positive")}>{telegram.enabled ? "online" : "off"}</span>
        </div>
        <div className="bot-status">
          <Settings2 size={28} />
          <strong>{state.counts.notifications}</strong>
          <span>bot events</span>
        </div>
      </div>
    </section>
  );
}

function TelegramSettingsModal({
  telegram,
  setTelegram,
  publicWebhookUrl,
  setPublicWebhookUrl,
  onSave,
  onClose
}: {
  telegram: TelegramSettings;
  setTelegram: (value: TelegramSettings) => void;
  publicWebhookUrl: string;
  setPublicWebhookUrl: (value: string) => void;
  onSave: () => Promise<unknown>;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title="Настройки бота"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" type="button" onClick={() => onSave()}>
            <Check size={16} />
            Сохранить
          </button>
        </>
      }
    >
      <div className="form-grid modal-form">
        <label className="toggle-row">
          <input checked={telegram.enabled} type="checkbox" onChange={(event) => setTelegram({ ...telegram, enabled: event.target.checked })} />
          Включён
        </label>
        <label className="toggle-row">
          <input
            checked={telegram.lowBalanceNotifications}
            type="checkbox"
            onChange={(event) => setTelegram({ ...telegram, lowBalanceNotifications: event.target.checked })}
          />
          Малый остаток
        </label>
        <label>
          Chat ID
          <input autoFocus value={telegram.chatId} onChange={(event) => setTelegram({ ...telegram, chatId: event.target.value })} />
        </label>
        <label>
          Topic ID
          <input value={telegram.notificationTopicId} onChange={(event) => setTelegram({ ...telegram, notificationTopicId: event.target.value })} />
        </label>
        <label className="wide-field">
          Bot token
          <input type="password" value={telegram.botToken} onChange={(event) => setTelegram({ ...telegram, botToken: event.target.value })} />
        </label>
        <label className="wide-field">
          Webhook secret
          <input value={telegram.webhookSecret} onChange={(event) => setTelegram({ ...telegram, webhookSecret: event.target.value })} />
        </label>
        <label className="wide-field">
          Webhook URL
          <input value={publicWebhookUrl} onChange={(event) => setPublicWebhookUrl(event.target.value)} />
        </label>
        <div className="bot-diagnostics wide-field">
          <span className={classNames("status-pill", telegram.pollingEnabled && "reversal")}>
            {telegram.pollingEnabled ? "Polling включён" : "Polling выключен"}
          </span>
          <span>Топик уведомлений: {telegram.notificationTopicId || "не задан"}</span>
          <span>Последний update: {dateTime(telegram.lastUpdateAt)}</span>
          {telegram.lastError && <span className="text-danger">{telegram.lastError}</span>}
        </div>
      </div>
    </ModalShell>
  );
}

function SecurityModal({
  form,
  setForm,
  onSave,
  onClose
}: {
  form: { currentPassword: string; newPassword: string };
  setForm: (value: { currentPassword: string; newPassword: string }) => void;
  onSave: () => Promise<unknown>;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title="Пароль админки"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" type="button" disabled={!form.currentPassword || !form.newPassword} onClick={() => onSave()}>
            <Check size={16} />
            Сохранить
          </button>
        </>
      }
    >
      <div className="form-grid modal-form">
        <label>
          Текущий пароль
          <input autoFocus type="password" value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} />
        </label>
        <label>
          Новый пароль
          <input type="password" value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} />
        </label>
      </div>
    </ModalShell>
  );
}

function CurrencyModal({
  title,
  currency,
  setCurrency,
  onSave,
  onClose,
  codeReadOnly = false
}: {
  title: string;
  currency: CurrencyDraft;
  setCurrency: (value: any) => void;
  onSave: () => Promise<unknown>;
  onClose: () => void;
  codeReadOnly?: boolean;
}) {
  return (
    <ModalShell
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" type="button" disabled={!currency.code.trim() || !currency.name.trim()} onClick={() => onSave()}>
            <Check size={16} />
            Сохранить
          </button>
        </>
      }
    >
      <div className="form-grid modal-form">
        <label>
          Код
          <input autoFocus={!codeReadOnly} readOnly={codeReadOnly} value={currency.code} onChange={(event) => setCurrency({ ...currency, code: event.target.value.toUpperCase() })} />
        </label>
        <label>
          Название
          <input autoFocus={codeReadOnly} value={currency.name} onChange={(event) => setCurrency({ ...currency, name: event.target.value })} />
        </label>
        <label>
          Символ
          <input value={currency.symbol} onChange={(event) => setCurrency({ ...currency, symbol: event.target.value })} />
        </label>
        <label>
          Курс к RUB
          <input
            type="number"
            min="0"
            step="0.0001"
            value={currency.rateToRub}
            onChange={(event) => setCurrency({ ...currency, rateToRub: Number(event.target.value) })}
          />
        </label>
      </div>
    </ModalShell>
  );
}

function CurrencyRow({ currency, onSave }: { currency: Currency; onSave: (currency: Currency) => Promise<AppState> }) {
  const [draft, setDraft] = useState(currency);
  const [editing, setEditing] = useState(false);

  useEffect(() => setDraft(currency), [currency]);

  return (
    <article className="currency-row">
      <strong>{draft.code}</strong>
      <div className="currency-summary">
        <span>{draft.name}</span>
        <small>
          {draft.symbol || "без символа"} · {Number(draft.rateToRub || 0).toLocaleString("ru-RU", { maximumFractionDigits: 4 })} RUB
        </small>
      </div>
      <button className="ghost compact" type="button" onClick={() => setEditing(true)}>
        Изменить
      </button>
      {editing && (
        <CurrencyModal
          title={`Валюта ${draft.code}`}
          currency={draft}
          setCurrency={setDraft}
          codeReadOnly
          onClose={() => {
            setDraft(currency);
            setEditing(false);
          }}
          onSave={() => onSave(draft).then((nextState) => {
            setEditing(false);
            return nextState;
          })}
        />
      )}
    </article>
  );
}
