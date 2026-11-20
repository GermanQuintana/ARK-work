---
name: ark-compras
description: 'Facturación, cobros, deudores y compras a proveedores en ARK gestión veterinaria. Úsala cuando pregunten por facturas, cobros o pagos recibidos, quién debe dinero (deudores), lo que debemos a proveedores, pedidos y compras, o cuando quieran REGISTRAR una compra/pedido — incluido meter una compra a partir de la FOTO de una factura o albarán de proveedor. Ejemplos: "¿qué facturas hay pendientes?", "¿quién me debe?", "busca las compras de este mes", "mete esta factura del proveedor" (con foto), "haz un pedido a X".'
---

# Facturación, cobros y compras en ARK

Trabajas sobre **ARK** (servidor MCP `ark`). Las consultas son de **producción**. La **creación de pedidos y compras ESCRIBE en producción**: sigue siempre el protocolo de confirmación de más abajo.

## Vocabulario ARK
- **Factura**: documento de venta a un cliente. Campos: nº documento, cliente, fecha, `importeTotal`, `importePendiente`.
- **Cobro**: pago recibido de un cliente (efectivo, tarjeta...). Puede cubrir varias facturas/albaranes.
- **Deudor**: cliente con saldo pendiente (`importePendiente` > 0 en sus documentos, o `saldo` > 0 en su ficha).
- **Compra**: entrada de mercancía de un proveedor. Afecta al **stock** y a la **cuenta del proveedor**. Campos: nº documento, proveedor, `importeTotal`, `importePendiente`.
- **Pedido**: solicitud a un proveedor (previo a la compra). Se crea en borrador y luego se **emite**.
- **Documento de proveedor**: factura/albarán recibido del proveedor. ARK puede convertirlo en una compra.
- **Operaciones**: las líneas (artículos) de un pedido/compra.

## Consultas (solo lectura)
Los buscadores de transacciones comparten filtros: `fechaDesde?`, `fechaHasta?` (YYYY-MM-DD), `estado?`, `cliente?` (texto, facturas/cobros), `proveedor?` (texto, compras/pedidos), `numeroDocumento?`, `page`, `size`.
- Facturas → `ark_buscar_factura(...)`.
- Cobros → `ark_buscar_cobro(...)`.
- Compras a proveedor → `ark_buscar_compra(...)`; detalle con `ark_ficha_compra(idCompra)`.
- Pedidos → `ark_buscar_pedido(...)`; detalle con `ark_ficha_pedido(idPedido)`.
- Lo que debemos a un proveedor → `ark_saldo_proveedor(idProveedor)` o `ark_compras_pendientes_proveedor(idProveedor)`.
- Documentos de proveedor pendientes → `ark_documentos_proveedor_pendientes()`.

**Importante sobre fechas y volumen:**
- Estas búsquedas **exigen acotar por fecha**: sin rango el servidor escanea toda la tabla y tarda minutos o falla. Por eso, si no indicas fechas, se aplica un rango por defecto (**31 días** en facturas/cobros, **90 días** en compras/pedidos). Para otros periodos, pasa `fechaDesde`/`fechaHasta`.
- El resultado llega como `{total, page, size, mostrando, items}`. `total` es cuántos casan con el filtro; `items` es solo la página pedida. Si `total` supera a `size`, avisa e itera con `page` o acota el filtro (fechas, cliente, estado).

### Deudores (quién nos debe)
No hay un listado global de deudores en JSON. Resuélvelo así:
- Deuda de **un** cliente concreto → `ark_buscar_cliente` → `ark_saldo_cliente(idCliente)` (detalle de documentos pendientes).
- Facturas pendientes en general → `ark_buscar_factura(estado:"Pendiente", fechaDesde, fechaHasta)` y fíjate en `importePendiente` (recuerda que por defecto solo mira 31 días; amplía el rango si buscan deuda antigua).
Si el usuario pide "todos los deudores", explica que se obtiene revisando facturas pendientes o el saldo por cliente, y ofrece hacerlo por cliente o por rango de fechas.

## Registrar pedidos y compras (ESCRITURA — protocolo obligatorio)
Todas las herramientas de creación (`ark_crear_pedido`, `ark_emitir_pedido`, `ark_crear_compra`, `ark_crear_compra_desde_documento`, `ark_crear_articulos_desde_documento`) llevan un parámetro `confirmar`:
- **`confirmar` ausente/false → vista previa**: devuelven exactamente lo que enviarían, SIN escribir.
- **`confirmar: true` → ejecuta** la escritura en producción.

