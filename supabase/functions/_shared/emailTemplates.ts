// =============================================================================
// _shared/emailTemplates.ts
// Render de los correos al cliente final. PURO (sin I/O) — gemelo de
// notificationTemplates.ts, misma disciplina: el snapshot viaja en el payload y
// renderizar es reproducible (editar la cotización después NO cambia lo enviado).
//
// Alcance v1 a propósito: SOLO quote_ready y vehicle_received. Son los dos eventos
// donde el correo aporta algo que el WhatsApp no puede — el desglose con precios.
// Los otros 4 (citas, listo para retirar, entrega) son avisos cortos y siguen
// siendo whatsapp-only; renderEmail devuelve null para ellos y el drenado degrada
// igual que con una plantilla desconocida.
//
// El HTML está escrito para CLIENTES DE CORREO, no para navegadores: tablas en vez
// de flex/grid, estilos INLINE (Gmail descarta <style> en la vista de conversación),
// ancho fijo 600px, sin CSS externo, sin JS, sin webfonts. Feo de leer, robusto de
// ver. Sin PDF adjunto en v1 (mejora futura).
// =============================================================================

import type { NotificationPayload } from "./notificationTemplates.ts";

// Espejo de quote_section_type (0001) + los labels del FE (SECTION_LABELS en
// src/lib/data/quotes.ts). Si el FE los renombra, este mapa lo sigue: el cliente
// tiene que leer lo mismo en el correo que en la cotización impresa.
const SECTION_LABELS: Record<string, string> = {
  maintenance: "Mantenimiento y Reparación",
  bodywork: "Enderezada y Pintura",
};

export interface QuoteSnapshotItem {
  description?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  line_total?: number | null;
}

export interface QuoteSnapshotSection {
  section_type?: string | null;
  subtotal?: number | null;
  items: QuoteSnapshotItem[];
}

/** Foto de la cotización al momento de enviarla. Congela lo que el cliente recibió. */
export interface QuoteSnapshot {
  quote_number?: number | null;
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
  sections: QuoteSnapshotSection[];
}

