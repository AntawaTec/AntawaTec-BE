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
export interface NotificationPayload {
  customer_name?: string | null;
  whatsapp_number?: string | null; // destinatario (snapshot al encolar)
  plate?: string | null;
  make?: string | null;
  model?: string | null;
  scheduled_at?: string | null; // ISO
  services_summary?: string | null;
  shop_name?: string | null;
}

export interface RenderedNotification {
  text: string; // preview sandbox
  components: string[]; // variables posicionales del body (para Meta)
}

function vehicleLabel(p: NotificationPayload): string {
  const mm = [p.make, p.model].filter(Boolean).join(" ");
  return [mm, p.plate].filter(Boolean).join(" ") || "tu vehículo";
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "la fecha agendada";
  // Formato simple y estable (sin locale del runtime): "2026-06-25 09:00".
  return iso.replace("T", " ").slice(0, 16);
}

// Una función de render por plantilla. Cada una arma text + components (mismas vars).
const RENDERERS: Record<NotificationTemplate, (p: NotificationPayload) => RenderedNotification> = {
  appointment_confirmed: (p) => {
    const name = p.customer_name ?? "Hola";
    const veh = vehicleLabel(p);
    const date = fmtDate(p.scheduled_at);
    return {
      text: `${name}, tu cita para ${veh} quedó confirmada para el ${date}.`,
      components: [name, veh, date],
    };
  },
  appointment_reminder_24h: (p) => {
    const name = p.customer_name ?? "Hola";
    const veh = vehicleLabel(p);
    const date = fmtDate(p.scheduled_at);
    return {
      text: `${name}, te recordamos tu cita para ${veh} mañana, ${date}.`,
      components: [name, veh, date],
    };
  },
  vehicle_received: (p) => {
    const name = p.customer_name ?? "Hola";
    const veh = vehicleLabel(p);
    return {
      text: `${name}, recibimos ${veh} en el taller. Te avisamos cuando esté listo.`,
      components: [name, veh],
    };
  },
  quote_ready: (p) => {
    const name = p.customer_name ?? "Hola";
    const veh = vehicleLabel(p);
    return {
      text: `${name}, la cotización para ${veh} está lista para tu revisión.`,
      components: [name, veh],
    };
  },
  vehicle_ready: (p) => {
    const name = p.customer_name ?? "Hola";
    const veh = vehicleLabel(p);
    return {
      text: `${name}, ${veh} ya está listo para retirar.`,
      components: [name, veh],
    };
  },
  delivery_completed: (p) => {
    const name = p.customer_name ?? "Hola";
    const veh = vehicleLabel(p);
    const summary = p.services_summary ?? "el servicio realizado";
    return {
      text: `${name}, gracias por confiar en nosotros. Entregamos ${veh}. Resumen: ${summary}.`,
      components: [name, veh, summary],
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
