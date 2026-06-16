import {
  Activity,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  BellRing,
  Bot,
  CalendarClock,
  CalendarPlus,
  Check,
  CircleDollarSign,
  Clock3,
  Coins,
  CreditCard,
  Download,
  Gauge,
  History,
  LogOut,
  Plus,
  RefreshCcw,
  Send,
  Settings2,
  Shield,
  Trash2,
  Upload,
  Wallet,
  Wrench,
  X,
  UserPlus,
  Users
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
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
import type { AppState, BillingPeriod, Currency, Service, ServiceConnectionSettings, ServiceHealthStatus, TelegramSettings, User } from "./types";
import type { AutoDeposit } from "./types";

type View = "dashboard" | "services" | "people" | "ledger" | "bot";

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

const authStorageKey = "vpn-payment-current-user-id";
const latencyLineColors = ["#7aa8ff", "#47d18c", "#f8c15d", "#ff8b82", "#b994ff", "#5ed4d6", "#f49ac2", "#c6cad2"];

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
  botAdmin: false
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

function money(value: number, currency: string) {
  return `${Number(value || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
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

function plainDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit"
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

function isEffectiveOperation(operation: { cancelledAt?: string | null; reversesId?: string | null }) {
  return !operation.cancelledAt && !operation.reversesId;
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
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
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

function AuthScreen({ state, onLogin }: { state: AppState; onLogin: (userId: string) => void }) {
  const [selectedUserId, setSelectedUserId] = useState(state.users[0]?.id ?? "");
  const selectedUser = state.users.find((user) => user.id === selectedUserId) ?? state.users[0];

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
                  {state.users.map((user) => (
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
                <small>{money(selectedUser.balance, "RUB")}</small>
              </div>
              {selectedUser.botAdmin && <span className="status-pill reversal">админ</span>}
            </div>
            <button className="primary auth-login" type="button" onClick={() => onLogin(selectedUser.id)}>
              <Shield size={16} />
              Войти
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

  const currentUser = useMemo(() => state?.users.find((user) => user.id === currentUserId), [currentUserId, state?.users]);
  const isAdmin = Boolean(currentUser?.botAdmin);
  const visibleNavItems = useMemo(() => navItems.filter((item) => isAdmin || item.id !== "bot"), [isAdmin]);

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

  useEffect(() => {
    load().catch((error) => setToast(error.message));
  }, []);

  useEffect(() => {
    if (!state) return;
    if (currentUserId && !state.users.some((user) => user.id === currentUserId)) {
      window.localStorage.removeItem(authStorageKey);
      setCurrentUserId("");
    }
  }, [currentUserId, state]);

  useEffect(() => {
    if (!isAdmin && view === "bot") {
      setView("dashboard");
    }
  }, [isAdmin, view]);

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
      const response = await fetch("/api/database/export");
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
        latencyTimeline: [],
        latencySeries: [],
        latencyRecent: [],
        latencyByUser: []
      };
    }

    const rate = (code: string) => state.currencies.find((currency) => currency.code === code)?.rateToRub ?? 1;
    const totalMonthly = state.services.reduce((sum, service) => sum + service.monthlyCost * rate(service.currency), 0);
    const totalBalanceRub = state.users.reduce((sum, user) => sum + user.balance, 0);

    const byDate = new Map<string, { date: string; deposits: number; debits: number }>();
    const ensure = (iso: string) => {
      const key = plainDate(iso);
      if (!byDate.has(key)) byDate.set(key, { date: key, deposits: 0, debits: 0 });
      return byDate.get(key)!;
    };

    for (const deposit of state.deposits.filter(isEffectiveOperation).slice(0, 80)) {
      ensure(deposit.createdAt).deposits += deposit.amountBalanceCurrency ?? deposit.amountServiceCurrency * rate(deposit.serviceCurrency);
    }
    for (const debit of state.debits.filter(isEffectiveOperation).slice(0, 80)) {
      ensure(debit.createdAt).debits += debit.amountBalanceCurrency ?? debit.amount * rate(debit.currency);
    }

    const balances = state.users
      .map((user) => ({
        name: user.name,
        balance: user.balance
      }))
      .slice(0, 10);
    const latencyRecent = state.latencyChecks.slice(0, 20);
    const latencySeries: Array<{ key: string; name: string; color: string }> = [];
    const latencySeriesByPair = new Map<string, { key: string; name: string; color: string }>();
    const latencyBuckets = new Map<string, { time: string; ts: number; sums: Record<string, { sum: number; count: number }> }>();

    for (const check of state.latencyChecks.filter((item) => item.latencyMs !== null).slice(0, 120).reverse()) {
      const user = state.users.find((item) => item.id === check.userId);
      const service = state.services.find((item) => item.id === check.serviceId);
      const pair = `${check.userId ?? "unknown"}:${check.serviceId}`;
      let series = latencySeriesByPair.get(pair);
      if (!series && latencySeries.length < latencyLineColors.length) {
        series = {
          key: `latency_${latencySeries.length}`,
          name: `${user?.name ?? "Не выбран"} · ${service?.name ?? "Сервис"}`,
          color: latencyLineColors[latencySeries.length]
        };
        latencySeriesByPair.set(pair, series);
        latencySeries.push(series);
      }
      if (!series) continue;

      const bucketDate = new Date(check.checkedAt);
      bucketDate.setSeconds(0, 0);
      const bucketId = bucketDate.toISOString();
      const bucket =
        latencyBuckets.get(bucketId) ??
        {
          time: new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(bucketDate),
          ts: bucketDate.getTime(),
          sums: {}
        };
      const current = bucket.sums[series.key] ?? { sum: 0, count: 0 };
      current.sum += check.latencyMs ?? 0;
      current.count += 1;
      bucket.sums[series.key] = current;
      latencyBuckets.set(bucketId, bucket);
    }

    const latencyTimeline = Array.from(latencyBuckets.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(-40)
      .map((bucket) => {
        const point: Record<string, string | number> = { time: bucket.time };
        for (const series of latencySeries) {
          const value = bucket.sums[series.key];
          if (value) point[series.key] = Math.round(value.sum / value.count);
        }
        return point;
      });
    const latencyStats = new Map<string, { name: string; sum: number; count: number }>();
    for (const check of state.latencyChecks) {
      if (check.latencyMs === null || !check.userId) continue;
      const user = state.users.find((item) => item.id === check.userId);
      const current = latencyStats.get(check.userId) ?? { name: user?.name ?? "Участник", sum: 0, count: 0 };
      current.sum += check.latencyMs;
      current.count += 1;
      latencyStats.set(check.userId, current);
    }

    return {
      totalMonthly,
      totalBalanceRub,
      lowBalance: state.summaries.reduce((sum, summary) => sum + summary.lowBalanceCount, 0),
      debt: state.summaries.reduce((sum, summary) => sum + summary.debtCount, 0),
      chart: Array.from(byDate.values()).reverse().slice(-14),
      balances,
      latencyTimeline,
      latencySeries,
      latencyRecent,
      latencyByUser: Array.from(latencyStats.values())
        .map((item) => ({ name: item.name, avg: Math.round(item.sum / item.count), count: item.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
    };
  }, [state]);

  if (!state) {
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
        state={state}
        onLogin={(userId) => {
          window.localStorage.setItem(authStorageKey, userId);
          setCurrentUserId(userId);
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
                onClick={() => setView(item.id)}
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
              window.localStorage.removeItem(authStorageKey);
              setCurrentUserId("");
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
          <div className="top-actions">
            <select value={selectedServiceId} onChange={(event) => setSelectedServiceId(event.target.value)}>
              {state.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
            <button className="icon-button" onClick={load} type="button" title="Обновить">
              <RefreshCcw size={16} />
            </button>
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
  userById
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
    latencyRecent: AppState["latencyChecks"];
    latencyByUser: Array<{ name: string; avg: number; count: number }>;
  };
  clientHealth: Record<string, ClientHealth>;
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
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
          <span className="chip">{dashboard.latencyRecent.length}</span>
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
              {dashboard.latencyRecent.map((check) => (
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
          {!dashboard.latencyRecent.length && <Empty label="Замеров пока нет" />}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Уведомления</h2>
          <span className="chip">{state.notifications.length}</span>
        </div>
        <div className="feed">
          {state.notifications.slice(0, 8).map((notification) => (
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
          {!state.notifications.length && <Empty label="Нет уведомлений" />}
        </div>
      </div>
    </section>
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
  serviceOptions
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
          <button className="primary" type="button" disabled={!depositUserId || depositForm.amount <= 0} onClick={() => mutate("/api/deposits", { ...depositForm, userId: depositUserId }).then(onClose)}>
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
  saveUser
}: {
  state: AppState;
  userForm: typeof blankUser;
  setUserForm: (value: typeof blankUser) => void;
  userById: (id: string) => User | undefined;
  serviceById: (id: string) => Service | undefined;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  saveUser: (user: User & { adminPassword?: string }) => Promise<AppState>;
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
              onDelete={() => mutate(`/api/users/${user.id}`, undefined, "DELETE")}
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
  onDelete
}: {
  user: User;
  state: AppState;
  serviceById: (id: string) => Service | undefined;
  onSave: (user: User) => Promise<AppState>;
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
  onSave,
  onClose
}: {
  title: string;
  draft: User | typeof blankUser;
  setDraft: (value: any) => void;
  wasAdmin: boolean;
  onSave: (user: (User | typeof blankUser) & { adminPassword?: string }) => Promise<AppState>;
  onClose: () => void;
}) {
  const [adminPassword, setAdminPassword] = useState("");
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
            onClick={() => onSave({ ...draft, adminPassword })}
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
  isAdmin
}: {
  state: AppState;
  depositForm: DepositForm;
  setDepositForm: (value: DepositForm) => void;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
  currentUser: User;
  isAdmin: boolean;
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
  const visibleDeposits = isAdmin ? state.deposits : state.deposits.filter((deposit) => deposit.userId === currentUser.id);
  const visibleDebits = isAdmin ? state.debits : state.debits.filter((debit) => debit.userId === currentUser.id);

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
            onClose={() => setDepositOpen(false)}
          />
        )}
      </div>

      <HistoryTable
        title="Зачисления"
        rows={visibleDeposits}
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
              onCancel={() => mutate(`/api/deposits/${deposit.id}/cancel`, { reason: "Отмена из истории" })}
            />
          </OperationCell>,
          money(deposit.balanceAfter, deposit.balanceCurrency ?? "RUB")
        ]}
      />

      <HistoryTable
        title="Списания"
        rows={visibleDebits}
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
              onCancel={() => mutate(`/api/debits/${debit.id}/cancel`, { reason: "Отмена из истории" })}
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

function CancelOperationButton({ disabled, onCancel }: { disabled: boolean; onCancel: () => Promise<AppState> }) {
  return (
    <button className="ghost compact" type="button" disabled={disabled} onClick={onCancel}>
      Отменить
    </button>
  );
}

function HistoryTable<T extends { id: string }>({
  title,
  rows,
  columns,
  render
}: {
  title: string;
  rows: T[];
  columns: string[];
  render: (row: T) => ReactNode[];
}) {
  return (
    <div className="panel wide">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="chip">{rows.length}</span>
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
            {rows.slice(0, 80).map((row) => (
              <tr key={row.id}>
                {render(row).map((cell, index) => (
                  <td key={`${row.id}-${index}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty label="Нет записей" />}
      </div>
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
          <strong>{state.notifications.filter((item) => item.kind !== "system").length}</strong>
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
