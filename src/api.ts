const TOKEN_KEY = "vpn-payment-auth-token";
const LEGACY_USER_KEY = "vpn-payment-current-user-id";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const authToken = {
  get: () => storage()?.getItem(TOKEN_KEY) ?? "",
  set: (token: string) => storage()?.setItem(TOKEN_KEY, token),
  clear: () => {
    storage()?.removeItem(TOKEN_KEY);
    storage()?.removeItem(LEGACY_USER_KEY);
  }
};

/** Listeners notified when the server rejects the session (401). */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void) {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

async function readError(response: Response) {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (body?.error) return body.error;
  }
  if (response.status === 413) return "Файл или запрос слишком большой";
  if (response.status >= 500) return "Сервер временно недоступен";
  return `Ошибка запроса (${response.status})`;
}

type RequestOptions = { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal };

/** Calls the JSON API and unwraps `{ ok, payload }`. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = authToken.get();
  const headers: Record<string, string> = { ...options.headers };
  if (token) headers["x-auth-token"] = token;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? (options.body !== undefined || options.raw !== undefined ? "POST" : "GET"),
      headers,
      body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: options.signal
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "Нет связи с сервером");
  }

  if (!response.ok) {
    const message = await readError(response);
    if (response.status === 401 && !path.startsWith("/api/auth/")) unauthorizedListeners.forEach((listener) => listener());
    throw new ApiError(response.status, message);
  }

  const result = (await response.json()) as { ok: boolean; payload?: T; error?: string };
  if (!result.ok) throw new ApiError(response.status, result.error ?? "Ошибка API");
  return result.payload as T;
}

/** Downloads an authenticated file and hands it to the browser. */
export async function downloadFile(path: string, fallbackName: string) {
  const response = await fetch(path, { headers: { "x-auth-token": authToken.get() } });
  if (!response.ok) throw new ApiError(response.status, await readError(response));
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return fileName;
}

export const errorMessage = (error: unknown, fallback = "Что-то пошло не так") =>
  error instanceof Error && error.message ? error.message : fallback;
