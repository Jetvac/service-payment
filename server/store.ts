import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppData, WallFile } from "./types";
import {
  BALANCE_CURRENCY,
  buildNextAutoDepositDate,
  defaultPaymentSettings,
  defaultServiceConnection,
  normalizeNumber,
  nowIso,
  roundMoney,
  seedData
} from "./domain";
import { hashPassword, isPasswordHash, sessionExpiresAt, sessionIsActive } from "./security";

const dataDir = path.resolve(process.env.APP_DATA_DIR || path.join(process.cwd(), "data"));
const legacyDataFile = path.join(dataDir, "db.json");
const wallFilesDir = path.join(dataDir, "wall-files");
const databaseFile = path.resolve(process.env.APP_DATABASE_PATH || path.join(dataDir, "service-payment.sqlite"));

function cloneData(data: AppData) {
  return JSON.parse(JSON.stringify(data)) as AppData;
}

export class Store {
  private db: Database.Database;
  private data: AppData;

  constructor() {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = this.openDatabase();
    this.data = this.load();
    this.migrateLegacyFiles();
  }

  read() {
    return this.data;
  }

  exportData() {
    return cloneData(this.data);
  }

  write(mutator: (data: AppData) => void) {
    const next = cloneData(this.data);
    mutator(next);
    this.persistData(next);
    this.data = next;
    return this.data;
  }

  replace(raw: unknown) {
    const wallData = {
      wallFiles: this.data.wallFiles ?? [],
      wallPosts: this.data.wallPosts ?? [],
      wallTags: this.data.wallTags ?? [],
      wallComments: this.data.wallComments ?? []
    };
    const next = {
      ...this.migrate(this.normalizeImport(raw)),
      ...wallData
    };
    this.persistData(next);
    this.data = next;
    return this.data;
  }

  persist() {
    this.persistData(this.data);
  }

  private load(): AppData {
    const row = this.db.prepare("SELECT data FROM app_state WHERE id = 1").get() as { data?: string } | undefined;
    if (row?.data) {
      const migrated = this.migrate(JSON.parse(row.data) as AppData);
      this.persistData(migrated);
      return migrated;
    }

    const initial = fs.existsSync(legacyDataFile)
      ? this.migrate(JSON.parse(fs.readFileSync(legacyDataFile, "utf-8")) as AppData)
      : this.migrate(seedData());
    this.persistData(initial);
    return initial;
  }

  private openDatabase() {
    const db = new Database(databaseFile, { timeout: 5000 });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wall_file_blobs (
        file_id TEXT PRIMARY KEY,
        content BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wall_file_blobs_updated_at ON wall_file_blobs(updated_at);
    `);
    return db;
  }

  private persistData(data: AppData) {
    this.db
      .prepare(
        `INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(data), new Date().toISOString());
  }

