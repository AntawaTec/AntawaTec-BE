// =============================================================================
// _shared/supabaseAdmin.ts
// Cliente de Supabase con service_role para Edge Functions del lado servidor.
// Convención ÚNICA del repo: toda función que necesite el cliente admin lo crea
// con `createAdminClient()` y se lo pasa a las utilidades de `_shared/` (p. ej.
// `provisionTenant(admin, ...)`). No hay otros nombres/instancias de cliente admin.
//
// service_role salta RLS: úsalo SOLO en el servidor, nunca expuesto al cliente
// (CLAUDE.md). SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las inyecta el runtime de
// Supabase automáticamente; no hace falta setearlas como secret.
// =============================================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export type { SupabaseClient };

export function createAdminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno de la función.",
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
