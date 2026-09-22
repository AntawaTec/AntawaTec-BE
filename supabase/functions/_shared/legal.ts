// =============================================================================
// _shared/legal.ts
// COPIA de AntawaTec-FE/src/lib/legal.ts. El descargo va en el documento de
// RECEPCIÓN ("Orden de trabajo"), que el cliente firma al ingresar el vehículo —
// NO en el recibo de entrega.
//
// Ahora hay DOS renders del mismo documento: la vista imprimible del FE
// (OrderPrintView) y el PDF que el BE adjunta al correo de recepción. El texto
// tiene que ser EL MISMO en los dos: es la única parte del documento con efecto
// legal, y que el correo diga algo distinto del papel que el cliente firmó sería
// el peor de los bugs cosméticos.
//
// ⚠️ TEXTO PLACEHOLDER razonable hasta que Pablo pase el texto EXACTO de Zoho.
// Al llegar hay que reemplazar este string en LOS DOS REPOS (acá y en
// AntawaTec-FE/src/lib/legal.ts) en el mismo lote.
// =============================================================================
export const LIABILITY_DISCLAIMER =
  `El cliente declara que la información del vehículo consignada en este documento es correcta y autoriza al taller a realizar los trabajos aquí detallados.
El taller no se responsabiliza por objetos de valor dejados dentro del vehículo que no hayan sido declarados al momento de la recepción, ni por fallas preexistentes no relacionadas con los trabajos realizados.
Los repuestos reemplazados quedan a disposición del cliente al momento de la entrega. Los trabajos y repuestos cuentan con la garantía ofrecida por el taller; dicha garantía no cubre daños derivados de uso indebido ni de intervenciones de terceros posteriores a la entrega.`;
