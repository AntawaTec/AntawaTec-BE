// =============================================================================
// billing-setup/index.ts
// Alta y configuración de la facturación electrónica de un taller, invocada por
// el DUEÑO desde Configuración en la PWA. Exige `shops.billing_enabled` (lo
// prende Antawa desde /admin).
//
// Acciones (body JSON { action, ... }):
//   - status:             configuración guardada + si hay credencial del proveedor.
//   - save_fiscal:        valida RUC/razón social/serie/régimen, crea (o actualiza)
//                         la empresa en el proveedor, guarda su API key en Vault y
//                         la configuración en shop_billing_settings.
//   - upload_certificate: reenvía el .p12 (base64) y su clave al proveedor. NUNCA
//                         se persisten ni se loguean; solo se guarda el vencimiento.
//   - set_environment:    'test' (SRI de pruebas) | 'production'.
//
// shop_billing_settings no tiene policies de escritura: TODO cambio pasa por acá
// (service_role) porque primero tiene que aceptarlo el proveedor.
//
// Re-entrante (mismo racional que provisionTenant): proveedor y DB no comparten
// transacción. Si la empresa se crea en el proveedor y la escritura nuestra
// falla, el reintento la ENCUENTRA por RUC en la cuenta (findCompanyByRuc) y la
// adopta, en vez de crear otra. Solo se adopta una empresa que ningún otro
// taller tiene registrada (el unique de RUC de 0050 lo garantiza antes).
//
// Seguridad: verify_jwt = false (preflight CORS), auth real in-code vía
// _shared/requireOwner.ts; todo se escribe sobre el shop_id del PERFIL.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import { requireShopOwner } from "../_shared/requireOwner.ts";
import { badRequest, forbidden, json, methodNotAllowed, ok, preflight, serverError } from "../_shared/response.ts";
import {
  canCreateCompanies,
  MISSING_CONFIG_MESSAGE,
  providerFromEnv,
  webhookSecretFromEnv,
  webhookUrlFromEnv,
} from "../_shared/billing/config.ts";
import {
  certValid,
  getProviderKey,
  loadSettings,
  setProviderKey,
  SETTINGS_COLUMNS,
  type SettingsRow,
  shopBillingEnabled,
} from "../_shared/billing/invoiceStore.ts";
import { type BillingProvider, ProviderError } from "../_shared/billing/provider.ts";
import { type Regimen, validateRuc } from "../_shared/billing/sri.ts";

const LABEL = "billing-setup";
const MAX_P12_BYTES = 5 * 1024 * 1024; // límite del proveedor
const REGIMENES: Regimen[] = ["general", "rimpe_emprendedor", "rimpe_negocio_popular"];
type Action = "status" | "save_fiscal" | "upload_certificate" | "set_environment";
const ACTIONS: Action[] = ["status", "save_fiscal", "upload_certificate", "set_environment"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error(`${LABEL}: configuración incompleta:`, e);
    return serverError(MISSING_CONFIG_MESSAGE);
  }

  const owner = await requireShopOwner(
    admin,
    req,
    LABEL,
    "Solo el dueño del taller puede configurar la facturación.",
  );
  if (!owner.ok) return owner.response;
  const { shopId } = owner;

  // deno-lint-ignore no-explicit-any
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }
  const action = body?.action as Action;
  if (!ACTIONS.includes(action)) {
    return badRequest("action debe ser 'status', 'save_fiscal', 'upload_certificate' o 'set_environment'.");
  }

  try {
    if (!(await shopBillingEnabled(admin, shopId))) {
      return forbidden("La facturación electrónica no está activada para tu taller.");
    }
    if (action === "status") return await status(admin, shopId);

    const provider = providerFromEnv();
    if (!provider) {
      console.error(`${LABEL}: faltan AUTORIZADOREC_BASE_URL / AUTORIZADOREC_ACCOUNT_KEY.`);
      return serverError(MISSING_CONFIG_MESSAGE);
    }
    switch (action) {
      case "save_fiscal":
        return await saveFiscal(admin, provider, shopId, body);
      case "upload_certificate":
        return await uploadCertificate(admin, provider, shopId, body);
      case "set_environment":
        return await setEnvironment(admin, provider, shopId, body);
    }
  } catch (e) {
    if (e instanceof ProviderError) return providerFailure(e, action);
    console.error(`${LABEL}: error en ${action} (taller ${shopId}):`, e instanceof Error ? e.message : e);
    return serverError("No se pudo completar la operación. Intenta de nuevo.");
  }
  return serverError("Acción no implementada.");
});

