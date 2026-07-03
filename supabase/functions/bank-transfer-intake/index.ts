// =============================================================================
// bank-transfer-intake/index.ts
// Intake del comprobante de transferencia bancaria. La invoca un PROSPECTO
// ANÓNIMO desde la landing estática: no existe usuario todavía, así que no hay
// JWT posible (verify_jwt = false en config.toml). Es la puerta de entrada del
// embudo bancario; la otra mitad (aprobación) vive en bank-transfer-approval.
//
// Contrato: POST multipart/form-data (nativo en el browser vía FormData y en
// Deno vía req.formData(); simple request de CORS, sin preflight en el submit).
//   businessName  req, 1–120 chars
//   email         req, formato válido, ≤254
//   amount        opcional, numérico > 0 y ≤ 99999.99
//   website       HONEYPOT: si viene lleno es un bot → 201 FALSO sin escribir
//   file          req, ≤ 5 MB, mime ∈ {jpeg, png, webp, pdf}
//
// Defensa (sin captcha en V1): validación estricta in-code (multipart, mime y
// tamaño por whitelist), honeypot y cap de 3 proofs `pending` por email (429).
// Las escrituras van con createAdminClient() (service_role, salta el RLS
// admin-only de bank_transfer_proofs y del bucket payment-proofs); el
// service_role NUNCA sale de la función.
//
// proof_url guarda el PATH del objeto, nunca una URL firmada (patrón del FE:
// signed URL on-demand al mostrar).
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import {
  badRequest,
  created,
  methodNotAllowed,
  preflight,
  serverError,
  tooManyRequests,
} from "../_shared/response.ts";

const BUCKET = "payment-proofs";

// La landing promete "hasta 5 MB"; el bucket topa a 10 (0010). Server-side manda.
const MAX_FILE_BYTES = 5_242_880;

// Extensión derivada del MIME (no del filename, que lo controla el cliente).
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const MAX_PENDING_PER_EMAIL = 3;
const MAX_BUSINESS_NAME = 120;
const MAX_EMAIL = 254;
const MAX_AMOUNT = 99999.99;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error("bank-transfer-intake: configuración incompleta:", e);
    return serverError("Configuración del servidor incompleta.");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("Se esperaba un body multipart/form-data.");
  }

  // Honeypot ANTES de validar nada: a un bot que llenó el campo oculto se le
  // responde el mismo 201 que a un humano (proofId inventado), sin escribir ni
  // delatar que fue detectado.
  const website = form.get("website");
  if (typeof website === "string" && website.trim() !== "") {
    console.log("bank-transfer-intake: honeypot activado; 201 falso sin escritura.");
    return created({ proofId: crypto.randomUUID(), status: "pending" });
  }

  // --- Validación server-side (la landing valida lo mismo, pero acá manda) ---
  const businessNameRaw = form.get("businessName");
  const businessName = typeof businessNameRaw === "string" ? businessNameRaw.trim() : "";
  if (!businessName || businessName.length > MAX_BUSINESS_NAME) {
    return badRequest("businessName es obligatorio (1–120 caracteres).");
  }

  const emailRaw = form.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return badRequest("email es obligatorio y debe ser una dirección válida.");
  }

  const amountRaw = form.get("amount");
  let amount: number | null = null;
  if (typeof amountRaw === "string" && amountRaw.trim() !== "") {
    const parsed = Number(amountRaw.trim());
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_AMOUNT) {
      return badRequest("amount debe ser un número mayor a 0 y hasta 99999.99.");
    }
    amount = parsed;
  } else if (amountRaw !== null && typeof amountRaw !== "string") {
    return badRequest("amount debe ser un número.");
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return badRequest("Falta el archivo del comprobante (campo file).");
  }
  if (file.size > MAX_FILE_BYTES) {
    return badRequest("El comprobante supera el máximo de 5 MB.");
  }
  const ext = MIME_EXT[file.type];
  if (!ext) {
    return badRequest("Formato no soportado: se acepta JPG, PNG, WebP o PDF.");
  }

  try {
    // Cap anti-abuso: a partir del 4º proof pendiente del mismo email → 429.
    const { count, error: countErr } = await admin
      .from("bank_transfer_proofs")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .eq("status", "pending");
    if (countErr) throw new Error(`Conteo de pendientes falló: ${countErr.message}`);
    if ((count ?? 0) >= MAX_PENDING_PER_EMAIL) {
      return tooManyRequests(
        "Ya tenemos comprobantes pendientes para este email. Espera a que los validemos.",
      );
    }

    // Orden de escritura: primero el objeto, después la fila que lo referencia.
    const proofId = crypto.randomUUID();
    const path = `intake/${proofId}/proof.${ext}`;

    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) throw new Error(`Upload del comprobante falló: ${upErr.message}`);

    const { error: insErr } = await admin.from("bank_transfer_proofs").insert({
      id: proofId,
      business_name: businessName,
      email,
      amount,
      proof_url: path, // PATH, no URL firmada
    });
    if (insErr) {
      // Best-effort: no dejar el objeto huérfano si la fila no existe. Si el
      // remove también falla, se acepta el residuo (bucket privado solo-admin).
      await admin.storage.from(BUCKET).remove([path]).catch(() => {});
      throw new Error(`Insert del proof falló: ${insErr.message}`);
    }

    console.log(`bank-transfer-intake: proof ${proofId} recibido (${email}).`);
    return created({ proofId, status: "pending" });
  } catch (e) {
    console.error("bank-transfer-intake: error procesando el intake:", e);
    return serverError("No pudimos recibir tu comprobante. Intenta de nuevo.");
  }
});
