import {
  Activity,
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
  Lock,
  Plus,
  RefreshCcw,
  Send,
  Settings2,
  Shield,
  Trash2,
  Unlock,
  Upload,
  Wallet,
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
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { AppState, BillingPeriod, Currency, Service, TelegramSettings, User } from "./types";
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

type ApiResult = {
  ok: boolean;
  payload?: unknown;
  error?: string;
};

type SystemUpdateResult = {
  steps: Array<{ command: string; output: string }>;
  restart: { scheduled: boolean; serviceUnit?: string; reason?: string };
};

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

function isEffectiveOperation(operation: { cancelledAt?: string | null; reversesId?: string | null }) {
  return !operation.cancelledAt && !operation.reversesId;
}

function activeServicesForUser(state: AppState, userId: string) {
  return state.memberships
    .filter((membership) => membership.userId === userId && membership.active)
    .map((membership) => state.services.find((service) => service.id === membership.serviceId))
    .filter((service): service is Service => Boolean(service));
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

function Empty({ label }: { label: string }) {
  return <div className="empty">{label}</div>;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [toast, setToast] = useState("");
  const [serviceForm, setServiceForm] = useState(blankService);
  const [userForm, setUserForm] = useState(blankUser);
  const [currencyForm, setCurrencyForm] = useState({ code: "", name: "", symbol: "", rateToRub: 1 });
  const [depositForm, setDepositForm] = useState({
    serviceId: "",
    userId: "",
    amount: 0,
    currency: "RUB",
    comment: ""
  });

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
        balances: []
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

    return {
      totalMonthly,
      totalBalanceRub,
      lowBalance: state.summaries.reduce((sum, summary) => sum + summary.lowBalanceCount, 0),
      debt: state.summaries.reduce((sum, summary) => sum + summary.debtCount, 0),
      chart: Array.from(byDate.values()).reverse().slice(-14),
      balances
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
        ...service.billing
      },
      "PUT"
    );

  const saveUser = (user: User) => mutate(`/api/users/${user.id}`, user, "PUT");
  const saveTelegram = (telegram: TelegramSettings) => mutate("/api/settings/telegram", telegram, "PUT");
  const saveCurrency = (currency: Currency) => mutate(`/api/currencies/${currency.code}`, currency, "PUT");

  const content = {
    dashboard: (
      <Dashboard
        state={state}
        dashboard={dashboard}
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
          {navItems.map((item) => {
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
  };
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
                    <td>{dateTime(summary?.nextChargeAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
  saveService: (service: Service) => Promise<AppState>;
}) {
  const [draft, setDraft] = useState<Service | null>(selectedService ?? null);
  const [depositDraft, setDepositDraft] = useState<DepositForm | null>(null);

  useEffect(() => {
    setDraft(selectedService ?? null);
  }, [selectedService]);

  const openDeposit = (membership: AppState["memberships"][number]) => {
    setDepositDraft({
      serviceId: membership.serviceId,
      userId: membership.userId,
      amount: 0,
      currency: selectedService?.currency ?? "RUB",
      comment: ""
    });
  };

  return (
    <section className="page-grid">
      <div className="panel wide">
        <div className="panel-head">
          <h2>Список сервисов</h2>
          <button
            className="primary"
            type="button"
            onClick={() => {
              mutate("/api/services", serviceForm).then(() => setServiceForm(blankService));
            }}
          >
            <Plus size={16} />
            Добавить
          </button>
        </div>
        <div className="form-grid service-create">
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
                <button className="ghost" type="button" onClick={() => mutate(`/api/debits/manual`, { serviceId: selectedService.id })}>
                  <CreditCard size={16} />
                  Списать
                </button>
                <button className="primary" type="button" onClick={() => saveService(draft)}>
                  <Check size={16} />
                  Сохранить
                </button>
              </div>
            </div>

            <div className="stats-grid small">
              <Stat icon={Users} label="Участников" value={String(selectedSummary?.memberCount ?? 0)} />
              <Stat icon={CircleDollarSign} label="С человека в месяц" value={money(selectedSummary?.perMemberMonth ?? 0, draft.currency)} />
              <Stat icon={Clock3} label="Списание за период" value={money(selectedSummary?.perMemberPeriod ?? 0, draft.currency)} />
              <Stat icon={CalendarClock} label="Следующее списание" value={dateTime(draft.billing.nextChargeAt)} />
            </div>

            <div className="form-grid service-edit">
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
        </>
      )}
    </section>
  );
}

function DepositModal({
  state,
  depositForm,
  setDepositForm,
  mutate,
  serviceById,
  userById,
  onClose
}: {
  state: AppState;
  depositForm: DepositForm;
  setDepositForm: (value: DepositForm) => void;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
  onClose: () => void;
}) {
  const service = serviceById(depositForm.serviceId);
  const user = userById(depositForm.userId);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-panel" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Зачисление</h2>
            <small>
              {service?.name ?? "Сервис"} · {user?.name ?? "Участник"}
            </small>
          </div>
          <button className="icon-button" type="button" title="Закрыть" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="form-grid modal-form">
          <label>
            Сумма
            <input
              autoFocus
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
        <div className="modal-actions">
          <button className="ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="primary"
            type="button"
            disabled={depositForm.amount <= 0}
            onClick={() => mutate("/api/deposits", depositForm).then(onClose)}
          >
            <Plus size={16} />
            Зачислить
          </button>
        </div>
      </section>
    </div>
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
  saveUser: (user: User) => Promise<AppState>;
}) {
  return (
    <section className="page-grid">
      <div className="panel wide">
        <div className="panel-head">
          <h2>Новый участник</h2>
          <button
            className="primary"
            type="button"
            onClick={() => {
              mutate("/api/users", userForm).then(() => setUserForm(blankUser));
            }}
          >
            <UserPlus size={16} />
            Добавить
          </button>
        </div>
        <div className="form-grid user-create">
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
        <button className="primary" type="button" disabled={!form.userId || !form.serviceId || form.amount <= 0} onClick={createAutoDeposit}>
          <CalendarPlus size={16} />
          Добавить
        </button>
      </div>
      <div className="form-grid auto-payment-form">
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
      <label>
        Участник
        <select
          value={draft.userId}
          onChange={(event) => {
            const services = activeServicesForUser(state, event.target.value);
            setDraft({
              ...draft,
              userId: event.target.value,
              serviceId: services[0]?.id ?? "",
              currency: services[0]?.currency ?? draft.currency
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
        <select
          value={draft.serviceId}
          disabled={!serviceOptions.length}
          onChange={(event) => setDraft({ ...draft, serviceId: event.target.value })}
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
          value={draft.amount}
          onChange={(event) => setDraft({ ...draft, amount: Number(event.target.value) })}
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
        День
        <input
          type="number"
          min="1"
          max="31"
          value={draft.dayOfMonth}
          onChange={(event) => setDraft({ ...draft, dayOfMonth: Number(event.target.value) })}
        />
      </label>
      <label>
        Час
        <input
          type="number"
          min="0"
          max="23"
          value={draft.hour}
          onChange={(event) => setDraft({ ...draft, hour: Number(event.target.value) })}
        />
      </label>
      <label className="toggle-row auto-toggle">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
        Вкл
      </label>
      <label className="wide-field">
        Комментарий
        <input value={draft.comment} onChange={(event) => setDraft({ ...draft, comment: event.target.value })} />
      </label>
      <div className="auto-payment-meta">
        <span>Следующий: {dateTime(draft.nextDepositAt)}</span>
        <span>Последний: {dateTime(draft.lastDepositedAt)}</span>
        <span>
          {userById(draft.userId)?.name ?? "Участник"} · {serviceById(draft.serviceId)?.name ?? "Сервис"}
        </span>
      </div>
      <div className="auto-payment-actions">
        <button className="ghost compact" type="button" disabled={!draft.serviceId || draft.amount <= 0} onClick={() => mutate(`/api/auto-deposits/${draft.id}/run`, {})}>
          Сейчас
        </button>
        <button className="ghost compact" type="button" disabled={!draft.serviceId || draft.amount <= 0} onClick={() => mutate(`/api/auto-deposits/${draft.id}`, draft, "PUT")}>
          Сохранить
        </button>
        <button className="icon-button danger" type="button" title="Удалить" onClick={() => mutate(`/api/auto-deposits/${draft.id}`, undefined, "DELETE")}>
          <Trash2 size={15} />
        </button>
      </div>
    </article>
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

  useEffect(() => setDraft(user), [user]);

  const memberships = state.memberships.filter((membership) => membership.userId === user.id && membership.active);

  return (
    <article className="person-card">
      <div className="person-head">
        <span className="avatar">{draft.name.slice(0, 2).toUpperCase()}</span>
        <div>
          <input className="inline-input strong" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <small>{draft.telegramUsername ? `@${draft.telegramUsername}` : "Telegram username"}</small>
        </div>
        <button
          className={classNames("lock-button", draft.commandDepositsBlocked && "locked")}
          type="button"
          onClick={() => setDraft({ ...draft, commandDepositsBlocked: !draft.commandDepositsBlocked })}
          title={draft.commandDepositsBlocked ? "Разрешить команду" : "Заблокировать команду"}
        >
          {draft.commandDepositsBlocked ? <Lock size={15} /> : <Unlock size={15} />}
        </button>
        <button
          className={classNames("lock-button", draft.botAdmin && "admin")}
          type="button"
          onClick={() => setDraft({ ...draft, botAdmin: !draft.botAdmin })}
          title={draft.botAdmin ? "Убрать администратора бота" : "Сделать администратором бота"}
        >
          <Shield size={15} />
        </button>
      </div>
      <div className="form-grid person-fields">
        <label>
          Telegram ID
          <input value={draft.telegramId} onChange={(event) => setDraft({ ...draft, telegramId: event.target.value })} />
        </label>
        <label>
          Username
          <input value={draft.telegramUsername} onChange={(event) => setDraft({ ...draft, telegramUsername: event.target.value })} />
        </label>
        <label className="wide-field">
          Заметка
          <input value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
        </label>
      </div>
      <div className="balance-stack">
        <div className="balance-row">
          <span>Общий баланс</span>
          <strong className={classNames(draft.balance < 0 && "text-danger")}>{money(draft.balance, "RUB")}</strong>
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
        <button className="primary" type="button" onClick={() => onSave(draft)}>
          <Check size={15} />
          Сохранить
        </button>
      </div>
    </article>
  );
}

function LedgerView({
  state,
  depositForm,
  setDepositForm,
  mutate,
  serviceById,
  userById
}: {
  state: AppState;
  depositForm: DepositForm;
  setDepositForm: (value: DepositForm) => void;
  mutate: (path: string, body?: unknown, method?: string) => Promise<AppState>;
  serviceById: (id: string) => Service | undefined;
  userById: (id: string) => User | undefined;
}) {
  const selectedService = serviceById(depositForm.serviceId);
  const members = state.memberships.filter((membership) => membership.serviceId === depositForm.serviceId && membership.active);
  const selectedUserIsMember = members.some((membership) => membership.userId === depositForm.userId);
  const depositUserId = selectedUserIsMember ? depositForm.userId : members[0]?.userId ?? "";

  useEffect(() => {
    if (!depositForm.serviceId && state.services[0]) {
      const service = state.services[0];
      const member = state.memberships.find((membership) => membership.serviceId === service.id && membership.active);
      setDepositForm({ ...depositForm, serviceId: service.id, userId: member?.userId ?? "", currency: service.currency });
      return;
    }

    if (depositForm.serviceId && depositForm.userId !== depositUserId) {
      setDepositForm({ ...depositForm, userId: depositUserId, currency: selectedService?.currency ?? depositForm.currency });
    }
  }, [depositForm.serviceId, depositForm.userId, depositUserId, selectedService?.currency, state.memberships, state.services]);

  const submitDeposit = () =>
    mutate("/api/deposits", { ...depositForm, userId: depositUserId }).then(() =>
      setDepositForm({ ...depositForm, userId: depositUserId, amount: 0, comment: "", currency: selectedService?.currency ?? depositForm.currency })
    );

  return (
    <section className="page-grid">
      <div className="panel wide">
        <div className="panel-head">
          <h2>Зачисление</h2>
          <button
            className="primary"
            type="button"
            disabled={!depositUserId || depositForm.amount <= 0}
            onClick={submitDeposit}
          >
            <Plus size={16} />
            Зачислить
          </button>
        </div>
        <div className="form-grid deposit-form">
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
      </div>

      <HistoryTable
        title="Зачисления"
        rows={state.deposits}
        columns={["Дата", "Сервис", "Участник", "Исходно", "В баланс", "Источник", "Баланс"]}
        render={(deposit) => [
          dateTime(deposit.createdAt),
          serviceById(deposit.serviceId)?.name ?? "Сервис",
          userById(deposit.userId)?.name ?? "Участник",
          money(deposit.amountOriginal, deposit.currencyOriginal),
          money(deposit.amountBalanceCurrency ?? deposit.amountServiceCurrency, deposit.balanceCurrency ?? "RUB"),
          <OperationCell source={deposit.source} cancelledAt={deposit.cancelledAt} reversesId={deposit.reversesId}>
            <CancelOperationButton
              disabled={Boolean(deposit.cancelledAt || deposit.reversesId)}
              onCancel={() => mutate(`/api/deposits/${deposit.id}/cancel`, { reason: "Отмена из истории" })}
            />
          </OperationCell>,
          money(deposit.balanceAfter, deposit.balanceCurrency ?? "RUB")
        ]}
      />

      <HistoryTable
        title="Списания"
        rows={state.debits}
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
              disabled={Boolean(debit.cancelledAt || debit.reversesId)}
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
          <button className="primary" type="button" onClick={() => saveTelegram(telegram)}>
            <Send size={16} />
            Сохранить
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
        <div className="form-grid bot-form">
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
        </div>
      </div>

      <div className="panel wide">
        <div className="panel-head">
          <h2>Валюты</h2>
          <button
            className="primary"
            type="button"
            onClick={() => {
              mutate("/api/currencies", currencyForm).then(() => setCurrencyForm({ code: "", name: "", symbol: "", rateToRub: 1 }));
            }}
          >
            <Plus size={16} />
            Добавить
          </button>
        </div>
        <div className="form-grid currency-form">
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

function CurrencyRow({ currency, onSave }: { currency: Currency; onSave: (currency: Currency) => Promise<AppState> }) {
  const [draft, setDraft] = useState(currency);

  useEffect(() => setDraft(currency), [currency]);

  return (
    <article className="currency-row">
      <strong>{draft.code}</strong>
      <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <input value={draft.symbol} onChange={(event) => setDraft({ ...draft, symbol: event.target.value })} />
      <input
        type="number"
        min="0"
        step="0.0001"
        value={draft.rateToRub}
        onChange={(event) => setDraft({ ...draft, rateToRub: Number(event.target.value) })}
      />
      <button className="icon-button" type="button" title="Сохранить" onClick={() => onSave(draft)}>
        <Check size={15} />
      </button>
    </article>
  );
}
