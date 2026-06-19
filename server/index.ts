import crypto from "node:crypto";
import http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";
import { Store } from "./store";
import { latencyAggregator } from "./latencyAggregator";
import type {
  AppData,
  AutoDeposit,
  BillingPeriod,
  Currency,
  LatencyCheck,
  Service,
  ServiceConnectionSettings,
  ServiceHealthStatus,
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
const server = http.createServer(app);
const realtime = new WebSocketServer({ server, path: "/api/realtime" });
const port = Number(process.env.PORT ?? 4077);
const store = new Store();
const execFileAsync = promisify(execFile);
latencyAggregator.start();
const latencyLineColors = ["#7aa8ff", "#47d18c", "#f8c15d", "#ff8b82", "#b994ff", "#5ed4d6", "#f49ac2", "#c6cad2"];
const wallFilesDir = path.resolve(process.cwd(), "data", "wall-files");
const maxWallFileSize = 2 * 1024 * 1024 * 1024;

app.use(express.json({ limit: "25mb" }));

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
  if (!session || !data.users.some((user) => user.id === session.userId)) {
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
  data.settings.security.sessions[token] = { userId: user.id, createdAt: nowIso() };
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
  if (req.method === "GET" && /^\/wall\/files\/[^/]+\/download$/.test(req.path)) return next();
  if (req.path.startsWith("/telegram/webhook/")) return next();

  const token = String(req.header("x-auth-token") ?? "");
  const data = store.read();
  const session = token ? data.settings.security.sessions?.[token] : undefined;
  const user = session ? data.users.find((item) => item.id === session.userId) : undefined;

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

function readTime(value: unknown) {
  const raw = String(value ?? "");
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

function latencyBucketSize(rangeMs: number) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (rangeMs <= 2 * day) return 30 * 60 * 1000;
  if (rangeMs <= 14 * day) return 6 * hour;
  if (rangeMs <= 90 * day) return day;
  if (rangeMs <= 370 * day) return 7 * day;
  return 31 * day;
}

function latencyBucketLabel(bucketTime: number, bucketSize: number) {
  const date = new Date(bucketTime);
  const day = 24 * 60 * 60 * 1000;
  if (bucketSize < day) {
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(date);
}

function latencyChartData(data: AppData, query: Record<string, unknown>) {
  const from = readTime(query.from);
  const to = readTime(query.to);
  const rangeMs = Math.max(1, (to ?? Date.now()) - (from ?? ((to ?? Date.now()) - 7 * 24 * 60 * 60 * 1000)));
  const bucketSize = latencyBucketSize(rangeMs);
  const userId = String(query.userId ?? "");
  const knownUserIds = new Set(data.users.map((user) => user.id));
  const checks = data.latencyChecks
    .filter((check) => !check.userId || knownUserIds.has(check.userId))
    .filter((check) => !userId || check.userId === userId)
    .filter((check) => {
      const checkedAt = new Date(check.checkedAt).getTime();
      return (!from || checkedAt >= from) && (!to || checkedAt <= to);
    });

  const latencySeries: Array<{ key: string; name: string; color: string }> = [];
  const latencySeriesByPair = new Map<string, { key: string; name: string; color: string }>();
  const latencyBuckets = new Map<string, { time: string; ts: number; sums: Record<string, { sum: number; count: number }> }>();

  for (const check of checks.filter((item) => item.latencyMs !== null).slice(0, 5000).reverse()) {
    const user = data.users.find((item) => item.id === check.userId);
    const service = data.services.find((item) => item.id === check.serviceId);
    const pair = `${check.userId ?? "unknown"}:${check.serviceId}`;
    let series = latencySeriesByPair.get(pair);
    if (!series && latencySeries.length < latencyLineColors.length) {
      series = {
        key: `latency_${latencySeries.length}`,
        name: userId ? service?.name ?? "Сервис" : `${user?.name ?? "Не выбран"} · ${service?.name ?? "Сервис"}`,
        color: latencyLineColors[latencySeries.length]
      };
      latencySeriesByPair.set(pair, series);
      latencySeries.push(series);
    }
    if (!series) continue;

    const checkedAt = new Date(check.checkedAt).getTime();
    const bucketTime = Math.floor(checkedAt / bucketSize) * bucketSize;
    const bucketId = String(bucketTime);
    const bucket =
      latencyBuckets.get(bucketId) ??
      {
        time: latencyBucketLabel(bucketTime, bucketSize),
        ts: bucketTime,
        sums: {}
      };
    const current = bucket.sums[series.key] ?? { sum: 0, count: 0 };
    current.sum += check.latencyMs ?? 0;
    current.count += 1;
    bucket.sums[series.key] = current;
    latencyBuckets.set(bucketId, bucket);
  }

  return {
    latencyTimeline: Array.from(latencyBuckets.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(-160)
      .map((bucket) => {
        const point: Record<string, string | number> = { time: bucket.time };
        for (const series of latencySeries) {
          const value = bucket.sums[series.key];
          if (value) point[series.key] = Math.round(value.sum / value.count);
        }
        return point;
      }),
    latencySeries
  };
}

function dashboardData(data: AppData, query: Record<string, unknown>) {
  const notificationPage = readPage(
    { offset: query.notificationOffset, limit: query.notificationLimit },
    8,
    50
  );
  const latencyPage = readPage({ offset: query.latencyOffset, limit: query.latencyLimit }, 20, 100);
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

  const latencySeries: Array<{ key: string; name: string; color: string }> = [];
  const latencySeriesByPair = new Map<string, { key: string; name: string; color: string }>();
  const latencyBuckets = new Map<string, { time: string; ts: number; sums: Record<string, { sum: number; count: number }> }>();
  const knownUserIds = new Set(data.users.map((user) => user.id));
  const knownLatencyChecks = data.latencyChecks.filter((check) => !check.userId || knownUserIds.has(check.userId));

  for (const check of knownLatencyChecks.filter((item) => item.latencyMs !== null).slice(0, 240).reverse()) {
    const user = data.users.find((item) => item.id === check.userId);
    const service = data.services.find((item) => item.id === check.serviceId);
    const pair = `${check.userId ?? "unknown"}:${check.serviceId}`;
    let series = latencySeriesByPair.get(pair);
    if (!series && latencySeries.length < latencyLineColors.length) {
      series = {
        key: `latency_${latencySeries.length}`,
        name: `${user?.name ?? "Не выбран"} · ${service?.name ?? "Сервис"}`,
        color: latencyLineColors[latencySeries.length]
      };
      latencySeriesByPair.set(pair, series);
      latencySeries.push(series);
    }
    if (!series) continue;

    const bucketDate = new Date(check.checkedAt);
    bucketDate.setSeconds(0, 0);
    const bucketId = bucketDate.toISOString();
    const bucket =
      latencyBuckets.get(bucketId) ??
      {
        time: new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(bucketDate),
        ts: bucketDate.getTime(),
        sums: {}
      };
    const current = bucket.sums[series.key] ?? { sum: 0, count: 0 };
    current.sum += check.latencyMs ?? 0;
    current.count += 1;
    bucket.sums[series.key] = current;
    latencyBuckets.set(bucketId, bucket);
  }

  const selectedLatencyChart = latencyChartData(data, { from: query.latencyFrom, to: query.latencyTo });
  const latencyStats = new Map<string, { name: string; sum: number; count: number }>();
  for (const check of knownLatencyChecks) {
    if (check.latencyMs === null || !check.userId) continue;
    const user = data.users.find((item) => item.id === check.userId);
    if (!user) continue;
    const current = latencyStats.get(check.userId) ?? { name: user?.name ?? "Участник", sum: 0, count: 0 };
    current.sum += check.latencyMs;
    current.count += 1;
    latencyStats.set(check.userId, current);
  }

  return {
    chart: Array.from(byDate.values()).reverse().slice(-14),
    latencyTimeline: selectedLatencyChart.latencyTimeline.length ? selectedLatencyChart.latencyTimeline : Array.from(latencyBuckets.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(-40)
      .map((bucket) => {
        const point: Record<string, string | number> = { time: bucket.time };
        for (const series of latencySeries) {
          const value = bucket.sums[series.key];
          if (value) point[series.key] = Math.round(value.sum / value.count);
        }
        return point;
      }),
    latencySeries: selectedLatencyChart.latencySeries.length ? selectedLatencyChart.latencySeries : latencySeries,
    latencyByUser: Array.from(latencyStats.values())
      .map((item) => ({ name: item.name, avg: Math.round(item.sum / item.count), count: item.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    latencyRecent: pageResult(knownLatencyChecks, latencyPage.offset, latencyPage.limit),
    notifications: pageResult(data.notifications, notificationPage.offset, notificationPage.limit)
  };
}

function publicData(data: AppData) {
  const services = data.services.map((service) => {
    const source = data.services.find((item) => item.id === service.id);
    const connection = { ...defaultServiceConnection(), ...(service.connection ?? {}) };
    connection.password = "";
    connection.passwordSet = Boolean(source?.connection?.password);
    return { ...service, connection };
  });

  return {
    currencies: data.currencies,
    users: data.users.map(publicUser),
    services,
    memberships: data.memberships,
    autoDeposits: data.autoDeposits,
    deposits: [],
    debits: [],
    latencyChecks: [],
    notifications: [],
    settings: {
      telegram: data.settings.telegram,
      security: {
        adminPassword: "",
        adminPasswordSet: Boolean(data.settings.security?.adminPassword),
        sessions: {}
      }
    }
  };
}

function apiState() {
  const data = store.read();
  return {
    ...publicData(data),
    summaries: computeSummaries(data),
    counts: {
      deposits: data.deposits.length,
      debits: data.debits.length,
      latencyChecks: data.latencyChecks.length,
      notifications: data.notifications.length
    },
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

function validateAdminPassword(data: AppData, password: unknown) {
  const expected = data.settings.security?.adminPassword || "admin";
  if (String(password ?? "") !== expected) {
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
    if (!isAdmin && user.password && String(body.currentPassword ?? "") !== user.password) {
      throw new Error("Неверный текущий пароль");
    }
    user.password = passwordInput;
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

app.get("/api/auth/users", (_req, res) => {
  res.json(ok(authUsers(store.read())));
});

app.post("/api/auth/login", (req, res) => {
  try {
    const data = store.read();
    const user = data.users.find((item) => item.id === String(req.body.userId ?? ""));
    if (!user) throw new Error("Пользователь не найден");
    if (!user.password) throw new Error("Пароль не задан");
    if (String(req.body.password ?? "") !== user.password) throw new Error("Неверный пароль");

    const token = issueAuthToken(data, user);
    store.persist();
    res.json(ok({ token, userId: user.id, state: apiState() }));
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

app.get("/api/state", (_req, res) => {
  res.json(ok(apiState()));
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const data = store.read();
    const payload = dashboardData(data, req.query as Record<string, unknown>);
    if (latencyAggregator.enabled) {
      const chart = await latencyAggregator.queryChart(data, {
        from: req.query.latencyFrom,
        to: req.query.latencyTo
      });
      payload.latencyTimeline = chart.latencyTimeline;
      payload.latencySeries = chart.latencySeries;
    }
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

app.get("/api/latency-checks", async (req, res) => {
  try {
    const { offset, limit } = readPage(req.query as Record<string, unknown>, 20, 100);
    if (latencyAggregator.enabled) {
      res.json(ok(await latencyAggregator.queryMinuteRows(offset, limit)));
      return;
    }

    const actor = authUserFromRequest(req);
    const requestedUserId = String(req.query.userId ?? "");
    const userId = actor?.botAdmin ? requestedUserId : actor?.id ?? "";
    const rows = userId ? store.read().latencyChecks.filter((check) => check.userId === userId) : store.read().latencyChecks;
    res.json(ok(pageResult(rows, offset, limit)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/latency-chart", async (req, res) => {
  try {
    if (latencyAggregator.enabled) {
      res.json(ok(await latencyAggregator.queryChart(store.read(), req.query as Record<string, unknown>)));
      return;
    }

    const actor = authUserFromRequest(req);
    const requestedUserId = String(req.query.userId ?? "");
    const userId = actor?.botAdmin ? requestedUserId : actor?.id ?? "";
    res.json(ok(latencyChartData(store.read(), { ...req.query, userId })));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/latency/measurements", async (req, res) => {
  try {
    const measurements = Array.isArray(req.body) ? req.body : [req.body];
    if (measurements.length === 0) throw new Error("Нет замеров для обработки");
    if (measurements.length > 500) throw new Error("За один запрос можно передать не более 500 замеров");

    const data = store.read();
    const fallbackChecks: LatencyCheck[] = [];

    for (const measurement of measurements) {
      const service = data.services.find((item) => item.id === String(measurement.serviceId ?? ""));
      if (!service) throw new Error("Сервис не найден");

      service.connection = { ...defaultServiceConnection(), ...(service.connection ?? {}) };
      const status = normalizeHealthStatus(measurement.status);
      const checkedAt = String(measurement.checkedAt ?? nowIso());
      const latencyMs =
        typeof measurement.latencyMs === "number" && Number.isFinite(measurement.latencyMs)
          ? Math.max(0, Number(measurement.latencyMs))
          : null;
      const error = String(measurement.error ?? "").slice(0, 240);

      await latencyAggregator.record({
        serviceId: service.id,
        latencyMs,
        status,
        error,
        checkedAt
      });

      if (!latencyAggregator.enabled) {
        fallbackChecks.push({
          id: id("lat"),
          serviceId: service.id,
          userId: null,
          status,
          latencyMs,
          checkedAt,
          error,
          createdAt: nowIso()
        });
      }

      if (service.connection.lastStatus !== "maintenance" || status === "maintenance") {
        service.connection.lastStatus = status;
        service.connection.lastLatencyMs = latencyMs;
        service.connection.lastCheckedAt = checkedAt;
        service.connection.lastError = error;
      }
    }

    if (!latencyAggregator.enabled && fallbackChecks.length > 0) {
      data.latencyChecks.unshift(...fallbackChecks.reverse());
      data.latencyChecks = data.latencyChecks.slice(0, 2000);
    }

    store.persist();
    res.json(ok(apiState()));
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
    res.status(413).json(fail(new Error("Файл больше 2 ГБ")));
    return;
  }

  const fileId = id("wfile");
  const originalName = safeFileName(decodeHeaderValue(req.header("x-file-name"), "file"));
  const storageName = `${fileId}_${originalName}`;
  const filePath = path.join(wallFilesDir, storageName);
  let received = 0;

  try {
    fs.mkdirSync(wallFilesDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(filePath);
      const failUpload = (error: Error) => {
        output.destroy();
        fs.rmSync(filePath, { force: true });
        reject(error);
      };

      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxWallFileSize) {
          req.destroy(new Error("Файл больше 2 ГБ"));
        }
      });
      req.on("error", failUpload);
      output.on("error", failUpload);
      output.on("finish", resolve);
      req.pipe(output);
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

    store.write((current) => {
      current.wallFiles.unshift(file);
    });

    res.json(ok(publicWallFile(file)));
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    res.status(400).json(fail(error));
  }
});

app.post("/api/wall/files/cleanup", (req, res) => {
  try {
    store.write((data) => {
      getRequestActor(req, data, req.query.userId ?? req.body?.userId);
      cleanupUnusedWallFiles(data, normalizeStringList(req.body?.fileIds));
    });
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
    const filePath = path.join(wallFilesDir, file.storageName);
    if (!fs.existsSync(filePath)) throw new Error("Файл отсутствует на сервере");

    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(file.size));
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeFileName(file.originalName).replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
    );
    fs.createReadStream(filePath).pipe(res);
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

    if (storageName) removeWallFileFromDisk({ storageName });
    res.json(ok(wallListData(store.read(), req.query as Record<string, unknown>)));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.get("/api/database/export", (req, res) => {
  try {
    requireAdmin(req);
    const payload = JSON.stringify(store.exportData(), null, 2);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${backupFileName()}"`);
    res.send(payload);
  } catch (error) {
    res.status(403).json(fail(error));
  }
});

app.post("/api/database/import", (req, res) => {
  try {
    requireAdmin(req);
    store.replace(req.body);
    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/system/update", async (req, res) => {
  try {
    requireAdmin(req);
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
      data.latencyChecks = data.latencyChecks.filter((item) => item.userId !== req.params.id);
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

app.post("/api/services/:id/health", async (req, res) => {
  try {
    const data = store.read();
    const service = data.services.find((item) => item.id === req.params.id);
    if (!service) throw new Error("Сервис не найден");

    service.connection = { ...defaultServiceConnection(), ...(service.connection ?? {}) };
    const status = normalizeHealthStatus(req.body.status);
    const checkedAt = String(req.body.checkedAt ?? nowIso());
    const latencyMs =
      typeof req.body.latencyMs === "number" && Number.isFinite(req.body.latencyMs)
        ? Math.max(0, Number(req.body.latencyMs))
        : null;
    const error = String(req.body.error ?? "").slice(0, 240);
    const user = data.users.find((item) => item.id === String(req.body.userId ?? ""));

    const check: LatencyCheck = {
      id: id("lat"),
      serviceId: service.id,
      userId: user?.id ?? null,
      status,
      latencyMs,
      checkedAt,
      error,
      createdAt: nowIso()
    };

    await latencyAggregator.record({
      serviceId: service.id,
      latencyMs,
      status,
      error,
      checkedAt
    });

    if (!latencyAggregator.enabled) {
      data.latencyChecks.unshift(check);
      data.latencyChecks = data.latencyChecks.slice(0, 2000);
    }

    if (service.connection.lastStatus !== "maintenance" || status === "maintenance") {
      service.connection.lastStatus = status;
      service.connection.lastLatencyMs = latencyMs;
      service.connection.lastCheckedAt = checkedAt;
      service.connection.lastError = error;
    }

    store.persist();

    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/services/:id/maintenance", async (req, res) => {
  try {
    requireAdmin(req);
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
    requireAdmin(req);
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

app.put("/api/settings/security", (req, res) => {
  try {
    requireAdmin(req);
    store.write((data) => {
      validateAdminPassword(data, req.body.currentPassword);
      const nextPassword = String(req.body.newPassword ?? "").trim();
      if (!nextPassword) throw new Error("Укажите новый пароль администратора");
      data.settings.security.adminPassword = nextPassword;
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
    await configureTelegramIntegration(data, String(req.body.webhookUrl ?? ""));
    store.persist();
    res.json(ok(apiState()));
  } catch (error) {
    res.status(400).json(fail(error));
  }
});

app.post("/api/telegram/test", async (req, res) => {
  try {
    requireAdmin(req);
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

server.listen(port, () => {
  console.log(`VPN Payment Control API: http://localhost:${port}`);
});
