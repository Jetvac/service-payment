import crypto from "node:crypto";
import http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { Store } from "./store";
import type {
  AppData,
  AutoDeposit,
  BillingPeriod,
  Currency,
  PaymentIntent,
  PaymentMethod,
  Service,
  User,
  WallComment,
  WallFile,
  WallPost,
  WallTag
} from "./types";
import {
  addDeposit,
  addNotification,
  advanceAutoDepositDate,
  buildNextAutoDepositDate,
  buildNextChargeDate,
  cancelDebit,
  cancelDeposit,
  computeSummaries,
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
  sendTelegramMessage
} from "./telegram";
import { assertStrongPassword, hashPassword, sessionExpiresAt, sessionIsActive, verifyPassword } from "./security";
import { createYooKassaPayment, getYooKassaPayment, mapYooKassaStatus, type YooKassaPayment } from "./payments";

const app = express();
const server = http.createServer(app);
const realtime = new WebSocketServer({ server, path: "/api/realtime" });
const port = Number(process.env.PORT ?? 4077);
const store = new Store();
const execFileAsync = promisify(execFile);
const wallFilesDir = path.resolve(process.env.APP_DATA_DIR || path.join(process.cwd(), "data"), "wall-files");
const maxWallFileSize = Math.max(1, Number(process.env.MAX_UPLOAD_MB ?? 50)) * 1024 * 1024;

app.use(express.json({ limit: "25mb" }));
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

function broadcastRealtime(payload: unknown) {
  const message = JSON.stringify(payload);
  for (const client of realtime.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

realtime.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/api/realtime", `http://${request.headers.host ?? "localhost"}`);
  const token = url.searchParams.get("token") ?? "";
  const data = store.read();
  const session = token ? data.settings.security.sessions?.[token] : undefined;
  if (!sessionIsActive(session) || !data.users.some((user) => user.id === session?.userId)) {
    socket.close(1008, "auth required");
  }
});

function ok(payload: unknown) {
  return { ok: true, payload };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  return { ok: false, error: message };
}

function readPage(query: Record<string, unknown>, defaultLimit = 20, maxLimit = 100) {
  const limit = Math.min(maxLimit, Math.max(1, normalizeNumber(query.limit, defaultLimit)));
  const offset = Math.max(0, normalizeNumber(query.offset, 0));
  return { limit, offset };
}

function pageResult<T>(items: T[], offset: number, limit: number) {
  return {
    rows: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    hasMore: offset + limit < items.length
  };
}

function wallFileUrl(fileId: string) {
  return `/api/wall/files/${encodeURIComponent(fileId)}/download`;
}

function publicWallFile(file: WallFile) {
  return { ...file, url: wallFileUrl(file.id) };
}

function removeWallFileFromDisk(file: Pick<WallFile, "storageName">) {
  if (!file.storageName) return;
  fs.rmSync(path.join(wallFilesDir, file.storageName), { force: true });
}

function findWallFileOnDisk(fileId: string) {
  if (!fs.existsSync(wallFilesDir)) return null;
  const prefix = `${fileId}_`;
  const storageName = fs.readdirSync(wallFilesDir).find((name) => name.startsWith(prefix));
  if (!storageName) return null;
  const originalName = storageName.slice(prefix.length) || "file";
  const stat = fs.statSync(path.join(wallFilesDir, storageName));
  const mimeType =
    /\.(png)$/i.test(originalName) ? "image/png" :
    /\.(jpe?g)$/i.test(originalName) ? "image/jpeg" :
    /\.(gif)$/i.test(originalName) ? "image/gif" :
    /\.(webp)$/i.test(originalName) ? "image/webp" :
    "application/octet-stream";

  return {
    id: fileId,
    originalName,
    storageName,
    mimeType,
    size: stat.size,
    url: wallFileUrl(fileId),
    uploadedBy: "",
    createdAt: stat.birthtime.toISOString()
  } satisfies WallFile;
}

function wallPostFileIds(data: AppData, post: WallPost) {
  const ids = new Set<string>();
  if (post.previewFileId) ids.add(post.previewFileId);
  for (const fileId of post.fileIds) ids.add(fileId);
  for (const comment of data.wallComments.filter((item) => item.postId === post.id)) {
    for (const fileId of comment.fileIds) ids.add(fileId);
  }
  for (const file of data.wallFiles) {
    if (post.content.includes(wallFileUrl(file.id)) || post.content.includes(file.url)) ids.add(file.id);
    for (const comment of data.wallComments.filter((item) => item.postId === post.id)) {
      if (comment.content.includes(wallFileUrl(file.id)) || comment.content.includes(file.url)) ids.add(file.id);
    }
  }
  return ids;
}

function isWallFileUsed(data: AppData, fileId: string) {
  return data.wallPosts.some((post) => wallPostFileIds(data, post).has(fileId));
}

function cleanupUnusedWallFiles(data: AppData, candidateIds: Iterable<string>) {
  const candidates = new Set(Array.from(candidateIds).filter(Boolean));
  if (!candidates.size) return 0;

  const unusedFiles = data.wallFiles.filter((file) => candidates.has(file.id) && !isWallFileUsed(data, file.id));
  if (!unusedFiles.length) return 0;

  const unusedIds = new Set(unusedFiles.map((file) => file.id));
  data.wallFiles = data.wallFiles.filter((file) => !unusedIds.has(file.id));
  for (const post of data.wallPosts) {
    post.fileIds = post.fileIds.filter((fileId) => !unusedIds.has(fileId));
    if (post.previewFileId && unusedIds.has(post.previewFileId)) post.previewFileId = null;
  }
  for (const file of unusedFiles) removeWallFileFromDisk(file);
  return unusedFiles.length;
}

function safeFileName(value: string) {
  const normalized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return normalized.slice(0, 180) || "file";
}

