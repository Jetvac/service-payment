import crypto from "node:crypto";
import { Router, type Request } from "express";
import type { AppContext } from "../context";
import { id, nowIso } from "../domain";
import { badRequest, currentUser, forbidden, HttpError, notFound, param, requireAdmin, route, text, unauthorized } from "../http";
import { assertStrongPassword, hashPassword, sessionExpiresAt, sessionIsActive, verifyPassword } from "../security";
import { fetchTelegramAvatar } from "../telegram";
import type { AppData, User } from "../types";
import { apiState } from "../views";

const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60_000;
const MAX_AVATAR_LENGTH = 700_000;

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function pruneLoginAttempts(now = Date.now()) {
  for (const [key, attempt] of loginAttempts) if (attempt.resetAt <= now) loginAttempts.delete(key);
}

export function sessionUser(data: AppData, token: string) {
  const session = token ? data.settings.security.sessions?.[token] : undefined;
  if (!sessionIsActive(session)) return undefined;
  return data.users.find((user) => user.id === session?.userId);
}

function pruneSessions(data: AppData) {
  const sessions = data.settings.security.sessions ?? {};
  for (const [token, session] of Object.entries(sessions)) {
    if (!sessionIsActive(session) || !data.users.some((user) => user.id === session.userId)) delete sessions[token];
  }
}

function validateAdminPassword(data: AppData, password: unknown) {
  if (!verifyPassword(data.settings.security.adminPassword, String(password ?? ""))) {
    throw badRequest("Неверный пароль администратора");
  }
}

/** Accepts an http(s) link or an inline raster image; anything else is rejected. */
export function normalizeAvatar(value: unknown) {
  const avatar = String(value ?? "").trim();
  if (!avatar) return "";
  if (avatar.length > MAX_AVATAR_LENGTH) throw badRequest("Аватар слишком большой");
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(avatar)) return avatar;
  try {
    const url = new URL(avatar);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    // fall through
  }
  throw badRequest("Аватар должен быть ссылкой http(s) или изображением");
}

type UserInput = Partial<Omit<User, "balance">> & { adminPassword?: string; currentPassword?: string; password?: string };

/**
 * Applies a profile change. Administrators manage everything except the
 * balance, which only moves through ledger operations. Participants may only
 * change their own avatar and password.
 */
function applyUserInput(data: AppData, user: User, body: UserInput, actor: User) {
  const isAdmin = actor.botAdmin;
  if (!isAdmin && actor.id !== user.id) throw forbidden("Нет прав на изменение участника");

  const password = typeof body.password === "string" ? body.password.trim() : "";
  if (password) {
    assertStrongPassword(password);
    const changingOwn = actor.id === user.id;
    if (changingOwn && user.password && !verifyPassword(user.password, String(body.currentPassword ?? ""))) {
      throw badRequest("Неверный текущий пароль");
    }
    user.password = hashPassword(password);
    user.passwordSet = true;
  }

  if (body.avatarUrl !== undefined) user.avatarUrl = normalizeAvatar(body.avatarUrl);
  if (!isAdmin) return;

  const nextBotAdmin = body.botAdmin === undefined ? user.botAdmin : Boolean(body.botAdmin);
  if (nextBotAdmin && !user.botAdmin) validateAdminPassword(data, body.adminPassword);
  if (!nextBotAdmin && user.botAdmin && !data.users.some((item) => item.id !== user.id && item.botAdmin)) {
    throw badRequest("Нельзя снять права с последнего администратора");
  }

  if (body.name !== undefined) user.name = text(body.name, 80) || user.name;
  if (body.telegramId !== undefined) {
    const telegramId = text(body.telegramId, 32);
    if (telegramId && !/^-?\d+$/.test(telegramId)) throw badRequest("Telegram ID должен состоять из цифр");
    if (telegramId && data.users.some((item) => item.id !== user.id && item.telegramId === telegramId)) {
      throw badRequest("Этот Telegram ID уже привязан к другому участнику");
    }
    user.telegramId = telegramId;
  }
  if (body.telegramUsername !== undefined) user.telegramUsername = text(body.telegramUsername, 64).replace(/^@/, "");
  if (body.commandDepositsBlocked !== undefined) user.commandDepositsBlocked = Boolean(body.commandDepositsBlocked);
  if (body.notes !== undefined) user.notes = String(body.notes).slice(0, 2_000);
  user.botAdmin = nextBotAdmin;
}

