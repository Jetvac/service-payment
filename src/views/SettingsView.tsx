import { Bot, Coins, DatabaseBackup, FileJson, KeyRound, Pencil, Plus, Radio, RefreshCcw, Send, ShieldCheck, Upload, Wallet, Webhook } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, downloadFile, errorMessage } from "../api";
import { useApp } from "../app-context";
import { dateTime } from "../format";
import type { Currency, PaymentSettings, TelegramSettings } from "../types";
import { Badge, Card, CopyButton, Field, Modal, PageHeader, Spinner, Switch, useFeedback } from "../ui";

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, task: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await task();
    } finally {
      setBusy(null);
    }
  };
  return [busy, run] as const;
}

function SaveBar({ dirty, saving, onReset }: { dirty: boolean; saving: boolean; onReset: () => void }) {
  return (
    <div className="save-bar">
      {dirty && <span className="muted">Есть несохранённые изменения</span>}
      <button className="btn btn-ghost" type="button" disabled={!dirty || saving} onClick={onReset}>
        Сбросить
      </button>
      <button className="btn btn-primary" type="submit" disabled={!dirty || saving}>
        {saving && <Spinner />}
        Сохранить
      </button>
    </div>
  );
}

function PaymentSettingsCard() {
  const { state, mutate } = useApp();
  const [form, setForm] = useState<PaymentSettings>(state.settings.payments);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(state.settings.payments), [state.settings.payments]);
  const dirty = JSON.stringify(form) !== JSON.stringify(state.settings.payments);
  const set = <K extends keyof PaymentSettings>(key: K, value: PaymentSettings[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    await mutate("/api/settings/payments", { method: "PUT", body: form, success: "Реквизиты сохранены" });
    setSaving(false);
  };

  return (
    <Card title="Приём оплаты" subtitle="Участники переводят деньги сами и отмечают платёж в разделе «Внести оплату»">
      <form className="form" onSubmit={submit}>
        <Switch
          checked={form.manualEnabled}
          onChange={(value) => set("manualEnabled", value)}
          label="Участники могут отмечать оплату сами"
          description="Выключите, чтобы зачислять платежи могли только администраторы"
        />
        <div className="form-grid">
          <Field label="Получатель">
            <input value={form.recipientName} maxLength={120} onChange={(event) => set("recipientName", event.target.value)} />
          </Field>
          <Field label="Банк">
            <input value={form.bankName} maxLength={120} onChange={(event) => set("bankName", event.target.value)} />
          </Field>
          <Field label="Телефон для СБП">
            <input type="tel" value={form.phone} maxLength={40} onChange={(event) => set("phone", event.target.value)} />
          </Field>
          <Field label="Счёт или карта">
            <input value={form.account} maxLength={80} onChange={(event) => set("account", event.target.value)} />
          </Field>
          <Field label="Назначение платежа" wide>
            <input value={form.paymentPurpose} maxLength={200} onChange={(event) => set("paymentPurpose", event.target.value)} />
          </Field>
        </div>
        <SaveBar dirty={dirty} saving={saving} onReset={() => setForm(state.settings.payments)} />
      </form>
    </Card>
  );
}

type TelegramForm = Pick<TelegramSettings, "enabled" | "chatId" | "notificationTopicId" | "lowBalanceNotifications" | "monthlySummary"> & { botToken: string; webhookSecret: string };

function telegramForm(settings: TelegramSettings): TelegramForm {
  return {
    enabled: settings.enabled,
    chatId: settings.chatId,
    notificationTopicId: settings.notificationTopicId,
    lowBalanceNotifications: settings.lowBalanceNotifications,
    monthlySummary: settings.monthlySummary,
    botToken: "",
    webhookSecret: ""
  };
}

