import { Camera, History, KeyRound, Trash2, Wallet } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useApp } from "../app-context";
import { activeServicesFor, longDate, money, telegramHandle } from "../format";
import { Avatar, Badge, Card, Field, PageHeader, useFeedback } from "../ui";

/** Scales an image down to a square avatar and returns it as a JPEG data URL. */
async function toAvatarDataUrl(file: File, size = 256) {
  if (!file.type.startsWith("image/")) throw new Error("Выберите изображение");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      element.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Браузер не поддерживает обработку изображений");
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AccountView() {
  const { state, me, mutate, navigate } = useApp();
  const { toast } = useFeedback();
  const fileInput = useRef<HTMLInputElement>(null);
  const [passwords, setPasswords] = useState({ currentPassword: "", password: "", repeat: "" });
  const services = activeServicesFor(state, me.id);

  const saveAvatar = (avatarUrl: string) => mutate(`/api/users/${me.id}`, { method: "PUT", body: { avatarUrl }, success: avatarUrl ? "Аватар обновлён" : "Аватар удалён" });

  const mismatch = passwords.repeat.length > 0 && passwords.repeat !== passwords.password;
  const canChange = passwords.password.length >= 8 && passwords.password === passwords.repeat && (!me.passwordSet || passwords.currentPassword);

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!canChange) return;
    const result = await mutate(`/api/users/${me.id}`, {
      method: "PUT",
      body: { password: passwords.password, currentPassword: passwords.currentPassword },
      success: "Пароль изменён"
    });
    if (result) setPasswords({ currentPassword: "", password: "", repeat: "" });
  };

  return (
    <div className="page">
      <PageHeader title="Профиль" />

      <div className="grid grid-2">
        <Card>
          <div className="profile">
            <div className="profile-avatar">
              <Avatar user={me} size="xl" />
              <button className="icon-btn profile-avatar-edit" type="button" aria-label="Загрузить аватар" title="Загрузить аватар" onClick={() => fileInput.current?.click()}>
                <Camera size={16} />
              </button>
            </div>
            <div className="profile-text">
              <h2>{me.name}</h2>
              <p className="muted">{telegramHandle(me) || "Telegram не привязан"}</p>
              <div className="badges">
                {me.botAdmin && <Badge tone="accent">администратор</Badge>}
                <Badge>с {longDate(me.createdAt)}</Badge>
              </div>
            </div>
          </div>
          {me.avatarUrl && (
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => saveAvatar("")}>
              <Trash2 size={15} />
              Убрать аватар
            </button>
          )}
          <input
            ref={fileInput}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="Файл аватара"
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              try {
                await saveAvatar(await toAvatarDataUrl(file));
              } catch (error) {
                toast(error instanceof Error ? error.message : "Не удалось загрузить аватар", "error");
              }
            }}
          />

          <div className="divider" />

          <div className="profile-balance">
            <div>
              <span className="muted">Баланс</span>
              <strong className={me.balance < 0 ? "text-bad" : undefined}>{money(me.balance)}</strong>
            </div>
            <div className="toolbar">
              <button className="btn btn-ghost" type="button" onClick={() => navigate({ view: "ledger" })}>
                <History size={16} />
                История
              </button>
              <button className="btn btn-primary" type="button" disabled={!services.length} onClick={() => navigate({ view: "pay" })}>
                <Wallet size={16} />
                Внести оплату
              </button>
            </div>
          </div>
        </Card>

        <Card title="Пароль" subtitle="Используется для входа в веб-интерфейс">
          <form className="form" onSubmit={changePassword}>
            {me.passwordSet && (
              <Field label="Текущий пароль">
                <input type="password" autoComplete="current-password" value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} />
              </Field>
            )}
            <Field label="Новый пароль" hint="Минимум 8 символов">
              <input type="password" autoComplete="new-password" value={passwords.password} onChange={(event) => setPasswords({ ...passwords, password: event.target.value })} />
            </Field>
            <Field label="Повторите пароль" hint={mismatch ? "Пароли не совпадают" : undefined}>
              <input type="password" autoComplete="new-password" value={passwords.repeat} onChange={(event) => setPasswords({ ...passwords, repeat: event.target.value })} />
            </Field>
            <button className="btn btn-primary" type="submit" disabled={!canChange}>
              <KeyRound size={16} />
              Сменить пароль
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}
