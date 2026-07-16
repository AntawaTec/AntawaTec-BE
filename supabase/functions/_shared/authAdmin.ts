// =============================================================================
// _shared/authAdmin.ts
// Utilidades de GoTrue admin compartidas entre módulos que gestionan usuarios
// (provisionTenant para dueños, technician-access para técnicos). Extraídas de
// provisionTenant.ts sin cambio de lógica.
// =============================================================================

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/**
 * Busca un usuario de auth por email. GoTrue no expone un getUserByEmail, así
 * que paginamos listUsers y filtramos. A volumen de provisioning (altas puntuales,
 * 18 talleres en V1) es despreciable; si algún día el padrón crece, se reemplaza
 * por una RPC SECURITY DEFINER sobre auth.users o el filtro nativo de GoTrue.
 *
 * Importante: cortamos SOLO con una página vacía, nunca por `length < perPage`,
 * porque el servidor puede topar perPage y daría un falso "última página".
 *
 * El email debe venir ya normalizado (trim + lowercase).
 */
export async function findAuthUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<
  { id: string; email?: string; user_metadata?: Record<string, unknown> } | null
> {
  const perPage = 200;
  for (let page = 1; page <= 10_000; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers falló: ${error.message}`);
    const users = data?.users ?? [];
    if (users.length === 0) break;
    const found = users.find((u) => u.email?.toLowerCase() === email);
    if (found) return found;
  }
  return null;
}

/** ¿El error de GoTrue significa "este email ya tiene cuenta"? */
export function isAlreadyRegistered(
  error: { code?: string; message?: string },
): boolean {
  const code = error?.code ?? "";
  const msg = (error?.message ?? "").toLowerCase();
  return (
    code === "email_exists" ||
    msg.includes("already been registered") ||
    msg.includes("already registered")
  );
}
