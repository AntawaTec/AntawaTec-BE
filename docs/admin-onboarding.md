# Admin de Antawa: alta del rol y flujo de renovaciones

> Dos procedimientos que hoy viven en la cabeza del dev y no en el repo:
> **(a)** cómo crear un usuario `antawa_admin` (el único rol que puede aprobar
> comprobantes) y **(b)** cómo funciona la **renovación mensual por transferencia**
> desde que el dueño sube el comprobante hasta que la suscripción queda extendida.

---

## (a) Dar de alta un `antawa_admin`

No hay UI para esto (por diseño: crear un admin es un acto de plataforma, no de
producto). Son dos pasos en el Dashboard del proyecto.

### Antes de empezar: dos restricciones que muerden

1. **El email tiene que ser DISTINTO al de cualquier taller.** `profiles.id` **es**
   `auth.users.id`: un email = un usuario = **un solo** profile, y por lo tanto un
   solo rol. Si usás el mismo email con el que entra un dueño, o lo convertís en
   admin (y le rompés el acceso a su taller) o el insert falla. Usá algo como
   `admin@antwt.com`, nunca el email personal que ya está en `shops.contact_email`.
2. **Un admin NO tiene taller.** `profiles_role_shop_ck` (0002) exige
   `role = 'antawa_admin' ⇒ shop_id IS NULL`. Si mandás un `shop_id`, el insert
   revienta con un `23514`.

> Por qué a mano y no por Edge Function: `provisionTenant` está hecho para
> DUEÑOS (crea shop + subscription + magic link). Un admin no tiene nada de eso.

### Paso 1 — crear el usuario de auth

Dashboard → **Authentication → Users → Add user**:

- *Email*: el email del admin (ver restricción 1).
- Opción A — **Send invite**: el usuario recibe el mail y define su contraseña
  (o entra por magic link). Ojo: GoTrue tiene **un solo** template de invite y lo
  comparten dueños y técnicos, por eso el copy es neutro.
- Opción B — **Create user** con contraseña y *Auto Confirm User* tildado
  (útil si el mail todavía no está configurado).

Copiá el **UID** del usuario recién creado.

### Paso 2 — crear el profile con rol admin

Dashboard → **SQL Editor** (corre como `postgres`, salta la RLS; desde la app no
se puede: `profiles` no tiene política de INSERT):

```sql
insert into public.profiles (id, shop_id, role, full_name)
values ('<uid-copiado-del-paso-1>', null, 'antawa_admin', 'Nombre Apellido');
```

### Paso 3 — verificar

```sql
select p.id, u.email, p.role, p.shop_id
from public.profiles p
join auth.users u on u.id = p.id
where p.role = 'antawa_admin';
```

Debe aparecer con `shop_id` en `null`. Prueba funcional: entrar a `/admin` en la
PWA — `private.is_platform_admin()` ya devuelve `true` y las políticas
`*_admin_all` / lectura cross-shop se abren solas.

### Quitarle el rol

Borrar la **fila de profiles** (o el usuario de auth, que la cascadea). Sin
profile, `is_platform_admin()` da `false` al instante aunque el JWT siga vivo —
mismo razonamiento que el `deleteUser` de `technician-access`: banear dejaría el
token pasando RLS hasta que expire (~1 h).

---

## (b) Renovación mensual por transferencia

### El problema que resuelve

El alta (`bank-transfer-intake` → `bank-transfer-approval`) cobra el **primer**
mes y provisiona el taller. Del mes 2 en adelante no había nada: el comprobante
llegaba por WhatsApp y `subscriptions.current_period_end` quedaba viejo o se
tocaba a mano en el Dashboard. Ahora el circuito está en el producto.

### Piezas

| Pieza | Dónde | Qué hace |
|---|---|---|
| `bank_transfer_proofs.kind` | `0042` | `'signup'` (alta, prospecto anónimo) vs `'renewal'` (dueño autenticado). |
| `period_start` / `period_end` | `0042` | El mes que **pagó** ese comprobante. Se escriben al aprobar. |
| `btp_owner_insert_renewal` / `btp_owner_select_renewals` | `0042` | El dueño crea y ve **solo sus** renovaciones. |
| `btp_one_pending_renewal_per_shop` | `0042` | Un comprobante en revisión por taller. |
| policies de `payment-proofs` | `0043` | El dueño escribe/lee **solo** `{shop_id}/renewals/…`. |
| `subscription-renewal-approval` | Edge Function | El admin aprueba o rechaza; extiende la suscripción. |

### 1. El dueño sube el comprobante (PWA)

