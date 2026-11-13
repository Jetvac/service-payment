import {
  AlertTriangle,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Newspaper,
  RefreshCcw,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  Wallet,
  X,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, authToken, errorMessage, onUnauthorized } from "./api";
import { ADMIN_VIEWS, AppProvider, useApp, useHashRoute, type View } from "./app-context";
import { balanceWarning, classNames, money } from "./format";
import type { AppState } from "./types";
import { Avatar, FeedbackProvider, Spinner } from "./ui";
import { AccountView } from "./views/AccountView";
import { DashboardView } from "./views/DashboardView";
import { LedgerView } from "./views/LedgerView";
import { LoginView } from "./views/LoginView";
import { PayView } from "./views/PayView";
import { PeopleView } from "./views/PeopleView";
import { ServicesView } from "./views/ServicesView";
import { SettingsView } from "./views/SettingsView";
import { WallView } from "./views/WallView";

type Session = { status: "loading" } | { status: "anonymous"; notice?: string } | { status: "error"; message: string } | { status: "ready"; state: AppState };

const NAV: Array<{ view: View; label: string; icon: LucideIcon }> = [
  { view: "dashboard", label: "Обзор", icon: LayoutDashboard },
  { view: "pay", label: "Внести оплату", icon: Wallet },
  { view: "services", label: "Сервисы", icon: Server },
  { view: "ledger", label: "История", icon: History },
  { view: "wall", label: "Стена", icon: Newspaper },
  { view: "people", label: "Участники", icon: Users },
  { view: "settings", label: "Настройки", icon: Settings }
];

type Theme = "system" | "light" | "dark";
const THEME_KEY = "vpn-pay-theme";

function readTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage may be unavailable (private mode); the theme still applies.
    }
  }, [theme]);
  const cycle = () => setTheme((current) => (current === "system" ? "light" : current === "light" ? "dark" : "system"));
  return [theme, cycle] as const;
}

export default function App() {
  return (
    <FeedbackProvider>
      <Root />
    </FeedbackProvider>
  );
}

function Root() {
  const [route, navigate] = useHashRoute();
  const [session, setSession] = useState<Session>(() => (authToken.get() ? { status: "loading" } : { status: "anonymous" }));

  const loadState = useCallback(() => {
    setSession({ status: "loading" });
    api<AppState>("/api/state")
      .then((state) => setSession({ status: "ready", state }))
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) {
          authToken.clear();
          setSession({ status: "anonymous" });
        } else {
          setSession({ status: "error", message: errorMessage(error) });
        }
      });
  }, []);

  useEffect(() => {
    if (authToken.get()) loadState();
  }, [loadState]);

  useEffect(
    () =>
      onUnauthorized(() => {
        authToken.clear();
        setSession({ status: "anonymous", notice: "Сессия завершилась. Войдите снова" });
      }),
    []
  );

  const logout = useCallback((notice?: string) => {
    api("/api/auth/logout", { body: {} }).catch(() => undefined);
    authToken.clear();
    setSession({ status: "anonymous", notice });
  }, []);

  if (session.status === "loading") {
    return (
      <main className="splash">
        <span className="brand-mark brand-mark-lg">
          <ShieldCheck size={26} />
        </span>
        <Spinner label="Загрузка" />
      </main>
    );
  }

  if (session.status === "error") {
    return (
      <main className="splash">
        <AlertTriangle size={28} />
        <p>{session.message}</p>
        <button className="btn btn-primary" type="button" onClick={loadState}>
          <RefreshCcw size={16} />
          Повторить
        </button>
      </main>
    );
  }

  if (session.status === "anonymous") {
    return (
      <LoginView
        notice={session.notice}
        onLogin={(token, state) => {
          authToken.set(token);
          setSession({ status: "ready", state });
        }}
      />
    );
  }

  return (
    <AppProvider initialState={session.state} route={route} navigate={navigate} onLogout={() => logout()}>
      <Shell onLoggedOutByRestore={() => logout("База восстановлена. Войдите с паролем из резервной копии")} />
    </AppProvider>
  );
}

