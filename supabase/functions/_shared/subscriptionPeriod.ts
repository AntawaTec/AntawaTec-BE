// =============================================================================
// _shared/subscriptionPeriod.ts
// Aritmética del período de suscripción. TODO acá es PURO (sin red, sin base,
// sin Deno.env, sin Date.now() implícito: el `now` se inyecta) para que se pueda
// testear sin stack y para que la decisión "hasta cuándo pagó este taller" no
// quede escondida dentro de una Edge Function.
//
// Regla del negocio: la suscripción es MENSUAL y se cobra por transferencia, un
// mes por vez. Renovar = correr el vencimiento un MES CALENDARIO, no 30 días.
// La diferencia importa: con 30 días el vencimiento se va corriendo hacia atrás
// (dos renovaciones seguidas en meses de 31 se comen un día cada una) y el
// taller termina pagando el día 26 algo que empezó el día 1.
//
// Clamp de fin de mes: 31-ene + 1 mes = 28-feb (29 en bisiesto), no el 3-mar que
// daría un `setMonth` ingenuo por overflow. Mismo criterio que usa cualquier
// facturadora: el día del mes se recorta al último día del mes destino.
//
// Todo en UTC a propósito: los timestamps van a `timestamptz` y las funciones
// corren en UTC, pero los tests no deben depender del TZ de la máquina.
// =============================================================================

/** Último día (1–31) del mes `monthIndex` (0-based; admite 12 = enero siguiente). */
function daysInMonthUTC(year: number, monthIndex: number): number {
  // Día 0 del mes siguiente = último día del mes pedido.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Suma UN mes calendario, recortando el día al último del mes destino.
 * Conserva la hora exacta (el vencimiento no se "normaliza" a medianoche: se
 * compara contra now() y mover la hora regalaría o robaría horas de servicio).
 *
 *   2026-01-31T10:00Z → 2026-02-28T10:00Z   (clamp, año no bisiesto)
 *   2028-01-31T10:00Z → 2028-02-29T10:00Z   (clamp, bisiesto)
 *   2026-03-15T10:00Z → 2026-04-15T10:00Z   (día normal)
 *   2026-12-31T10:00Z → 2027-01-31T10:00Z   (cambio de año)
 */
export function addCalendarMonth(base: Date): Date {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();

  const targetDay = Math.min(day, daysInMonthUTC(year, month + 1));

  return new Date(Date.UTC(
    year,
    month + 1, // Date.UTC normaliza el 12 → enero del año siguiente.
    targetDay,
    base.getUTCHours(),
    base.getUTCMinutes(),
    base.getUTCSeconds(),
    base.getUTCMilliseconds(),
  ));
}

/** El período que un comprobante de renovación paga. */
export interface RenewalPeriod {
  /** Desde cuándo corre el mes pagado. */
  start: Date;
  /** Nuevo `subscriptions.current_period_end`. */
  end: Date;
}

/**
 * Calcula el período de una renovación.
 *
 * `base = max(current_period_end ?? now, now)`, y el resultado es base + 1 mes:
 *   - Suscripción VIGENTE (vence en el futuro): el mes nuevo se APILA sobre el
 *     vencimiento actual — pagar antes de tiempo no regala ni quema días.
 *   - Suscripción VENCIDA o inexistente: el mes corre desde AHORA. No se
 *     retro-cubre el tiempo que el taller estuvo sin pagar (si no, pagar tarde
 *     compraría días ya consumidos y el taller quedaría vencido al instante).
 */
export function computeRenewalPeriod(
  currentPeriodEnd: Date | null,
  now: Date,
): RenewalPeriod {
  const start = currentPeriodEnd !== null && currentPeriodEnd.getTime() > now.getTime()
    ? currentPeriodEnd
    : now;
  return { start, end: addCalendarMonth(start) };
}

/** Parsea un timestamptz de PostgREST. Devuelve null si falta o es inválido. */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * El mayor de dos vencimientos (cualquiera puede faltar). Se usa al escribir
 * `subscriptions.current_period_end`: el valor se calcula en JS y se escribe
 * ABSOLUTO, nunca con un `+ interval` en SQL — así un reintento converge al
 * mismo instante en vez de sumar otro mes.
 */
export function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
