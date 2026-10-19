---
name: ark-conocimiento
description: Conocimiento de fondo sobre el sistema de gestión veterinaria ARK y su servidor MCP (modelo de datos, convenciones y límites). Se aplica siempre que se trabaje con datos de ARK.
---

# Conocimiento base de ARK

**ARK** es un software de gestión para centros veterinarios (backend "Recevet"). Este plugin expone su API mediante el servidor MCP `ark`.

## Principios de uso
- **Mayoría de solo lectura**: casi todas las herramientas consultan y no modifican nada.
- **Escritura solo con confirmación**: las herramientas de crear/emitir pedidos y compras (`ark_crear_*`, `ark_emitir_pedido`) **sí escriben en producción**. Todas llevan un parámetro `confirmar`: sin él devuelven una vista previa sin escribir; solo ejecutan con `confirmar: true`. Muestra siempre la vista previa al usuario y espera un "sí" explícito antes de confirmar. Nunca pongas `confirmar: true` por tu cuenta.
- **Datos reales de producción**: no inventes ni completes datos que la API no devuelva. Si algo viene vacío o `null`, dilo.
- **Multi-centro (multi-tenant)**: la empresa se fija por el perfil OAuth autenticado de cada conexión. No compartas una configuración global de clínica entre usuarios. Algunas listas (p. ej. existencias) vienen desglosadas por tienda/centro.

## Modelo de datos (resumen)
- **Cliente** (propietario): `id`, nombre, `documentoIdentidad`, contacto, `saldo`, tarifa.
- **Mascota** (paciente): `id`, nombre, especie, raza, sexo, `nhc`, `chip`, `idPropietario`.
- **Visita**: anotación clínica; `fechaVisita`, `tipoVisita`, `diagnostico`, `veterinario`, `anamnesis`.
- **Recordatorio de mascota**: aviso con fecha de próxima aplicación.
- **Artículo**: producto/servicio; `codigo`, `codigoEAN`, `pvp1`, IVA.
- **Existencias**: stock por tienda (y por lote/caducidad).
- **Cita**: estados (pendiente, en espera, en consulta, atendida).
- **Factura / Cobro**: venta a cliente y su pago; `importeTotal`, `importePendiente`.
- **Proveedor**: suministrador; tiene `saldo` (lo que le debemos).
- **Compra / Pedido**: entrada de mercancía y solicitud a proveedor; sus líneas son las `operaciones`.
- **Documento de proveedor**: factura/albarán recibido, convertible en compra.

## Convenciones de las herramientas
- Los identificadores son numéricos (`id`). El flujo normal es **buscar → obtener id → consultar detalle**.
- Las búsquedas por texto (`...ContainingSearchText`) aceptan `page` (base 0) y `size` (1–100).
- Las fechas se manejan en formato ISO (`YYYY-MM-DD`).
- Los importes están en euros.

## Herramientas disponibles (servidor `ark`)
Clientes: `ark_buscar_cliente`, `ark_ficha_cliente`, `ark_saldo_cliente`.
Mascotas: `ark_mascotas_cliente`, `ark_buscar_mascota`, `ark_historial_mascota`, `ark_recordatorios_mascota`.
Almacén: `ark_buscar_articulo`, `ark_articulo_por_ean`, `ark_existencias_articulo`, `ark_existencias_lotes`.
Facturación/cobros: `ark_buscar_factura`, `ark_buscar_cobro`.
Proveedores: `ark_buscar_proveedor`, `ark_saldo_proveedor`, `ark_compras_pendientes_proveedor`.
Compras/pedidos (lectura): `ark_buscar_compra`, `ark_ficha_compra`, `ark_buscar_pedido`, `ark_ficha_pedido`, `ark_documentos_proveedor_pendientes`.
Citas: `ark_citas_pendientes_cliente`.
Empleados/empresa: `ark_veterinarios`, `ark_empleado_por_clave`, `ark_empresa`, `ark_terminales`.
Escritura (con `confirmar`): `ark_crear_pedido`, `ark_emitir_pedido`, `ark_crear_compra`, `ark_crear_compra_desde_documento`, `ark_crear_articulos_desde_documento`.

## Estilo de respuesta
Responde en español, con lenguaje natural y orientado al trabajo del centro veterinario (recepción, consulta, almacén). Resume; muestra JSON solo si lo piden.

## Revisión de precios

Las ediciones de artículos se rigen por `precios-proveedores`: revisión previa, propuesta, confirmación explícita posterior, aplicación y relectura. Esto también se exige usando el navegador. La petición inicial no reemplaza la confirmación de la propuesta. El navegador solo puede usarse si está disponible, dentro del centro correcto y respetando los permisos del usuario; no es una herramienta de edición añadida al MCP.