function Shell({ onLoggedOutByRestore }: { onLoggedOutByRestore: () => void }) {
  const { state, me, isAdmin, route, navigate, logout } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, cycleTheme] = useTheme();
  const items = NAV.filter((item) => isAdmin || !ADMIN_VIEWS.includes(item.view));
  const view = !isAdmin && ADMIN_VIEWS.includes(route.view) ? "dashboard" : route.view;
  const warning = balanceWarning(state, me);

  useEffect(() => setMenuOpen(false), [route.view, route.id]);
  useEffect(() => {
    document.title = `${NAV.find((item) => item.view === view)?.label ?? "Профиль"} · VPN Pay`;
  }, [view]);

  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const themeLabel = theme === "light" ? "Светлая тема" : theme === "dark" ? "Тёмная тема" : "Тема как в системе";

  return (
    <div className={classNames("shell", menuOpen && "menu-open")}>
      <header className="mobile-bar">
        <button className="icon-btn" type="button" aria-label="Меню" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <span className="brand-inline">
          <span className="brand-mark">
            <ShieldCheck size={16} />
          </span>
          VPN Pay
        </span>
        <button className="mobile-balance" type="button" onClick={() => navigate({ view: "account" })}>
          {money(me.balance)}
        </button>
      </header>

      <aside className="sidebar" aria-label="Навигация">
        <div className="brand">
          <span className="brand-mark">
            <ShieldCheck size={18} />
          </span>
          <div>
            <strong>VPN Pay</strong>
            <small>учёт общих оплат</small>
          </div>
        </div>

        <nav className="nav">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <a key={item.view} href={`#/${item.view}`} className={classNames("nav-item", view === item.view && "active")} aria-current={view === item.view ? "page" : undefined}>
                <Icon size={18} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          {isAdmin && (
            <a href="#/settings" className="bot-status">
              <span className={classNames("status-dot", state.botEnabled && "on")} />
              {state.botEnabled ? "Telegram-бот включён" : "Telegram-бот выключен"}
            </a>
          )}
          <div className={classNames("account-chip", view === "account" && "active")}>
            <a href="#/account" className="account-link">
              <Avatar user={me} />
              <span>
                <strong>{me.name}</strong>
                <small className={classNames(me.balance < 0 && "text-bad")}>{money(me.balance)}</small>
              </span>
            </a>
            <button className="icon-btn" type="button" title={themeLabel} aria-label={themeLabel} onClick={cycleTheme}>
              <ThemeIcon size={16} />
            </button>
            <button className="icon-btn" type="button" title="Выйти" aria-label="Выйти" onClick={logout}>
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="scrim" onClick={() => setMenuOpen(false)} />

      <main className="content" id="content">
        {(warning.low || warning.debt) && view !== "pay" && (
          <div className={classNames("banner", warning.debt ? "banner-bad" : "banner-warn")}>
            <AlertTriangle size={18} />
            <div>
              <strong>{warning.debt ? "На балансе задолженность" : "Баланса скоро не хватит"}</strong>
              <span>
                Сейчас {money(me.balance)}
                {warning.required > 0 && <>, на ближайшие списания нужно {money(warning.required)}</>}
              </span>
            </div>
            <button className="btn btn-sm btn-primary" type="button" onClick={() => navigate({ view: "pay" })}>
              Внести оплату
            </button>
          </div>
        )}

        {view === "dashboard" && <DashboardView />}
        {view === "pay" && <PayView />}
        {view === "wall" && <WallView postId={route.id} />}
        {view === "services" && <ServicesView serviceId={route.id} />}
        {view === "people" && <PeopleView />}
        {view === "ledger" && <LedgerView />}
        {view === "settings" && <SettingsView onRestored={onLoggedOutByRestore} />}
        {view === "account" && <AccountView />}
      </main>
    </div>
  );
}
