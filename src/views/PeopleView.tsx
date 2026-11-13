import { CalendarPlus, CalendarSync, Pencil, Play, Search, Trash2, UserPlus, Users, Wallet } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useApp } from "../app-context";
import { activeServicesFor, balanceWarning, classNames, dateTime, money, telegramHandle } from "../format";
import type { AutoDeposit, User } from "../types";
import { Avatar, Badge, Card, Empty, Field, Modal, PageHeader, Switch, useFeedback } from "../ui";
import { CreditModal } from "./ServicesView";

type UserDraft = {
  name: string;
  telegramId: string;
  telegramUsername: string;
  password: string;
  currentPassword: string;
  botAdmin: boolean;
  adminPassword: string;
  commandDepositsBlocked: boolean;
  notes: string;
};

function UserFormModal({ user, onClose }: { user?: User; onClose: () => void }) {
  const { mutate, me } = useApp();
  const [draft, setDraft] = useState<UserDraft>({
    name: user?.name ?? "",
    telegramId: user?.telegramId ?? "",
    telegramUsername: user?.telegramUsername ?? "",
    password: "",
    currentPassword: "",
    botAdmin: user?.botAdmin ?? false,
    adminPassword: "",
    commandDepositsBlocked: user?.commandDepositsBlocked ?? false,
    notes: user?.notes ?? ""
  });
  const set = <K extends keyof UserDraft>(key: K, value: UserDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const promoting = draft.botAdmin && !user?.botAdmin;
  const editingSelf = user?.id === me.id;
  const passwordTooShort = draft.password.length > 0 && draft.password.length < 8;
  const valid = draft.name.trim() && !passwordTooShort && (!promoting || draft.adminPassword) && (!editingSelf || !draft.password || draft.currentPassword);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const { currentPassword, adminPassword, password, ...rest } = draft;
    const body = { ...rest, ...(password ? { password } : {}), ...(currentPassword ? { currentPassword } : {}), ...(adminPassword ? { adminPassword } : {}) };
    const result = await mutate(user ? `/api/users/${user.id}` : "/api/users", {
      method: user ? "PUT" : "POST",
      body,
      success: user ? "Участник сохранён" : "Участник добавлен"
    });
    if (result) onClose();
  };

  return (
    <Modal
      title={user ? "Участник" : "Новый участник"}
      description={user ? `Баланс ${money(user.balance)} — меняется только через операции` : "Пароль можно задать сейчас или позже"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" type="submit" form="user-form" disabled={!valid}>
            {user ? "Сохранить" : "Добавить"}
          </button>
        </>
      }
    >
      <form id="user-form" className="form" onSubmit={submit}>
        <Field label="Имя">
          <input autoFocus value={draft.name} maxLength={80} onChange={(event) => set("name", event.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Telegram ID" hint="Бот подскажет его в ответ на /start">
            <input inputMode="numeric" value={draft.telegramId} onChange={(event) => set("telegramId", event.target.value.replace(/[^\d-]/g, ""))} />
          </Field>
          <Field label="Username">
            <input value={draft.telegramUsername} placeholder="@username" onChange={(event) => set("telegramUsername", event.target.value)} />
          </Field>
        </div>
        <Field label={user?.passwordSet ? "Новый пароль" : "Пароль для входа"} hint={passwordTooShort ? "Минимум 8 символов" : user?.passwordSet ? "Оставьте пустым, чтобы не менять" : "Минимум 8 символов"}>
          <input type="password" autoComplete="new-password" value={draft.password} onChange={(event) => set("password", event.target.value)} />
        </Field>
        {editingSelf && draft.password && (
          <Field label="Текущий пароль">
            <input type="password" autoComplete="current-password" value={draft.currentPassword} onChange={(event) => set("currentPassword", event.target.value)} />
          </Field>
        )}
        <Switch checked={draft.botAdmin} onChange={(value) => set("botAdmin", value)} label="Администратор" description="Управляет сервисами, участниками и настройками" />
        {promoting && (
          <Field label="Пароль администратора" hint="Общий пароль админки из раздела «Настройки → Система»">
            <input type="password" value={draft.adminPassword} onChange={(event) => set("adminPassword", event.target.value)} />
          </Field>
        )}
        <Switch
          checked={draft.commandDepositsBlocked}
          onChange={(value) => set("commandDepositsBlocked", value)}
          label="Запретить пополнение через бота"
          description="Команды /pay и /deposit будут отклоняться"
        />
        <Field label="Заметка" hint="Видна только администраторам и самому участнику">
          <textarea rows={3} value={draft.notes} onChange={(event) => set("notes", event.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

type ScheduleDraft = { userId: string; serviceId: string; amount: string; currency: string; dayOfMonth: number; hour: number; enabled: boolean; comment: string };

function AutoDepositModal({ schedule, onClose }: { schedule?: AutoDeposit; onClose: () => void }) {
  const { state, mutate } = useApp();
  const members = state.users.filter((user) => activeServicesFor(state, user.id).length);
  const [draft, setDraft] = useState<ScheduleDraft>(() => {
    const userId = schedule?.userId ?? members[0]?.id ?? "";
    const service = activeServicesFor(state, userId)[0];
    return {
      userId,
      serviceId: schedule?.serviceId ?? service?.id ?? "",
      amount: String(schedule?.amount ?? ""),
      currency: schedule?.currency ?? service?.currency ?? "RUB",
      dayOfMonth: schedule?.dayOfMonth ?? 1,
      hour: schedule?.hour ?? 12,
      enabled: schedule?.enabled ?? true,
      comment: schedule?.comment ?? ""
    };
  });
  const services = activeServicesFor(state, draft.userId);
  const amount = Number(draft.amount.replace(",", "."));
  const valid = draft.userId && draft.serviceId && Number.isFinite(amount) && amount > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const result = await mutate(schedule ? `/api/auto-deposits/${schedule.id}` : "/api/auto-deposits", {
      method: schedule ? "PUT" : "POST",
      body: { ...draft, amount },
      success: "Автоплатёж сохранён"
    });
    if (result) onClose();
  };

  return (
    <Modal
      title={schedule ? "Автоплатёж" : "Новый автоплатёж"}
      description="Ежемесячно зачисляет сумму на баланс участника — например, если он платит постоянным переводом"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" type="submit" form="schedule-form" disabled={!valid}>
            Сохранить
          </button>
        </>
      }
    >
      {members.length ? (
        <form id="schedule-form" className="form" onSubmit={submit}>
          <div className="form-row">
            <Field label="Участник">
              <select
                value={draft.userId}
                onChange={(event) => {
                  const service = activeServicesFor(state, event.target.value)[0];
                  setDraft({ ...draft, userId: event.target.value, serviceId: service?.id ?? "", currency: service?.currency ?? draft.currency });
                }}
              >
                {members.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Сервис">
              <select value={draft.serviceId} onChange={(event) => setDraft({ ...draft, serviceId: event.target.value })}>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="Сумма">
              <input inputMode="decimal" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/[^\d.,]/g, "") })} />
            </Field>
            <Field label="Валюта">
              <select value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value })}>
                {state.currencies.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="День месяца">
              <input type="number" min={1} max={31} value={draft.dayOfMonth} onChange={(event) => setDraft({ ...draft, dayOfMonth: Number(event.target.value) })} />
            </Field>
            <Field label="Час">
              <input type="number" min={0} max={23} value={draft.hour} onChange={(event) => setDraft({ ...draft, hour: Number(event.target.value) })} />
            </Field>
          </div>
          <Field label="Комментарий">
            <input value={draft.comment} maxLength={300} onChange={(event) => setDraft({ ...draft, comment: event.target.value })} />
          </Field>
          <Switch checked={draft.enabled} onChange={(value) => setDraft({ ...draft, enabled: value })} label="Включён" />
        </form>
      ) : (
        <Empty title="Нет участников с сервисами" text="Автоплатёж привязывается к сервису участника." />
      )}
    </Modal>
  );
}

