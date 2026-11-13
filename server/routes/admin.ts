import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import express, { Router, type Request, type Response } from "express";
import type { AppContext } from "../context";
import {
  addNotification,
  BALANCE_CURRENCY,
  buildNextChargeDate,
  clampInt,
  ensureMembership,
  getCurrency,
  id,
  isBillingPeriod,
  normalizeNumber,
  nowIso,
  roundMoney
} from "../domain";
import { badRequest, currentUser, HttpError, notFound, param, requireAdmin, route, sendError, text } from "../http";
import { assertStrongPassword, hashPassword, verifyPassword } from "../security";
import {
  configureTelegramIntegration,
  disableTelegramPolling,
  enableTelegramPolling,
  handleTelegramUpdate,
  sendTelegramMessage,
  type TelegramUpdate
} from "../telegram";
import type { AppData, Service } from "../types";
import { apiState, webhookUrl } from "../views";

const execFileAsync = promisify(execFile);
const maxBackupBytes = () => Math.max(100, Number(process.env.MAX_BACKUP_MB ?? 2048)) * 1024 * 1024;

function readServiceInput(data: AppData, body: Record<string, unknown>, existing?: Service) {
  const currency = String(body.currency ?? existing?.currency ?? BALANCE_CURRENCY).toUpperCase();
  if (!getCurrency(data, currency)) throw badRequest("Валюта не найдена");
  const period = body.period ?? existing?.billing.period ?? "month";
  if (!isBillingPeriod(period)) throw badRequest("Неизвестный период списания");

  const billing = {
    period,
    interval: clampInt(body.interval, 1, 365, existing?.billing.interval ?? 1),
    autoDebit: body.autoDebit === undefined ? existing?.billing.autoDebit ?? false : Boolean(body.autoDebit),
    anchorDay: clampInt(body.anchorDay, 1, 31, existing?.billing.anchorDay ?? 1),
    anchorHour: clampInt(body.anchorHour, 0, 23, existing?.billing.anchorHour ?? 12),
    shiftDays: clampInt(body.shiftDays, -27, 27, existing?.billing.shiftDays ?? 0),
    lowBalanceThresholdPeriods: clampInt(body.lowBalanceThresholdPeriods, 1, 100, existing?.billing.lowBalanceThresholdPeriods ?? 1)
  };

  return {
    name: text(body.name ?? existing?.name, 80) || existing?.name || "Новый сервис",
    description: text(body.description ?? existing?.description, 200),
    notes: String(body.notes ?? existing?.notes ?? "").slice(0, 5_000),
    monthlyCost: roundMoney(Math.min(10_000_000, Math.max(0, normalizeNumber(body.monthlyCost, existing?.monthlyCost ?? 0)))),
    currency,
    active: body.active === undefined ? existing?.active ?? true : Boolean(body.active),
    billing
  };
}

function nextChargeFor(billing: Service["billing"]) {
  return buildNextChargeDate(new Date(), billing.period, billing.interval, billing.anchorDay, billing.anchorHour, billing.shiftDays).toISOString();
}

function backupFileName(extension: "sqlite" | "json") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `service-payment-backup-${stamp}.${extension}`;
}