export interface EmailPayload extends NotificationPayload {
  email?: string | null; // destinatario (snapshot al encolar)
  contact_email?: string | null; // shops.contact_email → reply-to
  logo_url?: string | null;
  address?: string | null;
  quote?: QuoteSnapshot | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

// ---------- helpers puros ----------------------------------------------------

// TODO dato dinámico pasa por acá antes de entrar al HTML. No es paranoia: las
// descripciones de ítems y el nombre del taller son texto libre tipeado en la PWA,
// y un "<" suelto rompe el correo (o peor) en el cliente del destinatario.
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(n?: number | null): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  try {
    return `$ ${v.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } catch {
    // Runtime sin ICU completo: el correo sale igual, con formato simple.
    return `$ ${v.toFixed(2)}`;
  }
}

function qty(n?: number | null): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 1;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// Espeja formatQuoteNumber() del FE (src/lib/data/quotes.ts): "N° 0042".
function quoteNumber(n?: number | null): string {
  return `N° ${String(typeof n === "number" ? n : 0).padStart(4, "0")}`;
}

function shopName(p: EmailPayload): string {
  return (p.shop_name ?? "").trim() || "Tu taller de confianza";
}

function customerName(p: EmailPayload): string {
  return (p.customer_name ?? "").trim() || "cliente";
}

function vehicleLabel(p: EmailPayload): string {
  const mm = [p.make, p.model].filter(Boolean).join(" ");
  return [mm, p.plate].filter(Boolean).join(" ").trim() || "tu vehículo";
}

const FONT = "font-family:Arial,Helvetica,sans-serif";

function header(p: EmailPayload): string {
  const logo = p.logo_url
    ? `<img src="${esc(p.logo_url)}" alt="${esc(shopName(p))}" width="120" style="max-width:120px;height:auto;display:block;margin:0 0 12px 0;border:0;">`
    : "";
  const meta = [p.address, p.contact_phone ? `Tel. ${p.contact_phone}` : null]
    .filter(Boolean)
    .map((l) => esc(l))
    .join(" · ");
  return `
      <tr>
        <td style="padding:24px 24px 16px 24px;border-bottom:1px solid #e5e7eb;">
          ${logo}
          <div style="${FONT};font-size:18px;font-weight:bold;color:#111827;">${esc(shopName(p))}</div>
          ${meta ? `<div style="${FONT};font-size:12px;color:#6b7280;margin-top:4px;">${meta}</div>` : ""}
        </td>
      </tr>`;
}

function footer(p: EmailPayload): string {
  return `
      <tr>
        <td style="padding:16px 24px 24px 24px;border-top:1px solid #e5e7eb;">
          <div style="${FONT};font-size:11px;color:#9ca3af;line-height:1.5;">
            Este correo fue enviado por «${esc(shopName(p))}» a través de AntawaTec.
          </div>
        </td>
      </tr>`;
}

// Envoltorio común: fondo gris, tarjeta blanca de 600px centrada.
function layout(p: EmailPayload, body: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
${header(p)}
      <tr>
        <td style="padding:24px;">
${body}
        </td>
      </tr>
${footer(p)}
      </table>
    </td>
  </tr>
</table>`;
}

function paragraph(html: string): string {
  return `          <p style="${FONT};font-size:14px;color:#374151;line-height:1.6;margin:0 0 12px 0;">${html}</p>`;
}

function vehicleBox(p: EmailPayload): string {
  return `          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9fafb;border-radius:6px;margin:0 0 20px 0;">
            <tr><td style="padding:12px 16px;${FONT};font-size:13px;color:#374151;">
              <strong>Vehículo:</strong> ${esc(vehicleLabel(p))}
            </td></tr>
          </table>`;
}

// Una tabla por sección + bloque de totales. Es el desglose que el WhatsApp no
// puede llevar (allá va solo la línea corta de quoteSummaryLine).
function quoteTables(q: QuoteSnapshot): string {
  const sections = (q.sections ?? [])
    .map((s) => {
      const label = SECTION_LABELS[s.section_type ?? ""] ?? "Trabajos";
      const rows = (s.items ?? [])
        .map(
          (it) => `
              <tr>
                <td style="padding:8px 4px;border-bottom:1px solid #f3f4f6;${FONT};font-size:13px;color:#374151;">${esc(it.description ?? "Ítem")}</td>
                <td align="center" style="padding:8px 4px;border-bottom:1px solid #f3f4f6;${FONT};font-size:13px;color:#6b7280;white-space:nowrap;">${esc(qty(it.quantity))}</td>
                <td align="right" style="padding:8px 4px;border-bottom:1px solid #f3f4f6;${FONT};font-size:13px;color:#6b7280;white-space:nowrap;">${esc(money(it.unit_price))}</td>
                <td align="right" style="padding:8px 4px;border-bottom:1px solid #f3f4f6;${FONT};font-size:13px;color:#111827;white-space:nowrap;">${esc(money(it.line_total))}</td>
              </tr>`,
        )
        .join("");
      return `          <div style="${FONT};font-size:13px;font-weight:bold;color:#111827;margin:0 0 8px 0;">${esc(label)}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
            <tr>
              <th align="left"   style="padding:6px 4px;border-bottom:2px solid #e5e7eb;${FONT};font-size:11px;color:#6b7280;text-transform:uppercase;">Descripción</th>
              <th align="center" style="padding:6px 4px;border-bottom:2px solid #e5e7eb;${FONT};font-size:11px;color:#6b7280;text-transform:uppercase;">Cant.</th>
              <th align="right"  style="padding:6px 4px;border-bottom:2px solid #e5e7eb;${FONT};font-size:11px;color:#6b7280;text-transform:uppercase;">P. unit.</th>
              <th align="right"  style="padding:6px 4px;border-bottom:2px solid #e5e7eb;${FONT};font-size:11px;color:#6b7280;text-transform:uppercase;">Total</th>
            </tr>${rows}
          </table>`;
    })
    .join("\n");

  const totals = `          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
            <tr>
              <td align="right" style="padding:4px 4px;${FONT};font-size:13px;color:#6b7280;">Subtotal</td>
              <td align="right" width="120" style="padding:4px 4px;${FONT};font-size:13px;color:#374151;white-space:nowrap;">${esc(money(q.subtotal))}</td>
            </tr>
            <tr>
              <td align="right" style="padding:4px 4px;${FONT};font-size:13px;color:#6b7280;">IVA</td>
              <td align="right" style="padding:4px 4px;${FONT};font-size:13px;color:#374151;white-space:nowrap;">${esc(money(q.tax))}</td>
            </tr>
            <tr>
              <td align="right" style="padding:8px 4px;border-top:2px solid #e5e7eb;${FONT};font-size:15px;font-weight:bold;color:#111827;">Total</td>
              <td align="right" style="padding:8px 4px;border-top:2px solid #e5e7eb;${FONT};font-size:15px;font-weight:bold;color:#111827;white-space:nowrap;">${esc(money(q.total))}</td>
            </tr>
          </table>`;

  return `${sections}\n${totals}`;
}

// ---------- renderers --------------------------------------------------------

function quoteReady(p: EmailPayload): RenderedEmail {
  const q = p.quote ?? null;
  const num = quoteNumber(q?.quote_number);
  const detalle = q
    ? quoteTables(q)
    : paragraph("El detalle de la cotización está disponible en el taller.");
  return {
    subject: `Cotización ${num} — ${shopName(p)}`,
    html: layout(
      p,
      [
        paragraph(`Hola ${esc(customerName(p))},`),
        paragraph(
          `La cotización <strong>${esc(num)}</strong> para tu vehículo está lista para tu revisión. Te dejamos el detalle a continuación.`,
        ),
        vehicleBox(p),
        detalle,
        paragraph(
          "Cualquier inquietud, comunícate con el administrador del taller a los datos de contacto que aparecen arriba.",
        ),
      ].join("\n"),
    ),
  };
}

function vehicleReceived(p: EmailPayload): RenderedEmail {
  const q = p.quote ?? null;
  // Con cotización enlazada (work_orders.quote_id) el correo confirma QUÉ se acordó
  // hacer; sin ella es solo el acuse de recibo del vehículo.
  const cuerpo = q
    ? [
        paragraph(
          `Estos son los trabajos acordados según la cotización <strong>${esc(quoteNumber(q.quote_number))}</strong>:`,
        ),
        quoteTables(q),
      ].join("\n")
    : paragraph("Te avisaremos apenas tengamos novedades sobre el estado de tu vehículo.");
  return {
    subject: `Recibimos tu vehículo — ${shopName(p)}`,
    html: layout(
      p,
      [
        paragraph(`Hola ${esc(customerName(p))},`),
        paragraph(
          "Hemos recibido tu vehículo en el taller. Te avisamos cuando esté listo para retirar.",
        ),
        vehicleBox(p),
        cuerpo,
        paragraph(
          "Cualquier inquietud, comunícate con el administrador del taller a los datos de contacto que aparecen arriba.",
        ),
      ].join("\n"),
    ),
  };
}

const EMAIL_RENDERERS: Record<string, (p: EmailPayload) => RenderedEmail> = {
  quote_ready: quoteReady,
  vehicle_received: vehicleReceived,
};

/** null = esa plantilla no tiene correo (alcance v1) → el drenado degrada. */
export function renderEmail(template: string, payload: EmailPayload): RenderedEmail | null {
  const fn = EMAIL_RENDERERS[template];
  if (!fn) return null;
  return fn(payload);
}