Protocolo que DEBES seguir siempre:
1. Prepara los datos y llama primero **sin `confirmar`** (vista previa).
2. Para pedidos y compras, muestra obligatoriamente **centro, tienda y terminal**
   de la vista previa, además de proveedor, artículos, cantidades, precios e importe.
3. Pide que el usuario confirme expresamente **el centro/tienda que figura en la vista previa**.
4. Espera un **"sí, créalo"** explícito. Solo entonces repite la llamada con
   `centroEsperado` y `confirmar: true`.
5. Nunca pongas `confirmar: true` por iniciativa propia ni en la primera llamada.

La herramienta compara `centroEsperado` con la tienda real del terminal justo
antes de escribir. Si no coincide, bloquea la operación. No deduzcas el centro
por el usuario, el proveedor ni una configuración anterior.

### Contexto necesario para escribir
Las creaciones necesitan `idTerminal` (y opcionalmente `idEmpleado`). En ARK Work se resuelven para la conexión autenticada; no uses valores de entorno compartidos entre clínicas:
- Terminal → `ark_terminales()`; empleado → `ark_empleado_por_clave` con la clave indicada por el usuario para el `idEmpleado`.
- Proveedor y artículos → resuelve sus `id` con `ark_buscar_proveedor` y `ark_buscar_articulo` antes de construir las líneas.

## Meter una compra desde una FOTO de factura/albarán
Cuando el usuario aporte una imagen de una factura o albarán de proveedor:
1. **Lee la foto**: proveedor, nº y fecha del documento y, por cada línea, descripción, presentación, **cantidad y unidad de compra**, **precio por esa unidad sin IVA (antes de descuento)** y **descuento(s)** y, si el artículo lleva trazabilidad, **lote y caducidad**.
2. **Identifica en ARK** el proveedor (`ark_buscar_proveedor`) y cada artículo (`ark_buscar_articulo` por descripción o EAN).
3. **Excluye las líneas "pendiente de servir"** (no entregadas): no entran en stock.
4. **Muestra al usuario** la tabla extraída con proveedor, cantidad y unidad de compra por línea, precio por esa unidad, descuentos, lotes e importes para que la revise. No inventes datos que no se lean con claridad; pregunta.
5. **Construye las líneas** para `ark_crear_compra` (ver abajo) y llama primero **sin `confirmar`** (vista previa): la herramienta calcula el desglose de IVA y los totales. **Compara unidades, cantidades, precios, descuentos e importes por línea con el albarán**, además de la base, el IVA y el total. Un total correcto puede ocultar una conversión errónea de cantidad y precio. Si hay diferencias, explica su causa y resuélvelas antes de guardar.
6. Aplica el **protocolo de confirmación** antes de escribir.

### `ark_crear_compra` — cómo construir las líneas
**Orden de introducción:** introduce siempre las líneas de la compra en orden inverso al documento del proveedor: empieza por la última línea del albarán o factura y termina por la primera, para que en ARK se vean en el mismo orden que en el original. Si el documento tiene varias páginas, reúne primero sus líneas en el orden original de las páginas y después invierte la lista completa; no inviertas cada página por separado. Aplica este orden al array `compra.lineas` tanto en la vista previa como al guardar, conservando la posición relativa de las líneas incluidas si se excluye alguna.

La herramienta arma sola el documento real de ARK (tienda, proveedor, documentoProveedor, desglose de IVA escalonado y totales). Tú solo pasas datos sencillos:

```
compra: {
  idProveedor, numeroDocumento, fechaDocumento?, esFactura?, observaciones?,
  lineas: [{ idArticulo, cantidad, unidadCompra?, precio, descuento?|descuentos?, descripcion?, lotes? }]
}
```
- **`cantidad` y `unidadCompra`**: copia la cantidad anotada por el proveedor y su unidad de compra. El contenido del envase identifica la presentación. ARK convierte a unidades de venta internamente. Si el documento es ambiguo, aclara la unidad antes de preparar la compra.
- **`precio`**: precio **por esa unidad de compra, sin IVA y antes del descuento**. El IVA de compra lo saca la herramienta del artículo (¡ojo! el IVA de **compra** puede diferir del de **venta**).
- **`descuento`**: fracción (`0.14`) o porcentaje (`14`). Para descuentos compuestos usa **`descuentos: [0.33, 0.14]`** ("33%+14%"); se combinan.
- **`esFactura`**: `true` factura, `false` albarán (por defecto).
- **Ejemplo**. Una caja de 15 comprimidos a 24 € por caja con un 10 % de descuento se pasa como `cantidad: 1`, `unidadCompra: "caja"`, `precio: 24` y `descuento: 10`. La base es 21,60 € y, si toda la caja es de un mismo lote, la cantidad del lote es 1. No multipliques por 15 ni dividas el precio por 15.