function AutoDeposits() {
  const { state, mutate, userById, serviceById } = useApp();
  const { confirm } = useFeedback();
  const [editing, setEditing] = useState<AutoDeposit | "new" | null>(null);

  const runNow = async (schedule: AutoDeposit) => {
    const user = userById(schedule.userId);
    const answer = await confirm({
      title: "Зачислить сейчас?",
      message: `${money(schedule.amount, schedule.currency)} будет зачислено ${user?.name ?? "участнику"} вне расписания. Плановая дата не изменится.`,
      confirmLabel: "Зачислить"
    });
    if (answer !== null) await mutate(`/api/auto-deposits/${schedule.id}/run`, { success: "Зачислено" });
  };

  const remove = async (schedule: AutoDeposit) => {
    const answer = await confirm({ title: "Удалить автоплатёж?", confirmLabel: "Удалить", tone: "danger" });
    if (answer !== null) await mutate(`/api/auto-deposits/${schedule.id}`, { method: "DELETE", success: "Автоплатёж удалён" });
  };

  return (
    <Card
      title="Автоплатежи"
      subtitle="Ежемесячные зачисления по расписанию"
      flush
      actions={
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing("new")}>
          <CalendarPlus size={16} />
          Добавить
        </button>
      }
    >
      {state.autoDeposits.length ? (
        <ul className="schedule-list">
          {state.autoDeposits.map((schedule) => {
            const user = userById(schedule.userId);
            return (
              <li key={schedule.id} className={classNames(!schedule.enabled && "disabled")}>
                {user && <Avatar user={user} size="sm" />}
                <span className="schedule-main">
                  <strong>
                    {user?.name ?? "Участник"} · {money(schedule.amount, schedule.currency)}
                  </strong>
                  <small>
                    {serviceById(schedule.serviceId)?.name ?? "—"} · {schedule.dayOfMonth}-го числа в {String(schedule.hour).padStart(2, "0")}:00
                    {schedule.enabled ? ` · следующий ${dateTime(schedule.nextDepositAt)}` : " · выключен"}
                  </small>
                </span>
                <span className="row-actions">
                  <button className="icon-btn" type="button" title="Зачислить сейчас" aria-label="Зачислить сейчас" onClick={() => runNow(schedule)}>
                    <Play size={16} />
                  </button>
                  <button className="icon-btn" type="button" title="Изменить" aria-label="Изменить автоплатёж" onClick={() => setEditing(schedule)}>
                    <Pencil size={16} />
                  </button>
                  <button className="icon-btn danger" type="button" title="Удалить" aria-label="Удалить автоплатёж" onClick={() => remove(schedule)}>
                    <Trash2 size={16} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty icon={CalendarSync} title="Автоплатежей нет" />
      )}
      {editing && <AutoDepositModal schedule={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

export function PeopleView() {
  const { state, me, mutate } = useApp();
  const { confirm } = useFeedback();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [crediting, setCrediting] = useState<User | null>(null);

  const users = useMemo(() => {
    const query = search.trim().toLowerCase();
    return state.users
      .filter((user) => !query || [user.name, user.telegramUsername, user.telegramId].some((value) => value.toLowerCase().includes(query)))
      .sort((a, b) => Number(b.botAdmin) - Number(a.botAdmin) || a.name.localeCompare(b.name, "ru"));
  }, [search, state.users]);

  const remove = async (user: User) => {
    const answer = await confirm({
      title: `Удалить ${user.name}?`,
      message: (
        <>
          Участник будет отключён от сервисов, его автоплатежи удалены. Операции останутся в истории. Текущий баланс: <strong>{money(user.balance)}</strong>.
        </>
      ),
      confirmLabel: "Удалить",
      tone: "danger"
    });
    if (answer !== null) await mutate(`/api/users/${user.id}`, { method: "DELETE", success: "Участник удалён" });
  };

  return (
    <div className="page">
      <PageHeader
        title="Участники"
        subtitle="Доступ, балансы и привязка к Telegram"
        actions={
          <button className="btn btn-primary" type="button" onClick={() => setEditing("new")}>
            <UserPlus size={17} />
            Добавить
          </button>
        }
      />

      <Card flush>
        <div className="card-toolbar">
          <div className="input-icon">
            <Search size={16} />
            <input type="search" placeholder="Поиск по имени или Telegram" aria-label="Поиск участников" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        </div>
        {users.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Участник</th>
                  <th>Сервисы</th>
                  <th className="num">Баланс</th>
                  <th aria-label="Действия" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const services = activeServicesFor(state, user.id);
                  const warning = balanceWarning(state, user);
                  return (
                    <tr key={user.id}>
                      <td>
                        <span className="cell-person">
                          <Avatar user={user} />
                          <span>
                            <strong>
                              {user.name}
                              {user.id === me.id && <span className="muted"> (вы)</span>}
                            </strong>
                            <small>{telegramHandle(user) || "Telegram не привязан"}</small>
                            <span className="badges">
                              {user.botAdmin && <Badge tone="accent">админ</Badge>}
                              {!user.passwordSet && <Badge tone="warn">нет пароля</Badge>}
                              {user.commandDepositsBlocked && <Badge tone="muted">/pay закрыт</Badge>}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="badges">
                          {services.length ? services.map((service) => <Badge key={service.id}>{service.name}</Badge>) : <span className="muted">—</span>}
                        </span>
                      </td>
                      <td className={classNames("num strong", warning.debt ? "text-bad" : warning.low && "text-warn")}>{money(user.balance)}</td>
                      <td>
                        <span className="row-actions">
                          <button className="icon-btn" type="button" title="Зачислить оплату" aria-label={`Зачислить оплату: ${user.name}`} disabled={!services.length} onClick={() => setCrediting(user)}>
                            <Wallet size={16} />
                          </button>
                          <button className="icon-btn" type="button" title="Изменить" aria-label={`Изменить: ${user.name}`} onClick={() => setEditing(user)}>
                            <Pencil size={16} />
                          </button>
                          <button className="icon-btn danger" type="button" title="Удалить" aria-label={`Удалить: ${user.name}`} disabled={user.id === me.id} onClick={() => remove(user)}>
                            <Trash2 size={16} />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Users} title="Никого не нашли" />
        )}
      </Card>

      <AutoDeposits />

      {editing && <UserFormModal user={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      {crediting && <CreditModal user={crediting} onClose={() => setCrediting(null)} />}
    </div>
  );
}
