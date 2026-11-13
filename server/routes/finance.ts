import { Router, type Request } from "express";
import type { AppContext } from "../context";
import {
  addDeposit,
  buildNextAutoDepositDate,
  cancelDebit,
  cancelDeposit,
  clampInt,
  getCurrency,
  id,
  normalizeNumber,
  nowIso,
  roundMoney,
  runAutoDepositSchedule,
  runDebitForService
} from "../domain";
import { badRequest, currentUser, forbidden, notFound, pageResult, param, readPage, requireAdmin, route, text } from "../http";
import type { AppData, AutoDeposit, PaymentIntent, User } from "../types";
import { apiState, dashboardData } from "../views";
import { notifyAfterDebit } from "../jobs";

const MAX_PAYMENT = 1_000_000;

/** Admins may look at anyone (or everyone); participants only at themselves. */
function scopedUserId(req: Request, actor: User) {
  const requested = String(req.query.userId ?? "");
  return actor.botAdmin ? requested : actor.id;
}

function filterOperations<T extends { userId: string; serviceId: string }>(rows: T[], userId: string, serviceId: string) {
  return rows.filter((row) => (!userId || row.userId === userId) && (!serviceId || row.serviceId === serviceId));
}

function readAutoDepositInput(data: AppData, body: Partial<AutoDeposit>, existing?: AutoDeposit) {
  const userId = String(body.userId ?? existing?.userId ?? "");
  if (!data.users.some((item) => item.id === userId)) throw badRequest("Пользователь не найден");

  const requestedServiceId = String(body.serviceId ?? existing?.serviceId ?? "");
  const memberships = data.memberships.filter((membership) => membership.userId === userId && membership.active);
  if (!memberships.length) throw badRequest("Для автоплатежа нужно закрепить участника за сервисом");
  const serviceId = memberships.some((membership) => membership.serviceId === requestedServiceId)
    ? requestedServiceId
    : memberships.find((membership) => data.services.some((service) => service.id === membership.serviceId && service.active))?.serviceId ??
      memberships[0].serviceId;

  const amount = roundMoney(normalizeNumber(body.amount, existing?.amount ?? 0));
  if (!(amount > 0) || amount > MAX_PAYMENT) throw badRequest("Сумма автоплатежа должна быть от 0,01 до 1 000 000");

  const currency = String(body.currency ?? existing?.currency ?? "RUB").toUpperCase();
  if (!getCurrency(data, currency)) throw badRequest("Валюта не найдена");

  const dayOfMonth = clampInt(body.dayOfMonth, 1, 31, existing?.dayOfMonth ?? 1);
  const hour = clampInt(body.hour, 0, 23, existing?.hour ?? 12);
  const scheduleChanged = !existing || existing.dayOfMonth !== dayOfMonth || existing.hour !== hour;

  return {
    userId,
    serviceId,
    amount,
    currency,
    dayOfMonth,
    hour,
    enabled: body.enabled === undefined ? existing?.enabled ?? true : Boolean(body.enabled),
    comment: text(body.comment ?? existing?.comment, 300),
    nextDepositAt:
      scheduleChanged || !existing?.nextDepositAt
        ? buildNextAutoDepositDate(new Date(), dayOfMonth, hour).toISOString()
        : existing.nextDepositAt
  };
}