function TelegramCard({ settings }: { settings: TelegramSettings }) {
  const { mutate } = useApp();
  const [form, setForm] = useState(() => telegramForm(settings));
  const [busy, run] = useBusy();
  useEffect(() => setForm(telegramForm(settings)), [settings]);
  const dirty = JSON.stringify(form) !== JSON.stringify(telegramForm(settings));
  const set = <K extends keyof TelegramForm>(key: K, value: TelegramForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("save", () => mutate("/api/settings/telegram", { method: "PUT", body: form, success: "Настройки бота сохранены" }));
  };

  const mode = settings.pollingEnabled ? "Polling" : settings.lastUpdateAt ? "Webhook" : "Не подключён";

  return (
    <Card
      title="Telegram-бот"
      subtitle="Команды /pay, /balance, /services и уведомления о списаниях"
      actions={<Badge tone={settings.enabled ? "good" : "muted"}>{settings.enabled ? "включён" : "выключен"}</Badge>}
    >
      <div className="diagnostics">
        <div>
          <span>Режим</span>
          <strong>{mode}</strong>
        </div>
        <div>
          <span>Последнее сообщение</span>
          <strong>{dateTime(settings.lastUpdateAt)}</strong>
        </div>
        <div>
          <span>Топик уведомлений</span>
          <strong>{settings.notificationTopicId || "—"}</strong>
        </div>
        {settings.lastError && (
          <div className="diagnostics-error">
            <span>Последняя ошибка</span>
            <strong>{settings.lastError}</strong>
          </div>
        )}
      </div>

      <form className="form" onSubmit={submit}>
        <Switch checked={form.enabled} onChange={(value) => set("enabled", value)} label="Бот включён" description="Выключенный бот не отвечает на команды и не шлёт уведомления" />
        <div className="form-grid">
          <Field label="Bot token" hint={settings.botTokenSet ? "Сохранён. Введите новый, чтобы заменить" : "Выдаёт @BotFather"}>
            <input type="password" autoComplete="off" value={form.botToken} placeholder={settings.botTokenSet ? "••••••••••" : "123456:ABC…"} onChange={(event) => set("botToken", event.target.value.trim())} />
          </Field>
          <Field label="Webhook secret" hint={settings.webhookSecretSet ? "Задан. Введите новый, чтобы заменить" : "Минимум 8 символов"}>
            <input type="password" autoComplete="off" value={form.webhookSecret} placeholder={settings.webhookSecretSet ? "••••••••••" : ""} onChange={(event) => set("webhookSecret", event.target.value.trim())} />
          </Field>
          <Field label="Chat ID для уведомлений" hint="Проще всего задать командой /settopic в нужном чате">
            <input value={form.chatId} onChange={(event) => set("chatId", event.target.value.trim())} />
          </Field>
          <Field label="Topic ID">
            <input value={form.notificationTopicId} onChange={(event) => set("notificationTopicId", event.target.value.trim())} />
          </Field>
        </div>
        <Switch checked={form.lowBalanceNotifications} onChange={(value) => set("lowBalanceNotifications", value)} label="Предупреждать о малом остатке" />
        <Switch checked={form.monthlySummary} onChange={(value) => set("monthlySummary", value)} label="Сводка остатков после списания" />
        <SaveBar dirty={dirty} saving={busy === "save"} onReset={() => setForm(telegramForm(settings))} />
      </form>

      <div className="divider" />

      <div className="action-grid">
        <ActionTile
          icon={Webhook}
          title="Webhook"
          text="Для сервера с публичным HTTPS-адресом"
          disabled={dirty || !settings.botTokenSet}
          busy={busy === "webhook"}
          onClick={() => run("webhook", () => mutate("/api/telegram/configure", { success: "Webhook зарегистрирован" }))}
        />
        <ActionTile
          icon={Radio}
          title={settings.pollingEnabled ? "Остановить polling" : "Polling"}
          text="Сервер сам забирает сообщения — подходит без домена"
          disabled={dirty || !settings.botTokenSet}
          busy={busy === "polling"}
          onClick={() =>
            run("polling", () =>
              mutate(settings.pollingEnabled ? "/api/telegram/polling/stop" : "/api/telegram/polling/start", {
                success: settings.pollingEnabled ? "Polling остановлен" : "Polling запущен"
              })
            )
          }
        />
        <ActionTile
          icon={Send}
          title="Тест"
          text="Отправить проверочное сообщение в чат"
          disabled={dirty || !settings.botTokenSet}
          busy={busy === "test"}
          onClick={() => run("test", () => mutate("/api/telegram/test", { body: {}, success: "Тестовое сообщение отправлено" }))}
        />
      </div>
      {dirty && <p className="muted">Сохраните изменения, чтобы подключить бота.</p>}

      {settings.webhookUrl && (
        <div className="code-line">
          <code>{settings.webhookUrl}</code>
          <CopyButton value={settings.webhookUrl} label="Скопировать адрес webhook" />
        </div>
      )}
    </Card>
  );
}

function ActionTile({ icon: Icon, title, text, disabled, busy, onClick }: { icon: typeof Bot; title: string; text: string; disabled?: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button className="action-tile" type="button" disabled={disabled || busy} onClick={onClick}>
      <span className="action-tile-icon">{busy ? <Spinner /> : <Icon size={18} />}</span>
      <strong>{title}</strong>
      <small>{text}</small>
    </button>
  );
}

