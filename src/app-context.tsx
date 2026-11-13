import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorMessage } from "./api";
import type { AppState, Service, User } from "./types";
import { useFeedback } from "./ui";

export type View = "dashboard" | "pay" | "wall" | "services" | "people" | "ledger" | "settings" | "account";
export type Route = { view: View; id?: string };

const VIEWS: View[] = ["dashboard", "pay", "wall", "services", "people", "ledger", "settings", "account"];
export const ADMIN_VIEWS: View[] = ["people", "settings"];

export function parseHash(hash = window.location.hash): Route {
  const [rawView, rawId] = hash.replace(/^#\/?/, "").split("/");
  // Old links used #/bot for the settings page.
  const view = (rawView === "bot" ? "settings" : rawView) as View;
  if (!VIEWS.includes(view)) return { view: "dashboard" };
  return { view, id: rawId ? decodeURIComponent(rawId) : undefined };
}

export function routeHash(route: Route) {
  return `#/${route.view}${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash());
  useEffect(() => {
    const sync = () => setRoute(parseHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const navigate = useCallback((next: Route) => {
    const hash = routeHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    else setRoute(next);
  }, []);
  return [route, navigate] as const;
}

type AppContextValue = {
  state: AppState;
  me: User;
  isAdmin: boolean;
  route: Route;
  navigate: (route: Route) => void;
  /** Increments after every successful change; lists refetch on it. */
  revision: number;
  setState: (state: AppState) => void;
  refresh: () => Promise<void>;
  /**
   * Sends a change that answers with the new state (directly or as
   * `{ state }`). Shows a toast on success or failure; resolves with
   * undefined when the request failed.
   */
  mutate: <T = AppState>(path: string, options?: { body?: unknown; method?: string; success?: string | false }) => Promise<T | undefined>;
  userById: (id: string | null | undefined) => User | undefined;
  serviceById: (id: string | null | undefined) => Service | undefined;
  logout: () => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("AppProvider is missing");
  return context;
}

export function AppProvider({
  initialState,
  route,
  navigate,
  onLogout,
  children
}: {
  initialState: AppState;
  route: Route;
  navigate: (route: Route) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { toast } = useFeedback();
  const [state, setStateRaw] = useState(initialState);
  const [revision, setRevision] = useState(0);

  const setState = useCallback((next: AppState) => {
    setStateRaw(next);
    setRevision((value) => value + 1);
  }, []);

  const refresh = useCallback(async () => {
    setState(await api<AppState>("/api/state"));
  }, [setState]);

  const mutate = useCallback(
    async <T,>(path: string, options: { body?: unknown; method?: string; success?: string | false } = {}) => {
      try {
        const result = await api<T>(path, { method: options.method ?? "POST", body: options.body ?? {} });
        const nextState = result && typeof result === "object" && "state" in result ? (result as { state: AppState }).state : result;
        if (nextState && typeof nextState === "object" && "viewerId" in nextState) setState(nextState as AppState);
        else setRevision((value) => value + 1);
        if (options.success !== false) toast(options.success ?? "Сохранено");
        return result;
      } catch (error) {
        toast(errorMessage(error), "error");
        return undefined;
      }
    },
    [setState, toast]
  );

  const value = useMemo<AppContextValue>(() => {
    const me = state.users.find((user) => user.id === state.viewerId)!;
    const users = new Map(state.users.map((user) => [user.id, user]));
    const services = new Map(state.services.map((service) => [service.id, service]));
    return {
      state,
      me,
      isAdmin: Boolean(me?.botAdmin),
      route,
      navigate,
      revision,
      setState,
      refresh,
      mutate,
      userById: (id) => (id ? users.get(id) : undefined),
      serviceById: (id) => (id ? services.get(id) : undefined),
      logout: onLogout
    };
  }, [state, route, navigate, revision, setState, refresh, mutate, onLogout]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/**
 * Loads a server resource and reloads it whenever `deps` or the app
 * revision change. Stale responses from earlier requests are ignored.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], initial: T) {
  const { revision } = useApp();
  const { toast } = useFeedback();
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted && (error as Error).name !== "AbortError") toast(errorMessage(error), "error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision, tick]);

  return { data, setData, loading, reload: () => setTick((value) => value + 1) };
}
