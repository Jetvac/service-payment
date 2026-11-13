import { History, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, useResource } from "../app-context";
import { dateTime, money } from "../format";
import type { Debit, Deposit, PageResult } from "../types";
import { Avatar, Badge, Card, Empty, PageHeader, Pagination, Segmented, Spinner, useFeedback } from "../ui";

type Kind = "deposits" | "debits";
const PAGE = 25;
const SOURCE_LABELS: Record<string, string> = {
  manual: "Вручную",
  telegram: "Telegram",
  auto: "Автоматически",
  payment: "Онлайн-оплата",
  reversal: "Коррекция"
};

function OperationStatus({ operation }: { operation: Deposit | Debit }) {
  if (operation.cancelledAt) return <Badge tone="muted">отменено</Badge>;
  if (operation.reversesId) return <Badge tone="accent">коррекция</Badge>;
  return null;
}

export function LedgerView() {
  const { state, isAdmin, me, mutate, userById, serviceById } = useApp();
  const { confirm } = useFeedback();
  const [kind, setKind] = useState<Kind>("deposits");
  const [userId, setUserId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => setOffset(0), [kind, userId, serviceId]);

  const query = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
  if (isAdmin && userId) query.set("userId", userId);
  if (!isAdmin) query.set("userId", me.id);
  if (serviceId) query.set("serviceId", serviceId);

  const { data, loading } = useResource(
    (signal) => api<PageResult<Deposit | Debit>>(`/api/${kind}?${query.toString()}`, { signal }),
    [kind, offset, userId, serviceId],
    { rows: [], total: 0, offset: 0, limit: PAGE, hasMore: false }
  );

  const cancel = async (operation: Deposit | Debit) => {
    const isDeposit = kind === "deposits";
    const amount = money(operation.amountBalanceCurrency, "RUB");
    const reason = await confirm({
      title: isDeposit ? "Отменить зачисление?" : "Отменить списание?",
      message: (
        <>
          Будет создана корректирующая операция: баланс {userById(operation.userId)?.name ?? "участника"} {isDeposit ? "уменьшится" : "увеличится"} на <strong>{amount}</strong>.
        </>
      ),
      input: { label: "Причина", placeholder: "Например: ошибка ввода" },
      confirmLabel: "Отменить операцию",
      tone: "danger"
    });
    if (reason === null) return;
    await mutate(`/api/${kind}/${operation.id}/cancel`, { body: { reason }, success: "Операция отменена" });
  };

  const services = isAdmin ? state.services : state.services.filter((service) => state.memberships.some((item) => item.serviceId === service.id && item.userId === me.id));

  return (
    <div className="page">
      <PageHeader title="История" subtitle={isAdmin ? "Все движения по балансам участников" : "Движения по вашему балансу"} />

      <Card flush>
        <div className="card-toolbar">
          <Segmented<Kind>
            label="Тип операций"
            value={kind}
            onChange={setKind}
            options={[
              { value: "deposits", label: "Зачисления" },
              { value: "debits", label: "Списания" }
            ]}
          />
          <div className="filters">
            {isAdmin && (
              <select aria-label="Участник" value={userId} onChange={(event) => setUserId(event.target.value)}>
                <option value="">Все участники</option>
                {state.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            )}
            <select aria-label="Сервис" value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
              <option value="">Все сервисы</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
            {loading && <Spinner />}
          </div>
        </div>

        {data.rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Дата</th>
                  {isAdmin && <th>Участник</th>}
                  <th>Сервис</th>
                  <th className="num">Сумма</th>
                  <th className="num">Баланс после</th>
                  {isAdmin && <th aria-label="Действия" />}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((operation) => {
                  const user = userById(operation.userId);
                  const deposit = kind === "deposits" ? (operation as Deposit) : null;
                  const debit = kind === "debits" ? (operation as Debit) : null;
                  const inactive = Boolean(operation.cancelledAt);
                  const original = deposit
                    ? deposit.currencyOriginal !== "RUB" && money(deposit.amountOriginal, deposit.currencyOriginal)
                    : debit && debit.currency !== "RUB" && money(debit.amount, debit.currency);
                  return (
                    <tr key={operation.id} className={inactive ? "row-muted" : undefined}>
                      <td className="nowrap">
                        {dateTime(operation.createdAt)}
                        <small>{SOURCE_LABELS[operation.source] ?? operation.source}</small>
                      </td>
                      {isAdmin && (
                        <td>
                          <span className="cell-person">
                            {user && <Avatar user={user} size="sm" />}
                            {user?.name ?? "Удалённый участник"}
                          </span>
                        </td>
                      )}
                      <td>
                        {serviceById(operation.serviceId)?.name ?? "—"}
                        {operation.comment && <small>{operation.comment}</small>}
                        {operation.cancellationReason && <small>Причина отмены: {operation.cancellationReason}</small>}
                      </td>
                      <td className="num">
                        <span className={kind === "deposits" ? "text-good strong" : "text-bad strong"}>
                          {kind === "deposits" ? "+" : "−"}
                          {money(operation.amountBalanceCurrency)}
                        </span>
                        {original && <small>{original}</small>}
                        <OperationStatus operation={operation} />
                      </td>
                      <td className="num">{money(operation.balanceAfter)}</td>
                      {isAdmin && (
                        <td>
                          {!operation.cancelledAt && !operation.reversesId && (
                            <button className="icon-btn" type="button" title="Отменить операцию" aria-label="Отменить операцию" onClick={() => cancel(operation)}>
                              <Undo2 size={16} />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          !loading && <Empty icon={History} title="Операций нет" text={userId || serviceId ? "Попробуйте изменить фильтры." : undefined} />
        )}
        <Pagination page={data} onChange={setOffset} />
      </Card>
    </div>
  );
}