/** Error del proveedor → respuesta. Nunca incluye lo que se le mandó. */
function providerFailure(e: ProviderError, action: string): Response {
  console.error(`${LABEL}: proveedor falló en ${action}: ${e.kind} ${e.status ?? ""} ${e.providerMessage ?? ""}`);
  if (e.kind !== "http" || e.status === null || e.status >= 500 || e.status === 429) {
    return json(502, { error: "El proveedor de facturación no respondió. Intenta de nuevo en unos minutos." });
  }
  if (e.status === 401 || e.status === 403) {
    return json(502, { error: "El proveedor de facturación rechazó nuestras credenciales. Avisa a soporte de Antawa." });
  }
  const detail = e.providerMessage ? `: ${e.providerMessage}` : ".";
  if (action === "upload_certificate") {
    return badRequest(`No se pudo validar la firma (revisa el archivo .p12 y su clave)${detail}`);
  }
  return json(e.status === 409 ? 409 : 400, { error: `El proveedor de facturación rechazó los datos${detail}` });
}

function settingsView(s: SettingsRow | null) {
  if (!s) return null;
  return {
    ruc: s.ruc,
    razon_social: s.razon_social,
    nombre_comercial: s.nombre_comercial,
    direccion_matriz: s.direccion_matriz,
    establecimiento: s.establecimiento,
    punto_emision: s.punto_emision,
    obligado_contabilidad: s.obligado_contabilidad,
    regimen: s.regimen,
    contribuyente_especial: s.contribuyente_especial,
    environment: s.environment,
    provider: s.provider,
    company_registered: !!s.provider_company_id,
    cert_expires_at: s.cert_expires_at,
    ready: s.ready,
    updated_at: s.updated_at,
  };
}

/** Lista para emitir: empresa en el proveedor + key en Vault + firma vigente. */
function computeReady(companyId: string | null, hasKey: boolean, certExpiresAt: string | null): boolean {
  return !!companyId && hasKey && certValid({ shop_id: "", cert_expires_at: certExpiresAt }, Date.now());
}

// ------------------------------------------------------------------- status --

async function status(admin: SupabaseClient, shopId: string): Promise<Response> {
  const settings = await loadSettings(admin, shopId);
  const hasKey = settings ? (await getProviderKey(admin, shopId)) !== null : false;
  return ok({
    settings: settingsView(settings),
    hasProviderKey: hasKey,
    certValid: certValid(settings, Date.now()),
    ready: settings ? computeReady(settings.provider_company_id, hasKey, settings.cert_expires_at) : false,
  });
}

// -------------------------------------------------------------- save_fiscal --

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "").slice(0, max + 1);

