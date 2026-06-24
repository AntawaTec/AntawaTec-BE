#!/usr/bin/env bash
# =============================================================================
# seed-test.sh — UNA sola orden para la rebanada real-JWT (RUNBOOK Fase 1, 1b).
#
# Levanta el stack local, aplica migraciones + el seed DETERMINISTA
# (supabase/seed.sql: 2 talleres, 2 owners con password, fixtures de los 4
# targets) y emite `.env.integration` con URL + anon key + credenciales para que
# el FE corra `npm run test:integration`.
#
# Solo bash + Supabase CLI: este repo NO tiene runtime node/deno local. El
# service_role NUNCA sale de acá; el FE recibe únicamente la anon key + las
# credenciales de test (local-only).
#
# Uso:   ./scripts/seed-test.sh
# Luego: cd ../AntawaTec-FE && npm run test:integration
# =============================================================================
set -euo pipefail

BE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # .../AntawaTec-BE
cd "$BE_DIR"

echo "▸ supabase start (idempotente)…"
supabase start 2>/dev/null || true

echo "▸ supabase db reset (migraciones + seed determinista)…"
supabase db reset

# URL + anon key del stack local (NO el service_role).
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY)=')"

emit_env () {
  cat <<ENV
# Generado por scripts/seed-test.sh — stack de TEST local. NO commitear.
# Lo consume la rebanada real-JWT del FE (src/test/integration + npm run test:integration).
SUPABASE_TEST_URL=$API_URL
SUPABASE_TEST_ANON_KEY=$ANON_KEY
OWNER_A_EMAIL=ownera@antawa.test
OWNER_A_PASSWORD=ownera-pass-123
OWNER_B_EMAIL=ownerb@antawa.test
OWNER_B_PASSWORD=ownerb-pass-123
ADMIN_EMAIL=admin@antawa.test
ADMIN_PASSWORD=admin-pass-123
TECH_A_EMAIL=techa@antawa.test
TECH_A_PASSWORD=techa-pass-123
ENV
}

emit_env > "$BE_DIR/.env.integration"
echo "▸ escrito: $BE_DIR/.env.integration"

# Conveniencia: si el FE está como repo hermano, deja el archivo listo allí.
FE_DIR="$(cd "$BE_DIR/.." && pwd)/AntawaTec-FE"
if [ -d "$FE_DIR" ]; then
  emit_env > "$FE_DIR/.env.integration"
  echo "▸ copiado a: $FE_DIR/.env.integration"
fi

echo ""
echo "── Bloque de entorno (para CI o copia manual) ──"
emit_env
echo ""
echo "✓ Listo. Ahora: cd ../AntawaTec-FE && npm run test:integration"
