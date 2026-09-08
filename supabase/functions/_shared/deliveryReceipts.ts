// =============================================================================
// _shared/deliveryReceipts.ts
// Núcleo COMPARTIDO de los webhooks de recibos de entrega (`whatsapp-webhook`
// de Meta y `twilio-status-webhook`). Los dos proveedores mandan formatos y
// vocabularios distintos, pero asientan lo mismo en `notification_log`: acá vive
// esa única escritura, para que las dos decisiones de diseño de abajo no se
// dupliquen ni se desincronicen.
//
// DECISIÓN 1 — un fallo de ENTREGA no toca `notification_log.status`.
// El drenado de notification-dispatch reencola `status='failed' and attempts<5`,
// así que escribir 'failed' desde un webhook dispararía un REENVÍO de un mensaje
// que el proveedor ya aceptó y cobró. El fallo vive en `provider_status` +
// `error`, que son informativos.
//
// DECISIÓN 2 — los estados llegan DESORDENADOS (ni Meta ni Twilio garantizan
// orden), así que hay un rank y nunca se retrocede. `read` también completa
// `delivered_at` si ese evento se perdió, para que la fila no mienta.
// =============================================================================

import type { SupabaseClient } from "./supabaseAdmin.ts";

/**
 * Comparación en tiempo constante: no filtra el secret/firma por timing. Vive
 * acá porque la usan los DOS webhooks de recibos para validar su firma (HMAC-
 * SHA256 hex en Meta, HMAC-SHA1 base64 en Twilio) y el handshake de Meta.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Orden de progreso de un mensaje. Vocabulario común a los dos proveedores. */
export const DELIVERY_RANK: Record<string, number> = {
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

export interface DeliveryReceipt {
  /** wamid (Meta) o MessageSid (Twilio): la llave de correlación de la fila. */
  providerMessageId: string;
  /** Estado ya traducido al vocabulario común (ver DELIVERY_RANK). */
  status: string;
  /** Momento del evento, ISO. */
  at: string;
  /** Motivo legible del fallo (solo se usa cuando status === 'failed'). */
  error?: string | null;
}

/**
 * Asienta un recibo sobre la fila de `notification_log` que originó el mensaje.
 * Devuelve `true` si escribió algo; `false` si el id es desconocido (mensaje que
 * no salió de acá, o fila anterior a 0038), si el estado retrocede o repite, o
 * si el UPDATE falló.
 */
export async function applyDeliveryReceipt(
  admin: SupabaseClient,
  receipt: DeliveryReceipt,
): Promise<boolean> {
  const { data: row } = await admin
    .from("notification_log")
    .select("id, provider_status, delivered_at, read_at, error")
    .eq("provider_message_id", receipt.providerMessageId)
    .maybeSingle();

  if (!row) return false;

  const current = DELIVERY_RANK[(row.provider_status as string) ?? ""] ?? -1;
  const incoming = DELIVERY_RANK[receipt.status] ?? -1;
  if (incoming <= current) return false; // reintento o webhook fuera de orden

  const patch: Record<string, unknown> = { provider_status: receipt.status };
  if (receipt.status === "delivered" && !row.delivered_at) patch.delivered_at = receipt.at;
  if (receipt.status === "read") {
    patch.read_at = receipt.at;
    // 'read' implica entregado: si el webhook de delivered se perdió, no dejamos
    // la fila mintiendo que nunca llegó.
    if (!row.delivered_at) patch.delivered_at = receipt.at;
  }
  // OJO: `status` NO se toca (ver DECISIÓN 1). Solo dejamos el motivo legible.
  if (receipt.status === "failed") {
    patch.error = receipt.error ?? "entrega fallida (sin detalle del proveedor)";
  }

  const { error } = await admin
    .from("notification_log")
    .update(patch)
    .eq("id", row.id as string);
  return !error;
}