function CurrencyModal({ currency, onClose }: { currency?: Currency; onClose: () => void }) {
  const { mutate } = useApp();
  const [form, setForm] = useState({ code: currency?.code ?? "", name: currency?.name ?? "", symbol: currency?.symbol ?? "", rateToRub: String(currency?.rateToRub ?? "") });
  const rate = Number(form.rateToRub.replace(",", "."));
  const isBase = currency?.code === "RUB";
  const valid = /^[A-Z]{3}$/.test(form.code) && form.name.trim() && (isBase || (Number.isFinite(rate) && rate > 0));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const result = await mutate(currency ? `/api/currencies/${currency.code}` : "/api/currencies", {
      method: currency ? "PUT" : "POST",
      body: { ...form, rateToRub: rate },
      success: "Валюта сохранена"
    });
    if (result) onClose();
  };

  return (
    <Modal
      title={currency ? `Валюта ${currency.code}` : "Новая валюта"}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" type="submit" form="currency-form" disabled={!valid}>
            Сохранить
          </button>
        </>
      }
    >
      <form id="currency-form" className="form" onSubmit={submit}>
        <div className="form-row">
          <Field label="Код" hint="ISO, например USD">
            <input autoFocus={!currency} readOnly={Boolean(currency)} maxLength={3} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase().replace(/[^A-Z]/g, "") })} />
          </Field>
          <Field label="Символ">
            <input value={form.symbol} maxLength={6} onChange={(event) => setForm({ ...form, symbol: event.target.value })} />
          </Field>
        </div>
        <Field label="Название">
          <input autoFocus={Boolean(currency)} value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Курс к рублю" hint={isBase ? "Рубль — базовая валюта балансов, его курс всегда 1" : "Сколько рублей стоит 1 единица валюты"}>
          <input inputMode="decimal" disabled={isBase} value={isBase ? "1" : form.rateToRub} onChange={(event) => setForm({ ...form, rateToRub: event.target.value.replace(/[^\d.,]/g, "") })} />
        </Field>
      </form>
    </Modal>
  );
}

function CurrenciesCard() {
  const { state } = useApp();
  const [editing, setEditing] = useState<Currency | "new" | null>(null);
  return (
    <Card
      title="Валюты"
      subtitle="Балансы ведутся в рублях; платежи в другой валюте пересчитываются по курсу"
      flush
      actions={
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing("new")}>
          <Plus size={16} />
          Добавить
        </button>
      }
    >
      <ul className="currency-list">
        {state.currencies.map((currency) => (
          <li key={currency.code}>
            <span className="currency-code">{currency.code}</span>
            <span className="currency-name">
              <strong>{currency.name}</strong>
              <small>обновлён {dateTime(currency.updatedAt)}</small>
            </span>
            <span className="num">{currency.code === "RUB" ? "базовая" : `${currency.rateToRub.toLocaleString("ru-RU", { maximumFractionDigits: 4 })} ₽`}</span>
            <button className="icon-btn" type="button" aria-label={`Изменить ${currency.code}`} title="Изменить" onClick={() => setEditing(currency)}>
              <Pencil size={16} />
            </button>
          </li>
        ))}
      </ul>
      {editing && <CurrencyModal currency={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function AdminPasswordModal({ onClose }: { onClose: () => void }) {
  const { mutate } = useApp();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", repeat: "" });
  const mismatch = form.repeat.length > 0 && form.repeat !== form.newPassword;
  const valid = form.currentPassword && form.newPassword.length >= 8 && form.newPassword === form.repeat;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const result = await mutate("/api/settings/security", { method: "PUT", body: form, success: "Пароль администратора изменён" });
    if (result) onClose();
  };

  return (
    <Modal
      title="Пароль администратора"
      description="Нужен, чтобы выдать кому-то права администратора"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" type="submit" form="admin-password-form" disabled={!valid}>
            Сменить
          </button>
        </>
      }
    >
      <form id="admin-password-form" className="form" onSubmit={submit}>
        <Field label="Текущий пароль">
          <input type="password" autoComplete="current-password" value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} />
        </Field>
        <Field label="Новый пароль" hint="Минимум 8 символов">
          <input type="password" autoComplete="new-password" value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} />
        </Field>
        <Field label="Повторите пароль" hint={mismatch ? "Пароли не совпадают" : undefined}>
          <input type="password" autoComplete="new-password" value={form.repeat} onChange={(event) => setForm({ ...form, repeat: event.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}

function SystemCard({ onRestored }: { onRestored: () => void }) {
  const { toast, confirm } = useFeedback();
  const [busy, run] = useBusy();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const download = (key: string, path: string, fallback: string) =>
    run(key, async () => {
      try {
        const name = await downloadFile(path, fallback);
        toast(`Скачано: ${name}`);
      } catch (error) {
        toast(errorMessage(error, "Не удалось скачать копию"), "error");
      }
    });

  const restore = async (file: File) => {
    const isJson = file.name.toLowerCase().endsWith(".json");
    const answer = await confirm({
      title: "Восстановить базу из копии?",
      message: (
        <>
          Все текущие данные будут заменены содержимым файла <strong>{file.name}</strong>. Перед этим лучше скачать свежую копию. После восстановления потребуется войти заново.
          {isJson && " JSON-копия не содержит вложений стены: файлы останутся только если они уже есть в текущей базе."}
        </>
      ),
      confirmLabel: "Восстановить",
      tone: "danger"
    });
    if (answer === null) return;
    await run("restore", async () => {
      try {
        if (isJson) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(await file.text());
          } catch {
            throw new Error("Файл не является корректным JSON");
          }
          await api("/api/database/import", { body: parsed });
        } else {
          await api("/api/database/import", { raw: file, headers: { "Content-Type": "application/vnd.sqlite3" } });
        }
        onRestored();
      } catch (error) {
        toast(errorMessage(error, "Не удалось восстановить базу"), "error");
      }
    });
  };

  const update = async () => {
    const answer = await confirm({
      title: "Обновить приложение?",
      message: "Новая версия соберётся из репозитория, после чего сервис перезапустится. Перед заменой создаётся резервная копия; при ошибке старая версия вернётся автоматически.",
      confirmLabel: "Обновить"
    });
    if (answer === null) return;
    await run("update", async () => {
      try {
        const result = await api<{ scheduled: boolean }>("/api/system/update", { body: {} });
        toast(result.scheduled ? "Обновление запущено — сайт перезапустится через пару минут" : "Обновление установлено, перезапустите приложение", "info");
      } catch (error) {
        toast(errorMessage(error, "Не удалось запустить обновление"), "error");
      }
    });
  };

  return (
    <Card title="Система" subtitle="Резервные копии, обновление и доступ">
      <div className="action-grid">
        <ActionTile
          icon={DatabaseBackup}
          title="Скачать БД"
          text="Полная копия SQLite со всеми файлами стены"
          busy={busy === "sqlite"}
          onClick={() => download("sqlite", "/api/database/export", "service-payment-backup.sqlite")}
        />
        <ActionTile
          icon={FileJson}
          title="Скачать JSON"
          text="Копия в старом формате (без вложений) — для совместимости"
          busy={busy === "json"}
          onClick={() => download("json", "/api/database/export.json", "service-payment-backup.json")}
        />
        <ActionTile icon={Upload} title="Загрузить БД" text="Восстановить из .sqlite или старого .json" busy={busy === "restore"} onClick={() => fileInput.current?.click()} />
        <ActionTile icon={RefreshCcw} title="Обновить приложение" text="Сборка, проверка и перезапуск с откатом при ошибке" busy={busy === "update"} onClick={update} />
        <ActionTile icon={KeyRound} title="Пароль администратора" text="Нужен для выдачи прав администратора" onClick={() => setPasswordOpen(true)} />
      </div>
      <input
        ref={fileInput}
        hidden
        type="file"
        aria-label="Файл резервной копии"
        accept=".sqlite,.db,.json,application/vnd.sqlite3,application/json"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void restore(file);
        }}
      />
      {passwordOpen && <AdminPasswordModal onClose={() => setPasswordOpen(false)} />}
    </Card>
  );
}

