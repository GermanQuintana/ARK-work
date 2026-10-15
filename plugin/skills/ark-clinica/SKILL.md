---
name: ark-clinica
description: 'Consultar clientes, mascotas e información clínica en ARK gestión veterinaria. Úsala cuando el usuario pregunte por un cliente o propietario, por una mascota/paciente, su historia clínica o historial de visitas, sus recordatorios pendientes (vacunas, desparasitaciones), su saldo pendiente o sus próximas citas, o cuando quiera LISTAR mascotas por raza o clientes por población/localidad. Ejemplos: "busca el cliente García", "¿qué mascotas tiene Cecilia?", "enséñame el historial de Elliot", "¿tiene recordatorios pendientes?", "¿cuánto debe este cliente?", "dame todas las mascotas de raza Pastor Alemán", "lista los clientes de Foz".'
---

# Consulta clínica y de clientes en ARK

Trabajas sobre el sistema de gestión veterinaria **ARK** a través de las herramientas MCP del servidor `ark`. Los datos son **de producción y de solo lectura**: nunca inventes datos; si una herramienta no devuelve resultados, dilo claramente.

## Vocabulario ARK
- **Cliente / propietario**: la persona (o empresa) titular. Se identifica por `id`.
- **Mascota / paciente**: el animal. Tiene `nhc` (número de historia clínica) y `chip`. Pertenece a un propietario (`idPropietario`).
- **Visita**: cada anotación clínica del historial (fecha, tipo de visita, diagnóstico, veterinario, anamnesis).
- **Recordatorio**: aviso pendiente de una mascota (vacuna, desparasitación...) con fecha de próxima aplicación.
- **Saldo**: importe pendiente de cobro del cliente.

## Flujo típico (encadenar por id)
Casi todo parte de encontrar el `id` del cliente o de la mascota y luego consultar el detalle.

1. **Buscar cliente** → `ark_buscar_cliente(searchText)`. Acepta nombre, DNI/CIF, teléfono o email. Devuelve lista con `id`, nombre, contacto y `saldo`.
2. **Buscar mascota directamente** → `ark_buscar_mascota(searchText)`. Acepta nombre, `nhc` o `chip`. Devuelve `id`, especie, raza, `idPropietario`, etc.
3. **Mascotas de un cliente** → `ark_mascotas_cliente(idCliente)` usando el `id` del paso 1.
4. **Ficha del cliente** → `ark_ficha_cliente(idCliente)` para datos completos (contacto, tarifa, alertas, preferencias de comunicación).
5. **Saldo** → `ark_saldo_cliente(idCliente)` para el detalle de documentos pendientes.
6. **Historial clínico** → `ark_historial_mascota(idMascota, fechaDesde?, fechaHasta?)`. Devuelve las visitas de más reciente a más antigua. Usa `fechaDesde`/`fechaHasta` (formato `YYYY-MM-DD`) solo si el usuario acota fechas.
7. **Recordatorios pendientes** → `ark_recordatorios_mascota(idMascota)`.
   Para todos los animales de un propietario usa directamente
   `ark_recordatorios_cliente(idCliente?|nombreCliente?)`: evita recorrer la base
   de clientes y consulta las mascotas en paralelo.
8. **Próximas citas** → `ark_citas_pendientes_cliente(idCliente)`.

## Listar por raza o por población (filtros exactos)
El buscador general (`ark_buscar_cliente` / `ark_buscar_mascota`) es de **texto libre difuso**: al buscar "Foz" también saca "Alfoz", y al buscar "pastor" también saca perros *llamados* Pastor. Para listados limpios usa las herramientas de filtro exacto:
- **Mascotas por raza** → `ark_listar_mascotas_por_raza(raza, exacto?)`. Por defecto `exacto=false` (contiene): "Pastor" agrupa "Pastor Alemán", "Cruce de Pastor Alemán", etc. Usa `exacto=true` para la raza idéntica.
- **Clientes por población** → `ark_listar_clientes_por_poblacion(poblacion, exacto?)`. Por defecto `exacto=true` (localidad idéntica), para no colar parciales como "Alfoz" al pedir "Foz".
- Ambas devuelven `{ total, page, size, mostrando, items }`. Ojo: dependen de que el término aparezca en el registro; nombres de raza con doble espacio o tildes distintas ("Pastor  Alemán") pueden escaparse — si el total parece bajo, prueba un término más corto o `exacto=false`.

