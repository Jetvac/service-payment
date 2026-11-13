import { Banknote, CheckCircle2, Info, Receipt, Wallet } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api";
import { useApp, useResource } from "../app-context";
import { activeServicesFor, dateTime, money, periodPhrase, toRub } from "../format";
import type { PageResult, PaymentIntent } from "../types";
import { Avatar, Badge, Card, CopyButton, Empty, Field, PageHeader, Pagination, Spinner } from "../ui";

const METHOD_LABELS: Record<PaymentIntent["method"], string> = { manual: "Вручную", sbp: "СБП (архив)", sberbank: "СберБанк (архив)" };
const STATUS: Record<PaymentIntent["status"], { label: string; tone: "good" | "warn" | "bad" | "muted" }> = {
  succeeded: { label: "Зачислено", tone: "good" },
  pending: { label: "Не завершён", tone: "warn" },
  canceled: { label: "Отменено", tone: "muted" },
  failed: { label: "Ошибка", tone: "bad" }
};

const emptyPage: PageResult<PaymentIntent> = { rows: [], total: 0, offset: 0, limit: 10, hasMore: false };

export function PayView() {
  const { state, me, isAdmin, mutate, userById, serviceById } = useApp();
  const settings = state.settings.payments;
  const [userId, setUserId] = useState(me.id);
  const services = useMemo(() => activeServicesFor(state, userId).filter((service) => service.active), [state, userId]);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const service = services.find((item) => item.id === serviceId);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(service?.currency ?? "RUB");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [offset, setOffset] = useState(0);

  const payers = useMemo(
    () => state.users.filter((user) => state.memberships.some((membership) => membership.userId === user.id && membership.active)),
    [state.users, state.memberships]
  );

  useEffect(() => {
    if (!services.some((item) => item.id === serviceId)) setServiceId(services[0]?.id ?? "");
  }, [services, serviceId]);
  useEffect(() => {
    if (service) setCurrency(service.currency);
  }, [service?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const history = useResource(
    (signal) => api<PageResult<PaymentIntent>>(`/api/payments?offset=${offset}&limit=10${isAdmin ? "" : `&userId=${me.id}`}`, { signal }),
    [offset],
    emptyPage
  );

  const summary = state.summaries.find((item) => item.serviceId === serviceId);
  const value = Number(amount.replace(",", "."));
  const valid = Number.isFinite(value) && value > 0 && value <= 1_000_000 && Boolean(service);
  const blocked = !isAdmin && !settings.manualEnabled;
  const forSomeoneElse = userId !== me.id;

  const suggestions = summary
    ? Array.from(
        new Set([summary.perMemberPeriod, summary.perMemberMonth, summary.perMemberMonth * 3].map((item) => Math.round(item * 100) / 100).filter((item) => item > 0))
      )
    : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    const result = await mutate<{ payment: PaymentIntent }>("/api/payments", {
      body: { serviceId, amount: value, currency, comment, ...(isAdmin ? { userId } : {}) },
      success: forSomeoneElse ? `Оплата зачислена: ${userById(userId)?.name}` : "Оплата зачислена"
    });
    setSubmitting(false);
    if (result) {
      setAmount("");
      setComment("");
    }
  };

  const details = [
    { label: "Получатель", value: settings.recipientName },
    { label: "Банк", value: settings.bankName },
    { label: "Телефон для СБП", value: settings.phone },
    { label: "Счёт или карта", value: settings.account },
    { label: "Назначение", value: settings.paymentPurpose }
  ].filter((item) => item.value);

  return (
    <div className="page">
      <PageHeader title="Внести оплату" subtitle="Переведите деньги получателю и отметьте платёж — сумма сразу появится на балансе." />

      <div className="grid grid-3-2">
        <Card title="Отметить платёж">
          {blocked ? (
            <Empty icon={Info} title="Внесение оплаты отключено" text="Администратор временно выключил ручное внесение. Обратитесь к нему, чтобы он зачислил платёж." />
          ) : !payers.length ? (
            <Empty icon={Wallet} title="Нет подключённых сервисов" text="Сначала нужно подключить участника к сервису." />
          ) : (
            <form className="form" onSubmit={submit}>
              {isAdmin && (
                <Field label="Участник">
                  <select value={userId} onChange={(event) => setUserId(event.target.value)}>
                    {payers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                        {user.id === me.id ? " (вы)" : ""} — {money(user.balance)}
                      </option>
                    ))}
                    {!payers.some((user) => user.id === me.id) && <option value={me.id}>{me.name} (вы)</option>}
                  </select>
                </Field>
              )}

              {services.length ? (
                <>
                  <Field label="Сервис" hint={summary && service ? `${money(summary.perMemberPeriod, service.currency)} ${periodPhrase(service.billing.period, service.billing.interval)} с участника` : undefined}>
                    <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
                      {services.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <div className="form-row">
                    <Field label="Сумма">
                      <input inputMode="decimal" placeholder="0,00" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.,]/g, ""))} />
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

                  {suggestions.length > 0 && (
                    <div className="chips" aria-label="Быстрый выбор суммы">
                      {suggestions.map((item) => (
                        <button key={item} type="button" className="chip-btn" onClick={() => setAmount(String(item))}>
                          {money(item, service?.currency)}
                        </button>
                      ))}
                    </div>
                  )}

                  {valid && currency !== "RUB" && <p className="muted">≈ {money(toRub(state, value, currency))} поступит на баланс по текущему курсу</p>}

                  <Field label="Комментарий" hint="Необязательно: например, номер перевода">
                    <input value={comment} maxLength={500} placeholder={settings.paymentPurpose || "Комментарий к платежу"} onChange={(event) => setComment(event.target.value)} />
                  </Field>

                  <button className="btn btn-primary btn-lg" type="submit" disabled={!valid || submitting}>
                    {submitting ? <Spinner /> : <CheckCircle2 size={18} />}
                    {valid ? `Зачислить ${money(value, currency)}` : "Зачислить"}
                  </button>
                </>
              ) : (
                <Empty icon={Wallet} title="У участника нет активных сервисов" />
              )}
            </form>
          )}
        </Card>

        <Card title="Куда переводить" subtitle="Реквизиты задаёт администратор">
          {details.length ? (
            <dl className="details">
              {details.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>
                    <span>{item.value}</span>
                    <CopyButton value={item.value} label={`Скопировать: ${item.label}`} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <Empty icon={Banknote} title="Реквизиты не заданы" text={isAdmin ? "Добавьте их в разделе «Настройки»." : "Уточните их у администратора."} />
          )}
        </Card>
      </div>

      <Card title="История оплат" subtitle={isAdmin ? "Все отмеченные платежи" : "Ваши платежи"} flush actions={history.loading && <Spinner />}>
        {history.data.rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Дата</th>
                  {isAdmin && <th>Участник</th>}
                  <th>Сервис</th>
                  <th className="num">Сумма</th>
                  <th>Способ</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {history.data.rows.map((payment) => {
                  const user = userById(payment.userId);
                  return (
                    <tr key={payment.id}>
                      <td className="nowrap">{dateTime(payment.createdAt)}</td>
                      {isAdmin && (
                        <td>
                          <span className="cell-person">
                            {user && <Avatar user={user} size="sm" />}
                            {user?.name ?? "Удалённый участник"}
                          </span>
                        </td>
                      )}
                      <td>
                        {serviceById(payment.serviceId)?.name ?? "—"}
                        {payment.comment && <small>{payment.comment}</small>}
                      </td>
                      <td className="num strong">{money(payment.amount, payment.currency)}</td>
                      <td>{METHOD_LABELS[payment.method]}</td>
                      <td>
                        <Badge tone={STATUS[payment.status].tone}>{STATUS[payment.status].label}</Badge>
                        {payment.failureReason && <small>{payment.failureReason}</small>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          !history.loading && <Empty icon={Receipt} title="Оплат пока нет" />
        )}
        <Pagination page={history.data} onChange={setOffset} />
      </Card>
    </div>
  );
}
