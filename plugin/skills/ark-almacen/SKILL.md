---
name: ark-almacen
description: 'Consultar artículos, existencias y stock en el almacén de ARK gestión veterinaria. Úsala cuando el usuario pregunte por un artículo, su precio (PVP), su código de barras (EAN), o cuánto stock/existencias hay de un producto. Ejemplos: "¿cuánto stock tenemos de X?", "busca el artículo pienso", "precio del artículo con EAN 4014...", "¿queda alguna unidad?".'
---

# Consulta de almacén en ARK

Trabajas sobre el almacén de **ARK** a través de las herramientas MCP del servidor `ark`. Datos de **producción, solo lectura**.

## Vocabulario ARK
- **Artículo**: producto o servicio. Tiene `id`, `codigo`, `descripcion`, `codigoEAN` (código de barras), `pvp1` (precio de venta), `tasaGravamenVenta` (IVA/IGIC).
- **Existencias**: stock de un artículo **por tienda/centro**. Incluye `existencias` (stock actual), `reservas`, `pedidas`, `roturas`, `stockMin` (stock mínimo) y estadísticas de ventas/compras.

## Flujo típico
1. **Buscar artículo** → `ark_buscar_articulo(searchText)` por descripción o código. Devuelve `id`, `codigo`, `descripcion`, `pvp1`, IVA.
2. **Artículo por código de barras** → `ark_articulo_por_ean(codigoEAN)` cuando el usuario da un EAN escaneado.
3. **Existencias** → `ark_existencias_articulo(idArticulo)` con el `id` del paso anterior. Devuelve una fila por tienda.
4. **Existencias por lote** → `ark_existencias_lotes(idArticulo, idTienda)` para el desglose por lote y caducidad (artículos con control de lote).

## Cómo resolver peticiones habituales
- "¿Cuánto stock hay de [producto]?" → `ark_buscar_articulo` → tomar `id` → `ark_existencias_articulo`. Suma o desglosa por tienda según pregunten.
- "¿Qué es este código de barras?" → `ark_articulo_por_ean`.
- "Precio de [producto]" → `ark_buscar_articulo` y muestra `pvp1` (indica que es el PVP con impuestos incluidos si aplica).

## Presentación
- Responde en español y en lenguaje natural; no vuelques JSON salvo que lo pidan.
- Para existencias, destaca el stock disponible real y avisa si está por debajo del `stockMin`.
- Si la búsqueda devuelve varios artículos parecidos, lístalos con código y descripción para que el usuario elija.

## Paginación
`ark_buscar_articulo` acepta `page` (base 0) y `size` (máx. 100). Ofrece afinar la búsqueda si hay demasiados resultados.

## Tarifas y edición de artículos

Para revisar tarifas de PDF, imágenes o Excel, cambiar PVP/costes o editar nombres de artículos, usa la skill `precios-proveedores` del mismo plugin. El flujo es revisar la ficha y mostrar valores anteriores/propuestos, esperar confirmación explícita, aplicar solo lo aprobado y verificar. Si el MCP no permite editar, comprobar la vía de navegador disponible y el centro antes de declarar la operación imposible; no rellenar ni guardar antes de la confirmación. Conservar el nombre externo y actualizar el año del nombre interno al cambiar precios.
