// =============================================================================
// _shared/ecTime.ts — reloj del taller.
//
// Todo lo que el cliente lee ("tu cita es a las 08:30") y todo lo que el barrido
// decide por hora del día ("ya son las 7 de la mañana") va en hora de Ecuador.
// Ecuador no tiene horario de verano: el offset es fijo -05:00 y se computa a
// mano, sin Intl ni timeZone, para que el resultado sea idéntico corra donde
// corra (misma decisión que orderPdf.ts).
// =============================================================================

export const EC_OFFSET_MS = -5 * 3600_000;
const DAY_MS = 86_400_000;

const p = (n: number) => String(n).padStart(2, "0");

/** Instante (ms UTC) de la medianoche de Ecuador del día que contiene `nowMs`. */
export function ecDayStartMs(nowMs: number): number {
  return Math.floor((nowMs + EC_OFFSET_MS) / DAY_MS) * DAY_MS - EC_OFFSET_MS;
}

/** Minutos transcurridos desde la medianoche de Ecuador. */
export function ecMinutesOfDay(nowMs: number): number {
  return Math.floor((nowMs - ecDayStartMs(nowMs)) / 60_000);
}

/** "25/06/2026 a las 09:00" (hora de Ecuador), o null si el ISO no parsea. */
export function fmtEcDateTime(iso?: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const d = new Date(t + EC_OFFSET_MS);
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} a las ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "09:00" (hora de Ecuador), o null si el ISO no parsea. */
export function fmtEcTime(iso?: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const d = new Date(t + EC_OFFSET_MS);
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
