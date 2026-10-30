// =============================================================================
// _shared/trialReminderEmail.ts
// Render del correo "tu prueba termina" que manda `trial-reminder` al DUEÑO del
// taller 7 días antes de que venza su prueba por código (0047/0048). PURO (sin
// I/O ni env), como emailTemplates.ts: lo único que importa de afuera es el
// `esc` de ese módulo, para que todo texto libre (el nombre del taller lo tipeó
// el prospecto en la landing) pase por el MISMO escape antes del HTML.
//
// A diferencia de emailTemplates.ts, este correo NO va a un cliente final en
// nombre del taller: es AntawaTec hablándole a SU cliente (el taller). Por eso el
// encabezado es la marca de AntawaTec y no el logo del taller.
//
// Fecha en hora de Ecuador con offset fijo -05:00 calculado a mano (sin Intl ni
// timeZone, misma decisión que ecTime.ts / orderPdf.ts): un vencimiento a las
// 02:00 UTC es "el día anterior" para el dueño, y eso es lo que tiene que leer.
// =============================================================================

import { esc } from "./emailTemplates.ts";
import { EC_OFFSET_MS, ecDayStartMs } from "./ecTime.ts";

const DAY_MS = 86_400_000;

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// Datos fijos de la campaña (acordados con Pablo y Javier, 2026-10-30). Si cambia
// el precio o el canal de soporte, se cambia acá y en la landing a la vez.
const PRICE_TEXT = "$25 al mes";
const APP_URL = "https://app.antwt.com";
const SUPPORT_EMAIL = "soporte@antwt.com";
const SUPPORT_PHONE = "0983924303";

const FONT = "font-family:Arial,Helvetica,sans-serif";

export interface TrialReminderInput {
  shopName: string;
  periodEnd: Date;
  /** Reloj inyectable para tests; default = ahora. */
  now?: Date;
}

export interface TrialReminderEmail {
  subject: string;
  html: string;
}

/** "29 de noviembre" en hora de Ecuador. */
export function ecDayMonth(d: Date): string {
  const ec = new Date(d.getTime() + EC_OFFSET_MS);
  return `${ec.getUTCDate()} de ${MONTHS[ec.getUTCMonth()]}`;
}

/** Días de calendario (Ecuador) entre `now` y `periodEnd`. Nunca negativo. */
export function ecDaysLeft(periodEnd: Date, now: Date): number {
  const diff = ecDayStartMs(periodEnd.getTime()) - ecDayStartMs(now.getTime());
  return Math.max(0, Math.round(diff / DAY_MS));
}

function whenText(daysLeft: number): string {
  if (daysLeft === 0) return "hoy";
  if (daysLeft === 1) return "mañana";
  return `en ${daysLeft} días`;
}

function paragraph(html: string): string {
  return `          <p style="${FONT};font-size:14px;color:#374151;line-height:1.6;margin:0 0 12px 0;">${html}</p>`;
}

export function renderTrialReminder(input: TrialReminderInput): TrialReminderEmail {
  const now = input.now ?? new Date();
  const shopName = (input.shopName ?? "").trim() || "tu taller";
  const date = ecDayMonth(input.periodEnd);
  const when = whenText(ecDaysLeft(input.periodEnd, now));

  const subject = `Tu prueba de AntawaTec termina el ${date}`;

  const body = [
    paragraph(`Hola ${esc(shopName)},`),
    paragraph(
      `tu período de prueba de AntawaTec termina el <strong>${esc(date)}</strong> (${esc(when)}).`,
    ),
    paragraph(
      `Para seguir usando la app, el plan cuesta <strong>${esc(PRICE_TEXT)}</strong>: entra a ` +
        `<a href="${esc(APP_URL)}" style="color:#2563eb;">${esc(APP_URL.replace("https://", ""))}</a> ` +
        `→ <strong>Configuración → Suscripción</strong>, transfiere y sube el comprobante.`,
    ),
    paragraph(`Si no renuevas, el acceso se suspende al vencer la prueba.`),
    paragraph(
      `¿Dudas? Escríbenos a <a href="mailto:${esc(SUPPORT_EMAIL)}" style="color:#2563eb;">` +
        `${esc(SUPPORT_EMAIL)}</a> o al ${esc(SUPPORT_PHONE)}.`,
    ),
  ].join("\n");

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
      <tr>
        <td style="padding:24px 24px 16px 24px;border-bottom:1px solid #e5e7eb;">
          <div style="${FONT};font-size:18px;font-weight:bold;color:#111827;">AntawaTec</div>
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
${body}
        </td>
      </tr>
      <tr>
        <td style="padding:16px 24px 24px 24px;border-top:1px solid #e5e7eb;">
          <div style="${FONT};font-size:11px;color:#9ca3af;line-height:1.5;">
            Recibes este correo porque activaste una prueba gratis de AntawaTec para «${esc(shopName)}».
          </div>
        </td>
      </tr>
      </table>
    </td>
  </tr>
</table>`;

  return { subject, html };
}