## Cómo resolver peticiones habituales
- "Busca a [nombre] y su historial" → `ark_buscar_cliente` → tomar `id` → `ark_mascotas_cliente` → por cada mascota (o la indicada) `ark_historial_mascota`.
- "¿Qué le toca a [mascota]?" → `ark_buscar_mascota` → `ark_recordatorios_mascota`.
- "¿Qué avisos tiene [cliente]?" → `ark_recordatorios_cliente(nombreCliente)`;
  si el nombre no es único, busca primero y repite con `idCliente`.
- "¿Cuánto debe [cliente]?" → `ark_buscar_cliente` → `ark_saldo_cliente`.
- "Dame las mascotas de raza [X]" → `ark_listar_mascotas_por_raza`.
- "Lista los clientes de [localidad]" → `ark_listar_clientes_por_poblacion`.
- Si el nombre es ambiguo y hay varios resultados, muéstralos y pide al usuario que elija antes de profundizar.

## Asistente de recordatorios / seguimiento (email)
Antes de proponer un recordatorio a un propietario, **revisa el contexto de la mascota** — no mandes mensajes "a ciegas".

1. **Reúne el contexto** → `ark_contexto_recordatorio(idMascota)`. Devuelve ficha (incl. `baja`/fallecimiento), propietario (email, teléfono, consentimiento), recordatorios pendientes, últimas visitas (diagnóstico/anamnesis) y un bloque `senales` pre-evaluado.
2. **Decide por mascota** usando `senales` como ayuda (pero razona con el historial, no solo con el flag):
   - `fallecida` o `dadaDeBaja` → **no enviar**; avisa del motivo.
   - `sinConsentimiento` (`permitirComunicacionesComerciales=false`) → **no enviar** por email comercial; ofrécelo como excluido.
   - `sinEmail` → no se puede por email; sugiere el `telefono` para llamar/otro canal.
   - `visitaReciente` o enfermedad/empeoramiento en `ultimasVisitas` → **cambia el tono**: en vez del recordatorio seco, un *"¿cómo sigue [mascota] tras la última visita?"*.
   - Normal → redacta un recordatorio **personalizado** (vacuna / desparasitación int-ext / crónico / seguimiento) e incluye **datos de contacto del centro** (obténlos con `ark_empresa`).
3. **Plantillas** → `ark_plantillas_email()` lista las de tipo `RECORDATORIO_MASCOTA` (id + asunto) para el envío.
4. **Vista previa SIEMPRE**: muestra una tabla mascota → acción (enviar/omitir + motivo) → borrador. Excluye siempre a quien no da consentimiento.

### Recall masivo por email (una mascota o toda una tanda)
1. **Listar lo que vence** → `ark_buscar_recordatorios_comunicacion(fechaDesde?, fechaHasta?)`. Es la pantalla "Consulta y notificación de recordatorios": devuelve filas con `idRecordatorioMascota`, `emailPropietario`, consentimiento, preferencias y flags `notificado*`. **Son muchos** (todo el histórico pendiente): acota por fechas y usa page/size.
2. Para casos delicados, **revisa antes** con `ark_contexto_recordatorio(idMascota)` (fallecimiento/empeoramiento) y ajusta o excluye.
3. **Elige plantilla** con `ark_plantillas_email()`.
4. **Envía** → `ark_enviar_recordatorios_email(idEmailTemplate, recordatorios, confirmar)`. Pásale las filas elegidas del paso 1.
   - Por defecto (`confirmar=false`) devuelve **vista previa**: a quién se enviaría y a quién excluye (sin email / sin consentimiento / ya notificado). **No envía.**
   - Muestra esa vista previa al usuario, resume destinatarios + plantilla, y **solo con un "sí" explícito** repite con `confirmar=true`.
   - **Manda correos reales a clientes**: nunca confirmes sin autorización clara; la herramienta ya excluye a quien no procede, pero la decisión final es del usuario.

## Presentación de resultados
- Resume en lenguaje natural y en español; no vuelques el JSON crudo salvo que lo pidan.
- Para el historial, presenta cada visita como: fecha · tipo de visita · veterinario · diagnóstico (si hay) · resumen de la anamnesis.
- Muestra fechas de forma legible y avisa de recordatorios ya vencidos (fecha de próxima aplicación pasada).
- Los importes están en euros.

## Paginación
Las búsquedas aceptan `page` (base 0) y `size` (máx. 100, por defecto 20). Si hay muchos resultados, ofrece afinar la búsqueda o pedir la siguiente página.
