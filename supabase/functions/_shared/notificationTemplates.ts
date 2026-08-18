// =============================================================================
// _shared/notificationTemplates.ts
// Render de las 6 plantillas de notificación. PURO (sin I/O) → fácil de testear.
//
// renderTemplate devuelve DOS formas a propósito:
//   - text:       string renderizado para el modo SANDBOX / dry-run / preview.
//   - components: las variables POSICIONALES del body, que es lo que la WhatsApp
//                 Cloud API exige (plantillas registradas + components, NO texto
//                 libre). Producir ambas desde ya mantiene el swap-a-Meta dentro
//                 del transport (no hay que re-extraer variables del texto plano).
// Decidido vía debate dual-Opus (insight de Orion: el swap NO es "una función"
// si solo guardás texto).
// =============================================================================

export type NotificationTemplate =
  | "appointment_confirmed"
  | "appointment_reminder_24h"
  | "vehicle_received"
  | "quote_ready"
  | "vehicle_ready"
  | "delivery_completed";

// Snapshot de datos que el barrido guarda en notification_log.payload al encolar.
// Todo lo que el render necesita viaja acá: renderizar es puro y reproducible aun
// si el taller se renombra o la cotización se edita después del encolado.
export interface NotificationPayload {
  customer_name?: string | null;
  whatsapp_number?: string | null; // destinatario (snapshot al encolar)
  plate?: string | null;
  make?: string | null;
  model?: string | null;
  scheduled_at?: string | null; // ISO
  services_summary?: string | null; // CRUDO (multilínea) — se aplana en el render
  shop_name?: string | null;
  contact_phone?: string | null; // shops.contact_phone — entra en la firma
  // quote_ready: insumos del resumen corto que va en el WhatsApp. El desglose con
  // precios por ítem viaja por email (ver emailTemplates.ts).
  quote_item_descriptions?: string[] | null;
  quote_total?: number | null;
}

export interface RenderedNotification {
  text: string; // preview sandbox
  components: string[]; // variables posicionales del body (para Meta)
}

// Tope de largo para los parámetros "gordos" (resúmenes). Meta acepta bodies de
// hasta 1024 chars y los nuestros dejan holgura; el cap protege del caso patológico
// (un resumen de 3 párrafos) sin recortar nada real.
const PARAM_MAX = 240;

