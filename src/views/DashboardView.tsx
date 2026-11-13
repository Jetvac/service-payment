import { AlertTriangle, BellRing, CalendarClock, CircleDollarSign, PiggyBank, TrendingDown, Wallet, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { useApp, useResource } from "../app-context";
import { activeServicesFor, balanceWarning, classNames, dateTime, dayMonth, money, periodPhrase, plural, relative, toRub } from "../format";
import type { DashboardData, Notification } from "../types";
import { Avatar, Badge, Card, Empty, PageHeader, Pagination, Spinner, Stat } from "../ui";

const emptyDashboard: DashboardData = { currency: "RUB", chart: [], notifications: { rows: [], total: 0, offset: 0, limit: 8, hasMore: false } };

export function FlowChart({ data }: { data: DashboardData["chart"] }) {
  const hasData = data.some((item) => item.deposits || item.debits);
  if (!hasData) return <Empty icon={TrendingDown} title="Движений пока нет" text="Пополнения и списания за 14 дней появятся здесь." />;
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 260 }}>
        <BarChart data={data.map((item) => ({ ...item, label: dayMonth(item.date) }))} barGap={2} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--text-3)", fontSize: 12 }} interval="preserveStartEnd" minTickGap={12} />
          <YAxis tickLine={false} axisLine={false} width={56} tick={{ fill: "var(--text-3)", fontSize: 12 }} tickFormatter={(value: number) => value.toLocaleString("ru-RU", { notation: "compact" })} />
          <Tooltip
            cursor={{ fill: "var(--hover)" }}
            contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--line-strong)", borderRadius: 10, color: "var(--text)" }}
            labelStyle={{ color: "var(--text-2)" }}
            formatter={(value, name) => [money(Number(value ?? 0)), String(name)]}
          />
          <Bar dataKey="deposits" name="Пополнения" fill="var(--good)" radius={[4, 4, 0, 0]} maxBarSize={18} />
          <Bar dataKey="debits" name="Списания" fill="var(--bad)" radius={[4, 4, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
      <div className="chart-legend">
        <span>
          <i className="legend-dot good" />
          Пополнения
        </span>
        <span>
          <i className="legend-dot bad" />
          Списания
        </span>
      </div>
    </div>
  );
}