async function saveFiscal(
  admin: SupabaseClient,
  provider: BillingProvider,
  shopId: string,
  // deno-lint-ignore no-explicit-any
  body: Record<string, any>,
): Promise<Response> {
  // 1) Validación de entrada.
  const ruc = str(body.ruc, 13);
  const razonSocial = str(body.razonSocial, 300);
  const nombreComercial = str(body.nombreComercial, 300) || null;
  const direccionMatriz = str(body.direccionMatriz, 300);
  const establecimiento = str(body.establecimiento ?? "001", 3);
  const puntoEmision = str(body.puntoEmision ?? "001", 3);
  const obligado = body.obligadoContabilidad === true;
  const regimen = (body.regimen ?? "general") as Regimen;
  const especial = str(body.contribuyenteEspecial, 13) || null;

  const rucCheck = validateRuc(ruc);
  if (!rucCheck.ok) return badRequest(rucCheck.reason);
  if (!razonSocial || razonSocial.length > 300) return badRequest("La razón social es obligatoria (máximo 300 caracteres).");
  if (nombreComercial && nombreComercial.length > 300) return badRequest("El nombre comercial no puede superar 300 caracteres.");
  if (!direccionMatriz || direccionMatriz.length > 300) return badRequest("La dirección matriz es obligatoria (máximo 300 caracteres).");
  if (!/^[0-9]{3}$/.test(establecimiento) || establecimiento === "000") {
    return badRequest("El establecimiento debe ser un código de 3 dígitos (por ejemplo 001).");
  }
  if (!/^[0-9]{3}$/.test(puntoEmision) || puntoEmision === "000") {
    return badRequest("El punto de emisión debe ser un código de 3 dígitos (por ejemplo 001).");
  }
  if (!REGIMENES.includes(regimen)) return badRequest("El régimen debe ser general, RIMPE emprendedor o RIMPE negocio popular.");
  if (especial && !/^[0-9]{3,13}$/.test(especial)) {
    return badRequest("El número de resolución de contribuyente especial debe tener de 3 a 13 dígitos.");
  }

  const webhookSecret = webhookSecretFromEnv();
  const webhookUrl = webhookUrlFromEnv();
  if (!webhookSecret || !webhookUrl) {
    console.error(`${LABEL}: faltan AUTORIZADOREC_WEBHOOK_SECRET / SUPABASE_URL.`);
    return serverError(MISSING_CONFIG_MESSAGE);
  }

  // 2) Un taller por RUC (0050, shop_billing_settings_ruc_unique): cortar ANTES de
  //    tocar el proveedor.
  const { data: other, error: otherErr } = await admin
    .from("shop_billing_settings")
    .select("shop_id")
    .eq("ruc", ruc)
    .neq("shop_id", shopId)
    .limit(1);
  if (otherErr) throw new Error(`Chequeo de RUC falló: ${otherErr.message}`);
  if (other && other.length > 0) return rucTaken();

  const { data: shop } = await admin.from("shops").select("name, contact_email, contact_phone").eq("id", shopId).maybeSingle();
  const existing = await loadSettings(admin, shopId);
  const environment = (existing?.environment ?? "test") as "test" | "production";

  const companyInput = {
    razonSocial,
    nombreComercial,
    direccionMatriz,
    email: (shop?.contact_email as string | null) ?? null,
    phone: (shop?.contact_phone as string | null) ?? null,
    establecimiento,
    webhookUrl,
    webhookSecret,
  };

  // 3) Empresa en el proveedor.
  let companyId = (existing?.provider_company_id as string | null) ?? null;
  if (companyId) {
    if (existing?.ruc !== ruc) await provider.changeCompanyRuc(companyId, ruc);
    await provider.updateCompany(companyId, companyInput);
    if (!(await getProviderKey(admin, shopId))) {
      // Settings con empresa pero sin key en Vault: no debería pasar; se recupera
      // por RUC (el listado del proveedor trae la key).
      const ref = await provider.findCompanyByRuc(ruc);
      if (!ref || ref.companyId !== companyId) {
        console.error(`${LABEL}: taller ${shopId} con empresa ${companyId} sin API key recuperable.`);
        return serverError("No se pudo recuperar la credencial del proveedor. Avisa a soporte de Antawa.");
      }
      await setProviderKey(admin, shopId, ref.apiKey);
    }
  } else {
    let ref = await provider.findCompanyByRuc(ruc);
    if (ref) {
      // Adopción (reintento tras una escritura nuestra fallida). Nunca una empresa
      // que ya tenga otro taller.
      const { data: claimed, error: claimErr } = await admin
        .from("shop_billing_settings")
        .select("shop_id")
        .eq("provider_company_id", ref.companyId)
        .neq("shop_id", shopId)
        .limit(1);
      if (claimErr) throw new Error(`Chequeo de empresa falló: ${claimErr.message}`);
      if (claimed && claimed.length > 0) return rucTaken();
      console.log(`${LABEL}: taller ${shopId} adopta la empresa ${ref.companyId} existente en el proveedor.`);
      await provider.updateCompany(ref.companyId, companyInput);
    } else {
      if (!canCreateCompanies()) {
        console.error(`${LABEL}: falta AUTORIZADOREC_PLAN_ID para crear empresas.`);
        return serverError(MISSING_CONFIG_MESSAGE);
      }
      ref = await provider.createCompany({ ...companyInput, ruc, environment });
    }
    // La key PRIMERO (si lo de abajo falla, el reintento adopta la empresa).
    await setProviderKey(admin, shopId, ref.apiKey);
    companyId = ref.companyId;
  }

  await provider.ensureSeries(companyId, {
    establecimiento,
    puntoEmision,
    address: direccionMatriz,
    name: nombreComercial ?? razonSocial,
  });

  // 4) Persistir.
  const hasKey = (await getProviderKey(admin, shopId)) !== null;
  const certExpiresAt = (existing?.cert_expires_at as string | null) ?? null;
  const { data: saved, error: saveErr } = await admin
    .from("shop_billing_settings")
    .upsert(
      {
        shop_id: shopId,
        ruc,
        razon_social: razonSocial,
        nombre_comercial: nombreComercial,
        direccion_matriz: direccionMatriz,
        establecimiento,
        punto_emision: puntoEmision,
        obligado_contabilidad: obligado,
        regimen,
        contribuyente_especial: especial,
        environment,
        provider: provider.name,
        provider_company_id: companyId,
        cert_expires_at: certExpiresAt,
        ready: computeReady(companyId, hasKey, certExpiresAt),
      },
      { onConflict: "shop_id" },
    )
    .select(SETTINGS_COLUMNS)
    .single();
  if (saveErr) {
    if (saveErr.code === "23505") return rucTaken();
    throw new Error(`No se pudo guardar la configuración: ${saveErr.message}`);
  }
  console.log(`${LABEL}: datos fiscales guardados para el taller ${shopId} (empresa ${companyId}).`);
  return ok({ settings: settingsView(saved as unknown as SettingsRow), hasProviderKey: hasKey });
}