// Meta rechaza parámetros con saltos de línea, tabs o 4+ espacios seguidos. TODOS
// los parámetros salen de texto tipeado a mano (nombre del taller, del cliente,
// placa, resumen de entrega), así que el colapso se aplica en el único choke point
// que hay antes del transporte, en vez de confiar en la validación del front.
// (El cuerpo FIJO de la plantilla sí lleva saltos: la restricción es sobre las
// variables, no sobre el texto de la plantilla.)
function collapseParam(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max = PARAM_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function vehicleLabel(p: NotificationPayload): string {
  const mm = [p.make, p.model].filter(Boolean).join(" ");
  const label = [mm, p.plate].filter(Boolean).join(" ");
  return collapseParam(label) || "tu vehículo";
}

// Los textos arrancan con "Hola {{1}}", así que el fallback no puede ser "Hola"
// (quedaría "Hola Hola,"). Ver la nota sobre las reglas de Meta más abajo.
function customerName(p: NotificationPayload): string {
  return collapseParam(p.customer_name ?? "") || "cliente";
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "la fecha agendada";
  // Formato simple y estable (sin locale del runtime): "2026-06-25 09:00".
  return iso.replace("T", " ").slice(0, 16);
}

function fmtMoney(n: number): string {
  try {
    return `$${n.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

/**
 * Firma del taller: UNA variable compuesta en código en vez de dos variables en la
 * plantilla. Con teléfono → "Taller Pablo · Tel. 0998765432"; sin → "Taller Pablo".
 * Resuelve que contact_phone sea opcional sin bifurcar la plantilla registrada en
 * Meta (que es rígida) y hace que el aviso de "comunicarse con el administrador"
 * diga CÓMO. Fallback obligatorio: cubre las filas ya encoladas con payload viejo,
 * de antes de que el barrido supiera de qué taller venía cada notificación.
 */
export function signatureLine(p: NotificationPayload): string {
  const name = collapseParam(p.shop_name ?? "") || "Tu taller de confianza";
  const phone = collapseParam(p.contact_phone ?? "");
  return phone ? `${name} · Tel. ${phone}` : name;
}

/**
 * Aplana el resumen de servicios que el taller escribe al entregar
 * (work_order_deliveries.services_summary): típicamente multilínea y con viñetas.
 * Devuelve null si no hay nada útil (el render aplica su propio fallback).
 * Se aplica EN EL RENDER, no al encolar: el payload guarda el snapshot fiel.
 */
export function flattenSummary(raw?: string | null): string | null {
  if (!raw) return null;
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-–—•*]\s*/, "").trim())
    .filter((l) => l.length > 0);
  const joined = collapseParam(lines.join("; "));
  return joined ? truncate(joined) : null;
}

/**
 * Resumen corto de la cotización para el WhatsApp de quote_ready:
 * "Cambio de aceite, Filtro de aire — Total: $54.05". El desglose completo con
 * precios por ítem va por email; acá alcanza con que el cliente reconozca de qué
 * trabajo le están hablando antes de abrir el correo.
 */
export function quoteSummaryLine(p: NotificationPayload): string {
  const descs = (p.quote_item_descriptions ?? [])
    .map((d) => collapseParam(d ?? ""))
    .filter((d) => d.length > 0);
  const total = typeof p.quote_total === "number" ? ` — Total: ${fmtMoney(p.quote_total)}` : "";
  if (descs.length === 0) return "Detalle disponible en el taller";
  return truncate(`${descs.join(", ")}${total}`);
}

// Aviso de canal de UNA VÍA, fijo al cierre de las 6 plantillas. No hay chatbot ni
// bandeja de entrada (CLAUDE.md: "solo salida"), así que si el cliente responde no
// lo lee nadie. Redacción de Pablo (el piloto). Va en el CUERPO y no en el footer
// de Meta porque mide ~101 chars y el footer topea en 60.
//
// Efecto lateral buscado: como es texto fijo DESPUÉS de la firma, ninguna plantilla
// termina en variable (regla 2 de Meta) y mejora el ratio variables/texto.
const AVISO =
  "Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.";

// Una función de render por plantilla. Cada una arma text + components (mismas vars).
//
// ⚠️ Los textos NO son libres: espejan carácter por carácter las plantillas
// registradas en Meta (WABA 1644478160040571, categoría Servicio/Utility, idioma
// Spanish `es`), saltos de línea incluidos. Si cambia uno, hay que cambiar el otro
// o el envío falla. La tabla del contrato vive en docs/whatsapp-meta-setup.md.
//
// Tres reglas de Meta condicionan la redacción (las dos primeras descubiertas al
// registrar las plantillas el 2026-07-30, el contrato viejo las violaba y era
// irregistrable):
//   1. una plantilla NO puede EMPEZAR con variable → de ahí el prefijo "Hola ".
//   2. tampoco puede TERMINAR con variable, y un punto final no alcanza: hace
//      falta texto real después → de ahí el AVISO fijo al cierre de las 6.
//   3. los PARÁMETROS no pueden llevar saltos de línea, tabs ni 4+ espacios (el
//      cuerpo fijo sí puede ser multilínea) → de ahí collapseParam() en todos.
const RENDERERS: Record<NotificationTemplate, (p: NotificationPayload) => RenderedNotification> = {
  appointment_confirmed: (p) => {
    const name = customerName(p);
    const veh = vehicleLabel(p);
    const date = fmtDate(p.scheduled_at);
    const sign = signatureLine(p);
    return {
      text:
        `Hola ${name}, tu cita de servicio para tu vehículo ${veh} quedó confirmada para el ${date}.\n\n` +
        `Te esperamos,\n\n${sign}\n\n${AVISO}`,
      components: [name, veh, date, sign],
    };
  },
  appointment_reminder_24h: (p) => {
    const name = customerName(p);
    const veh = vehicleLabel(p);
    const date = fmtDate(p.scheduled_at);
    const sign = signatureLine(p);
    return {
      text:
        `Hola ${name}, te recordamos tu cita para tu vehículo ${veh} mañana ${date}.\n\n` +
        `Te esperamos,\n\n${sign}\n\n${AVISO}`,
      components: [name, veh, date, sign],
    };
  },
  vehicle_received: (p) => {
    const name = customerName(p);
    const veh = vehicleLabel(p);
    const sign = signatureLine(p);
    return {
      text:
        `Hola ${name}, hemos recibido tu vehículo ${veh} en el taller. Te avisamos cuando esté listo.\n\n` +
        `Atentamente,\n\n${sign}\n\n${AVISO}`,
      components: [name, veh, sign],
    };
  },
  quote_ready: (p) => {
    const name = customerName(p);
    const veh = vehicleLabel(p);
    const summary = quoteSummaryLine(p);
    const sign = signatureLine(p);
    return {
      text:
        `Hola ${name}, la cotización para tu vehículo ${veh} está lista para tu revisión.\n\n` +
        `${summary}\n\nAtentamente,\n\n${sign}\n\n${AVISO}`,
      components: [name, veh, summary, sign],
    };
  },
  vehicle_ready: (p) => {
    const name = customerName(p);
    const veh = vehicleLabel(p);
    const sign = signatureLine(p);
    return {
      text:
        `Hola ${name}, tu vehículo ${veh} ya está listo para retirar.\n\n` +
        `Atentamente,\n\n${sign}\n\n${AVISO}`,
      components: [name, veh, sign],
    };
  },
  delivery_completed: (p) => {
    const name = customerName(p);
    const veh = vehicleLabel(p);
    // El cierre rápido de una orden deja services_summary en NULL → fallback.
    const summary = flattenSummary(p.services_summary) ?? "los trabajos acordados";
    const sign = signatureLine(p);
    return {
      text:
        `Hola ${name}, entregamos tu vehículo ${veh}. Resumen del servicio: ${summary}.\n\n` +
        `¡Gracias por confiar en nosotros!\n\n${sign}\n\n${AVISO}`,
      components: [name, veh, summary, sign],
    };
  },
};

// Tolerante a plantillas desconocidas (degrada en vez de romper el drenado).
export function renderTemplate(
  template: string,
  payload: NotificationPayload,
): RenderedNotification | null {
  const fn = RENDERERS[template as NotificationTemplate];
  if (!fn) return null;
  return fn(payload);
}