const COMMANDS: Array<[string, string]> = [
  ["/pay 600", "зачислить сумму в валюте первого сервиса"],
  ["/deposit 600 VPN Main", "зачислить на конкретный сервис"],
  ["/balance", "показать баланс"],
  ["/services", "подключённые сервисы и списания"],
  ["/users", "остатки всех участников (админ)"],
  ["/settopic", "направить уведомления в этот чат или топик (админ)"],
  ["/help", "список команд"]
];

function Section({ id, icon: Icon, title, children }: { id: string; icon: typeof Bot; title: string; children: ReactNode }) {
  return (
    <section className="settings-section" id={id} aria-labelledby={`${id}-title`}>
      <h2 className="section-title" id={`${id}-title`}>
        <Icon size={18} />
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingsView({ onRestored }: { onRestored: () => void }) {
  const { state } = useApp();
  return (
    <div className="page">
      <PageHeader title="Настройки" subtitle="Приём оплаты, Telegram-бот, валюты и обслуживание" />
      <Section id="payments" icon={Wallet} title="Оплата">
        <PaymentSettingsCard />
      </Section>
      <Section id="telegram" icon={Bot} title="Telegram">
        {state.settings.telegram && <TelegramCard settings={state.settings.telegram} />}
        <Card title="Команды бота">
          <dl className="commands">
            {COMMANDS.map(([command, description]) => (
              <div key={command}>
                <dt>
                  <code>{command}</code>
                </dt>
                <dd>{description}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </Section>
      <Section id="currencies" icon={Coins} title="Валюты">
        <CurrenciesCard />
      </Section>
      <Section id="system" icon={ShieldCheck} title="Обслуживание">
        <SystemCard onRestored={onRestored} />
      </Section>
    </div>
  );
}
