import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AppContext } from "./context";
import { fail, sendError, unauthorized } from "./http";
import { accountRoutes, sessionUser, userRoutes } from "./routes/account";
import { adminRoutes, databaseImportRoute, telegramWebhookRoute } from "./routes/admin";
import { financeRoutes } from "./routes/finance";
import { wallDownloadRoute, wallRoutes } from "./wall";

const PAGE_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self'",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join("; ");

export function createApp(context: AppContext) {
  const { store } = context;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.header("x-auth-token") ?? "");
    const user = sessionUser(store.read(), token);
    if (!user) {
      sendError(res, unauthorized());
      return;
    }
    req.authUser = user;
    req.authToken = token;
    next();
  };

  // Public endpoints.
  app.get("/api/health", (_req, res) => res.json({ ok: true, status: "ready", serverTime: new Date().toISOString() }));
  app.post("/api/telegram/webhook/:secret", express.json({ limit: "1mb" }), telegramWebhookRoute(context));
  app.get("/api/wall/files/:id/download", wallDownloadRoute(context));

  // Streaming bodies must not pass through the JSON parser: a backup can be
  // large, and an uploaded file may itself be JSON.
  app.post("/api/database/import", authenticate, databaseImportRoute(context));
  const jsonParser = express.json({ limit: "5mb" });
  app.use("/api", (req, res, next) => (req.method === "POST" && req.path === "/wall/files" ? next() : jsonParser(req, res, next)));

  app.use("/api", accountRoutes(context));
  app.use("/api", authenticate);
  app.use("/api", userRoutes(context), financeRoutes(context), adminRoutes(context), wallRoutes(context));
  app.use("/api", (_req, res) => {
    res.status(404).json(fail(new Error("Метод API не найден")));
  });

  const distDir = path.resolve(process.cwd(), "dist");
  app.use(express.static(distDir, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader("Content-Security-Policy", PAGE_SECURITY_POLICY);
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(distDir, "index.html"), (error) => {
      if (error && !res.headersSent) res.status(404).type("text").send("Интерфейс не собран: выполните npm run build");
    });
  });

  // Malformed JSON and oversized bodies from the parsers end up here.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status;
    if (status === 413) {
      res.status(413).json(fail(new Error("Слишком большой запрос")));
      return;
    }
    if (status === 400) {
      res.status(400).json(fail(new Error("Некорректный JSON в запросе")));
      return;
    }
    sendError(res, error);
  });

  return app;
}
