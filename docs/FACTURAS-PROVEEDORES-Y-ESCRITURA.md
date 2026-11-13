# Facturas de proveedor y escritura clínica

Esta versión conserva las funciones anteriores y añade ocho herramientas: conciliación de factura, consulta de pagos, ficha de pago, consulta de vencimientos, anotación de factura en observaciones, registro de pago, ficha de visita y actualización de textos de visita. Con el perfil se anuncian 39 herramientas de lectura y 48 si se consiente escritura.

## Circuito de factura

1. Aportar PDF/foto en ChatGPT. Extraer proveedor, referencias completas, importes, forma de pago y vencimientos.
2. Buscar todas las compras relevantes, incluidas las pagadas, y cruzar las referencias del proveedor. El número interno de ARK no es el del albarán. `ark_conciliar_factura_proveedor` recibe los ids candidatos encontrados; no hace una búsqueda exhaustiva por sí sola y señala ese alcance.
3. Revisar duplicados, faltantes, abonos, impuestos y totales. No crear una compra adicional por la factura si las entradas de sus albaranes ya existen.
4. Consultar pagos y vencimientos. `ark_anotar_factura_proveedor` conserva el albarán y añade la factura y sus condiciones a las observaciones del documento proveedor. No adjunta el PDF, no crea factura agrupada nativa ni liquida la deuda.
5. Registrar un pago realizado con evidencia o confirmación concreta de fecha/importe. Un recibo o pagaré previsto lleva vencimiento y permanece identificado como previsto. Esta versión no implementa la verificación posterior de un recibo/pagaré existente: hacerlo en ARK, sin crear otro pago.
6. La vista previa incluye centro y huella del estado leído. Para guardar, confirmar la operación, el centro exacto y la huella. Se comprueba el saldo antes de enviar; la API de ARK sigue siendo responsable de la atomicidad frente a cambios simultáneos.

El registro de un pago no ordena una transferencia bancaria. La fecha contable es la del registro; la fecha acreditada del pago se conserva en observaciones. Tras un resultado de red desconocido no repetir una escritura: consultar pagos y saldos.

## Historia clínica

`ark_ficha_visita` recupera la visita. `ark_actualizar_visita` permite anexar o sustituir anamnesis, diagnóstico, tratamiento y anotaciones de una visita existente. El valor predeterminado es anexar. Conserva los objetos de recetas, pruebas y tratamientos facturados. Verifica paciente, centro y huella; rechaza visitas cerradas/anuladas. Esta versión no crea nuevas visitas ni recetas.

## Activación

El servidor requiere `WORK_ENABLE_WRITES=true`, consentimiento OAuth `ark:write` y permisos de la cuenta de ARK. No ampliar los scopes de conexiones ya emitidas: volver a autorizar desde ChatGPT. El valor predeterminado continúa siendo solo lectura para instalaciones nuevas.

En el VPS existente, `scripts/enable-full-workflows-hostinger.sh` prepara una versión separada, construye solo el servicio `ark-work` y reutiliza el Compose, `.env` y volumen actuales. No modifica el proxy compartido ni otros servicios. Guarda un override persistente y uno de rollback con la imagen anterior y el indicador de escritura. Revisar el script antes de ejecutarlo. No confundir preparación del código con despliegue efectivo.

Las skills del paquete acompañan las herramientas; la skill personal `ark-conciliar-facturas` puede usarse con cualquiera de las conexiones ARK que exponga dichas herramientas.

## Origen y validación

Rutas y formas de objetos observadas en los archivos públicos del cliente oficial el 13-11-2026:

- `https://ark.gestionveterinariaark.es/ark/chunk-B_y9lyxr.js`: GET de compras/pagos, PUT de búsqueda y documentos de proveedor, POST de pagos e informe de vencimientos.
- `https://ark.gestionveterinariaark.es/ark/chunk-BEchUr-8.js`: modelos de pago, formas de pago, entradas de compra y visita.
- `https://ark.gestionveterinariaark.es/ark/chunk-Cby86syR.js`: construcción del pago en la interfaz.
- `https://ark.gestionveterinariaark.es/ark/chunk-BK80vwEQ.js` y `chunk-D5gSqQqL.js`: consulta y edición de visitas.

Las pruebas usan exclusivamente datos ficticios y un servidor ARK local simulado. Comprueban conciliación, permisos, cambio de centro/paciente, modificación concurrente, pagos parciales, pagos previstos y respuesta de red desconocida sin reintentos automáticos. No se han realizado escrituras reales para probar esta versión ni verificado su aceptación en una empresa real. La primera operación real debe revisarse con un documento auténtico autorizado.
