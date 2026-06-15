import express from "express";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Store } from "./store";
import type { BillingPeriod, Currency, Service, User } from "./types";
import {
  addDeposit,
  addNotification,
  buildNextChargeDate,
  cancelDebit,
  cancelDeposit,
  computeSummaries,
  ensureMembership,
  id,
  normalizeNumber,
  nowIso,
  roundMoney,
  runDebitForService
} from "./domain";
import {
  configureTelegramIntegration,
  disableTelegramPolling,
  enableTelegramPolling,
  handleTelegramUpdate,
  pollTelegramUpdates,
  sendLowBalanceWarnings,
  sendServiceBalanceSummary,
  sendTelegramMessage
} from "./telegram";

const app = express();
const port = Number(process.env.PORT ?? 4077);
const store = new Store();
const execFileAsync = promisify(execFile);

app.use(express.json({ limit: "25mb" }));

function ok(payload: unknown) {
  return { ok: true, payload };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  return { ok: false, error: message };
}

function apiState() {
  const data = store.read();
  return {
    ...data,
    summaries: computeSummaries(data),
    serverTime: nowIso()
  };
}

function backupFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `service-payment-backup-${stamp}.json`;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function serviceUnitName() {
  const serviceName = process.env.APP_SERVICE_NAME || process.env.SERVICE_NAME || "service-payment";
  return serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`;
}

async function runUpdateStep(command: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });

  return {
    command: [command, ...args].join(" "),
    output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(-8000)
  };
}

async function runRawUbuntuUpdate() {
  const branch = process.env.UPDATE_BRANCH || "main";
  const updateUrl =
    process.env.UPDATE_SCRIPT_URL || `https://raw.githubusercontent.com/Jetvac/service-payment/${branch}/scripts/update-ubuntu.sh`;
  const script = [
    "set -Eeuo pipefail",
    `curl -fsSL ${shellQuote(updateUrl)} | APP_DIR=${shellQuote(process.cwd())} APP_SERVICE_NAME=${shellQuote(
      serviceUnitName()
    )} BRANCH=${shellQuote(branch)} RESTART_SERVICE=false bash`
  ].join("; ");

  return runUpdateStep("bash", ["-lc", script]);
}

async function runLocalGitUpdate() {
  const steps = [];
  steps.push(await runUpdateStep("git", ["remote", "set-url", "origin", "https://github.com/Jetvac/service-payment.git"]));
  steps.push(await runUpdateStep("git", ["fetch", "--all", "--prune"]));
  steps.push(await runUpdateStep("git", ["pull", "--ff-only"]));
  steps.push(
    await runUpdateStep(npmCommand(), [
      fs.existsSync(path.resolve(process.cwd(), "package-lock.json")) ? "ci" : "install"
    ])
  );
  steps.push(await runUpdateStep(npmCommand(), ["run", "build"]));
  return steps;
}

