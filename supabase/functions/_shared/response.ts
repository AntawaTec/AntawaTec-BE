// =============================================================================
// _shared/response.ts
// Respuestas HTTP JSON consistentes para las Edge Functions (códigos y forma de
// error uniformes, como pide CLAUDE.md). Incluye CORS para funciones invocadas
// desde el navegador (p. ej. bank-transfer-approval desde el admin dashboard);
// los headers CORS son inocuos para las server-to-server como hotmart-webhook.
// =============================================================================

// Allow-Origin "*" alcanza para V1: la auth va por bearer token (sin cookies),
// así que no hay credenciales que el navegador necesite restringir. Si más
// adelante se quiere fijar el origen del dashboard, se cambia aquí.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

/** Respuesta al preflight CORS (OPTIONS). No exige auth: es el preflight. */
export const preflight = (): Response =>
  new Response(null, { status: 204, headers: corsHeaders });

export const ok = (body: unknown = { ok: true }): Response => json(200, body);

export const badRequest = (message: string): Response =>
  json(400, { error: message });

export const unauthorized = (message: string): Response =>
  json(401, { error: message });

export const forbidden = (message: string): Response =>
  json(403, { error: message });

export const notFound = (message: string): Response =>
  json(404, { error: message });

export const methodNotAllowed = (message = "Método no permitido"): Response =>
  json(405, { error: message });

export const serverError = (message: string): Response =>
  json(500, { error: message });