1. Sube el archivo al bucket privado `payment-proofs` con la ruta
   **`{shop_id}/renewals/{uuid}.{ext}`** (`upsert: false`). Las policies de `0043`
   exigen esas dos carpetas exactas: `[1]` = su `shop_id`, `[2]` = `renewals`. Los
   comprobantes de ALTA viven en `intake/{proofId}/` y le siguen siendo invisibles.
2. Inserta la fila:

```ts
await supabase.from('bank_transfer_proofs').insert({
  shop_id: profile.shop_id,          // regla de oro: shop_id explícito en el insert
  kind: 'renewal',
  business_name: shop.name,          // NOT NULL heredado del intake anónimo
  email: profile.email,              // idem
  amount: 25,
  proof_url: path,                   // el PATH del objeto, nunca una signed URL
});
```

   No manda `status` (default `pending`) ni `period_*` / `validated_*`: el
   `WITH CHECK` los exige nulos. Si ya hay uno en revisión llega un **23505** de
   `btp_one_pending_renewal_per_shop` → mostrar "ya tenés un comprobante en
   revisión", no un error crudo.

3. El dueño ve el estado (`pending` / `approved` / `rejected`) por
   `btp_owner_select_renewals`, y puede volver a ver su archivo con una signed URL
   (por eso `0043` incluye la policy SELECT, no solo INSERT).

### 2. El admin aprueba o rechaza

Desde el dashboard de Antawa, invocando la Edge Function con **su** JWT:

```ts
await supabase.functions.invoke('subscription-renewal-approval', {
  body: { proofId, decision: 'approve' },   // o 'reject'
});
```

La función verifica el Bearer contra GoTrue y que el profile del caller sea
`antawa_admin` (`_shared/requireAdmin.ts`). Un comprobante con `kind = 'signup'`
se rechaza con **400**: ese va por `bank-transfer-approval`, que además provisiona.

### 3. Qué cambia al aprobar

1. **`bank_transfer_proofs`**: `status = 'approved'`, `validated_by`,
   `validated_at`, y el período pagado —
   `period_start = max(current_period_end, now)` y
   `period_end = period_start + 1 mes calendario` (con clamp de fin de mes:
   31-ene → 28/29-feb).
2. **`subscriptions`**: la fila del taller con el vencimiento más lejano pasa a
   `status = 'active'` y `current_period_end = max(actual, period_end)`. Si el
   taller no tiene ninguna, se crea una `provider = 'bank_transfer'`,
   `plan = 'mensual'`.
3. **`shops`**: `status = 'active'`, `subscription_status = 'active'` y
   `activated_at` solo si estaba vacío (es la fecha de ALTA, no la del último pago).

Al **rechazar** solo se marca `status = 'rejected'` + `validated_*`. No se toca la
suscripción y el dueño puede subir otro (el unique parcial ya lo liberó).

### Idempotencia (lo importante)

Aprobar dos veces **nunca** suma dos meses. El `period_end` se escribe en el
**mismo UPDATE condicional** que marca `approved` (`where status = 'pending'`), así
que gana una sola llamada; cualquier reintento relee ese valor guardado y escribe
`max(actual, period_end)` como instante **absoluto** (nunca un `+ interval` en SQL).
Un fallo a mitad de camino se arregla volviendo a apretar "Aprobar": converge al
mismo estado y responde `alreadyProcessed: true`.

### Comprobaciones útiles

```sql
-- Renovaciones en revisión.
select p.id, s.name, p.amount, p.created_at
from public.bank_transfer_proofs p
join public.shops s on s.id = p.shop_id
where p.kind = 'renewal' and p.status = 'pending'
order by p.created_at;

-- Vencimientos: quién está por caer.
select s.name, sub.provider, sub.status, sub.current_period_end
from public.subscriptions sub
join public.shops s on s.id = sub.shop_id
order by sub.current_period_end nulls first;
```

### Límites conocidos (V1)

- **No hay corte automático por vencimiento.** `current_period_end` queda al día,
  pero nada suspende al taller que no pagó: la suspensión sigue siendo manual
  (`shops.status = 'suspended'`). Un cron de vencimientos es el follow-up natural.
- **No hay recordatorio de pago.** Ninguna de las 6 plantillas de notificación es
  de cobranza.
- **El dueño no puede borrar ni corregir** un comprobante subido (a propósito: es
  evidencia). Se corrige rechazándolo y subiendo otro.
- **Un taller con suscripción de Hotmart** que renueve por transferencia extiende
  esa fila de Hotmart en vez de crear una segunda. Es deliberado: dos filas activas
  con fechas distintas serían dos verdades sobre "hasta cuándo pagó".