### Lotes y caducidad (trazabilidad)
- Los artículos con `trazabilidad=true` **exigen lote**: pasa `lotes: [{ numeroLote, caducidad?, cantidad? }]`.
- **Una misma línea puede repartir la cantidad de compra en varios lotes** (p. ej. 3 cajas = 2 del lote A + 1 del lote B), y mezclar lotes nuevos y existentes. Cuando hay más de un lote, **indica la `cantidad` de cada uno**; la suma debe cuadrar con la `cantidad` de la línea (si no, la herramienta avisa). Con un solo lote, su cantidad es la de la línea.
- **Si el lote YA EXISTE** (mismo número para ese artículo), la herramienta lo **reutiliza automáticamente (autocompleta)** con su caducidad guardada; la `caducidad` es opcional en ese caso.
- **Si el lote es NUEVO**, hay que **crearlo**: la `caducidad` es **obligatoria** (`YYYY-MM-DD` o `MM/YYYY`).
- La vista previa marca cada lote como `existente` o `nuevo` para que lo revises.

### Artículos que no existen en el catálogo
Cuando una línea del albarán no tenga ficha en ARK, decide según **qué tipo de producto** es:
- **Fungible / material de consumo** (guantes, gasas, alargaderas, goteros, jeringas, equipos de infusión...): **no necesita ficha propia**. Mételo como **CONCEPTOS VARIOS** del IVA que marque el albarán (`0%`, `4%`, `10%`, `21%`), poniendo en `descripcion` el texto literal de la línea para que quede identificado. Búscalos con `ark_buscar_articulo("conceptos varios")` y usa el id del IVA que toque.
- **Medicamento, pienso o producto con stock, lote o PVP propios**: **pregunta al usuario** si quiere darlo de alta como artículo nuevo. No lo metas en conceptos varios por tu cuenta: perderías existencias, trazabilidad de lote y PVP.
- **Ante la duda, pregunta** en vez de elegir ficha por parecido: dos artículos de nombre similar (p. ej. la misma alargadera en 75 y 85 cm) son fichas distintas y equivocarse mete el stock en la que no es.
- Si el documento ya está en ARK, los artículos nuevos se dan de alta con `ark_crear_articulos_desde_documento`.

### Vía documento de proveedor (alternativa)
- Si el documento ya existe en ARK (`ark_documentos_proveedor_pendientes`), da de alta los artículos nuevos con `ark_crear_articulos_desde_documento` y comprueba en las líneas originales que cantidad, precio y descuentos corresponden a la unidad de compra del proveedor. Usa `ark_crear_compra_desde_documento` solo si coinciden. Esta herramienta delega la conversión a ARK y no permite editar las líneas. Si falta información o las líneas discrepan, usa el documento original para preparar la entrada con `ark_crear_compra` cuando esté completa y comprueba antes que el albarán no esté ya registrado.

## Presentación
- Responde en español y en lenguaje natural; no vuelques JSON salvo que lo pidan.
- Importes en euros. Fechas legibles. Distingue claramente **lo que nos deben** (clientes) de **lo que debemos** (proveedores).
- Al mostrar una vista previa de escritura, deja muy claro que **aún no se ha guardado nada**.

## Facturas que agrupan albaranes, vencimientos y pagos

Usar `ark-conciliar-facturas` cuando se aporte una factura para comprobar los albaranes ya registrados, forma de pago, vencimientos o pago. No crear otra compra por el total de una factura si sus albaranes ya han entrado en stock. Consultar pagos a proveedores con `ark_buscar_pago_proveedor` y distinguirlos de cobros de clientes. Un vencimiento o domiciliación no acreditan pago. Registrar únicamente un asiento justificado o un pago previsto claramente identificado y verificar el resultado.

Para altas de catálogo con EAN, unidades y tarifa, sigue `ark-crear-productos`. Para albaranes que la clínica emite a sus clientes, usa `ark-albaranes-venta`.
