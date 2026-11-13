import { addNotification, advanceAutoDepositDate, buildNextAutoDepositDate, nowIso, runAutoDepositSchedule, runDebitForService } from "./domain";
import type { Store } from "./store";
import { pollTelegramUpdates, sendLowBalanceWarnings, sendServiceBalanceSummary } from "./telegram";

/**
 * Sends the post-debit summary and low-balance warnings. The debit is already
 * committed, so a delivery problem is recorded instead of being thrown: a
 * thrown error would make the caller retry and charge everyone twice.
 */
export async function notifyAfterDebit(store: Store, serviceId: string) {
  try {
    const data = store.read();
    const service = data.services.find((item) => item.id === serviceId);
    if (!service) return;
    await sendServiceBalanceSummary(data, service);
    await sendLowBalanceWarnings(data, service);
    store.persist();
  } catch (error) {
    const data = store.read();
    const message = error instanceof Error ? error.message : "Ошибка уведомления Telegram";
    data.settings.telegram.lastError = message;
    addNotification(data, {
      serviceId,
      userId: null,
      kind: "system",
      message: `Списание сохранено, но уведомление не отправлено: ${message}`,
      status: "failed"
    });
    store.persist();
  }
}

/** Charges every service whose automatic debit is due. Each service is isolated. */
export async function processDueServices(store: Store, now = new Date()) {
  const charged: string[] = [];
  const due = store
    .read()
    .services.filter(
      (service) => service.active && service.billing.autoDebit && service.billing.nextChargeAt && new Date(service.billing.nextChargeAt) <= now
    )
    .map((service) => service.id);

  for (const serviceId of due) {
    try {
      store.write((data) => {
        runDebitForService(data, serviceId, "auto");
      });
      charged.push(serviceId);
    } catch (error) {
      // Record the problem and push the schedule forward, otherwise the same
      // failure would repeat (and notify) every minute.
      store.write((data) => {
        const service = data.services.find((item) => item.id === serviceId);
        if (service) service.billing.autoDebit = false;
        addNotification(data, {
          serviceId,
          userId: null,
          kind: "system",
          message: `Автосписание отключено из-за ошибки: ${error instanceof Error ? error.message : "неизвестная ошибка"}`,
          status: "failed"
        });
      });
    }
  }

  for (const serviceId of charged) await notifyAfterDebit(store, serviceId);
  return charged.length;
}

export function processDueAutoDeposits(store: Store, now = new Date()) {
  let processed = 0;
  let failed = 0;

  store.write((data) => {
    for (const schedule of data.autoDeposits) {
      if (!schedule.enabled) continue;

      if (!schedule.nextDepositAt || Number.isNaN(new Date(schedule.nextDepositAt).getTime())) {
        schedule.nextDepositAt = buildNextAutoDepositDate(now, schedule.dayOfMonth, schedule.hour).toISOString();
        continue;
      }

      // Catch up missed months (server downtime), but never loop forever.
      for (let guard = 0; guard < 24 && new Date(schedule.nextDepositAt!) <= now; guard += 1) {
        try {
          runAutoDepositSchedule(data, schedule.id, { advance: true });
          processed += 1;
        } catch (error) {
          failed += 1;
          addNotification(data, {
            serviceId: schedule.serviceId || data.services[0]?.id || "",
            userId: schedule.userId,
            kind: "system",
            message: `Автоплатёж: ${error instanceof Error ? error.message : "ошибка"}`,
            status: "failed"
          });
          schedule.nextDepositAt = advanceAutoDepositDate(schedule, new Date(schedule.nextDepositAt!)).toISOString();
          schedule.updatedAt = nowIso();
          break;
        }
      }
    }

    if (processed || failed) {
      addNotification(data, {
        serviceId: data.services[0]?.id ?? "",
        userId: null,
        kind: "system",
        message: `Автоплатежи: ${processed}, ошибки: ${failed}`,
        status: failed ? "failed" : "sent"
      });
    }
  });

  return { processed, failed };
}

/** Starts the minute schedulers and the Telegram polling loop. Returns a stop function. */
export function startBackgroundJobs(store: Store) {
  const timers: NodeJS.Timeout[] = [];

  const reportSchedulerError = (error: unknown) => {
    store.write((data) => {
      addNotification(data, {
        serviceId: data.services[0]?.id ?? "",
        userId: null,
        kind: "system",
        message: `Планировщик: ${error instanceof Error ? error.message : "ошибка"}`,
        status: "failed"
      });
    });
  };

  const tick = () => {
    try {
      processDueAutoDeposits(store);
    } catch (error) {
      reportSchedulerError(error);
    }
    processDueServices(store).catch(reportSchedulerError);
  };
  tick();
  timers.push(setInterval(tick, 60_000));

  // Telegram polling with exponential backoff; repeated identical errors are
  // logged at most once every 15 minutes.
  let busy = false;
  let failures = 0;
  let nextAttemptAt = 0;
  let lastNotification = "";
  let lastNotificationAt = 0;

  timers.push(
    setInterval(() => {
      if (busy || Date.now() < nextAttemptAt) return;
      busy = true;
      const data = store.read();
      const previousError = data.settings.telegram.lastError;
      pollTelegramUpdates(data)
        .then((count) => {
          failures = 0;
          nextAttemptAt = 0;
          if (count > 0 || previousError) store.persist();
        })
        .catch((error) => {
          const current = store.read();
          const message = error instanceof Error ? error.message : "Telegram polling error";
          const errorChanged = current.settings.telegram.lastError !== message;
          current.settings.telegram.lastError = message;
          failures += 1;
          nextAttemptAt = Date.now() + Math.min(5 * 60_000, 4_000 * 2 ** Math.min(failures - 1, 7));

          const shouldNotify = lastNotification !== message || Date.now() - lastNotificationAt >= 15 * 60_000;
          if (shouldNotify) {
            addNotification(current, { serviceId: current.services[0]?.id ?? "", userId: null, kind: "system", message, status: "failed" });
            lastNotification = message;
            lastNotificationAt = Date.now();
          }
          if (errorChanged || shouldNotify) store.persist();
        })
        .finally(() => {
          busy = false;
        });
    }, 4_000)
  );

  return () => timers.forEach((timer) => clearInterval(timer));
}
