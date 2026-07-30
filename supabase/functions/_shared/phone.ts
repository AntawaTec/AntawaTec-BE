// =============================================================================
// _shared/phone.ts
// Normalización de números a MSISDN para la WhatsApp Cloud API.
//
// Meta exige el número en formato internacional (código de país + número, sin
// '+' ni separadores). Los `customers.whatsapp_number` de prod vienen tipeados a
// mano y la auditoría del 2026-07-30 encontró 3 formas conviviendo sobre 18
// clientes: '+593 9XXXXXXXX' (9), local con 0 troncal '09XXXXXXXX' (4) y móvil
// pelado sin 0 '9XXXXXXXX' (3). Mandar cualquiera de las dos últimas tal cual
// hace que Meta rechace el envío, así que normalizamos acá — un solo punto,
// aguas arriba del fetch — en vez de confiar en lo que se tipeó en el front.
//
// PURO (sin I/O). Ecuador: móvil = 9 + 8 dígitos; con país = 593 + esos 9.
// =============================================================================

const EC_COUNTRY_CODE = "593";
const EC_MOBILE = /^9\d{8}$/;

/**
 * Devuelve el MSISDN listo para Meta ('593XXXXXXXXX') o `null` si el número no
 * es un móvil ecuatoriano reconocible. Devolver null (en vez de adivinar) es
 * deliberado: es preferible que la notificación quede 'failed' con un error
 * legible a mandarle un WhatsApp a un número equivocado.
 */
export function toWhatsAppMsisdn(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let d = raw.replace(/\D/g, "");
  if (!d) return null;

  if (d.startsWith("00")) d = d.slice(2); // prefijo de salida internacional
  if (d.startsWith(EC_COUNTRY_CODE)) d = d.slice(EC_COUNTRY_CODE.length);
  if (d.startsWith("0")) d = d.slice(1); // 0 troncal (local, o pegado tras el 593)

  if (!EC_MOBILE.test(d)) return null;
  return `${EC_COUNTRY_CODE}${d}`;
}
