import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Info, Loader2, X, type LucideIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { classNames, initials } from "./format";
import type { PageResult } from "./types";

/* -------------------------------------------------------------------------- */
/* Feedback: toasts and confirmation dialogs                                  */
/* -------------------------------------------------------------------------- */

type ToastTone = "success" | "error" | "info";
type Toast = { id: number; message: string; tone: ToastTone };

type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  /** Ask for a short text (e.g. a cancellation reason). */
  input?: { label: string; placeholder?: string; required?: boolean };
};
type ConfirmRequest = ConfirmOptions & { resolve: (value: string | null) => void };

type Feedback = {
  toast: (message: string, tone?: ToastTone) => void;
  /** Resolves with the entered text ("" without an input) or null when cancelled. */
  confirm: (options: ConfirmOptions) => Promise<string | null>;
};

const FeedbackContext = createContext<Feedback | null>(null);

export function useFeedback() {
  const context = useContext(FeedbackContext);
  if (!context) throw new Error("FeedbackProvider is missing");
  return context;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((message: string, tone: ToastTone = "success") => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), tone === "error" ? 6_000 : 3_500);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<string | null>((resolve) => setRequest({ ...options, resolve })),
    []
  );

  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={classNames("toast", `toast-${item.tone}`)}>
            {item.tone === "error" ? <AlertTriangle size={16} /> : item.tone === "info" ? <Info size={16} /> : <Check size={16} />}
            <span>{item.message}</span>
            <button type="button" className="toast-close" aria-label="Закрыть" onClick={() => setToasts((current) => current.filter((toastItem) => toastItem.id !== item.id))}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      {request && (
        <ConfirmDialog
          request={request}
          onDone={(value) => {
            request.resolve(value);
            setRequest(null);
          }}
        />
      )}
    </FeedbackContext.Provider>
  );
}

function ConfirmDialog({ request, onDone }: { request: ConfirmRequest; onDone: (value: string | null) => void }) {
  const [text, setText] = useState("");
  const blocked = Boolean(request.input?.required && !text.trim());
  return (
    <Modal
      title={request.title}
      size="sm"
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={() => onDone(null)}>
            Отмена
          </button>
          <button
            className={classNames("btn", request.tone === "danger" ? "btn-danger" : "btn-primary")}
            type="button"
            disabled={blocked}
            onClick={() => onDone(text.trim())}
          >
            {request.confirmLabel ?? "Подтвердить"}
          </button>
        </>
      }
    >
      {request.message && <div className="confirm-message">{request.message}</div>}
      {request.input && (
        <Field label={request.input.label}>
          <input autoFocus value={text} placeholder={request.input.placeholder} maxLength={300} onChange={(event) => setText(event.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                          */
/* -------------------------------------------------------------------------- */

export function Modal({
  title,
  description,
  size = "md",
  children,
  footer,
  onClose
}: {
  title: string;
  description?: ReactNode;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const target = panel.querySelector<HTMLElement>("[autofocus], input:not([type=hidden]), select, textarea, button.btn-primary");
      (target ?? panel).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      // Passive cleanups run after the DOM update, so only other open modals remain.
      if (!document.querySelector(".modal-backdrop")) document.body.classList.remove("modal-open");
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={panelRef} className={classNames("modal", `modal-${size}`)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-btn" type="button" aria-label="Закрыть" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  flush = false
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={classNames("card", flush && "card-flush", className)}>
      {(title || actions) && (
        <header className="card-header">
          <div className="card-heading">
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone = "neutral"
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
}) {
  return (
    <div className={classNames("stat", `tone-${tone}`)}>
      <span className="stat-icon">
        <Icon size={18} />
      </span>
      <div className="stat-text">
        <span className="stat-label">{label}</span>
        <strong className="stat-value">{value}</strong>
        {hint && <span className="stat-hint">{hint}</span>}
      </div>
    </div>
  );
}

export function Empty({ icon: Icon, title, text, action }: { icon?: LucideIcon; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {Icon && (
        <span className="empty-icon">
          <Icon size={22} />
        </span>
      )}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <Loader2 size={16} className="spin" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad" | "accent" | "muted"; children: ReactNode }) {
  return <span className={classNames("badge", `badge-${tone}`)}>{children}</span>;
}

export function Avatar({ user, size = "md" }: { user: { name: string; avatarUrl?: string }; size?: "sm" | "md" | "lg" | "xl" }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [user.avatarUrl]);
  return (
    <span className={classNames("avatar", `avatar-${size}`)} aria-hidden="true">
      {user.avatarUrl && !broken ? <img src={user.avatarUrl} alt="" onError={() => setBroken(true)} /> : initials(user.name || "?")}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Forms                                                                      */
/* -------------------------------------------------------------------------- */

export function Field({ label, hint, children, wide = false }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={classNames("field", wide && "field-wide")}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={classNames("switch-row", disabled && "disabled")}>
      <span className="switch-text">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={classNames(option.value === value && "active")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Pagination<T>({ page, onChange }: { page: PageResult<T>; onChange: (offset: number) => void }) {
  if (page.total <= page.limit && page.offset === 0) return null;
  const current = Math.floor(page.offset / page.limit) + 1;
  const total = Math.max(1, Math.ceil(page.total / page.limit));
  return (
    <nav className="pagination" aria-label="Страницы">
      <button className="icon-btn" type="button" aria-label="Предыдущая страница" disabled={page.offset === 0} onClick={() => onChange(Math.max(0, page.offset - page.limit))}>
        <ChevronLeft size={16} />
      </button>
      <span>
        {current} из {total}
      </span>
      <button className="icon-btn" type="button" aria-label="Следующая страница" disabled={!page.hasMore} onClick={() => onChange(page.offset + page.limit)}>
        <ChevronRight size={16} />
      </button>
    </nav>
  );
}

export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  }
}

export function CopyButton({ value, label = "Скопировать" }: { value: string; label?: string }) {
  const { toast } = useFeedback();
  return (
    <button
      className="icon-btn"
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => toast((await copyText(value)) ? "Скопировано" : "Не удалось скопировать", "info")}
    >
      <Copy size={15} />
    </button>
  );
}

/** Keeps a value stable until it has not changed for `delay` ms. */
export function useDebounced<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