function decodeHeaderValue(value: unknown, fallback = "") {
  const text = String(value ?? fallback);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function getActor(data: AppData, userId: unknown) {
  const user = data.users.find((item) => item.id === String(userId ?? ""));
  if (!user) throw new Error("Пользователь не найден");
  return user;
}

function canManageWallPost(actor: User, post: WallPost) {
  return actor.botAdmin || post.authorId === actor.id;
}

function canManageWallComment(actor: User, comment: WallComment) {
  return comment.authorId === actor.id;
}

function getRequestActor(req: Request, data: AppData, fallbackUserId: unknown) {
  return authUserFromRequest(req) ?? getActor(data, fallbackUserId);
}

function publicUser(user: User) {
  return {
    ...user,
    password: "",
    passwordSet: Boolean(user.password)
  };
}

function authUsers(data: AppData) {
  return data.users.map((user) => ({
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    botAdmin: user.botAdmin,
    passwordSet: Boolean(user.password)
  }));
}

function issueAuthToken(data: AppData, user: User) {
  const token = `sess_${crypto.randomBytes(24).toString("hex")}`;
  data.settings.security.sessions ??= {};
  const createdAt = nowIso();
  data.settings.security.sessions[token] = { userId: user.id, createdAt, expiresAt: sessionExpiresAt(new Date(createdAt)) };
  return token;
}

function authUserFromRequest(req: Request) {
  return (req as Request & { authUser?: User }).authUser;
}

function requireAdmin(req: Request) {
  const actor = authUserFromRequest(req);
  if (!actor?.botAdmin) throw new Error("Требуются права администратора");
  return actor;
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith("/auth/")) return next();
  if (req.method === "GET" && req.path === "/health") return next();
  if (req.method === "GET" && /^\/wall\/files\/[^/]+\/download$/.test(req.path)) return next();
  if (req.path.startsWith("/telegram/webhook/")) return next();
  if (req.path === "/payments/yookassa/webhook") return next();

  const token = String(req.header("x-auth-token") ?? "");
  const data = store.read();
  const session = token ? data.settings.security.sessions?.[token] : undefined;
  const user = sessionIsActive(session) ? data.users.find((item) => item.id === session?.userId) : undefined;

  if (!user) {
    res.status(401).json(fail(new Error("Требуется вход")));
    return;
  }

  (req as Request & { authUser?: User }).authUser = user;
  next();
}

function normalizeStringList(value: unknown) {
  return Array.isArray(value) ? Array.from(new Set(value.map((item) => String(item)).filter(Boolean))) : [];
}

function normalizeWallPostInput(data: AppData, body: Partial<WallPost>, fallback?: WallPost) {
  const serviceId = body.serviceId === null || body.serviceId === "" || body.serviceId === undefined ? null : String(body.serviceId);
  if (serviceId && !data.services.some((service) => service.id === serviceId)) throw new Error("Сервис не найден");

  const tagIds = normalizeStringList(body.tagIds).filter((tagId) => data.wallTags.some((tag) => tag.id === tagId));
  const fileIds = normalizeStringList(body.fileIds).filter((fileId) => data.wallFiles.some((file) => file.id === fileId));
  const rawPreviewFileId =
    body.previewFileId === null || body.previewFileId === "" || body.previewFileId === undefined
      ? fallback?.previewFileId ?? null
      : String(body.previewFileId);
  const previewFileId = rawPreviewFileId && data.wallFiles.some((file) => file.id === rawPreviewFileId) ? rawPreviewFileId : null;

  return {
    title: String(body.title ?? fallback?.title ?? "").trim().slice(0, 160) || "Без названия",
    previewFileId,
    content: String(body.content ?? fallback?.content ?? "").slice(0, 200_000),
    serviceId,
    tagIds,
    fileIds
  };
}

function wallPostFlags(post: WallPost, tags: WallTag[]) {
  const postTags = tags.filter((tag) => post.tagIds.includes(tag.id));
  return {
    pinned: postTags.some((tag) => tag.pinned),
    archived: postTags.some((tag) => tag.archived)
  };
}