  saveWallFile(file: WallFile, content: Buffer) {
    const next = cloneData(this.data);
    next.wallFiles = next.wallFiles.filter((item) => item.id !== file.id);
    next.wallFiles.unshift(file);
    const save = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO wall_file_blobs (file_id, content, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(file_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
        )
        .run(file.id, content, new Date().toISOString());
      this.persistData(next);
    });
    save();
    this.data = next;
    return file;
  }

  readWallFile(fileId: string) {
    const row = this.db.prepare("SELECT content FROM wall_file_blobs WHERE file_id = ?").get(fileId) as { content?: Buffer } | undefined;
    return row?.content ? Buffer.from(row.content) : null;
  }

  deleteWallFileBlob(fileId: string) {
    this.db.prepare("DELETE FROM wall_file_blobs WHERE file_id = ?").run(fileId);
  }

  async backupTo(destination: string) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await this.db.backup(destination);
    return destination;
  }

  replaceWithDatabase(sourceFile: string) {
    const candidate = new Database(sourceFile, { readonly: true, fileMustExist: true });
    try {
      const row = candidate.prepare("SELECT data FROM app_state WHERE id = 1").get() as { data?: string } | undefined;
      if (!row?.data) throw new Error("В резервной копии отсутствует состояние приложения");
      this.migrate(JSON.parse(row.data) as AppData);
    } finally {
      candidate.close();
    }

    const rollbackFile = `${databaseFile}.rollback`;
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
    fs.copyFileSync(databaseFile, rollbackFile);

    try {
      fs.copyFileSync(sourceFile, databaseFile);
      fs.rmSync(`${databaseFile}-wal`, { force: true });
      fs.rmSync(`${databaseFile}-shm`, { force: true });
      this.db = this.openDatabase();
      this.data = this.load();
      fs.rmSync(rollbackFile, { force: true });
      return this.data;
    } catch (error) {
      try {
        if (this.db?.open) this.db.close();
      } catch {
        // ignore failed candidate close before restoring the known-good database
      }
      fs.copyFileSync(rollbackFile, databaseFile);
      fs.rmSync(`${databaseFile}-wal`, { force: true });
      fs.rmSync(`${databaseFile}-shm`, { force: true });
      this.db = this.openDatabase();
      this.data = this.load();
      throw error;
    }
  }

  getDatabasePath() {
    return databaseFile;
  }

  private migrateLegacyFiles() {
    if (!fs.existsSync(wallFilesDir)) return;
    const insert = this.db.prepare("INSERT OR IGNORE INTO wall_file_blobs (file_id, content, updated_at) VALUES (?, ?, ?)");
    const migrateAll = this.db.transaction(() => {
      for (const file of this.data.wallFiles) {
        if (!file.storageName) continue;
        const legacyPath = path.join(wallFilesDir, file.storageName);
        if (!fs.existsSync(legacyPath)) continue;
        insert.run(file.id, fs.readFileSync(legacyPath), new Date().toISOString());
      }
    });
    migrateAll();
  }

  private normalizeImport(raw: unknown): AppData {
    if (!raw || typeof raw !== "object") {
      throw new Error("Некорректный файл базы данных");
    }

    const backup = raw as Partial<AppData>;
    const fallback = seedData();

    if (
      !Array.isArray(backup.users) ||
      !Array.isArray(backup.services) ||
      !Array.isArray(backup.memberships) ||
      !Array.isArray(backup.currencies)
    ) {
      throw new Error("Файл не похож на backup Service Payment");
    }

    return {
      ...fallback,
      ...backup,
      currencies: backup.currencies,
      users: backup.users,
      services: backup.services,
      memberships: backup.memberships,
      autoDeposits: Array.isArray(backup.autoDeposits) ? backup.autoDeposits : [],
      deposits: Array.isArray(backup.deposits) ? backup.deposits : [],
      debits: Array.isArray(backup.debits) ? backup.debits : [],
      latencyChecks: Array.isArray(backup.latencyChecks) ? backup.latencyChecks : [],
      notifications: Array.isArray(backup.notifications) ? backup.notifications : [],
      payments: Array.isArray(backup.payments) ? backup.payments : [],
      wallTags: Array.isArray(backup.wallTags) ? backup.wallTags : [],
      wallFiles: Array.isArray(backup.wallFiles) ? backup.wallFiles : [],
      wallPosts: Array.isArray(backup.wallPosts) ? backup.wallPosts : [],
      wallComments: Array.isArray(backup.wallComments) ? backup.wallComments : [],
      settings: {
        ...fallback.settings,
        ...(backup.settings ?? {}),
        telegram: {
          ...fallback.settings.telegram,
          ...(backup.settings?.telegram ?? {})
        },
        security: {
          ...fallback.settings.security,
          ...(backup.settings?.security ?? {})
        },
        payments: {
          ...fallback.settings.payments,
          ...(backup.settings?.payments ?? {})
        }
      }
    } as AppData;
  }

  private migrate(data: AppData): AppData {
    const toBalanceCurrency = (amount: number, fromCode: string) => {
      const from = data.currencies.find((currency) => currency.code === fromCode);
      const to = data.currencies.find((currency) => currency.code === BALANCE_CURRENCY);
      if (!from || !to) return roundMoney(amount);
      return roundMoney((amount * from.rateToRub) / to.rateToRub);
    };

    for (const service of data.services) {
      service.notes ??= "";
      service.active ??= true;
      service.monthlyCost = roundMoney(service.monthlyCost);
      const connection = { ...defaultServiceConnection(), ...(service.connection ?? {}) };
      connection.enabled = Boolean(connection.enabled);
      connection.host = String(connection.host ?? "").trim();
      connection.port = Math.max(1, Math.min(65535, normalizeNumber(connection.port, 8765)));
      connection.sshPort = Math.max(1, Math.min(65535, normalizeNumber(connection.sshPort, 22)));
      connection.user = String(connection.user ?? "").trim();
      connection.password = String(connection.password ?? "");
      connection.passwordSet = Boolean(connection.password);
      connection.websocketPath = String(connection.websocketPath ?? "/echo").trim() || "/echo";
      if (!connection.websocketPath.startsWith("/")) connection.websocketPath = `/${connection.websocketPath}`;
      connection.useTls = Boolean(connection.useTls);
      connection.lastStatus = ["online", "offline", "unknown", "maintenance"].includes(connection.lastStatus)
        ? connection.lastStatus
        : "unknown";
      connection.lastLatencyMs =
        typeof connection.lastLatencyMs === "number" && Number.isFinite(connection.lastLatencyMs)
          ? Math.max(0, Math.round(connection.lastLatencyMs))
          : null;
      connection.lastCheckedAt ??= null;
      connection.lastError = String(connection.lastError ?? "");
      connection.lastDeployStatus = ["success", "failed", "unknown"].includes(connection.lastDeployStatus)
        ? connection.lastDeployStatus
        : "unknown";
      connection.lastDeployAt ??= null;
      connection.lastDeployOutput = String(connection.lastDeployOutput ?? "").slice(-8000);
      service.connection = connection;
    }

    for (const user of data.users) {
      user.notes ??= "";
      user.commandDepositsBlocked ??= false;
      user.botAdmin ??= false;
      user.telegramId ??= "";
      user.telegramUsername ??= "";
      user.avatarUrl ??= "";
      user.password = String(user.password || process.env.INITIAL_ADMIN_PASSWORD || "admin");
      if (!isPasswordHash(user.password)) user.password = hashPassword(user.password);
      user.passwordSet = Boolean(user.password);
      const legacyBalances = (data.memberships ?? []).filter(
        (membership) => membership.userId === user.id && typeof membership.balance === "number"
      );
      const legacyBalance = roundMoney(
        legacyBalances.reduce((sum, membership) => {
          const service = data.services.find((item) => item.id === membership.serviceId);
          return sum + toBalanceCurrency(Number(membership.balance ?? 0), service?.currency ?? BALANCE_CURRENCY);
        }, 0)
      );

      if (typeof user.balance !== "number" || (user.balance === 0 && legacyBalances.length > 0)) {
        user.balance = legacyBalance;
      } else {
        user.balance = roundMoney(user.balance);
      }
    }

    if (data.users.length > 0 && !data.users.some((user) => user.botAdmin)) {
      data.users[0].botAdmin = true;
    }

    data.notifications ??= [];
    data.payments ??= [];
    data.wallTags ??= [];
    data.wallFiles ??= [];
    data.wallPosts ??= [];
    data.wallComments ??= [];
    data.autoDeposits ??= [];
    data.deposits ??= [];
    data.debits ??= [];
    data.latencyChecks ??= [];
    data.memberships ??= [];
    data.settings ??= seedData().settings;
    data.settings.telegram ??= seedData().settings.telegram;
    data.settings.security ??= { adminPassword: process.env.INITIAL_ADMIN_PASSWORD || "admin", adminPasswordSet: true };
    data.settings.security.adminPassword = String(
      data.settings.security.adminPassword || process.env.INITIAL_ADMIN_PASSWORD || "admin"
    );
    if (!isPasswordHash(data.settings.security.adminPassword)) {
      data.settings.security.adminPassword = hashPassword(data.settings.security.adminPassword);
    }
    data.settings.security.adminPasswordSet = Boolean(data.settings.security.adminPassword);
    data.settings.security.sessions ??= {};
    for (const [token, session] of Object.entries(data.settings.security.sessions)) {
      if (!sessionIsActive(session) || !data.users.some((user) => user.id === session.userId)) {
        delete data.settings.security.sessions[token];
        continue;
      }
      session.expiresAt ??= sessionExpiresAt(new Date(session.createdAt));
    }
    data.settings.telegram.pollingEnabled ??= false;
    data.settings.telegram.notificationTopicId ??= "";
    data.settings.telegram.updateOffset ??= 0;
    data.settings.telegram.lastUpdateAt ??= null;
    data.settings.telegram.lastError ??= "";
    data.settings.telegram.botTokenSet = Boolean(data.settings.telegram.botToken);
    data.settings.telegram.webhookSecretSet = Boolean(data.settings.telegram.webhookSecret);
    data.settings.payments = { ...defaultPaymentSettings(), ...(data.settings.payments ?? {}) };
    data.settings.payments.secretKeySet = Boolean(data.settings.payments.secretKey);

    for (const payment of data.payments) {
      payment.id = String(payment.id ?? "");
      payment.userId = String(payment.userId ?? "");
      payment.serviceId = String(payment.serviceId ?? "");
      payment.amount = roundMoney(Math.max(0, normalizeNumber(payment.amount, 0)));
      payment.currency = String(payment.currency ?? BALANCE_CURRENCY).toUpperCase();
      payment.method = ["manual", "sbp", "sberbank"].includes(payment.method) ? payment.method : "manual";
      payment.provider = payment.method === "manual" ? "manual" : "yookassa";
      payment.status = ["pending", "succeeded", "canceled", "failed"].includes(payment.status)
        ? payment.status
        : "pending";
      payment.externalId = String(payment.externalId ?? "");
      payment.confirmationUrl = String(payment.confirmationUrl ?? "");
      payment.description = String(payment.description ?? "").slice(0, 128);
      payment.comment = String(payment.comment ?? "").slice(0, 500);
      payment.depositId = payment.depositId ? String(payment.depositId) : null;
      payment.failureReason = String(payment.failureReason ?? "").slice(0, 500);
      payment.createdAt = String(payment.createdAt ?? nowIso());
      payment.updatedAt = String(payment.updatedAt ?? payment.createdAt);
      payment.paidAt = payment.paidAt ? String(payment.paidAt) : null;
    }

    for (const membership of data.memberships) {
      delete membership.balance;
    }

    for (const schedule of data.autoDeposits) {
      schedule.userId = String(schedule.userId ?? "");
      schedule.serviceId =
        String(schedule.serviceId ?? "") ||
        data.memberships.find((membership) => membership.userId === schedule.userId && membership.active)?.serviceId ||
        "";
      schedule.amount = roundMoney(Math.max(0, normalizeNumber(schedule.amount, 0)));
      schedule.currency = data.currencies.some((currency) => currency.code === schedule.currency)
        ? schedule.currency
        : BALANCE_CURRENCY;
      schedule.dayOfMonth = Math.max(1, Math.min(31, normalizeNumber(schedule.dayOfMonth, 1)));
      schedule.hour = Math.max(0, Math.min(23, normalizeNumber(schedule.hour, 12)));
      schedule.enabled = Boolean(schedule.enabled);
      schedule.comment ??= "";
      schedule.lastDepositedAt ??= null;
      schedule.nextDepositAt ??= buildNextAutoDepositDate(new Date(), schedule.dayOfMonth, schedule.hour).toISOString();
      schedule.createdAt ??= new Date().toISOString();
      schedule.updatedAt ??= schedule.createdAt;
    }

    for (const deposit of data.deposits) {
      deposit.cancelledAt ??= null;
      deposit.reversalId ??= null;
      deposit.reversesId ??= null;
      deposit.amountOriginal = roundMoney(deposit.amountOriginal);
      deposit.amountServiceCurrency = roundMoney(deposit.amountServiceCurrency);
      deposit.serviceCurrency ??= data.services.find((service) => service.id === deposit.serviceId)?.currency ?? BALANCE_CURRENCY;
      deposit.amountBalanceCurrency ??= toBalanceCurrency(deposit.amountServiceCurrency, deposit.serviceCurrency);
      deposit.amountBalanceCurrency = roundMoney(deposit.amountBalanceCurrency);
      deposit.balanceCurrency ??= BALANCE_CURRENCY;
      if (deposit.balanceCurrency !== BALANCE_CURRENCY) {
        deposit.balanceAfter = toBalanceCurrency(deposit.balanceAfter, deposit.balanceCurrency);
        deposit.balanceCurrency = BALANCE_CURRENCY;
      } else {
        deposit.balanceAfter = roundMoney(deposit.balanceAfter);
      }
    }

    for (const debit of data.debits) {
      debit.cancelledAt ??= null;
      debit.reversalId ??= null;
      debit.reversesId ??= null;
      debit.amount = roundMoney(debit.amount);
      debit.currency ??= data.services.find((service) => service.id === debit.serviceId)?.currency ?? BALANCE_CURRENCY;
      debit.amountBalanceCurrency ??= toBalanceCurrency(debit.amount, debit.currency);
      debit.amountBalanceCurrency = roundMoney(debit.amountBalanceCurrency);
      debit.balanceCurrency ??= BALANCE_CURRENCY;
      debit.rateSnapshot ??= Object.fromEntries(data.currencies.map((currency) => [currency.code, currency.rateToRub]));
      if (debit.balanceCurrency !== BALANCE_CURRENCY) {
        debit.balanceAfter = toBalanceCurrency(debit.balanceAfter, debit.balanceCurrency);
        debit.balanceCurrency = BALANCE_CURRENCY;
      } else {
        debit.balanceAfter = roundMoney(debit.balanceAfter);
      }
    }

    for (const check of data.latencyChecks) {
      check.userId = check.userId ? String(check.userId) : null;
      check.serviceId = String(check.serviceId ?? "");
      check.status = ["online", "offline", "unknown", "maintenance"].includes(check.status) ? check.status : "unknown";
      check.latencyMs =
        typeof check.latencyMs === "number" && Number.isFinite(check.latencyMs)
          ? Math.max(0, Math.round(check.latencyMs))
          : null;
      check.checkedAt = String(check.checkedAt ?? check.createdAt ?? new Date().toISOString());
      check.createdAt = String(check.createdAt ?? check.checkedAt);
      check.error = String(check.error ?? "").slice(0, 240);
    }

    for (const tag of data.wallTags) {
      tag.id = String(tag.id ?? "");
      tag.name = String(tag.name ?? "Тег").trim() || "Тег";
      tag.color = String(tag.color ?? "#7aa8ff");
      tag.pinned = Boolean(tag.pinned);
      tag.archived = Boolean(tag.archived);
      tag.createdAt = String(tag.createdAt ?? new Date().toISOString());
    }

    for (const file of data.wallFiles) {
      file.id = String(file.id ?? "");
      file.originalName = String(file.originalName ?? "file");
      file.storageName = String(file.storageName ?? "");
      file.mimeType = String(file.mimeType ?? "application/octet-stream");
      file.size = Math.max(0, normalizeNumber(file.size, 0));
      file.url = `/api/wall/files/${encodeURIComponent(file.id)}/download`;
      file.uploadedBy = String(file.uploadedBy ?? "");
      file.createdAt = String(file.createdAt ?? new Date().toISOString());
    }

    for (const post of data.wallPosts) {
      const legacyPost = post as typeof post & { preview?: unknown; pinned?: unknown; archived?: unknown };
      post.id = String(post.id ?? "");
      post.title = String(post.title ?? "Без названия").trim() || "Без названия";
      post.previewFileId = post.previewFileId ? String(post.previewFileId) : null;
      if (post.previewFileId && !data.wallFiles.some((file) => file.id === post.previewFileId)) post.previewFileId = null;
      post.content = String(post.content ?? "");
      post.authorId = String(post.authorId ?? data.users[0]?.id ?? "");
      post.serviceId = post.serviceId ? String(post.serviceId) : null;
      post.tagIds = Array.isArray(post.tagIds) ? post.tagIds.map(String) : [];
      post.fileIds = Array.isArray(post.fileIds) ? post.fileIds.map(String) : [];
      delete legacyPost.preview;
      delete legacyPost.pinned;
      delete legacyPost.archived;
      post.views = Math.max(0, normalizeNumber(post.views, 0));
      post.createdAt = String(post.createdAt ?? new Date().toISOString());
      post.updatedAt = String(post.updatedAt ?? post.createdAt);
    }

    for (const comment of data.wallComments) {
      comment.id = String(comment.id ?? "");
      comment.postId = String(comment.postId ?? "");
      comment.parentId = comment.parentId ? String(comment.parentId) : null;
      comment.authorId = String(comment.authorId ?? data.users[0]?.id ?? "");
      comment.content = String(comment.content ?? "");
      comment.fileIds = Array.isArray(comment.fileIds) ? comment.fileIds.map(String) : [];
      comment.deletedAt = comment.deletedAt ? String(comment.deletedAt) : null;
      comment.createdAt = String(comment.createdAt ?? new Date().toISOString());
      comment.updatedAt = String(comment.updatedAt ?? comment.createdAt);
    }

    return data;
  }
}
