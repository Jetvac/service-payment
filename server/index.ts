import express from "express";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "ssh2";
import { Store } from "./store";
import type { AppData, AutoDeposit, BillingPeriod, Currency, Service, ServiceConnectionSettings, ServiceHealthStatus, User } from "./types";
import {
  addDeposit,
  addNotification,
  advanceAutoDepositDate,
  buildNextAutoDepositDate,
  buildNextChargeDate,
  cancelDebit,
  cancelDeposit,
  computeSummaries,
  defaultServiceConnection,
  ensureMembership,
  id,
  normalizeNumber,
  nowIso,
  roundMoney,
  runAutoDepositSchedule,
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
  sendServiceMaintenanceNotice,
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

function publicData(data: AppData) {
  const clone = JSON.parse(JSON.stringify(data)) as AppData;

  clone.services = clone.services.map((service) => {
    const source = data.services.find((item) => item.id === service.id);
    const connection = { ...defaultServiceConnection(), ...(service.connection ?? {}) };
    connection.password = "";
    connection.passwordSet = Boolean(source?.connection?.password);
    return { ...service, connection };
  });

  return clone;
}

function apiState() {
  const data = store.read();
  return {
    ...publicData(data),
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

function normalizeConnectionInput(body: Partial<ServiceConnectionSettings> | undefined, fallback?: ServiceConnectionSettings) {
  const base = { ...defaultServiceConnection(), ...(fallback ?? {}) };
  const input = body ?? {};
  const passwordInput = typeof input.password === "string" ? input.password : "";
  const websocketPath = String(input.websocketPath ?? base.websocketPath ?? "/echo").trim() || "/echo";

  return {
    ...base,
    enabled: Boolean(input.enabled ?? base.enabled),
    host: String(input.host ?? base.host ?? "").trim(),
    port: Math.max(1, Math.min(65535, normalizeNumber(input.port, base.port || 8765))),
    sshPort: Math.max(1, Math.min(65535, normalizeNumber(input.sshPort, base.sshPort || 22))),
    user: String(input.user ?? base.user ?? "").trim(),
    password: passwordInput ? passwordInput : base.password,
    passwordSet: Boolean(passwordInput || base.password),
    websocketPath: websocketPath.startsWith("/") ? websocketPath : `/${websocketPath}`,
    useTls: Boolean(input.useTls ?? base.useTls),
    lastStatus: base.lastStatus,
    lastLatencyMs: base.lastLatencyMs,
    lastCheckedAt: base.lastCheckedAt,
    lastError: base.lastError,
    lastDeployStatus: base.lastDeployStatus,
    lastDeployAt: base.lastDeployAt,
    lastDeployOutput: base.lastDeployOutput
  };
}

function normalizeHealthStatus(value: unknown): ServiceHealthStatus {
  return value === "online" || value === "offline" || value === "unknown" || value === "maintenance" ? value : "unknown";
}

async function telegramJson(token: string, method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: {
      photos?: Array<Array<{ file_id: string; file_size?: number }>>;
      file_path?: string;
    };
  } | null;
}

async function tryFetchTelegramAvatar(data: AppData, user: User) {
  const token = data.settings.telegram.botToken;
  const telegramId = user.telegramId.trim();
  if (!token || !telegramId) return user.avatarUrl ?? "";

  try {
    const photos = await telegramJson(token, "getUserProfilePhotos", { user_id: telegramId, limit: 1 });
    const sizes = photos?.ok ? photos.result?.photos?.[0] ?? [] : [];
    const photo = sizes.sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).at(-1);
    if (!photo?.file_id) return user.avatarUrl ?? "";

    const file = await telegramJson(token, "getFile", { file_id: photo.file_id });
    const filePath = file?.ok ? file.result?.file_path : "";
    if (!filePath) return user.avatarUrl ?? "";

    const image = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!image.ok) return user.avatarUrl ?? "";
    const contentType = image.headers.get("content-type") || "image/jpeg";
    const bytes = Buffer.from(await image.arrayBuffer());
    if (!bytes.length || bytes.length > 1024 * 1024) return user.avatarUrl ?? "";
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return user.avatarUrl ?? "";
  }
}