function wallListData(data: AppData, query: Record<string, unknown>) {
  const { offset, limit } = readPage(query, 20, 80);
  const search = String(query.search ?? "").trim().toLowerCase();
  const serviceId = String(query.serviceId ?? "");
  const tagId = String(query.tagId ?? "");
  const archived = String(query.archive ?? query.archived ?? "false") === "true";

  const posts = data.wallPosts
    .filter((post) => wallPostFlags(post, data.wallTags).archived === archived)
    .filter((post) => !serviceId || post.serviceId === serviceId)
    .filter((post) => !tagId || post.tagIds.includes(tagId))
    .filter((post) => {
      if (!search) return true;
      return [post.title, post.content].some((value) => value.toLowerCase().includes(search));
    })
    .sort((a, b) => {
      const aFlags = wallPostFlags(a, data.wallTags);
      const bFlags = wallPostFlags(b, data.wallTags);
      return Number(bFlags.pinned) - Number(aFlags.pinned) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .map((post) => publicWallPost(data, post));

  return {
    posts: pageResult(posts, offset, limit),
    tags: data.wallTags,
    files: data.wallFiles.map(publicWallFile)
  };
}

function wallPostCommentCount(data: AppData, postId: string) {
  return data.wallComments.filter((comment) => comment.postId === postId && !comment.deletedAt).length;
}

function publicWallPost(data: AppData, post: WallPost) {
  return {
    ...post,
    commentCount: wallPostCommentCount(data, post.id)
  };
}

function wallCommentsForPost(data: AppData, postId: string) {
  return data.wallComments
    .filter((comment) => comment.postId === postId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function broadcastWallCommentsChanged(postId: string) {
  const comments = wallCommentsForPost(store.read(), postId);
  broadcastRealtime({ type: "wall-comments-changed", postId, comments });
  return comments;
}

function normalizeWallCommentInput(data: AppData, postId: string, body: Partial<WallComment>) {
  const post = data.wallPosts.find((item) => item.id === postId);
  if (!post) throw new Error("Пост не найден");

  const parentId = body.parentId ? String(body.parentId) : null;
  if (parentId && !data.wallComments.some((comment) => comment.id === parentId && comment.postId === postId && !comment.deletedAt)) {
    throw new Error("Комментарий для ответа не найден");
  }

  const fileIds = normalizeStringList(body.fileIds).filter((fileId) => data.wallFiles.some((file) => file.id === fileId));
  const content = String(body.content ?? "").trim().slice(0, 20_000);
  if (!content && !fileIds.length) throw new Error("Комментарий пустой");

  return { parentId, content, fileIds };
}

function isEffectiveOperation(operation: { cancelledAt?: string | null; reversesId?: string | null }) {
  return !operation.cancelledAt && !operation.reversesId;
}

function plainDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit"
  }).format(new Date(value));
}

function dashboardData(data: AppData, query: Record<string, unknown>) {
  const notificationPage = readPage(
    { offset: query.notificationOffset, limit: query.notificationLimit },
    8,
    50
  );
  const rate = (code: string) => data.currencies.find((currency) => currency.code === code)?.rateToRub ?? 1;

  const byDate = new Map<string, { date: string; deposits: number; debits: number }>();
  const ensure = (iso: string) => {
    const key = plainDate(iso);
    if (!byDate.has(key)) byDate.set(key, { date: key, deposits: 0, debits: 0 });
    return byDate.get(key)!;
  };

  for (const deposit of data.deposits.filter(isEffectiveOperation).slice(0, 400)) {
    ensure(deposit.createdAt).deposits += deposit.amountBalanceCurrency ?? deposit.amountServiceCurrency * rate(deposit.serviceCurrency);
  }
  for (const debit of data.debits.filter(isEffectiveOperation).slice(0, 400)) {
    ensure(debit.createdAt).debits += debit.amountBalanceCurrency ?? debit.amount * rate(debit.currency);
  }

  return {
    chart: Array.from(byDate.values()).reverse().slice(-14),
    notifications: pageResult(data.notifications, notificationPage.offset, notificationPage.limit)
  };
}

function publicData(data: AppData, viewer?: User) {
  const telegram = { ...data.settings.telegram, botToken: "", webhookSecret: "" };
  telegram.botTokenSet = Boolean(data.settings.telegram.botToken);
  telegram.webhookSecretSet = Boolean(data.settings.telegram.webhookSecret);
  const payments = { ...data.settings.payments, secretKey: "", secretKeySet: Boolean(data.settings.payments.secretKey) };

  return {
    currencies: data.currencies,
    users: data.users.map(publicUser),
    services: data.services,
    memberships: data.memberships,
    autoDeposits: data.autoDeposits,
    deposits: [],
    debits: [],
    notifications: [],
    payments: viewer?.botAdmin ? data.payments : data.payments.filter((payment) => payment.userId === viewer?.id),
    settings: {
      telegram,
      security: {
        adminPassword: "",
        adminPasswordSet: Boolean(data.settings.security?.adminPassword),
        sessions: {}
      },
      payments
    }
  };
}

function apiState(viewer?: User) {
  const data = store.read();
  return {
    ...publicData(data, viewer),
    summaries: computeSummaries(data),
    counts: {
      deposits: data.deposits.length,
      debits: data.debits.length,
      notifications: data.notifications.length,
      payments: data.payments.length
    },
    serverTime: nowIso()
  };
}

function backupFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `service-payment-backup-${stamp}.sqlite`;
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

async function scheduleUbuntuUpdate() {
  const updateUnit = serviceUnitName().replace(/\.service$/, "-update.service");
  await execFileAsync("sudo", ["-n", "systemctl", "start", "--no-block", updateUnit]);
  const logPath = path.resolve(process.cwd(), "data", "logs", "update.log");
  return { scheduled: true, logPath };
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

function validateAdminPassword(data: AppData, password: unknown) {
  const expected = data.settings.security?.adminPassword || "admin";
  if (!verifyPassword(expected, String(password ?? ""))) {
    throw new Error("Неверный пароль администратора");
  }
}

function applyUserInput(
  data: AppData,
  user: User,
  body: Partial<User> & { adminPassword?: string; currentPassword?: string },
  actor?: User
) {
  const isAdmin = Boolean(actor?.botAdmin);
  const isSelf = actor?.id === user.id;
  if (!isAdmin && !isSelf) throw new Error("Нет прав на изменение участника");

  const nextBotAdmin = body.botAdmin === undefined ? user.botAdmin : Boolean(body.botAdmin);
  if (nextBotAdmin && !user.botAdmin) {
    validateAdminPassword(data, body.adminPassword);
  }

  const passwordInput = typeof body.password === "string" ? body.password.trim() : "";
  if (passwordInput) {
    assertStrongPassword(passwordInput);
    if (!isAdmin && user.password && !verifyPassword(user.password, String(body.currentPassword ?? ""))) {
      throw new Error("Неверный текущий пароль");
    }
    user.password = hashPassword(passwordInput);
    user.passwordSet = true;
  }

  if (!isAdmin) {
    user.avatarUrl = String(body.avatarUrl ?? user.avatarUrl ?? "");
    return;
  }

  user.name = String(body.name ?? user.name).trim() || user.name;
  user.balance = roundMoney(normalizeNumber(body.balance, user.balance));
  user.telegramId = String(body.telegramId ?? user.telegramId).trim();
  user.telegramUsername = String(body.telegramUsername ?? user.telegramUsername).trim().replace(/^@/, "");
  user.avatarUrl = String(body.avatarUrl ?? user.avatarUrl ?? "");
  user.commandDepositsBlocked =
    body.commandDepositsBlocked === undefined ? user.commandDepositsBlocked : Boolean(body.commandDepositsBlocked);
  user.botAdmin = nextBotAdmin;
  user.notes = String(body.notes ?? user.notes);
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

function paymentDescription(data: AppData, user: User, serviceId: string) {
  const service = data.services.find((item) => item.id === serviceId);
  return `Пополнение ${service?.name ?? "сервиса"}: ${user.name}`.slice(0, 128);
}

function applyProviderPayment(data: AppData, intent: PaymentIntent, payment: YooKassaPayment) {
  if (intent.externalId && payment.id !== intent.externalId) throw new Error("Платёж провайдера не совпадает с заявкой");
  if (payment.metadata?.payment_intent_id !== intent.id) throw new Error("Метаданные платежа не совпадают с заявкой");
  if (payment.metadata?.user_id !== intent.userId || payment.metadata?.service_id !== intent.serviceId) {
    throw new Error("Получатель платежа не совпадает с заявкой");
  }
  if (payment.amount.currency !== intent.currency || Number(payment.amount.value) !== intent.amount) {
    throw new Error("Сумма платежа не совпадает с заявкой");
  }

  intent.externalId = payment.id;
  intent.status = mapYooKassaStatus(payment);
  intent.updatedAt = nowIso();
  intent.failureReason = payment.cancellation_details?.reason ?? "";
  if (intent.status === "succeeded" && !intent.depositId) {
    const deposit = addDeposit(data, {
      serviceId: intent.serviceId,
      userId: intent.userId,
      amount: intent.amount,
      currency: intent.currency,
      comment: intent.comment || intent.description,
      source: "payment"
    });
    intent.depositId = deposit.id;
    intent.paidAt = nowIso();
    addNotification(data, {
      serviceId: intent.serviceId,
      userId: intent.userId,
      kind: "payment",
      message: `Платёж ${intent.amount.toFixed(2)} ${intent.currency} подтверждён`,
      status: "sent"
    });
  }
  return intent;
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, status: "ready", serverTime: nowIso() });
});

