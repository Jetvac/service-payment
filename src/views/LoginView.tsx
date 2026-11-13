import { LogIn, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";
import { classNames } from "../format";
import type { AppState, AuthUser } from "../types";
import { Avatar, Badge, Empty, Field, Spinner } from "../ui";

export function LoginView({ notice, onLogin }: { notice?: string; onLogin: (token: string, state: AppState) => void }) {
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<AuthUser[]>("/api/auth/users")
      .then((list) => {
        setUsers(list);
        setSelectedId((current) => current || list.find((user) => user.passwordSet)?.id || list[0]?.id || "");
      })
      .catch((reason) => setLoadError(errorMessage(reason, "Не удалось загрузить участников")));
  }, []);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (users ?? []).filter((user) => !query || user.name.toLowerCase().includes(query));
  }, [search, users]);
  const selected = users?.find((user) => user.id === selectedId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !password) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await api<{ token: string; state: AppState }>("/api/auth/login", { body: { userId: selected.id, password } });
      onLogin(result.token, result.state);
    } catch (reason) {
      setError(errorMessage(reason, "Не удалось войти"));
      setSubmitting(false);
    }
  };

  return (
    <main className="login">
      <section className="login-card">
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg">
            <ShieldCheck size={24} />
          </span>
          <div>
            <h1>VPN Pay</h1>
            <p>Учёт общих оплат за VPN</p>
          </div>
        </div>

        {notice && <div className="notice">{notice}</div>}
        {loadError && <div className="notice notice-bad">{loadError}</div>}

        {!users && !loadError && <Spinner label="Загрузка участников" />}

        {users && !users.length && <Empty title="Участников пока нет" text="Администратор создаётся при первом запуске сервера." />}

        {users && users.length > 0 && (
          <form className="login-form" onSubmit={submit}>
            <fieldset className="login-users">
              <legend>Участник</legend>
              {users.length > 6 && (
                <div className="input-icon">
                  <Search size={16} />
                  <input type="search" placeholder="Найти по имени" aria-label="Найти участника" value={search} onChange={(event) => setSearch(event.target.value)} />
                </div>
              )}
              <div className="login-user-list" role="radiogroup" aria-label="Участник">
                {visible.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    role="radio"
                    aria-checked={user.id === selectedId}
                    className={classNames("login-user", user.id === selectedId && "selected")}
                    onClick={() => {
                      setSelectedId(user.id);
                      setError("");
                    }}
                  >
                    <Avatar user={user} />
                    <span className="login-user-name">{user.name}</span>
                    {user.botAdmin && <Badge tone="accent">админ</Badge>}
                    {!user.passwordSet && <Badge tone="muted">без пароля</Badge>}
                  </button>
                ))}
                {!visible.length && <p className="muted">Никого не нашли</p>}
              </div>
            </fieldset>

            {selected && !selected.passwordSet ? (
              <div className="notice">Для «{selected.name}» пароль ещё не задан. Попросите администратора задать его.</div>
            ) : (
              <Field label="Пароль">
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  autoFocus
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError("");
                  }}
                />
              </Field>
            )}

            {error && (
              <div className="notice notice-bad" role="alert">
                {error}
              </div>
            )}

            <button className="btn btn-primary btn-block" type="submit" disabled={!selected?.passwordSet || !password || submitting}>
              {submitting ? <Spinner /> : <LogIn size={17} />}
              Войти
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
