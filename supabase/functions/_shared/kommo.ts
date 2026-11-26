// =============================================================================
// _shared/kommo.ts
// Sincronización con Kommo (CRM de marketing). Mueve el lead de un taller entre
// etapas del pipeline de ventas; Kommo, por su lado, reenvía esos movimientos a
// Meta como eventos de conversión. Lo llaman:
//   - promo-intake                    → prueba activada   (stage "trial")
//   - subscription-renewal-approval   → primer pago       (stage "purchase")
//
// Reglas (todas a propósito):
//   - APAGADO por defecto: sin el secret KOMMO_TOKEN no se llama a nadie.
//   - NUNCA rompe el flujo del taller: corre en segundo plano, no lanza, y un
//     fallo de Kommo solo deja la fecha `*_synced_at` en null.
//   - El `lid` viene de una URL pública, así que no se confía en él: solo se
//     mueve un lead que existe, está en NUESTRO pipeline y no está ya ganado.
//   - El token da acceso total al CRM: vive solo como secret de la función.
// =============================================================================

import type { SupabaseClient } from "./supabaseAdmin.ts";

export const KOMMO_DEFAULT_BASE_URL = "https://gmdigital1209.kommo.com/api/v4";
/** Pipeline "Embudo de ventas". */
export const KOMMO_PIPELINE_ID = 14812171;
/** Etapa "Demo realizada / Prueba activa". */
export const KOMMO_STATUS_TRIAL = 114455767;
/** Etapa "Logrado con éxito" (id fijo de Kommo para "ganado"). */
export const KOMMO_STATUS_WON = 142;

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 8000;
const BACKOFF_MS = [1000, 3000];

/**
 * moved    = el lead cambió de etapa.
 * skipped  = no hay nada que hacer y no lo habrá (no existe, es de otro
 *            pipeline, ya está ganado o ya está en esa etapa). Definitivo.
 * failed   = Kommo no respondió bien (5xx/429 agotados, token malo, red).
 *            Reintentable: NO se marca como sincronizado.
 * disabled = falta KOMMO_TOKEN.
 */
export type KommoOutcome = "moved" | "skipped" | "failed" | "disabled";

export interface KommoDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  token?: string;
  baseUrl?: string;
}

/** Id de lead de Kommo: entero positivo. Cualquier otra cosa → null (se ignora). */
export function parseLeadId(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** fetch con hasta 3 intentos ante 5xx / 429 / error de red. null = agotado. */
async function fetchWithRetry(
  doFetch: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 3000);
    try {
      const res = await doFetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!isRetryable(res.status)) return res;
      await res.body?.cancel();
    } catch {
      // red / timeout: se reintenta
    }
  }
  return null;
}

/** Mueve un lead a `statusId` con `price`, respetando las guardas de arriba. */
export async function moveLead(
  input: { leadId: number; statusId: number; price: number },
  deps: KommoDeps = {},
): Promise<KommoOutcome> {
  const token = deps.token ?? Deno.env.get("KOMMO_TOKEN") ?? "";
  if (!token) return "disabled";
  const base = (deps.baseUrl ?? Deno.env.get("KOMMO_BASE_URL") ?? KOMMO_DEFAULT_BASE_URL)
    .replace(/\/+$/, "");
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${base}/leads/${input.leadId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const res = await fetchWithRetry(doFetch, sleep, url, { headers });
  if (!res) return "failed";
  // Token inválido o sin permiso: es problema nuestro, no del lead → reintentable.
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    return "failed";
  }
  // Kommo responde 204 (sin cuerpo) o 4xx para un lead que no existe.
  if (res.status !== 200) {
    await res.body?.cancel();
    return "skipped";
  }
  let lead: { pipeline_id?: unknown; status_id?: unknown };
  try {
    lead = await res.json();
  } catch {
    return "failed";
  }
  if (lead.pipeline_id !== KOMMO_PIPELINE_ID) return "skipped";
  if (lead.status_id === KOMMO_STATUS_WON) return "skipped";
  if (lead.status_id === input.statusId) return "skipped";

  const patch = await fetchWithRetry(doFetch, sleep, url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status_id: input.statusId, price: input.price }),
  });
  if (!patch) return "failed";
  await patch.body?.cancel();
  return patch.ok ? "moved" : "failed";
}

const STAGES = {
  trial: { statusId: KOMMO_STATUS_TRIAL, column: "trial_synced_at" },
  purchase: { statusId: KOMMO_STATUS_WON, column: "purchase_synced_at" },
} as const;

export type KommoStage = keyof typeof STAGES;

/**
 * Sincroniza la etapa del lead enlazado al taller, UNA sola vez por etapa (ancla
 * `kommo_leads.<stage>_synced_at`). Sin fila en kommo_leads (el taller no llegó
 * con `lid`) no hace nada. No lanza nunca.
 */
export async function syncLeadStage(
  admin: SupabaseClient,
  shopId: string,
  stage: KommoStage,
  price: number,
  deps: KommoDeps = {},
): Promise<void> {
  const { statusId, column } = STAGES[stage];
  try {
    const { data, error } = await admin
      .from("kommo_leads")
      .select("lead_id, trial_synced_at, purchase_synced_at")
      .eq("shop_id", shopId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || data[column]) return;

    const leadId = data.lead_id as number;
    const outcome = await moveLead({ leadId, statusId, price }, deps);
    console.log(`kommo: shop=${shopId} lead=${leadId} etapa=${stage} → ${outcome}`);
    if (outcome !== "moved" && outcome !== "skipped") return;

    const { error: markErr } = await admin
      .from("kommo_leads")
      .update({ [column]: new Date().toISOString() })
      .eq("shop_id", shopId)
      .is(column, null);
    if (markErr) throw new Error(markErr.message);
  } catch (e) {
    console.error(`kommo: no se pudo sincronizar shop=${shopId} etapa=${stage}:`, e);
  }
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/** Deja corriendo `p` después de responder (el usuario no espera a Kommo). */
export function runInBackground(p: Promise<unknown>): void {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(p);
  }
  // Sin EdgeRuntime (tests / deno local) la promesa igual corre; syncLeadStage no lanza.
}