app.get("/api/auth/users", (_req, res) => {
  res.json(ok(authUsers(store.read())));
});

app.post("/api/auth/login", (req, res) => {
  try {
    const attemptKey = `${req.ip}:${String(req.body.userId ?? "")}`;
    const current = loginAttempts.get(attemptKey);
    if (current && current.resetAt > Date.now() && current.count >= 8) {
      res.setHeader("Retry-After", String(Math.ceil((current.resetAt - Date.now()) / 1000)));
      throw new Error("Слишком много попыток. Повторите вход через несколько минут");
    }
    const data = store.read();
    const user = data.users.find((item) => item.id === String(req.body.userId ?? ""));
    if (!user) throw new Error("Пользователь не найден");
    if (!user.password) throw new Error("Пароль не задан");
    if (!verifyPassword(user.password, String(req.body.password ?? ""))) {
      const next = current && current.resetAt > Date.now() ? current : { count: 0, resetAt: Date.now() + 10 * 60_000 };
      next.count += 1;
      loginAttempts.set(attemptKey, next);
      throw new Error("Неверный пароль");
    }

    const token = issueAuthToken(data, user);
    store.persist();
    loginAttempts.delete(attemptKey);
    res.json(ok({ token, userId: user.id, state: apiState(user) }));
  } catch (error) {
    res.status(401).json(fail(error));
  }
});

app.post("/api/auth/logout", (req, res) => {
  const token = String(req.header("x-auth-token") ?? "");
  store.write((data) => {
    if (token && data.settings.security.sessions) delete data.settings.security.sessions[token];
  });
  res.json(ok({ loggedOut: true }));
});

app.use("/api", authMiddleware);

app.get("/api/state", (req, res) => {
  res.json(ok(apiState(authUserFromRequest(req))));
});

app.get("/api/payments", (req, res) => {
  const actor = authUserFromRequest(req)!;
  const payments = (actor.botAdmin ? store.read().payments : store.read().payments.filter((item) => item.userId === actor.id))
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json(ok(payments));
});

