import { Archive, ArchiveRestore, CalendarClock, CircleDollarSign, Pencil, Plus, Receipt, Server, Trash2, UserMinus, UserPlus, Users, Wallet, Zap } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useApp } from "../app-context";
import { classNames, dateTime, money, PERIOD_NAMES, periodPhrase, plural, relative, telegramHandle } from "../format";
import type { BillingPeriod, Service, User } from "../types";
import { Avatar, Badge, Card, Empty, Field, Modal, PageHeader, Stat, Switch, useFeedback } from "../ui";

type ServiceDraft = {
  name: string;
  description: string;
  notes: string;
  monthlyCost: string;
  currency: string;
  period: BillingPeriod;
  interval: number;
  anchorDay: number;
  anchorHour: number;
  shiftDays: number;
  autoDebit: boolean;
  lowBalanceThresholdPeriods: number;
};

function draftFrom(service?: Service): ServiceDraft {
  return {
    name: service?.name ?? "",
    description: service?.description ?? "",
    notes: service?.notes ?? "",
    monthlyCost: String(service?.monthlyCost ?? 600),
    currency: service?.currency ?? "RUB",
    period: service?.billing.period ?? "month",
    interval: service?.billing.interval ?? 1,
    anchorDay: service?.billing.anchorDay ?? 1,
    anchorHour: service?.billing.anchorHour ?? 12,
    shiftDays: service?.billing.shiftDays ?? 0,
    autoDebit: service?.billing.autoDebit ?? false,
    lowBalanceThresholdPeriods: service?.billing.lowBalanceThresholdPeriods ?? 1
  };
}