export function accountRoutes({ store }: AppContext) {
  const router = Router();

  router.get(
    "/auth/users",
    route(() =>
      store.read().users.map((user) => ({
        id: user.id,
        name: user.name,
        avatarUrl: user.avatarUrl,
        botAdmin: user.botAdmin,
        passwordSet: Boolean(user.password)
      }))
    )
  );

  router.post(
    "/auth/login",
    route((req, res) => {
      const userId = String(req.body?.userId ?? "");
      const attemptKey = `${req.ip}:${userId}`;
      const now = Date.now();
      pruneLoginAttempts(now);
      const attempt = loginAttempts.get(attemptKey);
      if (attempt && attempt.count >= MAX_LOGIN_ATTEMPTS) {
        res.setHeader("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
        throw new HttpError(429, "Слишком много попыток. Повторите вход через несколько минут");
      }

      const user = store.read().users.find((item) => item.id === userId);
      if (!user) throw unauthorized("Пользователь не найден");
      if (!user.password) throw unauthorized("Пароль не задан. Попросите администратора задать пароль");
      if (!verifyPassword(user.password, String(req.body?.password ?? ""))) {
        const next = attempt ?? { count: 0, resetAt: now + LOGIN_WINDOW_MS };
        next.count += 1;
        loginAttempts.set(attemptKey, next);
        throw unauthorized("Неверный пароль");
      }

      loginAttempts.delete(attemptKey);
      const token = `sess_${crypto.randomBytes(24).toString("hex")}`;
      store.write((data) => {
        pruneSessions(data);
        data.settings.security.sessions ??= {};
        const createdAt = nowIso();
        data.settings.security.sessions[token] = { userId: user.id, createdAt, expiresAt: sessionExpiresAt(new Date(createdAt)) };
      });
      const viewer = store.read().users.find((item) => item.id === user.id)!;
      return { token, userId: user.id, state: apiState(store, viewer, req) };
    })
  );

  router.post(
    "/auth/logout",
    route((req) => {
      const token = String(req.header("x-auth-token") ?? "");
      if (token && store.read().settings.security.sessions?.[token]) {
        store.write((data) => {
          delete data.settings.security.sessions?.[token];
        });
      }
      return { loggedOut: true };
    })
  );

  return router;
}

/** Routes that need an authenticated user (mounted after the auth middleware). */
export function userRoutes({ store }: AppContext) {
  const router = Router();
  const state = (req: Request) => apiState(store, currentUser(req), req);

  router.get("/state", route((req) => state(req)));

  router.post(
    "/users",
    route(async (req) => {
      const actor = requireAdmin(req);
      const body = (req.body ?? {}) as UserInput;
      // Fetch the avatar before writing so the write itself stays synchronous.
      const avatar = body.telegramId && !body.avatarUrl ? await fetchTelegramAvatar(store.read(), String(body.telegramId)) : null;
      store.write((data) => {
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
        applyUserInput(data, user, body, data.users.find((item) => item.id === actor.id)!);
        if (avatar) user.avatarUrl = avatar;
        data.users.push(user);
      });
      return state(req);
    })
  );

  router.put(
    "/users/:id",
    route(async (req) => {
      const actor = currentUser(req);
      const userId = param(req, "id");
      const existing = store.read().users.find((item) => item.id === userId);
      if (!existing) throw notFound("Пользователь не найден");
      const body = (req.body ?? {}) as UserInput;

      const telegramId = body.telegramId === undefined ? existing.telegramId : String(body.telegramId).trim();
      const shouldFetchAvatar = actor.botAdmin && telegramId && body.avatarUrl === undefined && (!existing.avatarUrl || telegramId !== existing.telegramId);
      const avatar = shouldFetchAvatar ? await fetchTelegramAvatar(store.read(), telegramId) : null;

      store.write((data) => {
        const user = data.users.find((item) => item.id === userId);
        if (!user) throw notFound("Пользователь не найден");
        applyUserInput(data, user, body, data.users.find((item) => item.id === actor.id) ?? actor);
        if (avatar) user.avatarUrl = avatar;
      });
      return state(req);
    })
  );

  router.delete(
    "/users/:id",
    route((req) => {
      const actor = requireAdmin(req);
      const userId = param(req, "id");
      if (userId === actor.id) throw badRequest("Нельзя удалить самого себя");
      store.write((data) => {
        const user = data.users.find((item) => item.id === userId);
        if (!user) throw notFound("Пользователь не найден");
        if (user.botAdmin && !data.users.some((item) => item.id !== userId && item.botAdmin)) {
          throw badRequest("Нельзя удалить последнего администратора");
        }
        data.users = data.users.filter((item) => item.id !== userId);
        data.memberships = data.memberships.filter((item) => item.userId !== userId);
        data.autoDeposits = data.autoDeposits.filter((item) => item.userId !== userId);
        pruneSessions(data);
      });
      return state(req);
    })
  );

  return router;
}