function applyUserInput(user: User, body: Partial<User>) {
  user.name = String(body.name ?? user.name).trim() || user.name;
  user.balance = roundMoney(normalizeNumber(body.balance, user.balance));
  user.telegramId = String(body.telegramId ?? user.telegramId).trim();
  user.telegramUsername = String(body.telegramUsername ?? user.telegramUsername).trim().replace(/^@/, "");
  user.avatarUrl = String(body.avatarUrl ?? user.avatarUrl ?? "");
  user.commandDepositsBlocked = Boolean(body.commandDepositsBlocked);
  user.botAdmin = Boolean(body.botAdmin);
  user.notes = String(body.notes ?? user.notes);
}

const echoServerRepoUrl = "https://github.com/LazyDoomSlayer/rust-websocket-server.git";
const echoServerServiceName = "rust-websocket-echo-server";

function buildEchoServerDeployScript(password: string) {
  const passwordBase64 = Buffer.from(password, "utf8").toString("base64");
  const unitFile = `[Unit]
Description=Rust WebSocket Echo Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/${echoServerServiceName}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;

  return [
    "set -Eeuo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    `SUDO_PASSWORD="$(printf '%s' ${shellQuote(passwordBase64)} | base64 -d)"`,
    "run_sudo() { if [ \"$(id -u)\" -eq 0 ]; then \"$@\"; else printf '%s\\n' \"$SUDO_PASSWORD\" | sudo -S -p '' \"$@\"; fi; }",
    "echo 'Checking sudo access'",
    "run_sudo true",
    "echo 'Installing system dependencies'",
    "run_sudo apt-get update -y",
    "run_sudo apt-get install -y ca-certificates curl git build-essential pkg-config libssl-dev",
    "if ! command -v cargo >/dev/null 2>&1; then echo 'Installing Rust toolchain'; curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal; fi",
    "if [ -f \"$HOME/.cargo/env\" ]; then . \"$HOME/.cargo/env\"; fi",
    "if ! command -v cargo >/dev/null 2>&1; then echo 'cargo not found after rustup installation'; exit 1; fi",
    "APP_DIR='/opt/rust-websocket-server'",
    `REPO_URL=${shellQuote(echoServerRepoUrl)}`,
    "echo 'Fetching repository'",
    "if [ -d \"$APP_DIR/.git\" ]; then run_sudo chown -R \"$(id -un):$(id -gn)\" \"$APP_DIR\" || true; git -C \"$APP_DIR\" fetch --depth 1 origin main; git -C \"$APP_DIR\" reset --hard FETCH_HEAD; else run_sudo rm -rf \"$APP_DIR\"; run_sudo mkdir -p \"$APP_DIR\"; run_sudo chown \"$(id -un):$(id -gn)\" \"$APP_DIR\"; git clone --depth 1 \"$REPO_URL\" \"$APP_DIR\"; fi",
    "cd \"$APP_DIR\"",
    "echo 'Building release binary'",
    "cargo build --release",
    "BIN=\"$(find target/release -maxdepth 1 -type f -perm /111 \\( -name 'rust-websocket-server' -o -name 'rust-websocket-echo-server' \\) | head -n 1)\"",
    "if [ -z \"$BIN\" ]; then echo 'Release binary not found'; find target/release -maxdepth 1 -type f -print; exit 1; fi",
    "echo 'Installing binary'",
    `run_sudo install -m 755 "$BIN" /usr/local/bin/${echoServerServiceName}`,
    `printf '%s' ${shellQuote(unitFile)} | run_sudo tee /etc/systemd/system/${echoServerServiceName}.service >/dev/null`,
    "run_sudo systemctl daemon-reload",
    `run_sudo systemctl enable ${echoServerServiceName}.service`,
    `run_sudo systemctl restart ${echoServerServiceName}.service`,
    "if command -v ufw >/dev/null 2>&1 && run_sudo ufw status | grep -qi active; then run_sudo ufw allow 8765/tcp || true; fi",
    "sleep 1",
    `run_sudo systemctl --no-pager --full status ${echoServerServiceName}.service | sed -n '1,18p' || true`,
    "echo 'Echo server is deployed on ws://0.0.0.0:8765/echo'"
  ].join("\n");
}

function appendOutput(current: string, chunk: Buffer | string) {
  return (current + chunk.toString()).slice(-12000);
}

function runSshScript(service: Service, script: string) {
  const connection = service.connection;
  return new Promise<string>((resolve, reject) => {
    const client = new Client();
    let output = "";
    let settled = false;
    let streamStarted = false;

    const finish = (error?: Error, result = output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      if (error) {
        (error as Error & { output?: string }).output = result;
        reject(error);
      } else {
        resolve(result);
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error("SSH deploy timeout"), output);
    }, 10 * 60 * 1000);

    client
      .on("ready", () => {
        client.exec("bash -s", { pty: true }, (error, stream) => {
          if (error) {
            finish(error);
            return;
          }

          streamStarted = true;
          stream
            .on("close", (code: number | null) => {
              if (code === 0) {
                finish(undefined, output);
              } else {
                finish(new Error(`SSH deploy failed with exit code ${code ?? "unknown"}`), output);
              }
            })
            .on("data", (chunk: Buffer) => {
              output = appendOutput(output, chunk);
            })
            .stderr.on("data", (chunk: Buffer) => {
              output = appendOutput(output, chunk);
            });

          stream.end(script);
        });
      })
      .on("error", (error) => {
        finish(error, streamStarted ? output : appendOutput(output, error.message));
      })
      .connect({
        host: connection.host,
        port: connection.sshPort || 22,
        username: connection.user,
        password: connection.password,
        readyTimeout: 20000
      });
  });
}

async function deployEchoServer(service: Service) {
  const connection = { ...defaultServiceConnection(), ...(service.connection ?? {}) };
  if (!connection.host.trim()) throw new Error("Укажите IP / host сервиса");
  if (!connection.user.trim()) throw new Error("Укажите SSH user");
  if (!connection.password) throw new Error("Укажите SSH pass и сохраните сервис");

  return runSshScript({ ...service, connection }, buildEchoServerDeployScript(connection.password));
}

function normalizeAutoDepositInput(data: AppData, body: Partial<AutoDeposit>, fallback?: AutoDeposit) {
  const userId = String(body.userId ?? fallback?.userId ?? "");
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw new Error("РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ");

  const requestedServiceId = String(body.serviceId ?? fallback?.serviceId ?? "");
  const activeMemberships = data.memberships.filter((membership) => membership.userId === userId && membership.active);
  const serviceId =
    activeMemberships.find((membership) => membership.serviceId === requestedServiceId)?.serviceId ??
    activeMemberships.find((membership) => data.services.some((service) => service.id === membership.serviceId && service.active))?.serviceId ??
    activeMemberships[0]?.serviceId ??
    "";

  if (!serviceId) {
    throw new Error("Для автоплатежа нужно закрепить участника за сервисом");
  }

  const amount = roundMoney(Math.max(0, normalizeNumber(body.amount, fallback?.amount ?? 0)));
  if (amount <= 0) throw new Error("Сумма автоплатежа должна быть больше нуля");

  const currency = String(body.currency ?? fallback?.currency ?? "RUB").toUpperCase();
  if (!data.currencies.some((item) => item.code === currency)) throw new Error("Валюта не найдена");

  const dayOfMonth = Math.max(1, Math.min(31, normalizeNumber(body.dayOfMonth, fallback?.dayOfMonth ?? 1)));
  const hour = Math.max(0, Math.min(23, normalizeNumber(body.hour, fallback?.hour ?? 12)));

  return {
    userId,
    serviceId,
    amount,
    currency,
    dayOfMonth,
    hour,
    enabled: body.enabled ?? fallback?.enabled ?? true,
    comment: String(body.comment ?? fallback?.comment ?? ""),
    nextDepositAt: buildNextAutoDepositDate(new Date(), dayOfMonth, hour).toISOString()
  };
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

app.post("/api/users", async (req, res) => {
  try {
    const body = req.body as Partial<User>;
    const user: User = {
      id: id("usr"),
      name: String(body.name ?? "").trim() || "Новый участник",
      balance: roundMoney(normalizeNumber(body.balance, 0)),
      telegramId: String(body.telegramId ?? "").trim(),
      telegramUsername: String(body.telegramUsername ?? "").trim().replace(/^@/, ""),
      avatarUrl: String(body.avatarUrl ?? ""),
      commandDepositsBlocked: Boolean(body.commandDepositsBlocked),
      botAdmin: Boolean(body.botAdmin),
      notes: String(body.notes ?? ""),
      createdAt: nowIso()
    };

    const data = store.read();
    user.avatarUrl = await tryFetchTelegramAvatar(data, user);
    data.users.push(user);
    store.persist();

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/users/:id", async (req, res) => {
  try {
    const data = store.read();
    const user = data.users.find((item) => item.id === req.params.id);
    if (!user) throw new Error("Пользователь не найден");

    applyUserInput(user, req.body);
    user.avatarUrl = await tryFetchTelegramAvatar(data, user);
    store.persist();

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
      data.autoDeposits = data.autoDeposits.filter((item) => item.userId !== req.params.id);
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
      connection: normalizeConnectionInput(req.body.connection),
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
      service.connection = normalizeConnectionInput(req.body.connection, service.connection);
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

app.post("/api/services/:id/health", (req, res) => {
  try {
    store.write((data) => {
      const service = data.services.find((item) => item.id === req.params.id);
      if (!service) throw new Error("Сервис не найден");
      service.connection = { ...defaultServiceConnection(), ...(service.connection ?? {}) };
      if (service.connection.lastStatus === "maintenance" && req.body.status !== "maintenance") return;
      service.connection.lastStatus = normalizeHealthStatus(req.body.status);
      service.connection.lastLatencyMs =
        typeof req.body.latencyMs === "number" && Number.isFinite(req.body.latencyMs)
          ? Math.max(0, Math.round(req.body.latencyMs))
          : null;
      service.connection.lastCheckedAt = String(req.body.checkedAt ?? nowIso());
      service.connection.lastError = String(req.body.error ?? "").slice(0, 240);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/services/:id/maintenance", async (req, res) => {
  try {
    const data = store.read();
    const service = data.services.find((item) => item.id === req.params.id);
    if (!service) throw new Error("Сервис не найден");

    const maintenance = Boolean(req.body.maintenance);
    service.connection = { ...defaultServiceConnection(), ...(service.connection ?? {}) };
    service.connection.lastStatus = maintenance ? "maintenance" : "unknown";
    service.connection.lastLatencyMs = null;
    service.connection.lastCheckedAt = nowIso();
    service.connection.lastError = maintenance ? "Плановое обслуживание" : "";

    try {
      await sendServiceMaintenanceNotice(data, service, maintenance);
    } catch (notifyError) {
      addNotification(data, {
        serviceId: service.id,
        userId: null,
        kind: "system",
        message: `Telegram maintenance notice failed: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`,
        status: "failed"
      });
    }

    store.persist();
    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/services/:id/deploy-echo", async (req, res) => {
  let deployOutput = "";

  try {
    const service = store.read().services.find((item) => item.id === req.params.id);
    if (!service) throw new Error("Сервис не найден");

    deployOutput = await deployEchoServer(service);

    store.write((data) => {
      const target = data.services.find((item) => item.id === req.params.id);
      if (!target) throw new Error("Сервис не найден");
      target.connection = { ...defaultServiceConnection(), ...(target.connection ?? {}) };
      target.connection.enabled = true;
      target.connection.port = 8765;
      target.connection.websocketPath = "/echo";
      target.connection.lastDeployStatus = "success";
      target.connection.lastDeployAt = nowIso();
      target.connection.lastDeployOutput = deployOutput.slice(-8000);
      target.connection.lastStatus = "unknown";
      target.connection.lastError = "";
    });

    res.json(ok(apiState()));
  } catch (error) {
    const output = (error as Error & { output?: string }).output || (error instanceof Error ? error.message : String(error));

    store.write((data) => {
      const target = data.services.find((item) => item.id === req.params.id);
      if (!target) return;
      target.connection = { ...defaultServiceConnection(), ...(target.connection ?? {}) };
      target.connection.lastDeployStatus = "failed";
      target.connection.lastDeployAt = nowIso();
      target.connection.lastDeployOutput = output.slice(-8000);
    });

    res.json(ok(apiState()));
  }
});

app.delete("/api/services/:id", (req, res) => {
  try {
    store.write((data) => {
      data.services = data.services.filter((item) => item.id !== req.params.id);
      data.memberships = data.memberships.filter((item) => item.serviceId !== req.params.id);
      data.autoDeposits = data.autoDeposits.filter((item) => item.serviceId !== req.params.id);
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
      for (const schedule of data.autoDeposits.filter(
        (item) => item.userId === req.params.userId && item.serviceId === req.params.serviceId
      )) {
        const fallback = data.memberships.find(
          (item) => item.userId === req.params.userId && item.active && item.serviceId !== req.params.serviceId
        );
        if (fallback) schedule.serviceId = fallback.serviceId;
        else schedule.enabled = false;
        schedule.updatedAt = nowIso();
      }
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/auto-deposits", (req, res) => {
  try {
    store.write((data) => {
      const input = normalizeAutoDepositInput(data, req.body);
      const createdAt = nowIso();
      const schedule: AutoDeposit = {
        id: id("apm"),
        ...input,
        enabled: Boolean(input.enabled),
        lastDepositedAt: null,
        createdAt,
        updatedAt: createdAt
      };
      data.autoDeposits.unshift(schedule);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/auto-deposits/:id", (req, res) => {
  try {
    store.write((data) => {
      const schedule = data.autoDeposits.find((item) => item.id === req.params.id);
      if (!schedule) throw new Error("Автоплатеж не найден");
      const input = normalizeAutoDepositInput(data, req.body, schedule);
      Object.assign(schedule, {
        ...input,
        enabled: Boolean(input.enabled),
        updatedAt: nowIso()
      });
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.delete("/api/auto-deposits/:id", (req, res) => {
  try {
    store.write((data) => {
      data.autoDeposits = data.autoDeposits.filter((item) => item.id !== req.params.id);
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/auto-deposits/:id/run", (req, res) => {
  try {
    store.write((data) => {
      const deposit = runAutoDepositSchedule(data, req.params.id, { advance: false });
      if (!deposit) throw new Error("Автоплатеж отключён");
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

function processDueAutoDeposits() {
  let processed = 0;
  let failed = 0;

  store.write((data) => {
    const now = new Date();

    for (const schedule of data.autoDeposits) {
      if (!schedule.enabled) continue;

      if (!schedule.nextDepositAt || Number.isNaN(new Date(schedule.nextDepositAt).getTime())) {
        schedule.nextDepositAt = buildNextAutoDepositDate(now, schedule.dayOfMonth, schedule.hour).toISOString();
        continue;
      }

      let guard = 0;
      while (new Date(schedule.nextDepositAt) <= now && guard < 24) {
        try {
          runAutoDepositSchedule(data, schedule.id, { advance: true });
          processed += 1;
        } catch (error) {
          failed += 1;
          addNotification(data, {
            serviceId: schedule.serviceId || data.services[0]?.id || "",
            userId: schedule.userId,
            kind: "system",
            message: error instanceof Error ? error.message : "Ошибка автоплатежа",
            status: "failed"
          });
          schedule.nextDepositAt = advanceAutoDepositDate(schedule, new Date(schedule.nextDepositAt)).toISOString();
          schedule.updatedAt = nowIso();
          break;
        }
        guard += 1;
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
setInterval(() => {
  try {
    processDueAutoDeposits();
  } catch (error) {
    const data = store.read();
    addNotification(data, {
      serviceId: data.services[0]?.id ?? "",
      userId: null,
      kind: "system",
      message: error instanceof Error ? error.message : "Ошибка планировщика автоплатежей",
      status: "failed"
    });
    store.persist();
  }
}, 60_000);
processDueAutoDeposits();

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