function scheduleServiceRestart() {
  if (process.platform === "win32") {
    return { scheduled: false, reason: "Перезапуск systemd недоступен на Windows" };
  }

  const serviceUnit = serviceUnitName();

  setTimeout(() => {
    const child = spawn("sudo", ["-n", "systemctl", "restart", serviceUnit], {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => undefined);
    child.unref();
  }, 1200);

  return { scheduled: true, serviceUnit };
}

app.get("/api/state", (_req, res) => {
  res.json(ok(apiState()));
});

app.get("/api/database/export", (_req, res) => {
  const payload = JSON.stringify(store.exportData(), null, 2);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${backupFileName()}"`);
  res.send(payload);
});

app.post("/api/database/import", (req, res) => {
  try {
    store.replace(req.body);
    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/system/update", async (_req, res) => {
  try {
    const steps = process.platform === "win32" ? await runLocalGitUpdate() : [await runRawUbuntuUpdate()];

    const restart = scheduleServiceRestart();
    store.write((data) => {
      addNotification(data, {
        serviceId: data.services[0]?.id ?? "",
        userId: null,
        kind: "system",
        message: restart.scheduled
          ? `Обновление установлено. Перезапуск: ${restart.serviceUnit}`
          : `Обновление установлено. ${restart.reason}`,
        status: "sent"
      });
    });

    res.json(ok({ steps, restart }));
  } catch (error) {
    const data = store.read();
    addNotification(data, {
      serviceId: data.services[0]?.id ?? "",
      userId: null,
      kind: "system",
      message: error instanceof Error ? error.message : "Ошибка обновления",
      status: "failed"
    });
    store.persist();
    res.status(400).json(fail(error));
  }
});

app.post("/api/users", (req, res) => {
  try {
    const body = req.body as Partial<User>;
    const user: User = {
      id: id("usr"),
      name: String(body.name ?? "").trim() || "Новый участник",
      balance: roundMoney(normalizeNumber(body.balance, 0)),
      telegramId: String(body.telegramId ?? "").trim(),
      telegramUsername: String(body.telegramUsername ?? "").trim().replace(/^@/, ""),
      commandDepositsBlocked: Boolean(body.commandDepositsBlocked),
      botAdmin: Boolean(body.botAdmin),
      notes: String(body.notes ?? ""),
      createdAt: nowIso()
    };

    store.write((data) => {
      data.users.push(user);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/users/:id", (req, res) => {
  try {
    store.write((data) => {
      const user = data.users.find((item) => item.id === req.params.id);
      if (!user) throw new Error("Пользователь не найден");

      user.name = String(req.body.name ?? user.name).trim() || user.name;
      user.balance = roundMoney(normalizeNumber(req.body.balance, user.balance));
      user.telegramId = String(req.body.telegramId ?? user.telegramId).trim();
      user.telegramUsername = String(req.body.telegramUsername ?? user.telegramUsername).trim().replace(/^@/, "");
      user.commandDepositsBlocked = Boolean(req.body.commandDepositsBlocked);
      user.botAdmin = Boolean(req.body.botAdmin);
      user.notes = String(req.body.notes ?? user.notes);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.delete("/api/users/:id", (req, res) => {
  try {
    store.write((data) => {
      data.users = data.users.filter((item) => item.id !== req.params.id);
      data.memberships = data.memberships.filter((item) => item.userId !== req.params.id);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/services", (req, res) => {
  try {
    const period = String(req.body.period ?? "month") as BillingPeriod;
    const interval = Math.max(1, normalizeNumber(req.body.interval, 1));
    const anchorDay = Math.max(1, Math.min(31, normalizeNumber(req.body.anchorDay, 1)));
    const anchorHour = Math.max(0, Math.min(23, normalizeNumber(req.body.anchorHour, 12)));
    const shiftDays = normalizeNumber(req.body.shiftDays, 0);

    const service: Service = {
      id: id("svc"),
      name: String(req.body.name ?? "").trim() || "Новый сервис",
      description: String(req.body.description ?? ""),
      notes: String(req.body.notes ?? ""),
      monthlyCost: roundMoney(Math.max(0, normalizeNumber(req.body.monthlyCost, 0))),
      currency: String(req.body.currency ?? "RUB"),
      active: true,
      billing: {
        period,
        interval,
        autoDebit: Boolean(req.body.autoDebit),
        anchorDay,
        anchorHour,
        shiftDays,
        lastChargedAt: null,
        nextChargeAt: buildNextChargeDate(new Date(), period, interval, anchorDay, anchorHour, shiftDays).toISOString(),
        lowBalanceThresholdPeriods: Math.max(1, normalizeNumber(req.body.lowBalanceThresholdPeriods, 1))
      },
      createdAt: nowIso()
    };

    store.write((data) => {
      data.services.push(service);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/services/:id", (req, res) => {
  try {
    store.write((data) => {
      const service = data.services.find((item) => item.id === req.params.id);
      if (!service) throw new Error("Сервис не найден");

      service.name = String(req.body.name ?? service.name).trim() || service.name;
      service.description = String(req.body.description ?? service.description);
      service.notes = String(req.body.notes ?? service.notes ?? "");
      service.monthlyCost = roundMoney(Math.max(0, normalizeNumber(req.body.monthlyCost, service.monthlyCost)));
      service.currency = String(req.body.currency ?? service.currency);
      service.active = Boolean(req.body.active);
      service.billing.period = String(req.body.period ?? service.billing.period) as BillingPeriod;
      service.billing.interval = Math.max(1, normalizeNumber(req.body.interval, service.billing.interval));
      service.billing.autoDebit = Boolean(req.body.autoDebit);
      service.billing.anchorDay = Math.max(1, Math.min(31, normalizeNumber(req.body.anchorDay, service.billing.anchorDay)));
      service.billing.anchorHour = Math.max(0, Math.min(23, normalizeNumber(req.body.anchorHour, service.billing.anchorHour)));
      service.billing.shiftDays = normalizeNumber(req.body.shiftDays, service.billing.shiftDays);
      service.billing.lowBalanceThresholdPeriods = Math.max(
        1,
        normalizeNumber(req.body.lowBalanceThresholdPeriods, service.billing.lowBalanceThresholdPeriods)
      );
      service.billing.nextChargeAt = buildNextChargeDate(
        new Date(),
        service.billing.period,
        service.billing.interval,
        service.billing.anchorDay,
        service.billing.anchorHour,
        service.billing.shiftDays
      ).toISOString();
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.delete("/api/services/:id", (req, res) => {
  try {
    store.write((data) => {
      data.services = data.services.filter((item) => item.id !== req.params.id);
      data.memberships = data.memberships.filter((item) => item.serviceId !== req.params.id);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/services/:id/members", (req, res) => {
  try {
    store.write((data) => {
      const service = data.services.find((item) => item.id === req.params.id);
      const user = data.users.find((item) => item.id === req.body.userId);
      if (!service) throw new Error("Сервис не найден");
      if (!user) throw new Error("Пользователь не найден");
      ensureMembership(data, service.id, user.id);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.delete("/api/services/:serviceId/members/:userId", (req, res) => {
  try {
    store.write((data) => {
      const membership = data.memberships.find(
        (item) => item.serviceId === req.params.serviceId && item.userId === req.params.userId
      );
      if (membership) membership.active = false;
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/deposits", (req, res) => {
  try {
    store.write((data) => {
      addDeposit(data, {
        serviceId: String(req.body.serviceId),
        userId: String(req.body.userId),
        amount: normalizeNumber(req.body.amount, 0),
        currency: String(req.body.currency),
        comment: String(req.body.comment ?? ""),
        source: "manual"
      });
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/deposits/:id/cancel", (req, res) => {
  try {
    store.write((data) => {
      cancelDeposit(data, req.params.id, String(req.body.reason ?? ""));
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/debits/manual", async (req, res) => {
  try {
    const serviceId = String(req.body.serviceId);
    store.write((data) => {
      runDebitForService(data, serviceId, "manual");
    });

    const data = store.read();
    const service = data.services.find((item) => item.id === serviceId);
    if (service) {
      await sendServiceBalanceSummary(data, service);
      await sendLowBalanceWarnings(data, service);
      store.persist();
    }

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/debits/:id/cancel", (req, res) => {
  try {
    store.write((data) => {
      cancelDebit(data, req.params.id, String(req.body.reason ?? ""));
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/currencies", (req, res) => {
  try {
    const currency: Currency = {
      code: String(req.body.code ?? "").trim().toUpperCase(),
      name: String(req.body.name ?? "").trim(),
      symbol: String(req.body.symbol ?? "").trim(),
      rateToRub: Math.max(0.000001, normalizeNumber(req.body.rateToRub, 1)),
      updatedAt: nowIso()
    };

    store.write((data) => {
      if (!currency.code) throw new Error("Укажите код валюты");
      const existing = data.currencies.find((item) => item.code === currency.code);
      if (existing) Object.assign(existing, currency);
      else data.currencies.push(currency);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/currencies/:code", (req, res) => {
  try {
    store.write((data) => {
      const currency = data.currencies.find((item) => item.code === req.params.code.toUpperCase());
      if (!currency) throw new Error("Валюта не найдена");
      currency.name = String(req.body.name ?? currency.name);
      currency.symbol = String(req.body.symbol ?? currency.symbol);
      currency.rateToRub = Math.max(0.000001, normalizeNumber(req.body.rateToRub, currency.rateToRub));
      currency.updatedAt = nowIso();
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/settings/telegram", (req, res) => {
  try {
    store.write((data) => {
      data.settings.telegram.enabled = Boolean(req.body.enabled);
      data.settings.telegram.botToken = String(req.body.botToken ?? "");
      data.settings.telegram.chatId = String(req.body.chatId ?? "");
      data.settings.telegram.notificationTopicId = String(req.body.notificationTopicId ?? "");
      data.settings.telegram.webhookSecret = String(req.body.webhookSecret ?? data.settings.telegram.webhookSecret);
      data.settings.telegram.lowBalanceNotifications = Boolean(req.body.lowBalanceNotifications);
      data.settings.telegram.monthlySummary = Boolean(req.body.monthlySummary);
      data.settings.telegram.pollingEnabled = Boolean(req.body.pollingEnabled);
      data.settings.telegram.updateOffset = normalizeNumber(req.body.updateOffset, data.settings.telegram.updateOffset);
      data.settings.telegram.lastUpdateAt = req.body.lastUpdateAt ?? data.settings.telegram.lastUpdateAt ?? null;
      data.settings.telegram.lastError = String(req.body.lastError ?? data.settings.telegram.lastError ?? "");
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/polling/start", async (_req, res) => {
  try {
    const data = store.read();
    await enableTelegramPolling(data);
    store.persist();
    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/polling/stop", (_req, res) => {
  try {
    store.write((data) => {
      disableTelegramPolling(data);
    });
    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/configure", async (req, res) => {
  try {
    const data = store.read();
    await configureTelegramIntegration(data, String(req.body.webhookUrl ?? ""));
    store.persist();
    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/test", async (req, res) => {
  try {
    const data = store.read();
    const chatId = String(req.body.chatId ?? data.settings.telegram.chatId ?? "");
    const sent = await sendTelegramMessage(data, "Проверка связи VPN Pay. Команды доступны в меню.", chatId, {
      commandKeyboard: true
    });

    addNotification(data, {
      serviceId: data.services[0]?.id ?? "",
      userId: null,
      kind: "telegram_reply",
      message: sent ? "Telegram test sent" : "Telegram test skipped or failed",
      status: sent ? "sent" : "failed"
    });
    store.persist();
    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/webhook/:secret", async (req, res) => {
  try {
    const data = store.read();
    if (req.params.secret !== data.settings.telegram.webhookSecret) {
      res.status(403).json(fail(new Error("Некорректный webhook secret")));
      return;
    }

    await handleTelegramUpdate(data, req.body?.message ?? req.body?.edited_message ?? {});
    store.persist();
    res.json(ok({ received: true }));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

async function processDueServices() {
  const dueServices: string[] = [];

  store.write((data) => {
    for (const service of data.services) {
      if (!service.active || !service.billing.autoDebit || !service.billing.nextChargeAt) continue;
      if (new Date(service.billing.nextChargeAt) <= new Date()) {
        runDebitForService(data, service.id, "auto");
        dueServices.push(service.id);
      }
    }
  });

  const data = store.read();
  for (const serviceId of dueServices) {
    const service = data.services.find((item) => item.id === serviceId);
    if (!service) continue;
    await sendServiceBalanceSummary(data, service);
    await sendLowBalanceWarnings(data, service);
  }

  if (dueServices.length) {
    addNotification(data, {
      serviceId: dueServices[0],
      userId: null,
      kind: "system",
      message: `Автоматические списания: ${dueServices.length}`,
      status: "sent"
    });
    store.persist();
  }
}

setInterval(() => {
  processDueServices().catch((error) => {
    const data = store.read();
    addNotification(data, {
      serviceId: data.services[0]?.id ?? "",
      userId: null,
      kind: "system",
      message: error instanceof Error ? error.message : "Ошибка планировщика",
      status: "failed"
    });
    store.persist();
  });
}, 60_000);

processDueServices().catch(() => undefined);

let telegramPollingBusy = false;
setInterval(() => {
  if (telegramPollingBusy) return;
  telegramPollingBusy = true;
  const data = store.read();
  pollTelegramUpdates(data)
    .then((count) => {
      if (count > 0 || data.settings.telegram.lastError) store.persist();
    })
    .catch((error) => {
      const current = store.read();
      current.settings.telegram.lastError = error instanceof Error ? error.message : "Telegram polling error";
      addNotification(current, {
        serviceId: current.services[0]?.id ?? "",
        userId: null,
        kind: "system",
        message: current.settings.telegram.lastError,
        status: "failed"
      });
      store.persist();
    })
    .finally(() => {
      telegramPollingBusy = false;
    });
}, 4_000);

const distDir = path.resolve(process.cwd(), "dist");
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, () => {
  console.log(`VPN Payment Control API: http://localhost:${port}`);
});
