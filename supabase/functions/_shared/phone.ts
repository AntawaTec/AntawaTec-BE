// =============================================================================
// _shared/phone.ts
// Normalización de números a MSISDN para WhatsApp (Meta Cloud API / Twilio).
//
// El proveedor exige el número en formato internacional (código de país + número,
// sin '+' ni separadores). Los `customers.whatsapp_number` de prod vienen tipeados
// a mano y la auditoría del 2026-07-30 encontró 3 formas conviviendo sobre 18
// clientes: '+593 9XXXXXXXX' (9), local con 0 troncal '09XXXXXXXX' (4) y móvil
// pelado sin 0 '9XXXXXXXX' (3). Mandar cualquiera de las dos últimas tal cual
// hace que el proveedor rechace el envío, así que normalizamos acá — un solo
// punto, aguas arriba del fetch — en vez de confiar en lo que se tipeó en el front.
//
// Desde 2026-10-27 también se aceptan números FUERA de Ecuador (el tercer cliente
// con WhatsApp de EE.UU. que un taller no pudo guardar). La regla: un número es
// internacional SOLO si trae el código de país explícito ('+' o '00' adelante);
// sin él se asume Ecuador, como siempre. Así un '09…' o un '9…' local siguen
// resolviendo igual, y nunca adivinamos país a partir de un número pelado.
//
// PURO (sin I/O). Espejado en `src/lib/format.ts` del front (normalizeWhatsAppNumber),
// que guarda el E.164 con '+' para que lo que llega acá ya esté limpio.
// =============================================================================

const EC_COUNTRY_CODE = "593";
// Ecuador: móvil = 9 + 8 dígitos; con país = 593 + esos 9.
const EC_MOBILE = /^9\d{8}$/;
// NANP (+1: EE.UU., Canadá, Caribe): 1 + área [2-9]XX + central [2-9]XX + 4 dígitos.
// Es el caso real que motivó el cambio, así que lo validamos de verdad y no solo
// por largo: un +1 con 9 dígitos es un typo, no un número.
const NANP = /^1[2-9]\d{2}[2-9]\d{6}$/;
// Resto del mundo: E.164 (máx. 15 dígitos, sin 0 adelante). Pedimos mínimo 10 con
// país incluido — ningún móvil real con WhatsApp queda por debajo y así un
// '00' + número local ecuatoriano mal tipeado no se vuelve un país inventado.
const E164_OTHER = /^[2-9]\d{9,14}$/;

/**
 * Devuelve el MSISDN listo para el proveedor ('593XXXXXXXXX', '19547276658', …)
 * o `null` si el número no es reconocible. Devolver null (en vez de adivinar) es
 * deliberado: es preferible que la notificación quede 'failed' con un error
 * legible a mandarle un WhatsApp a un número equivocado.
 */
export function toWhatsAppMsisdn(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let d = raw.replace(/\D/g, "");
  if (!d) return null;

  const hasPlus = /^\s*\+/.test(raw);
  const hasExitPrefix = d.startsWith("00");
  if (hasExitPrefix) d = d.slice(2); // prefijo de salida internacional

  // Código de país explícito = '+' o '00' adelante y NO seguido de 0 (un '+09…'
  // es un '+' de más sobre un número local, no un país).
  const explicitCountry = (hasPlus || hasExitPrefix) && !d.startsWith("0");

  if (!explicitCountry || d.startsWith(EC_COUNTRY_CODE)) {
    // Ecuador: con o sin 593, con o sin 0 troncal (local, o pegado tras el 593).
    if (d.startsWith(EC_COUNTRY_CODE)) d = d.slice(EC_COUNTRY_CODE.length);
    if (d.startsWith("0")) d = d.slice(1);
    return EC_MOBILE.test(d) ? `${EC_COUNTRY_CODE}${d}` : null;
  }

  // Fuera de Ecuador: el código de país vino explícito, va tal cual (sin '+').
  if (d.startsWith("1")) return NANP.test(d) ? d : null;
  return E164_OTHER.test(d) ? d : null;
}