function serviceUnitName() {
  const serviceName = process.env.APP_SERVICE_NAME || process.env.SERVICE_NAME || "service-payment";
  return serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`;
}

async function runLocalGitUpdate() {
  const steps: Array<{ command: string; output: string }> = [];
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const commands: Array<[string, string[]]> = [
    ["git", ["fetch", "--prune"]],
    ["git", ["pull", "--ff-only"]],
    [npm, [fs.existsSync(path.resolve(process.cwd(), "package-lock.json")) ? "ci" : "install"]],
    [npm, ["run", "build"]]
  ];
  for (const [command, args] of commands) {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === "win32"
    });
    steps.push({ command: [command, ...args].join(" "), output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(-8000) });
  }
  return steps;
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Telegram webhook: public, authenticated by the secret in the path. */
export function telegramWebhookRoute({ store }: AppContext) {
  return async (req: Request, res: Response) => {
    const data = store.read();
    const secret = data.settings.telegram.webhookSecret;
    if (!secret || !constantTimeEqual(param(req, "secret"), secret)) {
      res.status(403).json({ ok: false, error: "Некорректный webhook secret" });
      return;
    }

    // Always answer 200 once the request is authentic: Telegram retries
    // anything else, and a retried "/pay" must never credit twice.
    try {
      const update = (req.body ?? {}) as TelegramUpdate;
      const updateId = Number(update.update_id);
      const settings = data.settings.telegram;
      if (!settings.enabled || !update.message) {
        res.json({ ok: true });
        return;
      }
      if (Number.isFinite(updateId)) {
        if (updateId < (settings.updateOffset || 0)) {
          res.json({ ok: true, duplicate: true });
          return;
        }
        settings.updateOffset = updateId + 1;
      }
      settings.lastUpdateAt = nowIso();
      await handleTelegramUpdate(data, update.message);
      store.persist();
    } catch (error) {
      const current = store.read();
      addNotification(current, {
        serviceId: current.services[0]?.id ?? "",
        userId: null,
        kind: "system",
        message: `Telegram webhook: ${error instanceof Error ? error.message : "ошибка обработки"}`,
        status: "failed"
      });
      store.persist();
    }
    res.json({ ok: true });
  };
}

/** Raw-body import route; registered before the global JSON parser. */
export function databaseImportRoute({ store }: AppContext) {
  const jsonParser = express.json({ limit: maxBackupBytes() });

  return async (req: Request, res: Response) => {
    let tempDir = "";
    try {
      const actor = requireAdmin(req);
      if (req.is("application/json")) {
        await new Promise<void>((resolve, reject) => jsonParser(req, res, (error?: unknown) => (error ? reject(error) : resolve())));
        store.replace(req.body);
      } else {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-payment-import-"));
        const source = path.join(tempDir, "import.sqlite");
        let received = 0;
        const limit = maxBackupBytes();
        await pipeline(
          req,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              received += chunk.length;
              if (received > limit) callback(new HttpError(413, "Резервная копия слишком большая"));
              else callback(null, chunk);
            }
          }),
          fs.createWriteStream(source, { flags: "wx" })
        );
        if (!received) throw badRequest("Файл резервной копии пустой");
        store.replaceWithDatabase(source);
      }
      res.json({ ok: true, payload: { restored: true, by: actor.id } });
    } catch (error) {
      sendError(res, error);
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

export function adminRoutes({ store }: AppContext) {
  const router = Router();
  const state = (req: Request) => apiState(store, currentUser(req), req);

  const recordTelegramError = (context: string, error: unknown) => {
    const data = store.read();
    const detail = error instanceof Error ? error.message : "Ошибка Telegram";
    data.settings.telegram.lastError = detail;
    addNotification(data, { serviceId: data.services[0]?.id ?? "", userId: null, kind: "system", message: `${context}: ${detail}`, status: "failed" });
    store.persist();
  };

  /* ---------------------------------------------------------------- services */

  router.post(
    "/services",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const input = readServiceInput(data, req.body ?? {});
        data.services.push({
          id: id("svc"),
          ...input,
          billing: { ...input.billing, lastChargedAt: null, nextChargeAt: nextChargeFor({ ...input.billing, lastChargedAt: null, nextChargeAt: null }) },
          createdAt: nowIso()
        });
      });
      return state(req);
    })
  );

  router.put(
    "/services/:id",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const service = data.services.find((item) => item.id === param(req, "id"));
        if (!service) throw notFound("Сервис не найден");
        const input = readServiceInput(data, req.body ?? {}, service);
        const previous = service.billing;
        const scheduleChanged = (["period", "interval", "anchorDay", "anchorHour", "shiftDays"] as const).some(
          (key) => previous[key] !== input.billing[key]
        );
        const reactivated = input.active && !service.active;
        Object.assign(service, input, { billing: { ...previous, ...input.billing } });
        // Saving a name or a note must not move the next charge; a new
        // schedule or a service returning from the archive starts afresh.
        if (scheduleChanged || reactivated || !previous.nextChargeAt) service.billing.nextChargeAt = nextChargeFor(service.billing);
      });
      return state(req);
    })
  );

  router.delete(
    "/services/:id",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const serviceId = param(req, "id");
        if (!data.services.some((item) => item.id === serviceId)) throw notFound("Сервис не найден");
        data.services = data.services.filter((item) => item.id !== serviceId);
        data.memberships = data.memberships.filter((item) => item.serviceId !== serviceId);
        data.autoDeposits = data.autoDeposits.filter((item) => item.serviceId !== serviceId);
        for (const post of data.wallPosts) if (post.serviceId === serviceId) post.serviceId = null;
      });
      return state(req);
    })
  );

  router.post(
    "/services/:id/members",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const service = data.services.find((item) => item.id === param(req, "id"));
        const user = data.users.find((item) => item.id === String(req.body?.userId ?? ""));
        if (!service) throw notFound("Сервис не найден");
        if (!user) throw notFound("Пользователь не найден");
        ensureMembership(data, service.id, user.id);
      });
      return state(req);
    })
  );

  router.delete(
    "/services/:serviceId/members/:userId",
    route((req) => {
      requireAdmin(req);
      const serviceId = param(req, "serviceId");
      const userId = param(req, "userId");
      store.write((data) => {
        const membership = data.memberships.find((item) => item.serviceId === serviceId && item.userId === userId);
        if (membership) membership.active = false;
        const fallback = data.memberships.find((item) => item.userId === userId && item.active && item.serviceId !== serviceId);
        for (const schedule of data.autoDeposits.filter((item) => item.userId === userId && item.serviceId === serviceId)) {
          if (fallback) schedule.serviceId = fallback.serviceId;
          else schedule.enabled = false;
          schedule.updatedAt = nowIso();
        }
      });
      return state(req);
    })
  );

  /* -------------------------------------------------------------- currencies */

  const readRate = (value: unknown, fallback: number) => {
    const rate = normalizeNumber(value, fallback);
    if (!(rate > 0) || rate > 1_000_000) throw badRequest("Курс должен быть больше нуля");
    return Math.round(rate * 1_000_000) / 1_000_000;
  };

  router.post(
    "/currencies",
    route((req) => {
      requireAdmin(req);
      const code = text(req.body?.code, 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) throw badRequest("Код валюты — три латинские буквы, например USD");
      store.write((data) => {
        if (getCurrency(data, code)) throw badRequest("Такая валюта уже есть");
        data.currencies.push({
          code,
          name: text(req.body?.name, 60) || code,
          symbol: text(req.body?.symbol, 6),
          rateToRub: readRate(req.body?.rateToRub, 1),
          updatedAt: nowIso()
        });
      });
      return state(req);
    })
  );

  router.put(
    "/currencies/:code",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const currency = getCurrency(data, param(req, "code").toUpperCase());
        if (!currency) throw notFound("Валюта не найдена");
        currency.name = text(req.body?.name ?? currency.name, 60) || currency.code;
        currency.symbol = text(req.body?.symbol ?? currency.symbol, 6);
        // The balance currency is the base of every conversion; its rate is always 1.
        currency.rateToRub = currency.code === BALANCE_CURRENCY ? 1 : readRate(req.body?.rateToRub, currency.rateToRub);
        currency.updatedAt = nowIso();
      });
      return state(req);
    })
  );

  /* ---------------------------------------------------------------- settings */

  router.put(
    "/settings/payments",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const current = data.settings.payments;
        const body = req.body ?? {};
        data.settings.payments = {
          manualEnabled: body.manualEnabled === undefined ? current.manualEnabled : Boolean(body.manualEnabled),
          recipientName: text(body.recipientName ?? current.recipientName, 120),
          bankName: text(body.bankName ?? current.bankName, 120),
          phone: text(body.phone ?? current.phone, 40),
          account: text(body.account ?? current.account, 80),
          paymentPurpose: text(body.paymentPurpose ?? current.paymentPurpose, 200)
        };
      });
      return state(req);
    })
  );

  router.put(
    "/settings/telegram",
    route((req) => {
      requireAdmin(req);
      const body = req.body ?? {};
      store.write((data) => {
        const telegram = data.settings.telegram;
        // Polling state, update offset and diagnostics are owned by the
        // server. Accepting them from a form would let a stale page rewind
        // the offset and replay old "/pay" commands.
        if (body.enabled !== undefined) telegram.enabled = Boolean(body.enabled);
        const botToken = text(body.botToken, 200);
        if (botToken) {
          if (!/^\d+:[\w-]+$/.test(botToken)) throw badRequest("Bot token выглядит неверно: ожидается формат 123456:ABC...");
          if (botToken !== telegram.botToken) telegram.updateOffset = 0;
          telegram.botToken = botToken;
        }
        if (body.chatId !== undefined) telegram.chatId = text(body.chatId, 40);
        if (body.notificationTopicId !== undefined) telegram.notificationTopicId = text(body.notificationTopicId, 20);
        const webhookSecret = text(body.webhookSecret, 120);
        if (webhookSecret) {
          if (!/^[\w-]{8,}$/.test(webhookSecret)) throw badRequest("Webhook secret: минимум 8 символов, латиница, цифры, _ и -");
          telegram.webhookSecret = webhookSecret;
        }
        if (body.lowBalanceNotifications !== undefined) telegram.lowBalanceNotifications = Boolean(body.lowBalanceNotifications);
        if (body.monthlySummary !== undefined) telegram.monthlySummary = Boolean(body.monthlySummary);
      });
      return state(req);
    })
  );

  router.put(
    "/settings/security",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        if (!verifyPassword(data.settings.security.adminPassword, String(req.body?.currentPassword ?? ""))) {
          throw badRequest("Неверный текущий пароль администратора");
        }
        const nextPassword = String(req.body?.newPassword ?? "").trim();
        assertStrongPassword(nextPassword);
        data.settings.security.adminPassword = hashPassword(nextPassword);
        data.settings.security.adminPasswordSet = true;
      });
      return state(req);
    })
  );

  /* ---------------------------------------------------------------- telegram */

  router.post(
    "/telegram/polling/start",
    route(async (req) => {
      requireAdmin(req);
      if (!store.read().settings.telegram.enabled) throw badRequest("Сначала включите бота в настройках");
      try {
        await enableTelegramPolling(store.read());
        store.persist();
      } catch (error) {
        recordTelegramError("Запуск polling", error);
        throw error;
      }
      return state(req);
    })
  );

  router.post(
    "/telegram/polling/stop",
    route((req) => {
      requireAdmin(req);
      store.write((data) => disableTelegramPolling(data));
      return state(req);
    })
  );

  router.post(
    "/telegram/configure",
    route(async (req) => {
      requireAdmin(req);
      const data = store.read();
      const url = webhookUrl(req, data);
      if (!url) throw badRequest("Сначала сохраните webhook secret");
      if (!url.startsWith("https://")) throw badRequest("Telegram принимает webhook только по HTTPS. Задайте PUBLIC_BASE_URL или используйте polling");
      try {
        await configureTelegramIntegration(data, url);
        store.persist();
      } catch (error) {
        recordTelegramError("Настройка webhook", error);
        throw error;
      }
      return state(req);
    })
  );

  router.post(
    "/telegram/test",
    route(async (req) => {
      requireAdmin(req);
      const data = store.read();
      if (!data.settings.telegram.enabled) throw badRequest("Сначала включите бота в настройках");
      const chatId = text(req.body?.chatId, 40) || data.settings.telegram.chatId;
      if (!chatId) throw badRequest("Укажите Chat ID");
      const sent = await sendTelegramMessage(data, "Проверка связи VPN Pay. Команды доступны в меню.", chatId, { removeKeyboard: true });
      if (!sent) {
        store.persist();
        throw badRequest(data.settings.telegram.lastError || "Telegram не подтвердил отправку тестового сообщения");
      }
      addNotification(data, { serviceId: data.services[0]?.id ?? "", userId: null, kind: "telegram_reply", message: "Тестовое сообщение отправлено", status: "sent" });
      store.persist();
      return state(req);
    })
  );

  /* ---------------------------------------------------------------- backups */

  router.get("/database/export", async (req, res) => {
    let tempDir = "";
    try {
      requireAdmin(req);
      const fileName = backupFileName("sqlite");
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-payment-export-"));
      const destination = path.join(tempDir, fileName);
      await store.backupTo(destination);
      res.setHeader("Content-Type", "application/vnd.sqlite3");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.sendFile(destination, () => fs.rmSync(tempDir, { recursive: true, force: true }));
    } catch (error) {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      sendError(res, error);
    }
  });

  /** Legacy JSON backup: the format of earlier releases, still accepted by import. */
  router.get(
    "/database/export.json",
    route((req, res) => {
      requireAdmin(req);
      const fileName = backupFileName("json");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.send(JSON.stringify(store.exportLegacyJson(), null, 2));
      return undefined;
    })
  );

  /* ------------------------------------------------------------------ update */

  router.post(
    "/system/update",
    route(async (req, res) => {
      requireAdmin(req);
      try {
        let result: Record<string, unknown>;
        if (process.platform === "win32") {
          result = { scheduled: false, steps: await runLocalGitUpdate(), restartRequired: true };
        } else {
          const updateUnit = serviceUnitName().replace(/\.service$/, "-update.service");
          await execFileAsync("sudo", ["-n", "systemctl", "start", "--no-block", updateUnit]);
          result = { scheduled: true, logPath: path.resolve(process.cwd(), "data", "logs", "update.log") };
        }
        store.write((data) => {
          addNotification(data, {
            serviceId: data.services[0]?.id ?? "",
            userId: null,
            kind: "system",
            message: result.scheduled
              ? "Безопасное обновление запущено. После сборки сервис перезапустится автоматически"
              : "Обновление установлено; перезапустите приложение",
            status: "sent"
          });
        });
        res.status(202);
        return result;
      } catch (error) {
        store.write((data) => {
          addNotification(data, {
            serviceId: data.services[0]?.id ?? "",
            userId: null,
            kind: "system",
            message: `Обновление: ${error instanceof Error ? error.message : "ошибка"}`,
            status: "failed"
          });
        });
        throw error;
      }
    })
  );

  return router;
}
