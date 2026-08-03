import type { PaymentIntent, PaymentSettings } from "./types";

type YooKassaPayment = {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid?: boolean;
  amount: { value: string; currency: string };
  confirmation?: { type: string; confirmation_url?: string };
  metadata?: Record<string, string>;
  cancellation_details?: { reason?: string };
};

function authHeader(settings: PaymentSettings) {
  if (!settings.shopId || !settings.secretKey) throw new Error("Заполните shopId и секретный ключ ЮKassa");
  return `Basic ${Buffer.from(`${settings.shopId}:${settings.secretKey}`).toString("base64")}`;
}

async function yooKassaRequest(settings: PaymentSettings, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.yookassa.ru/v3${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: authHeader(settings),
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const payload = (await response.json().catch(() => ({}))) as YooKassaPayment & {
    description?: string;
    code?: string;
  };
  if (!response.ok) throw new Error(payload.description || payload.code || `ЮKassa вернула HTTP ${response.status}`);
  return payload;
}

export async function createYooKassaPayment(
  settings: PaymentSettings,
  intent: PaymentIntent,
  returnUrl: string
) {
  if (intent.method !== "sbp" && intent.method !== "sberbank") throw new Error("Этот способ не поддерживает онлайн-оплату");
  return yooKassaRequest(settings, "/payments", {
    method: "POST",
    headers: { "Idempotence-Key": intent.id },
    body: JSON.stringify({
      amount: { value: intent.amount.toFixed(2), currency: intent.currency },
      capture: true,
      payment_method_data: { type: intent.method },
      confirmation: { type: "redirect", return_url: returnUrl },
      description: intent.description,
      metadata: {
        payment_intent_id: intent.id,
        user_id: intent.userId,
        service_id: intent.serviceId
      }
    })
  });
}

export function getYooKassaPayment(settings: PaymentSettings, paymentId: string) {
  if (!paymentId) throw new Error("Идентификатор платежа отсутствует");
  return yooKassaRequest(settings, `/payments/${encodeURIComponent(paymentId)}`);
}

export function mapYooKassaStatus(payment: YooKassaPayment) {
  if (payment.status === "succeeded" && payment.paid) return "succeeded" as const;
  if (payment.status === "canceled") return "canceled" as const;
  return "pending" as const;
}

export type { YooKassaPayment };