app.post("/api/payments", async (req, res) => {
  try {
    const actor = authUserFromRequest(req)!;
    const data = store.read();
    const userId = actor.botAdmin && req.body.userId ? String(req.body.userId) : actor.id;
    const user = data.users.find((item) => item.id === userId);
    if (!user) throw new Error("Пользователь не найден");
    const serviceId = String(req.body.serviceId ?? "");
    const amount = roundMoney(normalizeNumber(req.body.amount, 0));
    if (amount <= 0 || amount > 1_000_000) throw new Error("Укажите сумму от 0,01 до 1 000 000");
    const method = String(req.body.method ?? "manual") as PaymentMethod;
    if (!["manual", "sbp", "sberbank"].includes(method)) throw new Error("Способ оплаты не поддерживается");
    const currency = method === "manual" ? String(req.body.currency ?? "RUB").toUpperCase() : "RUB";
    if (!data.currencies.some((item) => item.code === currency)) throw new Error("Валюта не найдена");
    const settings = data.settings.payments;
    if (method === "manual" && !settings.manualEnabled) throw new Error("Ручное пополнение отключено");
    if (method === "sbp" && (!settings.enabled || !settings.sbpEnabled)) throw new Error("Оплата через СБП отключена");
    if (method === "sberbank" && (!settings.enabled || !settings.sberPayEnabled)) throw new Error("Оплата через СберБанк Онлайн отключена");

    const createdAt = nowIso();
    const intent: PaymentIntent = {
      id: id("pay"),
      userId,
      serviceId,
      amount,
      currency,
      method,
      provider: method === "manual" ? "manual" : "yookassa",
      status: method === "manual" ? "succeeded" : "pending",
      externalId: "",
      confirmationUrl: "",
      description: paymentDescription(data, user, serviceId),
      comment: String(req.body.comment ?? "").trim().slice(0, 500),
      depositId: null,
      failureReason: "",
      createdAt,
      updatedAt: createdAt,
      paidAt: method === "manual" ? createdAt : null
    };

    store.write((current) => {
      if (method === "manual") {
        const deposit = addDeposit(current, {
          serviceId,
          userId,
          amount,
          currency,
          comment: intent.comment || "Ручное пополнение",
          source: "manual"
        });
        intent.depositId = deposit.id;
      } else {
        const membership = current.memberships.find(
          (item) => item.serviceId === serviceId && item.userId === userId && item.active
        );
        if (!membership) throw new Error("Пользователь не закреплён за сервисом");
      }
      current.payments.unshift(intent);
    });

    if (method !== "manual") {
      try {
        const baseUrl = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
        const providerPayment = await createYooKassaPayment(settings, intent, `${baseUrl}/?payment=${intent.id}`);
        store.write((current) => {
          const currentIntent = current.payments.find((item) => item.id === intent.id);
          if (!currentIntent) throw new Error("Заявка на оплату не найдена");
          currentIntent.externalId = providerPayment.id;
          currentIntent.confirmationUrl = providerPayment.confirmation?.confirmation_url ?? "";
          currentIntent.status = mapYooKassaStatus(providerPayment);
          currentIntent.updatedAt = nowIso();
        });
      } catch (error) {
        store.write((current) => {
          const currentIntent = current.payments.find((item) => item.id === intent.id);
          if (currentIntent) {
            currentIntent.status = "failed";
            currentIntent.failureReason = error instanceof Error ? error.message : "Ошибка платёжного провайдера";
            currentIntent.updatedAt = nowIso();
          }
        });
        throw error;
      }
    }

    const saved = store.read().payments.find((item) => item.id === intent.id)!;
    res.json(ok({ payment: saved, state: apiState(actor) }));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/payments/:id/refresh", async (req, res) => {
  try {
    const actor = authUserFromRequest(req)!;
    const data = store.read();
    const intent = data.payments.find((item) => item.id === req.params.id);
    if (!intent || (!actor.botAdmin && intent.userId !== actor.id)) throw new Error("Платёж не найден");
    if (intent.provider !== "yookassa") throw new Error("Ручной платёж уже обработан");
    const providerPayment = await getYooKassaPayment(data.settings.payments, intent.externalId);
    store.write((current) => {
      const currentIntent = current.payments.find((item) => item.id === intent.id)!;
      applyProviderPayment(current, currentIntent, providerPayment);
    });
    res.json(ok({ payment: store.read().payments.find((item) => item.id === intent.id), state: apiState(actor) }));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/payments/yookassa/webhook", async (req, res) => {
  try {
    const paymentId = String(req.body?.object?.id ?? "");
    if (!paymentId) throw new Error("Платёж не указан");
    const data = store.read();
    const intent = data.payments.find((item) => item.externalId === paymentId);
    if (!intent) throw new Error("Заявка на оплату не найдена");
    const verified = await getYooKassaPayment(data.settings.payments, paymentId);
    store.write((current) => {
      const currentIntent = current.payments.find((item) => item.id === intent.id)!;
      applyProviderPayment(current, currentIntent, verified);
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/settings/payments", (req, res) => {
  try {
    const actor = requireAdmin(req);
    store.write((data) => {
      const current = data.settings.payments;
      const secretKey = String(req.body.secretKey ?? "").trim();
      data.settings.payments = {
        ...current,
        enabled: Boolean(req.body.enabled),
        provider: "yookassa",
        manualEnabled: Boolean(req.body.manualEnabled),
        sbpEnabled: Boolean(req.body.sbpEnabled),
        sberPayEnabled: Boolean(req.body.sberPayEnabled),
        shopId: String(req.body.shopId ?? current.shopId).trim(),
        secretKey: secretKey || current.secretKey,
        secretKeySet: Boolean(secretKey || current.secretKey),
        recipientName: String(req.body.recipientName ?? current.recipientName).trim(),
        bankName: String(req.body.bankName ?? current.bankName).trim(),
        phone: String(req.body.phone ?? current.phone).trim(),
        account: String(req.body.account ?? current.account).trim(),
        paymentPurpose: String(req.body.paymentPurpose ?? current.paymentPurpose).trim().slice(0, 200)
      };
    });
    res.json(ok(apiState(actor)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const data = store.read();
    const payload = dashboardData(data, req.query as Record<string, unknown>);
    res.json(ok(payload));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/notifications", (req, res) => {
  try {
    const { offset, limit } = readPage(req.query as Record<string, unknown>, 20, 100);
    res.json(ok(pageResult(store.read().notifications, offset, limit)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/wall", (req, res) => {
  try {
    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/wall/posts/:id", (req, res) => {
  try {
    const data = store.read();
    const post = data.wallPosts.find((item) => item.id === req.params.id);
    if (!post) throw new Error("Пост не найден");
    res.json(ok(publicWallPost(data, post)));
  } catch (error) {
    res.status(404).json(fail(error));
  }
});

app.post("/api/wall/posts/:id/view", (req, res) => {
  try {
    let post: WallPost | undefined;
    store.write((data) => {
      post = data.wallPosts.find((item) => item.id === req.params.id);
      if (!post) throw new Error("Пост не найден");
      post.views += 1;
    });
    const data = store.read();
    res.json(ok(post ? publicWallPost(data, post) : post));
  } catch (error) {
    res.status(404).json(fail(error));
  }
});

app.get("/api/wall/posts/:id/comments", (req, res) => {
  try {
    const post = store.read().wallPosts.find((item) => item.id === req.params.id);
    if (!post) throw new Error("Пост не найден");
    res.json(ok(wallCommentsForPost(store.read(), req.params.id)));
  } catch (error) {
    res.status(404).json(fail(error));
  }
});

app.post("/api/wall/posts/:id/comments", (req, res) => {
  try {
    let comment: WallComment | undefined;
    store.write((data) => {
      const actor = getRequestActor(req, data, req.body.authorId);
      const input = normalizeWallCommentInput(data, req.params.id, req.body);
      const createdAt = nowIso();
      comment = {
        id: id("wcom"),
        postId: req.params.id,
        parentId: input.parentId,
        authorId: actor.id,
        content: input.content,
        fileIds: input.fileIds,
        deletedAt: null,
        createdAt,
        updatedAt: createdAt
      };
      data.wallComments.push(comment);
    });

    const comments = broadcastWallCommentsChanged(req.params.id);
    res.json(ok(comments));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/wall/posts/:postId/comments/:commentId", (req, res) => {
  try {
    store.write((data) => {
      const actor = getRequestActor(req, data, req.body.authorId ?? req.body.userId);
      const comment = data.wallComments.find((item) => item.id === req.params.commentId && item.postId === req.params.postId);
      if (!comment) throw new Error("Комментарий не найден");
      if (comment.deletedAt) throw new Error("Удалённый комментарий нельзя редактировать");
      if (!canManageWallComment(actor, comment)) throw new Error("Нет прав на редактирование комментария");

      const previousFileIds = new Set(comment.fileIds);
      const input = normalizeWallCommentInput(data, req.params.postId, {
        ...req.body,
        parentId: comment.parentId
      });
      comment.content = input.content;
      comment.fileIds = input.fileIds;
      comment.updatedAt = nowIso();
      cleanupUnusedWallFiles(data, previousFileIds);
    });

    const comments = broadcastWallCommentsChanged(req.params.postId);
    res.json(ok(comments));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.delete("/api/wall/posts/:postId/comments/:commentId", (req, res) => {
  try {
    store.write((data) => {
      const actor = getRequestActor(req, data, req.query.userId);
      const comment = data.wallComments.find((item) => item.id === req.params.commentId && item.postId === req.params.postId);
      if (!comment) throw new Error("Комментарий не найден");
      if (comment.deletedAt) throw new Error("Комментарий уже удалён");
      if (!canManageWallComment(actor, comment)) throw new Error("Нет прав на удаление комментария");

      const hasReplies = data.wallComments.some((item) => item.parentId === comment.id);
      const fileIds = new Set(comment.fileIds);
      if (hasReplies) {
        comment.content = "Комментарий удалён";
        comment.fileIds = [];
        comment.deletedAt = nowIso();
        comment.updatedAt = comment.deletedAt;
      } else {
        data.wallComments = data.wallComments.filter((item) => item.id !== comment.id);
      }
      cleanupUnusedWallFiles(data, fileIds);
    });

    const comments = broadcastWallCommentsChanged(req.params.postId);
    res.json(ok(comments));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/wall/posts", (req, res) => {
  try {
    store.write((data) => {
      const actor = getRequestActor(req, data, req.body.authorId);
      const createdAt = nowIso();
      const input = normalizeWallPostInput(data, req.body);
      data.wallPosts.unshift({
        id: id("wpost"),
        ...input,
        authorId: actor.id,
        views: 0,
        createdAt,
        updatedAt: createdAt
      });
    });

    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/wall/posts/:id", (req, res) => {
  try {
    store.write((data) => {
      const post = data.wallPosts.find((item) => item.id === req.params.id);
      if (!post) throw new Error("Пост не найден");
      const actor = getRequestActor(req, data, req.body.authorId);
      if (!canManageWallPost(actor, post)) throw new Error("Нет прав на изменение поста");
      const previousFileIds = wallPostFileIds(data, post);
      Object.assign(post, normalizeWallPostInput(data, req.body, post), { updatedAt: nowIso() });
      cleanupUnusedWallFiles(data, previousFileIds);
    });

    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.delete("/api/wall/posts/:id", (req, res) => {
  try {
    store.write((data) => {
      const post = data.wallPosts.find((item) => item.id === req.params.id);
      if (!post) throw new Error("Пост не найден");
      const actor = getRequestActor(req, data, req.query.userId);
      if (!canManageWallPost(actor, post)) throw new Error("Нет прав на удаление поста");
      const previousFileIds = wallPostFileIds(data, post);
      data.wallPosts = data.wallPosts.filter((item) => item.id !== post.id);
      data.wallComments = data.wallComments.filter((comment) => comment.postId !== post.id);
      cleanupUnusedWallFiles(data, previousFileIds);
    });

    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/wall/tags", (req, res) => {
  try {
    store.write((data) => {
      const name = String(req.body.name ?? "").trim().slice(0, 48);
      if (!name) throw new Error("Название тега обязательно");
      if (data.wallTags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) throw new Error("Такой тег уже есть");
      data.wallTags.push({
        id: id("wtag"),
        name,
        color: String(req.body.color ?? "#7aa8ff"),
        pinned: Boolean(req.body.pinned),
        archived: Boolean(req.body.archived),
        createdAt: nowIso()
      });
    });

    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.put("/api/wall/tags/:id", (req, res) => {
  try {
    store.write((data) => {
      const tag = data.wallTags.find((item) => item.id === req.params.id);
      if (!tag) throw new Error("Тег не найден");
      const name = String(req.body.name ?? tag.name).trim().slice(0, 48);
      if (!name) throw new Error("Название тега обязательно");
      const sameName = data.wallTags.find((item) => item.id !== tag.id && item.name.toLowerCase() === name.toLowerCase());
      if (sameName) throw new Error("Такой тег уже есть");
      tag.name = name;
      tag.color = String(req.body.color ?? tag.color);
      tag.pinned = Boolean(req.body.pinned);
      tag.archived = Boolean(req.body.archived);
    });

    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.delete("/api/wall/tags/:id", (req, res) => {
  try {
    store.write((data) => {
      data.wallTags = data.wallTags.filter((tag) => tag.id !== req.params.id);
      for (const post of data.wallPosts) {
        post.tagIds = post.tagIds.filter((tagId) => tagId !== req.params.id);
      }
    });

    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/wall/files", async (req, res) => {
  const data = store.read();
  const actor =
    authUserFromRequest(req) ?? data.users.find((item) => item.id === String(req.header("x-author-id") ?? req.query.authorId ?? ""));
  if (!actor) {
    res.status(400).json(fail(new Error("Пользователь не найден")));
    return;
  }

  const contentLength = Number(req.header("content-length") ?? 0);
  if (contentLength > maxWallFileSize) {
    res.status(413).json(fail(new Error(`Файл больше ${Math.round(maxWallFileSize / 1024 / 1024)} МБ`)));
    return;
  }

  const fileId = id("wfile");
  const originalName = safeFileName(decodeHeaderValue(req.header("x-file-name"), "file"));
  const storageName = `${fileId}_${originalName}`;
  let received = 0;

  try {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxWallFileSize) {
          reject(new Error(`Файл больше ${Math.round(maxWallFileSize / 1024 / 1024)} МБ`));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      req.on("end", resolve);
      req.on("error", reject);
    });

    const file: WallFile = {
      id: fileId,
      originalName,
      storageName,
      mimeType: String(req.header("content-type") ?? "application/octet-stream"),
      size: received,
      url: wallFileUrl(fileId),
      uploadedBy: actor.id,
      createdAt: nowIso()
    };

    store.saveWallFile(file, Buffer.concat(chunks));

    res.json(ok(publicWallFile(file)));
  } catch (error) {
    res.status(received > maxWallFileSize ? 413 : 400).json(fail(error));
  }
});

app.post("/api/wall/files/cleanup", (req, res) => {
  try {
    const before = new Set(store.read().wallFiles.map((file) => file.id));
    store.write((data) => {
      getRequestActor(req, data, req.query.userId ?? req.body?.userId);
      cleanupUnusedWallFiles(data, normalizeStringList(req.body?.fileIds));
    });
    const after = new Set(store.read().wallFiles.map((file) => file.id));
    for (const fileId of before) if (!after.has(fileId)) store.deleteWallFileBlob(fileId);
    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/wall/files/:id/download", (req, res) => {
  try {
    const data = store.read();
    let file = data.wallFiles.find((item) => item.id === req.params.id) ?? findWallFileOnDisk(req.params.id);
    if (!file) throw new Error("Файл не найден");
    if (!data.wallFiles.some((item) => item.id === file.id)) {
      store.write((current) => {
        if (!current.wallFiles.some((item) => item.id === file!.id)) current.wallFiles.unshift(file!);
      });
    }
    let content = store.readWallFile(file.id);
    if (!content && file.storageName) {
      const legacyPath = path.join(wallFilesDir, file.storageName);
      if (fs.existsSync(legacyPath)) content = fs.readFileSync(legacyPath);
    }
    if (!content) throw new Error("Файл отсутствует в базе данных");

    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(content.length));
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeFileName(file.originalName).replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
    );
    res.send(content);
  } catch (error) {
    res.status(404).json(fail(error));
  }
});

app.delete("/api/wall/files/:id", (req, res) => {
  try {
    let storageName = "";
    store.write((data) => {
      const file = data.wallFiles.find((item) => item.id === req.params.id);
      if (!file) throw new Error("Файл не найден");
      const actor = getRequestActor(req, data, req.query.userId);
      if (!actor.botAdmin && file.uploadedBy !== actor.id) throw new Error("Нет прав на удаление файла");

      storageName = file.storageName;
      data.wallFiles = data.wallFiles.filter((item) => item.id !== file.id);
      for (const post of data.wallPosts) {
        post.fileIds = post.fileIds.filter((fileId) => fileId !== file.id);
        if (post.previewFileId === file.id) post.previewFileId = null;
      }
      for (const comment of data.wallComments) {
        comment.fileIds = comment.fileIds.filter((fileId) => fileId !== file.id);
      }
    });

    store.deleteWallFileBlob(req.params.id);
    if (storageName) removeWallFileFromDisk({ storageName });
    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/database/export", async (req, res) => {
  let tempDir = "";
  try {
    requireAdmin(req);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-payment-export-"));
    const destination = path.join(tempDir, backupFileName());
    await store.backupTo(destination);
    res.setHeader("Content-Type", "application/vnd.sqlite3");
    res.setHeader("Content-Disposition", `attachment; filename="${backupFileName()}"`);
    res.sendFile(destination, () => fs.rmSync(tempDir, { recursive: true, force: true }));
  } catch (error) {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    res.status(403).json(fail(error));
  }
});

app.post("/api/database/import", async (req, res) => {
  let tempDir = "";
  try {
    requireAdmin(req);
    if (req.is("application/json")) {
      store.replace(req.body);
    } else {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-payment-import-"));
      const source = path.join(tempDir, "import.sqlite");
      const maxBackupSize = Math.max(100, Number(process.env.MAX_BACKUP_MB ?? 2048)) * 1024 * 1024;
      let received = 0;
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(source, { flags: "wx" });
        req.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBackupSize) {
            output.destroy(new Error("Резервная копия слишком большая"));
            return;
          }
        });
        req.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
        req.pipe(output);
      });
      store.replaceWithDatabase(source);
    }
    res.json(ok(apiState(authUserFromRequest(req))));
  } catch (error) {
    res.status(400).json(fail(error));
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

app.post("/api/system/update", async (req, res) => {
  try {
    requireAdmin(req);
    const update = process.platform === "win32"
      ? { scheduled: false, steps: await runLocalGitUpdate(), restart: scheduleServiceRestart() }
      : await scheduleUbuntuUpdate();
    store.write((data) => {
      addNotification(data, {
        serviceId: data.services[0]?.id ?? "",
        userId: null,
        kind: "system",
        message: update.scheduled
          ? "Безопасное обновление запущено. После сборки сервис перезапустится автоматически"
          : "Обновление установлено; перезапуск запланирован",
        status: "sent"
      });
    });

    res.status(202).json(ok(update));
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
    const actor = requireAdmin(req);
    const body = req.body as Partial<User> & { adminPassword?: string };
    const user: User = {
      id: id("usr"),
      name: "Новый участник",
      balance: 0,
      telegramId: "",
      telegramUsername: "",
      avatarUrl: "",
      commandDepositsBlocked: false,
      botAdmin: false,
      password: "",
      passwordSet: false,
      notes: "",
      createdAt: nowIso()
    };

    const data = store.read();
    applyUserInput(data, user, body, actor);
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

    const actor = authUserFromRequest(req);
    applyUserInput(data, user, req.body, actor);
    if (actor?.botAdmin) user.avatarUrl = await tryFetchTelegramAvatar(data, user);
    store.persist();

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.delete("/api/users/:id", (req, res) => {
  try {
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
    store.write((data) => {
      const deposit = runAutoDepositSchedule(data, req.params.id, { advance: false });
      if (!deposit) throw new Error("Автоплатеж отключён");
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/deposits", (req, res) => {
  try {
    const { offset, limit } = readPage(req.query as Record<string, unknown>, 20, 100);
    const actor = authUserFromRequest(req);
    const requestedUserId = String(req.query.userId ?? "");
    const userId = actor?.botAdmin ? requestedUserId : actor?.id ?? "";
    const rows = userId ? store.read().deposits.filter((deposit) => deposit.userId === userId) : store.read().deposits;
    res.json(ok(pageResult(rows, offset, limit)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/deposits", (req, res) => {
  try {
    const actor = authUserFromRequest(req);
    store.write((data) => {
      const targetUserId = actor?.botAdmin ? String(req.body.userId) : actor?.id ?? "";
      if (!targetUserId) throw new Error("Пользователь не найден");
      if (!actor?.botAdmin && String(req.body.userId ?? targetUserId) !== actor?.id) {
        throw new Error("Можно зачислять средства только себе");
      }
      addDeposit(data, {
        serviceId: String(req.body.serviceId),
        userId: targetUserId,
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
    requireAdmin(req);
    store.write((data) => {
      cancelDeposit(data, req.params.id, String(req.body.reason ?? ""));
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/debits", (req, res) => {
  try {
    const { offset, limit } = readPage(req.query as Record<string, unknown>, 20, 100);
    const actor = authUserFromRequest(req);
    const requestedUserId = String(req.query.userId ?? "");
    const userId = actor?.botAdmin ? requestedUserId : actor?.id ?? "";
    const rows = userId ? store.read().debits.filter((debit) => debit.userId === userId) : store.read().debits;
    res.json(ok(pageResult(rows, offset, limit)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/debits/manual", async (req, res) => {
  try {
    requireAdmin(req);
    const serviceId = String(req.body.serviceId);
    store.write((data) => {
      runDebitForService(data, serviceId, "manual");
    });

    await sendDebitNotifications(serviceId);

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/debits/:id/cancel", (req, res) => {
  try {
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
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
    requireAdmin(req);
    store.write((data) => {
      data.settings.telegram.enabled = Boolean(req.body.enabled);
      const botToken = String(req.body.botToken ?? "").trim();
      if (botToken) data.settings.telegram.botToken = botToken;
      data.settings.telegram.chatId = String(req.body.chatId ?? "");
      data.settings.telegram.notificationTopicId = String(req.body.notificationTopicId ?? "");
      const webhookSecret = String(req.body.webhookSecret ?? "").trim();
      if (webhookSecret) data.settings.telegram.webhookSecret = webhookSecret;
      data.settings.telegram.botTokenSet = Boolean(data.settings.telegram.botToken);
      data.settings.telegram.webhookSecretSet = Boolean(data.settings.telegram.webhookSecret);
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

app.put("/api/settings/security", (req, res) => {
  try {
    requireAdmin(req);
    store.write((data) => {
      validateAdminPassword(data, req.body.currentPassword);
      const nextPassword = String(req.body.newPassword ?? "").trim();
      assertStrongPassword(nextPassword);
      data.settings.security.adminPassword = hashPassword(nextPassword);
      data.settings.security.adminPasswordSet = true;
    });

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/polling/start", async (req, res) => {
  try {
    requireAdmin(req);
    const data = store.read();
    await enableTelegramPolling(data);
    store.persist();
    res.json(ok(apiState()));
  } catch (error) {
    persistTelegramError("Запуск polling", error);
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/polling/stop", (_req, res) => {
  try {
    requireAdmin(_req);
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
    requireAdmin(req);
    const data = store.read();
    const baseUrl = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const secret = data.settings.telegram.webhookSecret;
    if (!secret) throw new Error("Сначала сохраните webhook secret");
    await configureTelegramIntegration(data, `${baseUrl}/api/telegram/webhook/${encodeURIComponent(secret)}`);
    store.persist();
    res.json(ok(apiState()));
  } catch (error) {
    persistTelegramError("Настройка webhook", error);
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/test", async (req, res) => {
  try {
    requireAdmin(req);
    const data = store.read();
    const chatId = String(req.body.chatId ?? data.settings.telegram.chatId ?? "");
    const sent = await sendTelegramMessage(data, "Проверка связи VPN Pay. Команды доступны в меню.", chatId, {
      removeKeyboard: true
    });

    if (!sent) throw new Error(data.settings.telegram.lastError || "Telegram не подтвердил отправку тестового сообщения");

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
    persistTelegramError("Проверка связи", error);
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

  for (const serviceId of dueServices) {
    await sendDebitNotifications(serviceId);
  }

  if (dueServices.length) {
    const data = store.read();
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

async function sendDebitNotifications(serviceId: string) {
  try {
    const data = store.read();
    const service = data.services.find((item) => item.id === serviceId);
    if (!service) return;
    await sendServiceBalanceSummary(data, service);
    await sendLowBalanceWarnings(data, service);
    store.persist();
  } catch (error) {
    // The debit is already committed. Report a delivery problem without making
    // the client retry the debit and charge every participant a second time.
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

function persistTelegramError(context: string, error: unknown) {
  const data = store.read();
  const detail = error instanceof Error ? error.message : "Ошибка Telegram";
  data.settings.telegram.lastError = detail;
  addNotification(data, {
    serviceId: data.services[0]?.id ?? "",
    userId: null,
    kind: "system",
    message: `${context}: ${detail}`,
    status: "failed"
  });
  store.persist();
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

if (process.env.DISABLE_BACKGROUND_JOBS !== "true") {
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
}

const distDir = path.resolve(process.cwd(), "dist");
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

server.listen(port, () => {
  console.log(`VPN Payment Control API: http://localhost:${port}`);
});