export function financeRoutes({ store }: AppContext) {
  const router = Router();
  const state = (req: Request) => apiState(store, currentUser(req), req);

  router.get(
    "/dashboard",
    route((req) => dashboardData(store.read(), currentUser(req), req.query as Record<string, unknown>))
  );

  router.get(
    "/notifications",
    route((req) => {
      const actor = currentUser(req);
      const { offset, limit } = readPage(req.query as Record<string, unknown>, 20, 100);
      const rows = store.read().notifications.filter((item) => actor.botAdmin || item.userId === actor.id);
      return pageResult(rows, offset, limit);
    })
  );

  /* ---------------------------------------------------------------- payments */

  router.get(
    "/payments",
    route((req) => {
      const actor = currentUser(req);
      const { offset, limit } = readPage(req.query as Record<string, unknown>, 20, 100);
      const rows = filterOperations(store.read().payments, scopedUserId(req, actor), String(req.query.serviceId ?? ""))
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return pageResult(rows, offset, limit);
    })
  );

  /**
   * Records a payment entered by hand and credits it immediately. Participants
   * can record only their own payments and only while manual entry is on;
   * administrators can always record a payment for any participant.
   */
  router.post(
    "/payments",
    route((req) => {
      const actor = currentUser(req);
      const body = req.body ?? {};
      const userId = actor.botAdmin && body.userId ? String(body.userId) : actor.id;
      if (!actor.botAdmin && body.userId && String(body.userId) !== actor.id) throw forbidden("Можно вносить оплату только за себя");

      let paymentId = "";
      store.write((data) => {
        if (!actor.botAdmin && !data.settings.payments.manualEnabled) throw badRequest("Внесение оплаты отключено администратором");
        const user = data.users.find((item) => item.id === userId);
        if (!user) throw notFound("Пользователь не найден");
        const serviceId = String(body.serviceId ?? "");
        const service = data.services.find((item) => item.id === serviceId);
        if (!service) throw badRequest("Выберите сервис");
        if (!service.active) throw badRequest("Сервис в архиве");
        const amount = roundMoney(normalizeNumber(body.amount, 0));
        if (!(amount > 0) || amount > MAX_PAYMENT) throw badRequest("Укажите сумму от 0,01 до 1 000 000");
        const currency = String(body.currency || service.currency).toUpperCase();
        const comment = text(body.comment, 500);

        const deposit = addDeposit(data, {
          serviceId,
          userId,
          amount,
          currency,
          comment: comment || (actor.id === userId ? "Оплата внесена вручную" : `Оплата внесена администратором ${actor.name}`),
          source: "manual"
        });

        const createdAt = nowIso();
        const payment: PaymentIntent = {
          id: id("pay"),
          userId,
          serviceId,
          amount,
          currency,
          method: "manual",
          provider: "manual",
          status: "succeeded",
          externalId: "",
          confirmationUrl: "",
          description: `Пополнение ${service.name}: ${user.name}`.slice(0, 128),
          comment,
          depositId: deposit.id,
          failureReason: "",
          createdAt,
          updatedAt: createdAt,
          paidAt: createdAt
        };
        data.payments.unshift(payment);
        paymentId = payment.id;
      });

      return { payment: store.read().payments.find((item) => item.id === paymentId), state: state(req) };
    })
  );

  /* ------------------------------------------------------------------ ledger */

  router.get(
    "/deposits",
    route((req) => {
      const actor = currentUser(req);
      const { offset, limit } = readPage(req.query as Record<string, unknown>, 20, 100);
      const rows = filterOperations(store.read().deposits, scopedUserId(req, actor), String(req.query.serviceId ?? ""));
      return pageResult(rows, offset, limit);
    })
  );

  router.get(
    "/debits",
    route((req) => {
      const actor = currentUser(req);
      const { offset, limit } = readPage(req.query as Record<string, unknown>, 20, 100);
      const rows = filterOperations(store.read().debits, scopedUserId(req, actor), String(req.query.serviceId ?? ""));
      return pageResult(rows, offset, limit);
    })
  );

  router.post(
    "/deposits/:id/cancel",
    route((req) => {
      const actor = requireAdmin(req);
      store.write((data) => {
        cancelDeposit(data, param(req, "id"), text(req.body?.reason, 300) || `Отменено администратором ${actor.name}`);
      });
      return state(req);
    })
  );

  router.post(
    "/debits/:id/cancel",
    route((req) => {
      const actor = requireAdmin(req);
      store.write((data) => {
        cancelDebit(data, param(req, "id"), text(req.body?.reason, 300) || `Отменено администратором ${actor.name}`);
      });
      return state(req);
    })
  );

  router.post(
    "/debits/manual",
    route(async (req) => {
      requireAdmin(req);
      const serviceId = String(req.body?.serviceId ?? "");
      let charged = 0;
      store.write((data) => {
        const service = data.services.find((item) => item.id === serviceId);
        if (!service) throw notFound("Сервис не найден");
        if (!service.active) throw badRequest("Сервис в архиве");
        charged = runDebitForService(data, serviceId, "manual").length;
      });
      // The debit is committed; a Telegram problem must not look like a failed charge.
      await notifyAfterDebit(store, serviceId);
      return { charged, state: state(req) };
    })
  );

  /* ------------------------------------------------------------ auto deposit */

  router.post(
    "/auto-deposits",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const createdAt = nowIso();
        data.autoDeposits.unshift({
          id: id("apm"),
          ...readAutoDepositInput(data, req.body ?? {}),
          lastDepositedAt: null,
          createdAt,
          updatedAt: createdAt
        });
      });
      return state(req);
    })
  );

  router.put(
    "/auto-deposits/:id",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const schedule = data.autoDeposits.find((item) => item.id === param(req, "id"));
        if (!schedule) throw notFound("Автоплатёж не найден");
        Object.assign(schedule, readAutoDepositInput(data, req.body ?? {}, schedule), { updatedAt: nowIso() });
      });
      return state(req);
    })
  );

  router.delete(
    "/auto-deposits/:id",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        data.autoDeposits = data.autoDeposits.filter((item) => item.id !== param(req, "id"));
      });
      return state(req);
    })
  );

  router.post(
    "/auto-deposits/:id/run",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        runAutoDepositSchedule(data, param(req, "id"), { advance: false });
      });
      return state(req);
    })
  );

  return router;
}