function ServiceFormModal({ service, onClose }: { service?: Service; onClose: () => void }) {
  const { state, mutate, navigate } = useApp();
  const [draft, setDraft] = useState(() => draftFrom(service));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const cost = Number(draft.monthlyCost.replace(",", "."));
  const valid = draft.name.trim() && Number.isFinite(cost) && cost >= 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    const body = { ...draft, monthlyCost: cost };
    const result = await mutate(service ? `/api/services/${service.id}` : "/api/services", {
      method: service ? "PUT" : "POST",
      body,
      success: service ? "Сервис сохранён" : "Сервис создан"
    });
    setSaving(false);
    if (!result) return;
    if (!service) {
      const created = result.services.at(-1);
      if (created) navigate({ view: "services", id: created.id });
    }
    onClose();
  };

  return (
    <Modal
      title={service ? "Настройки сервиса" : "Новый сервис"}
      description={service?.name}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" type="submit" form="service-form" disabled={!valid || saving}>
            {service ? "Сохранить" : "Создать"}
          </button>
        </>
      }
    >
      <form id="service-form" className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Название">
            <input autoFocus value={draft.name} maxLength={80} onChange={(event) => set("name", event.target.value)} />
          </Field>
          <Field label="Описание">
            <input value={draft.description} maxLength={200} onChange={(event) => set("description", event.target.value)} />
          </Field>
          <Field label="Стоимость в месяц" hint="Делится поровну между участниками">
            <input inputMode="decimal" value={draft.monthlyCost} onChange={(event) => set("monthlyCost", event.target.value.replace(/[^\d.,]/g, ""))} />
          </Field>
          <Field label="Валюта">
            <select value={draft.currency} onChange={(event) => set("currency", event.target.value)}>
              {state.currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <h3 className="form-section">Расписание списаний</h3>
        <div className="form-grid">
          <Field label="Период">
            <select value={draft.period} onChange={(event) => set("period", event.target.value as BillingPeriod)}>
              {Object.entries(PERIOD_NAMES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Каждые N периодов" hint={periodPhrase(draft.period, draft.interval)}>
            <input type="number" min={1} max={365} value={draft.interval} onChange={(event) => set("interval", Number(event.target.value))} />
          </Field>
          {draft.period === "month" && (
            <Field label="День месяца" hint="31 = последний день короткого месяца">
              <input type="number" min={1} max={31} value={draft.anchorDay} onChange={(event) => set("anchorDay", Number(event.target.value))} />
            </Field>
          )}
          {draft.period !== "hour" && (
            <Field label="Час списания">
              <input type="number" min={0} max={23} value={draft.anchorHour} onChange={(event) => set("anchorHour", Number(event.target.value))} />
            </Field>
          )}
          {draft.period === "month" && (
            <Field label="Сдвиг, дней" hint="От −27 до 27, например чтобы списывать до дня оплаты провайдеру">
              <input type="number" min={-27} max={27} value={draft.shiftDays} onChange={(event) => set("shiftDays", Number(event.target.value))} />
            </Field>
          )}
          <Field label="Предупреждать за, периодов" hint="Порог малого остатка">
            <input type="number" min={1} max={100} value={draft.lowBalanceThresholdPeriods} onChange={(event) => set("lowBalanceThresholdPeriods", Number(event.target.value))} />
          </Field>
        </div>
        <Switch checked={draft.autoDebit} onChange={(value) => set("autoDebit", value)} label="Списывать автоматически" description="Иначе списание запускает администратор кнопкой «Списать»" />

        <Field label="Заметки" hint="Видны всем участникам сервиса" wide>
          <textarea rows={4} value={draft.notes} onChange={(event) => set("notes", event.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

export function CreditModal({ user, serviceId, onClose }: { user: User; serviceId?: string; onClose: () => void }) {
  const { state, mutate, serviceById } = useApp();
  const services = state.services.filter((service) => service.active && state.memberships.some((membership) => membership.userId === user.id && membership.serviceId === service.id && membership.active));
  const [selected, setSelected] = useState(serviceId ?? services[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(serviceById(selected)?.currency ?? "RUB");
  const [comment, setComment] = useState("");
  const value = Number(amount.replace(",", "."));
  const valid = Number.isFinite(value) && value > 0 && Boolean(selected);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const result = await mutate("/api/payments", { body: { userId: user.id, serviceId: selected, amount: value, currency, comment }, success: `Зачислено: ${user.name}` });
    if (result) onClose();
  };

  return (
    <Modal
      title="Зачислить оплату"
      description={`${user.name} · баланс ${money(user.balance)}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" type="submit" form="credit-form" disabled={!valid}>
            Зачислить
          </button>
        </>
      }
    >
      {services.length ? (
        <form id="credit-form" className="form" onSubmit={submit}>
          {!serviceId && (
            <Field label="Сервис">
              <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="form-row">
            <Field label="Сумма">
              <input autoFocus inputMode="decimal" placeholder="0,00" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.,]/g, ""))} />
            </Field>
            <Field label="Валюта">
              <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {state.currencies.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Комментарий">
            <input value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} />
          </Field>
        </form>
      ) : (
        <Empty title="Участник не подключён к активным сервисам" />
      )}
    </Modal>
  );
}

export function ServicesView({ serviceId }: { serviceId?: string }) {
  const { state, isAdmin, me, navigate } = useApp();
  const [creating, setCreating] = useState(false);
  const visible = isAdmin ? state.services : state.services.filter((service) => state.memberships.some((item) => item.serviceId === service.id && item.userId === me.id && item.active));
  const sorted = [...visible].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "ru"));
  const selected = sorted.find((service) => service.id === serviceId) ?? sorted[0];

  useEffect(() => {
    if (serviceId && !visible.some((service) => service.id === serviceId) && selected) navigate({ view: "services", id: selected.id });
  }, [serviceId, visible, selected, navigate]);

  return (
    <div className="page">
      <PageHeader
        title="Сервисы"
        subtitle={isAdmin ? "Подписки, которые оплачиваются вскладчину" : "Сервисы, к которым вы подключены"}
        actions={
          isAdmin && (
            <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
              <Plus size={17} />
              Новый сервис
            </button>
          )
        }
      />

      {sorted.length ? (
        <div className="master-detail">
          <nav className="master-list" aria-label="Сервисы">
            {sorted.map((service) => {
              const summary = state.summaries.find((item) => item.serviceId === service.id);
              return (
                <a key={service.id} href={`#/services/${service.id}`} className={classNames("master-item", selected?.id === service.id && "active", !service.active && "archived")}>
                  <span className="master-item-icon">
                    <Server size={16} />
                  </span>
                  <span className="master-item-text">
                    <strong>{service.name}</strong>
                    <small>
                      {money(service.monthlyCost, service.currency)}/мес · {summary?.memberCount ?? 0} {plural(summary?.memberCount ?? 0, ["участник", "участника", "участников"])}
                    </small>
                  </span>
                  {!service.active && <Badge tone="muted">архив</Badge>}
                  {service.active && (summary?.debtCount ?? 0) > 0 && <Badge tone="bad">{summary?.debtCount} в минусе</Badge>}
                </a>
              );
            })}
          </nav>
          {selected && <ServiceDetail service={selected} />}
        </div>
      ) : (
        <Card>
          <Empty
            icon={Server}
            title={isAdmin ? "Сервисов пока нет" : "Вы не подключены к сервисам"}
            text={isAdmin ? "Создайте первый сервис и добавьте в него участников." : "Администратор добавит вас к сервису."}
            action={
              isAdmin && (
                <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
                  <Plus size={17} />
                  Новый сервис
                </button>
              )
            }
          />
        </Card>
      )}

      {creating && <ServiceFormModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function ServiceDetail({ service }: { service: Service }) {
  const { state, isAdmin, mutate, navigate, userById } = useApp();
  const { confirm, toast } = useFeedback();
  const [editing, setEditing] = useState(false);
  const [crediting, setCrediting] = useState<User | null>(null);
  const summary = state.summaries.find((item) => item.serviceId === service.id);
  const members = state.memberships
    .filter((membership) => membership.serviceId === service.id && membership.active)
    .map((membership) => userById(membership.userId))
    .filter((user): user is User => Boolean(user))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const candidates = state.users.filter((user) => !members.some((member) => member.id === user.id));

  const chargeNow = async () => {
    const amount = money(summary?.perMemberPeriod ?? 0, service.currency);
    const answer = await confirm({
      title: "Списать сейчас?",
      message: (
        <>
          С каждого из {members.length} {plural(members.length, ["участника", "участников", "участников"])} будет списано <strong>{amount}</strong>. Следующее
          плановое списание сдвинется на один период.
        </>
      ),
      confirmLabel: `Списать ${amount}`,
      tone: "danger"
    });
    if (answer === null) return;
    const result = await mutate<{ charged: number }>("/api/debits/manual", { body: { serviceId: service.id }, success: false });
    if (result) toast(`Списано с ${result.charged} ${plural(result.charged, ["участника", "участников", "участников"])}`);
  };

  const toggleArchive = async () => {
    if (service.active) {
      const answer = await confirm({
        title: "Отправить сервис в архив?",
        message: "Автосписания и внесение оплаты по сервису остановятся. История сохранится, сервис можно вернуть.",
        confirmLabel: "В архив"
      });
      if (answer === null) return;
    }
    await mutate(`/api/services/${service.id}`, { method: "PUT", body: { active: !service.active }, success: service.active ? "Сервис в архиве" : "Сервис возвращён" });
  };

  const remove = async () => {
    const answer = await confirm({
      title: `Удалить «${service.name}»?`,
      message: "Участники будут отключены, автоплатежи по сервису удалены. Операции в истории сохранятся. Действие нельзя отменить — обычно достаточно архива.",
      confirmLabel: "Удалить",
      tone: "danger"
    });
    if (answer === null) return;
    const result = await mutate(`/api/services/${service.id}`, { method: "DELETE", success: "Сервис удалён" });
    if (result) navigate({ view: "services" });
  };

  const removeMember = async (user: User) => {
    const answer = await confirm({
      title: `Отключить ${user.name}?`,
      message: "Участник перестанет участвовать в списаниях этого сервиса. Баланс и история сохранятся.",
      confirmLabel: "Отключить",
      tone: "danger"
    });
    if (answer !== null) await mutate(`/api/services/${service.id}/members/${user.id}`, { method: "DELETE", success: `${user.name} отключён` });
  };

  return (
    <div className="detail">
      <Card>
        <div className="detail-head">
          <div>
            <h2>
              {service.name}
              {!service.active && <Badge tone="muted">архив</Badge>}
              {service.active && service.billing.autoDebit && (
                <Badge tone="accent">
                  <Zap size={12} /> автосписание
                </Badge>
              )}
            </h2>
            {service.description && <p className="muted">{service.description}</p>}
          </div>
          {isAdmin && (
            <div className="toolbar">
              {service.active && (
                <button className="btn btn-primary" type="button" disabled={!members.length || !(summary?.perMemberPeriod ?? 0)} onClick={chargeNow}>
                  <Receipt size={16} />
                  Списать
                </button>
              )}
              <button className="btn btn-ghost" type="button" onClick={() => setEditing(true)}>
                <Pencil size={16} />
                Изменить
              </button>
              <button className="icon-btn" type="button" title={service.active ? "В архив" : "Вернуть из архива"} aria-label={service.active ? "В архив" : "Вернуть из архива"} onClick={toggleArchive}>
                {service.active ? <Archive size={17} /> : <ArchiveRestore size={17} />}
              </button>
              <button className="icon-btn danger" type="button" title="Удалить сервис" aria-label="Удалить сервис" onClick={remove}>
                <Trash2 size={17} />
              </button>
            </div>
          )}
        </div>

        <div className="stats stats-compact">
          <Stat icon={CircleDollarSign} label="В месяц" value={money(service.monthlyCost, service.currency)} />
          <Stat icon={Wallet} label="С участника" value={money(summary?.perMemberPeriod ?? 0, service.currency)} hint={periodPhrase(service.billing.period, service.billing.interval)} tone="accent" />
          <Stat icon={Users} label="Участников" value={summary?.memberCount ?? 0} />
          <Stat
            icon={CalendarClock}
            label="Следующее списание"
            value={service.active ? dateTime(service.billing.nextChargeAt) : "—"}
            hint={service.active ? (service.billing.autoDebit ? relative(service.billing.nextChargeAt) : "по кнопке администратора") : "сервис в архиве"}
          />
        </div>

        {service.notes && (
          <div className="note">
            <strong>Заметки</strong>
            <p>{service.notes}</p>
          </div>
        )}
      </Card>

      <Card
        title="Участники"
        subtitle={`${members.length} ${plural(members.length, ["человек", "человека", "человек"])}`}
        flush
        actions={
          isAdmin &&
          candidates.length > 0 && (
            <label className="select-action">
              <UserPlus size={16} />
              <select
                aria-label="Добавить участника"
                value=""
                onChange={(event) => {
                  const user = userById(event.target.value);
                  if (user) void mutate(`/api/services/${service.id}/members`, { body: { userId: user.id }, success: `${user.name} добавлен` });
                }}
              >
                <option value="">Добавить участника</option>
                {candidates.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
          )
        }
      >
        {members.length ? (
          <ul className="member-list">
            {members.map((user) => (
              <li key={user.id}>
                <Avatar user={user} />
                <span className="member-name">
                  <strong>{user.name}</strong>
                  <small>{telegramHandle(user) || "Telegram не привязан"}</small>
                </span>
                <span className={classNames("amount", user.balance < 0 && "text-bad")}>{money(user.balance)}</span>
                {isAdmin && (
                  <span className="row-actions">
                    {service.active && (
                      <button className="icon-btn" type="button" title="Зачислить оплату" aria-label={`Зачислить оплату: ${user.name}`} onClick={() => setCrediting(user)}>
                        <Wallet size={16} />
                      </button>
                    )}
                    <button className="icon-btn danger" type="button" title="Отключить от сервиса" aria-label={`Отключить ${user.name}`} onClick={() => removeMember(user)}>
                      <UserMinus size={16} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={Users} title="В сервисе нет участников" text={isAdmin ? "Добавьте участников, чтобы делить стоимость." : undefined} />
        )}
      </Card>

      {editing && <ServiceFormModal service={service} onClose={() => setEditing(false)} />}
      {crediting && <CreditModal user={crediting} serviceId={service.id} onClose={() => setCrediting(null)} />}
    </div>
  );
}