function NotificationFeed({ scope }: { scope: "all" | "me" }) {
  const { serviceById, userById } = useApp();
  const [offset, setOffset] = useState(0);
  const { data, loading } = useResource(
    (signal) => api<DashboardData>(`/api/dashboard?scope=${scope}&notificationOffset=${offset}&notificationLimit=8`, { signal }),
    [offset, scope],
    emptyDashboard
  );

  const statusTone = (item: Notification) => (item.status === "failed" ? "bad" : item.status === "skipped" ? "muted" : "good");
  const statusLabel = { sent: "отправлено", skipped: "без отправки", failed: "ошибка" } as const;

  return (
    <Card title="События" subtitle={scope === "all" ? "Уведомления бота и системные сообщения" : "Ваши уведомления"} actions={loading && <Spinner />}>
      {data.notifications.rows.length ? (
        <ul className="feed">
          {data.notifications.rows.map((item) => (
            <li key={item.id} className="feed-item">
              <span className={classNames("feed-dot", `tone-${statusTone(item)}`)} />
              <div>
                {/* Messages are Telegram HTML; show them as plain text. */}
                <p>{item.message.replace(/<[^>]*>/g, "")}</p>
                <small>
                  {[serviceById(item.serviceId)?.name, userById(item.userId)?.name, dateTime(item.createdAt)].filter(Boolean).join(" · ")}
                </small>
              </div>
              <Badge tone={statusTone(item)}>{statusLabel[item.status]}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        !loading && <Empty icon={BellRing} title="Событий нет" />
      )}
      <Pagination page={data.notifications} onChange={setOffset} />
    </Card>
  );
}

export function DashboardView() {
  const { isAdmin } = useApp();
  return isAdmin ? <AdminDashboard /> : <MemberDashboard />;
}

function AdminDashboard() {
  const { state, navigate } = useApp();
  const { data } = useResource((signal) => api<DashboardData>("/api/dashboard?scope=all&notificationLimit=1", { signal }), [], emptyDashboard);

  const totals = useMemo(() => {
    const active = state.services.filter((service) => service.active);
    const monthly = active.reduce((sum, service) => sum + toRub(state, service.monthlyCost, service.currency), 0);
    const balances = state.users.reduce((sum, user) => sum + user.balance, 0);
    const attention = state.users
      .map((user) => ({ user, warning: balanceWarning(state, user) }))
      .filter(({ warning }) => warning.low || warning.debt)
      .sort((a, b) => a.user.balance - b.user.balance);
    const debt = state.users.filter((user) => user.balance < 0).reduce((sum, user) => sum + user.balance, 0);
    const upcoming = active
      .filter((service) => service.billing.nextChargeAt)
      .sort((a, b) => (a.billing.nextChargeAt ?? "").localeCompare(b.billing.nextChargeAt ?? ""));
    return { monthly, balances, attention, debt, upcoming, activeCount: active.length };
  }, [state]);

  const debtors = totals.attention.filter(({ warning }) => warning.debt).length;

  return (
    <div className="page">
      <PageHeader title="Обзор" subtitle={`${totals.activeCount} ${plural(totals.activeCount, ["активный сервис", "активных сервиса", "активных сервисов"])} · ${state.users.length} ${plural(state.users.length, ["участник", "участника", "участников"])}`} />

      <div className="stats">
        <Stat icon={CircleDollarSign} label="Сервисы в месяц" value={money(totals.monthly)} hint="стоимость активных сервисов" tone="accent" />
        <Stat icon={PiggyBank} label="На балансах" value={money(totals.balances)} hint="сумма по всем участникам" tone={totals.balances < 0 ? "bad" : "good"} />
        <Stat icon={AlertTriangle} label="Малый остаток" value={totals.attention.length - debtors} hint="не хватит на ближайшие списания" tone={totals.attention.length - debtors ? "warn" : "neutral"} />
        <Stat icon={TrendingDown} label="Задолженность" value={money(Math.abs(totals.debt))} hint={`${debtors} ${plural(debtors, ["участник", "участника", "участников"])} в минусе`} tone={debtors ? "bad" : "neutral"} />
      </div>

      <div className="grid grid-2-1">
        <Card title="Движение средств" subtitle="За последние 14 дней, в рублях">
          <FlowChart data={data.chart} />
        </Card>

        <Card title="Требуют внимания" subtitle="Отрицательный или малый остаток">
          {totals.attention.length ? (
            <ul className="person-list">
              {totals.attention.slice(0, 8).map(({ user, warning }) => (
                <li key={user.id}>
                  <Avatar user={user} size="sm" />
                  <span className="person-list-name">{user.name}</span>
                  <span className={classNames("amount", warning.debt ? "text-bad" : "text-warn")}>{money(user.balance)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon={Wallet} title="Все балансы в порядке" />
          )}
          {totals.attention.length > 8 && (
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => navigate({ view: "people" })}>
              Все участники
            </button>
          )}
        </Card>
      </div>

      <div className="grid grid-2-1">
        <Card title="Ближайшие списания" flush>
          {totals.upcoming.length ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Сервис</th>
                    <th>С участника</th>
                    <th>Участников</th>
                    <th>Когда</th>
                  </tr>
                </thead>
                <tbody>
                  {totals.upcoming.map((service) => {
                    const summary = state.summaries.find((item) => item.serviceId === service.id);
                    return (
                      <tr key={service.id} className="row-link" onClick={() => navigate({ view: "services", id: service.id })}>
                        <td>
                          <strong>{service.name}</strong>
                          <small>{periodPhrase(service.billing.period, service.billing.interval)}</small>
                        </td>
                        <td className="num">{money(summary?.perMemberPeriod ?? 0, service.currency)}</td>
                        <td className="num">{summary?.memberCount ?? 0}</td>
                        <td>
                          <span className="nowrap">{dateTime(service.billing.nextChargeAt)}</span>
                          <small>
                            {service.billing.autoDebit ? (
                              <>
                                <Zap size={12} /> автоматически {relative(service.billing.nextChargeAt)}
                              </>
                            ) : (
                              "вручную"
                            )}
                          </small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={CalendarClock} title="Нет активных сервисов" />
          )}
        </Card>
        <NotificationFeed scope="all" />
      </div>
    </div>
  );
}

function MemberDashboard() {
  const { state, me, navigate } = useApp();
  const { data } = useResource((signal) => api<DashboardData>("/api/dashboard?scope=me&notificationLimit=1", { signal }), [], emptyDashboard);
  const services = activeServicesFor(state, me.id).filter((service) => service.active);
  const warning = balanceWarning(state, me);
  const perMonth = services.reduce((sum, service) => {
    const summary = state.summaries.find((item) => item.serviceId === service.id);
    return sum + toRub(state, summary?.perMemberMonth ?? 0, service.currency);
  }, 0);

  return (
    <div className="page">
      <PageHeader title={`Здравствуйте, ${me.name}`} subtitle="Ваш баланс и ближайшие списания" />

      <section className={classNames("hero", warning.debt ? "tone-bad" : warning.low ? "tone-warn" : "tone-good")}>
        <div>
          <span className="hero-label">Баланс</span>
          <strong className="hero-value">{money(me.balance)}</strong>
          <span className="hero-hint">
            {warning.debt ? "Есть задолженность — пополните баланс" : warning.low ? "Скоро не хватит на списания" : services.length ? "Хватает на ближайшие списания" : "Вы пока не подключены к сервисам"}
          </span>
        </div>
        <div className="hero-side">
          <span>
            {money(perMonth)} <small>в месяц</small>
          </span>
          <button className="btn btn-primary" type="button" disabled={!services.length} onClick={() => navigate({ view: "pay" })}>
            <Wallet size={17} />
            Внести оплату
          </button>
        </div>
      </section>

      <div className="grid grid-2-1">
        <Card title="Мои сервисы" flush>
          {services.length ? (
            <ul className="service-list">
              {services.map((service) => {
                const summary = state.summaries.find((item) => item.serviceId === service.id);
                return (
                  <li key={service.id}>
                    <a href={`#/services/${service.id}`}>
                      <span className="service-list-main">
                        <strong>{service.name}</strong>
                        <small>
                          {money(summary?.perMemberPeriod ?? 0, service.currency)} {periodPhrase(service.billing.period, service.billing.interval)}
                        </small>
                      </span>
                      <span className="service-list-side">
                        <small>следующее</small>
                        {dateTime(service.billing.nextChargeAt)}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty title="Нет подключённых сервисов" text="Администратор добавит вас к сервису." />
          )}
        </Card>
        <NotificationFeed scope="me" />
      </div>

      <Card title="Мои операции" subtitle="За последние 14 дней">
        <FlowChart data={data.chart} />
      </Card>
    </div>
  );
}
