import type { NextFunction, Request, RequestHandler, Response } from "express";
import { normalizeNumber } from "./domain";
import type { User } from "./types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the auth middleware for every authenticated /api request. */
      authUser?: User;
      /** Session token the request was authenticated with. */
      authToken?: string;
    }
  }
}

/** An error whose message is safe to show to the user, with an HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = "Требуется вход") => new HttpError(401, message);
export const forbidden = (message = "Требуются права администратора") => new HttpError(403, message);
export const notFound = (message: string) => new HttpError(404, message);

export function ok<T>(payload: T) {
  return { ok: true as const, payload };
}

export function fail(error: unknown) {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  return { ok: false as const, error: message };
}

export function sendError(res: Response, error: unknown) {
  if (res.headersSent) return;
  const status = error instanceof HttpError ? error.status : 400;
  res.status(status).json(fail(error));
}

/**
 * Wraps a handler: a returned value is sent as `{ ok: true, payload }`, a
 * thrown error as `{ ok: false, error }` with the error's status (400 for
 * plain domain errors). Handlers that stream a response return undefined.
 */
export function route(handler: (req: Request, res: Response) => unknown): RequestHandler {
  return (req: Request, res: Response, _next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .then((payload) => {
        if (payload !== undefined && !res.headersSent) res.json(ok(payload));
      })
      .catch((error) => sendError(res, error));
  };
}

export function currentUser(req: Request) {
  if (!req.authUser) throw unauthorized();
  return req.authUser;
}

export function requireAdmin(req: Request) {
  const user = currentUser(req);
  if (!user.botAdmin) throw forbidden();
  return user;
}

export function param(req: Request, name: string) {
  return String(req.params[name] ?? "");
}

export type PageResult<T> = { rows: T[]; total: number; offset: number; limit: number; hasMore: boolean };

export function readPage(query: Record<string, unknown>, defaultLimit = 20, maxLimit = 100) {
  const limit = Math.min(maxLimit, Math.max(1, Math.round(normalizeNumber(query.limit, defaultLimit))));
  const offset = Math.max(0, Math.round(normalizeNumber(query.offset, 0)));
  return { limit, offset };
}

export function pageResult<T>(items: T[], offset: number, limit: number): PageResult<T> {
  return {
    rows: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    hasMore: offset + limit < items.length
  };
}

export function text(value: unknown, maxLength: number, fallback = "") {
  return String(value ?? fallback).trim().slice(0, maxLength);
}
