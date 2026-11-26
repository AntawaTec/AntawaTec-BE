# Kommo: sincronización de leads (campaña de prueba gratis)

Mueve el lead de Kommo de un taller cuando activa la prueba y cuando paga por
primera vez. Kommo reenvía esos movimientos a Meta. Código: `_shared/kommo.ts`.

| Momento | Función | Etapa en Kommo |
| --- | --- | --- |
| Prueba activada (link con `?lid=`) | `promo-intake` | Demo realizada / Prueba activa (`114455767`), $25 |
| Primer pago aprobado en `/admin` | `subscription-renewal-approval` | Logrado con éxito (`142`), $25 |

Está **apagado** mientras no exista el secret `KOMMO_TOKEN`: las funciones se
pueden deployar antes de tener el token.

## Salida a prod (en orden)

1. Mergear el PR y aplicar la migración `0056_kommo_leads.sql` (`db push`).
2. Deployar `promo-intake` y `subscription-renewal-approval` desde un worktree
   limpio de `origin/main`.
3. Dashboard → Edge Functions → Secrets: `KOMMO_TOKEN` (token de larga duración
   de Kommo; lo entrega marketing por canal seguro). Opcional `KOMMO_BASE_URL`
   (default `https://gmdigital1209.kommo.com/api/v4`).
4. Mergear la landing (manda `lid` a `promo-intake`). El orden con el paso 2 es
   libre: la función vieja ignora el campo.

## Verificar

- Activar una prueba con `antwt.com/prueba?codigo=<código>&lid=<lead de prueba>`:
  el lead pasa a "Prueba activa" con $25 en menos de un minuto.
- `select * from kommo_leads order by created_at desc limit 5;` →
  `trial_synced_at` con fecha. En null = Kommo falló (ver logs `kommo:` de la
  función) o falta el token.
- Un `lid` inventado o de otro pipeline no cambia nada (queda marcado como
  sincronizado: no hay nada que reintentar).

## Límites conocidos

- Solo cubre el primer pago **por transferencia aprobada en /admin**, que es el
  único camino de pago de un taller en prueba hoy. Una compra directa en la
  landing (tarjeta o transferencia, sin prueba) no lleva `lid`.
- Si Kommo falla los 3 intentos al activar la prueba no hay reintento
  automático; se mueve el lead a mano o se limpia y relanza. El pago sí se
  reintenta solo en la siguiente aprobación.
- Talleres que llegan sin `lid` no se buscan por teléfono (paso opcional del
  instructivo, no implementado).
