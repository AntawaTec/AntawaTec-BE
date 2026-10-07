#!/usr/bin/env bash
# =============================================================================
# scripts/twilio-create-template.sh — crea UNA plantilla de WhatsApp en Twilio
# (Content API) y la manda a aprobación de Meta como UTILITY / es.
#
# Uso (desde la Terminal del user, nunca con el token en el repo):
#   TWILIO_ACCOUNT_SID=AC… TWILIO_AUTH_TOKEN=… \
#     scripts/twilio-create-template.sh appointment_reminder_today
#
# Imprime el Content SID (HX…) que va en el secret TWILIO_CONTENT_SIDS con el
# nombre de la plantilla como llave. El cuerpo tiene que coincidir carácter por
# carácter con el render de _shared/notificationTemplates.ts.
# =============================================================================
set -euo pipefail

name="${1:?nombre de la plantilla (valor del enum notification_template)}"
: "${TWILIO_ACCOUNT_SID:?}" "${TWILIO_AUTH_TOKEN:?}"

AVISO='Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.'

case "$name" in
  appointment_reminder_today)
    body="Hola {{1}}, te recordamos que hoy tienes tu cita para tu vehículo {{2}} a las {{3}}.

Te esperamos,

{{4}}

$AVISO"
    vars='{"1":"Andrés","2":"Chevrolet Sail PBC-5251","3":"08:30","4":"Taller AntawaTec · Tel. 0998765432"}'
    ;;
  *)
    echo "plantilla desconocida: $name (agregar su cuerpo a este script)" >&2
    exit 1
    ;;
esac

payload=$(jq -n --arg name "$name" --arg body "$body" --argjson vars "$vars" \
  '{friendly_name: $name, language: "es", variables: $vars, types: {"twilio/text": {body: $body}}}')

created=$(curl -sS -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -d "$payload" https://content.twilio.com/v1/Content)
sid=$(jq -r '.sid // empty' <<<"$created")
if [[ -z "$sid" ]]; then echo "no se creó: $created" >&2; exit 1; fi

approval=$(curl -sS -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"name\":\"$name\",\"category\":\"UTILITY\"}" \
  "https://content.twilio.com/v1/Content/$sid/ApprovalRequests/whatsapp")

echo "Content SID: $sid"
echo "Aprobación:  $(jq -r '.status // .message // .' <<<"$approval")"
echo "Estado:      https://content.twilio.com/v1/Content/$sid/ApprovalRequests"
