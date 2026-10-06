# Runbook — confirmación de citas manuales + recordatorio del día (lote 2026-10-06)

Pedido del taller: (1) las citas agendadas a mano (sin cotización) también mandan
confirmación inmediata; (2) un recordatorio **el día de la cita a las 07:00** (hora de
Ecuador), que cubre también a las citas creadas con menos de un día de anticipación.

| Pieza | Qué cambia |
|---|---|
| `0045` | enum `notification_template` + `appointment_reminder_today` (una línea, ver 0040). |
| `0046` | **contención**: siembra `appointment_confirmed`/whatsapp en TODAS las citas existentes. Sin esto el primer tick confirma con atraso toda cita futura ya agendada. |
| `notification-dispatch` | `appointment_confirmed` para toda cita activa y futura (antes solo `source='quote'`); bloque nuevo `appointment_reminder_today` (desde las 07:00 EC, citas de hoy que no pasaron, creadas antes de las 07:00). Con `WHATSAPP_PROVIDER=twilio` **no encola nada si falta el SID** de la plantilla nueva. |
| `_shared/ecTime.ts` | reloj de Ecuador (-05:00 fijo) compartido por el render y el barrido. |
| `scripts/twilio-create-template.sh` | crea la plantilla en Twilio por Content API y pide aprobación. |

## Orden (cada paso depende del anterior)

1. **Plantilla en Twilio** (Terminal del user, subcuenta `AC5f1b…`):
   `TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… scripts/twilio-create-template.sh appointment_reminder_today`
   → anotar el `HX…`. Esperar **Approved** (Meta tarda de minutos a horas; se ve en
   Twilio → Content Template Builder o en la URL que imprime el script).
2. **Secret** `TWILIO_CONTENT_SIDS` (Dashboard): agregar la llave
   `"appointment_reminder_today":"HX…"` al JSON existente. Hasta este paso la función
   nueva puede estar deployada sin riesgo: el guard no encola sin SID.
3. **Pausar el cron**: `select cron.alter_job(job_id := 1, active := false);`
4. **`db push`** (0045 + 0046) y verificar: la query 1 de la cabecera de 0046 ANTES
   del push tiene que dar lo mismo que la 2 DESPUÉS. Nada en `queued` para
   `appointment_confirmed`.
5. **`functions deploy notification-dispatch`** (desde `main` ya mergeado).
6. **Reanudar el cron**: `select cron.alter_job(job_id := 1, active := true);`
7. Verificar en el primer tick: `select template, status, count(*) from notification_log
   where created_at > now() - interval '5 minutes' group by 1,2;` → solo lo esperado
   (citas de hoy pendientes si el deploy fue después de las 07:00).

Hacerlo **fuera del horario de los talleres**: una cita creada entre el push y el
deploy queda sembrada por 0046 y pierde su confirmación.

## Comportamiento resultante

| Evento | Cuándo | Plantilla |
|---|---|---|
| Cita creada (cualquier origen), futura | al minuto | `appointment_confirmed` |
| Cita de mañana | ventana [now+23h, now+24h] | `appointment_reminder_24h` |
| Cita de hoy, creada antes de las 07:00 | 07:00 EC (o el primer tick después) | `appointment_reminder_today` |
| Cita creada hoy después de las 07:00 para hoy | solo la confirmación | — |

Una cita que se reprograma NO vuelve a avisar (el dedupe es por cita + plantilla):
sigue siendo una limitación conocida.