function rucTaken(): Response {
  return json(409, {
    error: "Ese RUC ya está configurado en otro taller de AntawaTec. Escríbenos a soporte si es una sucursal tuya.",
  });
}

// ------------------------------------------------------- upload_certificate --

async function uploadCertificate(
  admin: SupabaseClient,
  provider: BillingProvider,
  shopId: string,
  // deno-lint-ignore no-explicit-any
  body: Record<string, any>,
): Promise<Response> {
  const settings = await loadSettings(admin, shopId);
  if (!settings?.provider_company_id) return json(409, { error: "Primero guarda los datos fiscales del taller." });

  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return badRequest("Falta la clave de la firma electrónica.");
  let p12: Uint8Array;
  try {
    p12 = decodeBase64(typeof body.p12Base64 === "string" ? body.p12Base64 : "");
  } catch {
    return badRequest("El archivo de la firma no es válido (se esperaba un .p12 en base64).");
  }
  if (p12.length === 0) return badRequest("Falta el archivo de la firma (.p12).");
  if (p12.length > MAX_P12_BYTES) return badRequest("El archivo de la firma no puede superar 5 MB.");

  // El .p12 y la clave viven solo en memoria durante esta llamada.
  const cert = await provider.uploadCertificate(settings.provider_company_id, p12, password);
  if (!cert.expiresAt) {
    console.error(`${LABEL}: el proveedor aceptó la firma del taller ${shopId} pero no informó vencimiento.`);
  }
  const hasKey = (await getProviderKey(admin, shopId)) !== null;
  const ready = computeReady(settings.provider_company_id, hasKey, cert.expiresAt);
  const { data: saved, error } = await admin
    .from("shop_billing_settings")
    .update({ cert_expires_at: cert.expiresAt, ready })
    .eq("shop_id", shopId)
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw new Error(`No se pudo guardar el vencimiento de la firma: ${error.message}`);
  console.log(`${LABEL}: firma cargada para el taller ${shopId} (vence ${cert.expiresAt ?? "?"}).`);
  return ok({
    settings: settingsView(saved as unknown as SettingsRow),
    certificate: { expiresAt: cert.expiresAt, subject: cert.subject },
  });
}

/** Base64 (con o sin prefijo data:) → bytes. Lanza si no es base64 válido. */
function decodeBase64(raw: string): Uint8Array {
  const b64 = raw.replace(/^data:[^;]*;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error("base64 inválido");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------- set_environment --

async function setEnvironment(
  admin: SupabaseClient,
  provider: BillingProvider,
  shopId: string,
  // deno-lint-ignore no-explicit-any
  body: Record<string, any>,
): Promise<Response> {
  const env = body.environment;
  if (env !== "test" && env !== "production") return badRequest("environment debe ser 'test' o 'production'.");
  const settings = await loadSettings(admin, shopId);
  if (!settings?.provider_company_id) return json(409, { error: "Primero guarda los datos fiscales del taller." });
  if (settings.environment === env) return ok({ settings: settingsView(settings), unchanged: true });
  if (env === "production" && !certValid(settings, Date.now())) {
    return json(409, { error: "Sube una firma electrónica vigente antes de pasar a producción." });
  }
  // Una factura en vuelo se resuelve contra el ambiente con que se emitió: no se
  // cambia el ambiente de la empresa debajo de ella.
  const { count, error: cErr } = await admin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("status", "processing");
  if (cErr) throw new Error(`Chequeo de facturas en emisión falló: ${cErr.message}`);
  if ((count ?? 0) > 0) {
    return json(409, { error: "Hay facturas en emisión. Espera a que terminen antes de cambiar de ambiente." });
  }

  await provider.setEnvironment(settings.provider_company_id, env);
  const { data: saved, error } = await admin
    .from("shop_billing_settings")
    .update({ environment: env })
    .eq("shop_id", shopId)
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw new Error(`No se pudo guardar el ambiente: ${error.message}`);
  console.log(`${LABEL}: taller ${shopId} pasó a ambiente ${env}.`);
  return ok({ settings: settingsView(saved as unknown as SettingsRow) });
}
