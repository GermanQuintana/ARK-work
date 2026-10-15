// Registry adapted from GermanQuintana/ark-vet 0.5.0; request-scoped credentials.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ArkClient, ArkError, type ArkConfig } from './arkClient.js';
import { construirCompra, type EntradaCompra } from './compra.js';

export function createArkServer(config: ArkConfig, allowWrites = false) {
const client = new ArkClient(config);
const writeCtx = { username: config.username, idTerminal: undefined as number | undefined, idEmpleado: undefined as number | undefined };
const server = new McpServer(
  { name: "ark-work", version: "0.1.0" },
  {
    instructions:
      "ARK contiene datos reales de producción. Las consultas son de solo lectura. " +
      "Las herramientas de escritura deben llamarse primero con confirmar=false, mostrar la " +
      "vista previa y esperar una confirmación explícita del usuario antes de repetir con " +
      "confirmar=true. Nunca inventes datos ni confirmes escrituras por iniciativa propia.",
  },
);

const WRITE_TOOLS = new Set([
  "ark_enviar_recordatorios_email",
  "ark_crear_pedido",
  "ark_emitir_pedido",
  "ark_crear_compra",
  "ark_crear_compra_desde_documento",
  "ark_crear_articulos_desde_documento",
]);

// Completa automáticamente las anotaciones MCP para que Codex diferencie las
// consultas de las acciones que modifican ARK o envían comunicaciones reales.
const originalRegisterTool = server.registerTool.bind(server);
server.registerTool = ((name: string, config: any, handler: any) => {
  const writes = WRITE_TOOLS.has(name);
  if (writes && !allowWrites) return undefined as any;
  return originalRegisterTool(
    name,
    {
      ...config,
      annotations: {
        ...config.annotations,
        readOnlyHint: !writes,
        destructiveHint: writes,
        idempotentHint: !writes,
        openWorldHint: true,
      },
    },
    handler,
  );
}) as typeof server.registerTool;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// Las búsquedas de transacciones (facturas, cobros, compras, pedidos) devuelven
// TODO el array que casa con el filtro (el servidor ignora page/size). Paginamos
// en el cliente para no volcar miles de registros y devolvemos el total.
function okPaginado(data: unknown, page: number, size: number): ToolResult {
  if (Array.isArray(data)) {
    const inicio = page * size;
    const items = data.slice(inicio, inicio + size);
    return ok({ total: data.length, page, size, mostrando: items.length, items });
  }
  return ok(data);
}

// Recupera TODOS los registros que casan un searchText, paginando en el cliente
// (los endpoints ...ContainingSearchText respetan page/size). Sirve para filtrar
// después con precisión por campos que ya vienen en el DTO (raza, población...).
// Cap de seguridad para no volcar toda la base si el término es muy genérico.
async function fetchAllMatches(
  path: string,
  searchText: string,
  pageSize = 500,
  maxPages = 20,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await client.get(path, { searchText, page, size: pageSize });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...(batch as Record<string, unknown>[]));
    if (batch.length < pageSize) break;
  }
  return all;
}

// Vista previa (dry-run) de una escritura: describe exactamente lo que se
// enviaría a ARK sin ejecutarlo. Es la salida por defecto cuando confirmar=false.
function preview(method: string, path: string, query: unknown, body: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          "VISTA PREVIA (no se ha escrito nada en ARK).\n" +
          "Para ejecutar, vuelve a llamar con confirmar=true.\n\n" +
          JSON.stringify({ method, path, query, body }, null, 2),
      },
    ],
  };
}

function fail(err: unknown): ToolResult {
  const msg =
    err instanceof ArkError
      ? `Error ARK (${err.status}): no se pudo completar la operación.`
      : `Error: ${(err as Error)?.message ?? String(err)}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

const pagination = {
  page: z.number().int().min(0).default(0).describe("Página (base 0)"),
  size: z.number().int().min(1).max(100).default(20).describe("Tamaño de página"),
};

// --- Clientes ---
server.registerTool(
  "ark_buscar_cliente",
  {
    title: "Buscar cliente",
    description:
      "Busca clientes activos por nombre, documento de identidad, teléfono o email. Devuelve una lista con id, nombre, contacto y saldo.",
    inputSchema: {
      searchText: z.string().describe("Texto a buscar (nombre, DNI, teléfono o email)"),
      ...pagination,
    },
  },
  async ({ searchText, page, size }) => {
    try {
      return ok(
        await client.get("/clientes/findAllClienteDTOActivoContainingSearchText", {
          searchText,
          page,
          size,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_ficha_cliente",
  {
    title: "Ficha de cliente",
    description:
      "Devuelve la ficha completa de un cliente por su id (datos de contacto, tarifa, saldo, alertas, etc.).",
    inputSchema: { idCliente: z.number().int().describe("Id del cliente") },
  },
  async ({ idCliente }) => {
    try {
      return ok(await client.get(`/clientes/${idCliente}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_saldo_cliente",
  {
    title: "Saldo del cliente",
    description:
      "Devuelve el detalle del saldo pendiente (documentos sin cobrar) de un cliente por su id.",
    inputSchema: { idCliente: z.number().int().describe("Id del cliente") },
  },
  async ({ idCliente }) => {
    try {
      return ok(await client.get("/clientes/findSaldoCliente", { idCliente }));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Mascotas ---
server.registerTool(
  "ark_mascotas_cliente",
  {
    title: "Mascotas de un cliente",
    description:
      "Lista las mascotas activas de un cliente (propietario). Devuelve id, nombre, especie, raza, sexo, nhc y chip.",
    inputSchema: { idCliente: z.number().int().describe("Id del cliente propietario") },
  },
  async ({ idCliente }) => {
    try {
      return ok(
        await client.get("/mascotas/findAllMascotaDTOActivaByPropietario", {
          idPropietario: idCliente,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_buscar_mascota",
  {
    title: "Buscar mascota",
    description:
      "Busca mascotas activas por nombre, número de historia clínica (nhc) o número de chip.",
    inputSchema: {
      searchText: z.string().describe("Nombre, nhc o chip de la mascota"),
      ...pagination,
    },
  },
  async ({ searchText, page, size }) => {
    try {
      return ok(
        await client.get("/mascotas/findAllMascotaDTOActivaContainingSearchText", {
          searchText,
          page,
          size,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_listar_mascotas_por_raza",
  {
    title: "Listar mascotas por raza",
    description:
      "Lista las mascotas activas de una raza (p. ej. 'Pastor Alemán', 'Mastín'). " +
      "Filtra de forma exacta por el campo raza y descarta las que solo casan por " +
      "nombre. Por defecto agrupa (contiene): 'pastor' trae también 'Cruce de Pastor " +
      "Alemán'. Usa exacto=true para la raza idéntica. Devuelve total y lista con id, " +
      "nombre, especie, raza, propietario, nhc y chip.",
    inputSchema: {
      raza: z.string().describe("Nombre o parte de la raza a filtrar (p. ej. 'Pastor')"),
      exacto: z
        .boolean()
        .default(false)
        .describe("true = raza idéntica; false = la raza contiene el texto (agrupa cruces)"),
      ...pagination,
    },
  },
  async ({ raza, exacto, page, size }) => {
    try {
      const q = raza.trim().toLowerCase();
      const matches = await fetchAllMatches(
        "/mascotas/findAllMascotaDTOActivaContainingSearchText",
        raza,
      );
      const filtradas = matches.filter((m) => {
        const r = String(m.nombreRaza ?? "").trim().toLowerCase();
        return exacto ? r === q : q !== "" && r.includes(q);
      });
      return okPaginado(filtradas, page, size);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_listar_clientes_por_poblacion",
  {
    title: "Listar clientes por población",
    description:
      "Lista los clientes activos de una población/localidad (por nombre de población). " +
      "Filtra de forma exacta por el campo población, descartando parciales (p. ej. " +
      "'Alfoz' al buscar 'Foz') y las que casan solo por dirección o nombre. Usa " +
      "exacto=false para buscar por contiene. Devuelve total y lista con id, nombre, " +
      "documento, contacto, población, provincia y saldo.",
    inputSchema: {
      poblacion: z.string().describe("Nombre de la población/localidad a filtrar (p. ej. 'Foz')"),
      exacto: z
        .boolean()
        .default(true)
        .describe("true = población idéntica; false = la población contiene el texto"),
      ...pagination,
    },
  },
  async ({ poblacion, exacto, page, size }) => {
    try {
      const q = poblacion.trim().toLowerCase();
      const matches = await fetchAllMatches(
        "/clientes/findAllClienteDTOActivoContainingSearchText",
        poblacion,
      );
      const filtrados = matches.filter((c) => {
        const p = String(c.poblacion ?? "").trim().toLowerCase();
        return exacto ? p === q : q !== "" && p.includes(q);
      });
      return okPaginado(filtrados, page, size);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_historial_mascota",
  {
    title: "Historial clínico de la mascota",
    description:
      "Devuelve el histórico de visitas clínicas de una mascota (fecha, tipo, diagnóstico, veterinario, anamnesis). Se puede filtrar por rango de fechas.",
    inputSchema: {
      idMascota: z.number().int().describe("Id de la mascota"),
      fechaDesde: z
        .string()
        .nullable()
        .default(null)
        .describe("Fecha inicial ISO (YYYY-MM-DD) o null"),
      fechaHasta: z
        .string()
        .nullable()
        .default(null)
        .describe("Fecha final ISO (YYYY-MM-DD) o null"),
      ...pagination,
    },
  },
  async ({ idMascota, fechaDesde, fechaHasta, page, size }) => {
    try {
      return ok(
        await client.putSearch(
          "/visitas/searchAllVisitaDTOByMascota",
          { fechaDesde, fechaHasta },
          { idMascota, page, size },
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_recordatorios_mascota",
  {
    title: "Recordatorios pendientes de la mascota",
    description:
      "Lista los recordatorios pendientes (vacunas, desparasitaciones, etc.) de una mascota y su fecha de próxima aplicación.",
    inputSchema: { idMascota: z.number().int().describe("Id de la mascota") },
  },
  async ({ idMascota }) => {
    try {
      return ok(
        await client.get(
          "/recordatoriosMascota/findAllRecordatorioMascotaPendienteByMascota",
          { idMascota },
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Recordatorios: asistente de seguimiento (email) ---

// Extrae un nombre legible de un campo que puede venir como string u objeto {nombre}.
function nombreDe(v: unknown): unknown {
  if (v && typeof v === "object" && "nombre" in (v as Record<string, unknown>)) {
    return (v as Record<string, unknown>).nombre;
  }
  return v;
}

// Normaliza a array respuestas que pueden venir como array plano o paginadas.
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.content)) return o.content;
    if (Array.isArray(o.items)) return o.items;
  }
  return [];
}

function normalizarTexto(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

server.registerTool(
  "ark_recordatorios_cliente",
  {
    title: "Recordatorios pendientes de un cliente",
    description:
      "Consulta en una sola operación los recordatorios pendientes de todas las mascotas activas " +
      "de un cliente. Admite el id del cliente o su nombre completo. Resuelve el cliente con una " +
      "única búsqueda y consulta las mascotas en paralelo; evita recorrer toda la base de clientes.",
    inputSchema: {
      idCliente: z.number().int().optional().describe("Id del cliente, si ya se conoce"),
      nombreCliente: z
        .string()
        .optional()
        .describe("Nombre completo exacto del cliente, si no se conoce su id"),
    },
  },
  async ({ idCliente, nombreCliente }) => {
    try {
      if (idCliente === undefined && !nombreCliente?.trim()) {
        return fail(new Error("Indica idCliente o nombreCliente."));
      }

      let cliente: Record<string, unknown> = { id: idCliente };
      if (idCliente === undefined) {
        const candidatos = asArray(
          await client.get("/clientes/findAllClienteDTOActivoContainingSearchText", {
            searchText: nombreCliente!.trim(),
            page: 0,
            size: 20,
          }),
        ) as Record<string, unknown>[];
        const objetivo = normalizarTexto(nombreCliente);
        const exactos = candidatos.filter((c) => normalizarTexto(c.nombreCompleto) === objetivo);
        if (exactos.length === 0) {
          return fail(
            new Error(
              `No se encontró un cliente activo con el nombre completo exacto "${nombreCliente}".`,
            ),
          );
        }
        if (exactos.length > 1) {
          return fail(
            new Error(
              `Hay ${exactos.length} clientes con ese nombre. Usa ark_buscar_cliente y repite con idCliente.`,
            ),
          );
        }
        cliente = exactos[0];
        idCliente = Number(cliente.id);
      }

      const mascotas = asArray(
        await client.get("/mascotas/findAllMascotaDTOActivaByPropietario", {
          idPropietario: idCliente,
        }),
      ) as Record<string, unknown>[];
      const recordatoriosPorMascota = await Promise.all(
        mascotas.map(async (mascota) => {
          const mascotaId = Number(mascota.id);
          if (!Number.isInteger(mascotaId)) {
            throw new Error("ARK devolvió una mascota sin id válido.");
          }
          const recordatorios = asArray(
            await client.get(
              "/recordatoriosMascota/findAllRecordatorioMascotaPendienteByMascota",
              { idMascota: mascotaId },
            ),
          );
          return {
            mascota: {
              id: mascotaId,
              nombre: mascota.nombre,
              especie: mascota.nombreEspecie,
              raza: mascota.nombreRaza,
              nhc: mascota.nhc,
              chip: mascota.chip,
            },
            recordatorios,
          };
        }),
      );
      return ok({
        cliente: { id: idCliente, nombre: cliente.nombreCompleto ?? nombreCliente ?? null },
        totalMascotas: mascotas.length,
        totalRecordatorios: recordatoriosPorMascota.reduce(
          (total, item) => total + item.recordatorios.length,
          0,
        ),
        mascotas: recordatoriosPorMascota,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_ficha_mascota",
  {
    title: "Ficha de mascota",
    description:
      "Devuelve la ficha completa de una mascota por su id: especie, raza, sexo, fechas, " +
      "alertas clínicas, observaciones, veterinario habitual, propietario y — importante — " +
      "fechaBaja/motivoBaja (una mascota con fechaBaja está dada de baja; si el motivo es " +
      "fallecimiento, NO se le deben enviar recordatorios).",
    inputSchema: { idMascota: z.number().int().describe("Id de la mascota") },
  },
  async ({ idMascota }) => {
    try {
      return ok(await client.get(`/mascotas/${idMascota}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_plantillas_email",
  {
    title: "Plantillas de email",
    description:
      "Lista las plantillas de email configuradas en el centro para un tipo de comunicación. " +
      "Por defecto 'RECORDATORIO_MASCOTA' (las usadas al enviar recordatorios). Devuelve id, " +
      "nombre y asunto; el id sirve para el envío de recordatorios por email.",
    inputSchema: {
      tipoComunicacion: z
        .string()
        .default("RECORDATORIO_MASCOTA")
        .describe("Tipo de comunicación (p. ej. RECORDATORIO_MASCOTA, CITA, FACTURA, VISITA)"),
    },
  },
  async ({ tipoComunicacion }) => {
    try {
      return ok(
        await client.get("/emailTemplates/findAllEmailTemplateDTOByTipoComunicacion", {
          tipoComunicacion,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_contexto_recordatorio",
  {
    title: "Contexto para recordatorio (asistente de seguimiento)",
    description:
      "Reúne en UNA llamada todo lo necesario para decidir si (y cómo) contactar al " +
      "propietario antes de enviar un recordatorio: ficha (incl. baja/fallecimiento), " +
      "consentimiento y email del propietario, recordatorios pendientes y las últimas visitas " +
      "(diagnóstico/anamnesis) para detectar enfermedad o empeoramiento reciente. Incluye " +
      "'senales' pre-evaluadas (fallecida, dadaDeBaja, sinConsentimiento, sinEmail, " +
      "visitaReciente) como AYUDA; la decisión y el texto los redacta el asistente. No envía nada.",
    inputSchema: {
      idMascota: z.number().int().describe("Id de la mascota"),
      nVisitas: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(3)
        .describe("Cuántas visitas recientes incluir para valorar el estado (por defecto 3)"),
      diasVisitaReciente: z
        .number()
        .int()
        .min(1)
        .default(30)
        .describe("Umbral en días para marcar 'visitaReciente' (por defecto 30)"),
    },
  },
  async ({ idMascota, nVisitas, diasVisitaReciente }) => {
    try {
      const m = (await client.get(`/mascotas/${idMascota}`)) as Record<string, unknown>;
      const prop = (m.propietario ?? {}) as Record<string, unknown>;
      const recordatorios = await client.get(
        "/recordatoriosMascota/findAllRecordatorioMascotaPendienteByMascota",
        { idMascota },
      );
      const visitas = asArray(
        await client.putSearch(
          "/visitas/searchAllVisitaDTOByMascota",
          { fechaDesde: null, fechaHasta: null },
          { idMascota, page: 0, size: nVisitas },
        ),
      );

      // Email y teléfono SOLO desde los datos de contacto del propietario. Nunca
      // recorrer el objeto entero: colgando de él está `centroAlta` con el email
      // del propio centro y podría enviarse al destinatario equivocado.
      const contacto = (prop.datosContacto ?? {}) as Record<string, unknown>;
      const email =
        typeof contacto.email === "string" && contacto.email.trim() ? contacto.email.trim() : null;
      const telefono = (contacto.movil as string) ?? (contacto.fijo as string) ?? null;
      const fechaUltimaVisita = (m.fechaUltimaVisita as string | null | undefined) ?? null;
      let visitaReciente = false;
      if (fechaUltimaVisita) {
        const dias = (Date.now() - new Date(fechaUltimaVisita).getTime()) / 86400000;
        visitaReciente = dias >= 0 && dias <= diasVisitaReciente;
      }
      const permite =
        prop.permitirComunicaciones !== false && prop.permitirComunicacionesComerciales !== false;
      const motivoBaja = nombreDe(m.motivoBaja) ?? null;

      const packet = {
        mascota: {
          id: m.id,
          nombre: m.nombre,
          especie: nombreDe(m.especie),
          raza: nombreDe(m.raza),
          sexo: nombreDe(m.sexo),
          fechaNacimiento: m.fechaNacimiento,
          edad: m.edad,
          fechaUltimaVisita,
          alertasClinicas: m.alertasClinicas,
          observaciones: m.observaciones,
          veterinarioHabitual: nombreDe(m.veterinarioHabitual),
        },
        baja: { fechaBaja: m.fechaBaja ?? null, motivoBaja, dadaDeBaja: !!m.fechaBaja },
        propietario: {
          id: prop.id,
          nombre: prop.nombreCompleto,
          email,
          telefono,
          permitirComunicaciones: prop.permitirComunicaciones,
          permitirComunicacionesComerciales: prop.permitirComunicacionesComerciales,
          prefiereEmail: prop.comunicacionPreferenteEmail,
        },
        recordatoriosPendientes: recordatorios,
        ultimasVisitas: visitas.map((v) => {
          const x = v as Record<string, unknown>;
          return {
            fechaVisita: x.fechaVisita,
            tipoVisita: nombreDe(x.tipoVisita),
            diagnostico: x.diagnostico,
            anamnesis: x.anamnesis,
            anotaciones: x.anotaciones,
            peso: x.peso,
            condicionCorporal: x.condicionCorporal,
          };
        }),
        senales: {
          fallecida: !!m.fechaBaja && /fallec|muert|exitus|difunt/i.test(String(motivoBaja ?? "")),
          dadaDeBaja: !!m.fechaBaja,
          sinConsentimiento: !permite,
          sinEmail: !email,
          visitaReciente,
        },
      };
      return ok(packet);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_buscar_recordatorios_comunicacion",
  {
    title: "Recordatorios pendientes de notificar (recall)",
    description:
      "Lista los recordatorios pendientes de notificar del centro (equivale a la pantalla " +
      "'Consulta y notificación de recordatorios' de ARK), con datos del propietario (email, " +
      "teléfono, consentimiento, preferencias) y los flags de ya-notificado. Es la base del " +
      "'recall': elige las filas que quieras y pásalas a ark_enviar_recordatorios_email. Filtra " +
      "por rango de fecha de próxima aplicación. Devuelve MUCHOS registros: usa page/size y acota " +
      "por fechas. Solo lectura.",
    inputSchema: {
      fechaDesde: z
        .string()
        .nullable()
        .default(null)
        .describe("Fecha próxima aplicación desde (YYYY-MM-DD) o null"),
      fechaHasta: z
        .string()
        .nullable()
        .default(null)
        .describe("Fecha próxima aplicación hasta (YYYY-MM-DD) o null"),
      ...pagination,
    },
  },
  async ({ fechaDesde, fechaHasta, page, size }) => {
    try {
      const data = await client.putSearch(
        "/recordatoriosMascota/searchRecordatorioMascotaReportComunicacion",
        { fechaDesde, fechaHasta },
      );
      const desde = fechaDesde?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
      const hasta = fechaHasta?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
      const rows = asArray(data) as Record<string, unknown>[];
      // Este endpoint de ARK puede ignorar el cuerpo de búsqueda y devolver todo
      // el histórico. Aplicamos siempre el rango también en el conector para que
      // "hoy" no termine mostrando miles de recordatorios de otras fechas.
      const dateFormatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Madrid",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const filtrados = rows.filter((row) => {
        if (!desde && !hasta) return true;
        const raw = row.fechaProximaAplicacion;
        if (typeof raw !== "string") return false;
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) return false;
        const parts = Object.fromEntries(
          dateFormatter
            .formatToParts(parsed)
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value]),
        );
        const fechaLocal = `${parts.year}-${parts.month}-${parts.day}`;
        return (!desde || fechaLocal >= desde) && (!hasta || fechaLocal <= hasta);
      });
      return okPaginado(filtrados, page, size);
    } catch (e) {
      return fail(e);
    }
  },
);

// Fila de recordatorio para notificar, tal como la devuelve
// ark_buscar_recordatorios_comunicacion. Se aceptan campos extra (passthrough)
// para poder reenviar el DTO íntegro a ARK.
const filaRecordatorioComunicacion = z
  .object({
    idRecordatorioMascota: z.number().int().describe("Id del recordatorio-mascota"),
    emailPropietario: z.string().nullable().optional(),
    permitirComunicacionesPropietario: z.boolean().nullable().optional(),
    notificadoEmail: z.boolean().nullable().optional(),
  })
  .passthrough();

server.registerTool(
  "ark_enviar_recordatorios_email",
  {
    title: "Enviar recordatorios por email (ESCRITURA, con confirmación)",
    description:
      "Envía por email una tanda de recordatorios a sus propietarios usando una plantilla de ARK. " +
      "Recibe las filas de ark_buscar_recordatorios_comunicacion y el id de plantilla " +
      "(ark_plantillas_email). SEGURIDAD: excluye automáticamente a quien no tiene email, no " +
      "permite comunicaciones o ya fue notificado por email. Por defecto NO envía: devuelve una " +
      "vista previa (a quién se enviaría y a quién se excluye y por qué). Solo con confirmar=true " +
      "realiza el envío real. Muestra SIEMPRE la vista previa y pide un 'sí' explícito antes de confirmar.",
    inputSchema: {
      idEmailTemplate: z
        .number()
        .int()
        .describe("Id de la plantilla de email (de ark_plantillas_email)"),
      recordatorios: z
        .array(filaRecordatorioComunicacion)
        .describe("Filas de recordatorio a notificar (de ark_buscar_recordatorios_comunicacion)"),
      confirmar: z
        .boolean()
        .default(false)
        .describe("false = vista previa (no envía nada); true = envía de verdad"),
    },
  },
  async ({ idEmailTemplate, recordatorios, confirmar }) => {
    try {
      const enviables: Record<string, unknown>[] = [];
      const excluidos: { idRecordatorioMascota: unknown; motivo: string }[] = [];
      for (const r of recordatorios) {
        const row = r as Record<string, unknown>;
        const email = row.emailPropietario;
        if (typeof email !== "string" || !email.trim()) {
          excluidos.push({ idRecordatorioMascota: row.idRecordatorioMascota, motivo: "sin email" });
        } else if (row.permitirComunicacionesPropietario === false) {
          excluidos.push({
            idRecordatorioMascota: row.idRecordatorioMascota,
            motivo: "no permite comunicaciones",
          });
        } else if (row.notificadoEmail === true) {
          excluidos.push({
            idRecordatorioMascota: row.idRecordatorioMascota,
            motivo: "ya notificado por email",
          });
        } else {
          enviables.push(row);
        }
      }

      if (!confirmar) {
        return ok({
          vistaPrevia: true,
          nota: "No se ha enviado nada. Para enviar de verdad, repite con confirmar=true.",
          idEmailTemplate,
          totalRecibidos: recordatorios.length,
          seEnviarianA: enviables.length,
          destinatarios: enviables.map((r) => ({
            idRecordatorioMascota: r.idRecordatorioMascota,
            mascota: r.nombreMascota,
            propietario: r.nombrePropietario,
            email: r.emailPropietario,
            recordatorio: r.nombreRecordatorio,
          })),
          excluidos,
        });
      }

      if (enviables.length === 0) {
        return ok({
          enviado: false,
          motivo: "No hay destinatarios válidos (todos excluidos).",
          excluidos,
        });
      }
      const res = await client.putSearch(
        "/emailOrders/sendRecordatoriosMascotaEmail",
        enviables,
        { idEmailTemplate },
      );
      return ok({
        enviado: true,
        idEmailTemplate,
        enviados: enviables.length,
        excluidos,
        respuestaArk: res,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Artículos / Almacén ---
server.registerTool(
  "ark_buscar_articulo",
  {
    title: "Buscar artículo",
    description:
      "Busca artículos activos (no especiales) por descripción o código. Devuelve id, código, descripción, PVP e IVA.",
    inputSchema: {
      searchText: z.string().describe("Texto a buscar (descripción o código)"),
      ...pagination,
    },
  },
  async ({ searchText, page, size }) => {
    try {
      return ok(
        await client.get(
          "/articulos/findAllArticuloDTONoEspecialActivoContainingSearchText",
          { searchText, page, size },
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_articulo_por_ean",
  {
    title: "Artículo por código de barras (EAN)",
    description: "Devuelve el artículo que corresponde a un código de barras EAN.",
    inputSchema: { codigoEAN: z.string().describe("Código de barras EAN") },
  },
  async ({ codigoEAN }) => {
    try {
      return ok(await client.get("/articulos/findArticuloByCodigoEAN", { codigoEAN }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_existencias_articulo",
  {
    title: "Existencias de un artículo",
    description:
      "Devuelve las existencias (stock, reservas, pedidas, roturas, stock mínimo) de un artículo por tienda.",
    inputSchema: { idArticulo: z.number().int().describe("Id del artículo") },
  },
  async ({ idArticulo }) => {
    try {
      return ok(
        await client.get("/existenciasArticulos/findExistenciasArticulo", { idArticulo }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Proveedores ---
server.registerTool(
  "ark_buscar_proveedor",
  {
    title: "Buscar proveedor",
    description:
      "Busca proveedores activos por nombre, documento de identidad, teléfono o email.",
    inputSchema: {
      searchText: z.string().describe("Texto a buscar"),
      ...pagination,
    },
  },
  async ({ searchText, page, size }) => {
    try {
      return ok(
        await client.get("/proveedores/findAllProveedorDTOActivoContainingSearchText", {
          searchText,
          page,
          size,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Citas ---
server.registerTool(
  "ark_citas_pendientes_cliente",
  {
    title: "Citas futuras de un cliente",
    description: "Lista las citas pendientes (futuras) de un cliente por su id.",
    inputSchema: { idCliente: z.number().int().describe("Id del cliente") },
  },
  async ({ idCliente }) => {
    try {
      return ok(await client.get("/citas/findAllCitaPendienteFuturoByCliente", { idCliente }));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Empleados / Empresa ---
server.registerTool(
  "ark_veterinarios",
  {
    title: "Veterinarios activos",
    description: "Lista los veterinarios activos del centro (id, nombre, nº de colegiado).",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await client.get("/empleados/findAllVeterinarioDTOActivo"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_empleado_por_clave",
  {
    title: "Empleado por clave",
    description: "Devuelve el empleado activo que corresponde a una clave (código de empleado).",
    inputSchema: { clave: z.string().describe("Clave / código del empleado (p. ej. '08')") },
  },
  async ({ clave }) => {
    try {
      return ok(await client.get("/empleados/findEmpleadoActivoByClave", { clave }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_empresa",
  {
    title: "Datos de la empresa principal",
    description: "Devuelve los datos de la empresa/centro principal configurado en ARK.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await client.get("/empresas/findEmpresaPrincipal"));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Existencias / Stock ---
server.registerTool(
  "ark_existencias_lotes",
  {
    title: "Existencias por lotes de un artículo",
    description:
      "Devuelve las existencias desglosadas por lote (número de lote, caducidad, unidades) de un artículo en una tienda concreta. Útil para artículos con control de lote/caducidad.",
    inputSchema: {
      idArticulo: z.number().int().describe("Id del artículo"),
      idTienda: z.number().int().describe("Id de la tienda"),
    },
  },
  async ({ idArticulo, idTienda }) => {
    try {
      return ok(
        await client.get("/existenciasArticulos/findExistenciasLotesArticuloByTienda", {
          idArticulo,
          idTienda,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Facturación / Cobros / Deudores / Compras / Pedidos ---
// El backend usa un único filtro de transacción (facturas, cobros, compras y
// pedidos comparten forma). El cuerpo va PLANO (no envuelto) e incluye page/size.
// IMPORTANTE: acotar por fecha (fechaDocumentoDesde/Hasta) es obligatorio en
// tablas grandes (facturas, cobros); sin rango el servidor escanea todo y tarda
// más de dos minutos o devuelve 500. Por eso facturas y cobros aplican un rango
// por defecto si no se indica.
const filtroBusqueda = {
  fechaDesde: z.string().optional().describe("Fecha inicial (YYYY-MM-DD). Acota la búsqueda."),
  fechaHasta: z.string().optional().describe("Fecha final (YYYY-MM-DD)."),
  estado: z
    .string()
    .optional()
    .describe("Estado (p. ej. 'Pendiente', 'Cobrada', 'Pagada', 'Recibida')."),
  cliente: z.string().optional().describe("Texto del nombre del cliente (facturas/cobros)."),
  proveedor: z.string().optional().describe("Texto del nombre del proveedor (compras/pedidos)."),
  numeroDocumento: z.string().optional().describe("Nº de documento a buscar."),
  ...pagination,
};

type FiltroBusqueda = {
  fechaDesde?: string;
  fechaHasta?: string;
  estado?: string;
  cliente?: string;
  proveedor?: string;
  numeroDocumento?: string;
  page: number;
  size: number;
};

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoDesde(d?: string): string | null {
  if (!d) return null;
  return d.includes("T") ? d : `${d}T00:00:00.000Z`;
}

function isoHasta(d?: string): string | null {
  if (!d) return null;
  return d.includes("T") ? d : `${d}T23:59:59.999Z`;
}

// Construye el cuerpo plano del filtro de transacción que espera el backend.
// defaultDias: si se indica y el usuario no pasó fechas, aplica un rango de los
// últimos N días para evitar el escaneo completo (facturas/cobros).
function cuerpoBusqueda(f: FiltroBusqueda, opts: { defaultDias?: number } = {}) {
  let desde = f.fechaDesde;
  let hasta = f.fechaHasta;
  if (opts.defaultDias && !desde && !hasta) {
    const now = new Date();
    hasta = ymd(now);
    const d = new Date(now);
    d.setDate(d.getDate() - opts.defaultDias);
    desde = ymd(d);
  }
  return {
    nombreSerieTransacccion: null,
    numeroDocumento: f.numeroDocumento ?? null,
    estadoTransaccion: f.estado ?? null,
    nombreTienda: null,
    importeTotalDesde: null,
    importeTotalHasta: null,
    codigoArticulo: 0,
    fechaDocumentoDesde: isoDesde(desde),
    fechaDocumentoHasta: isoHasta(hasta),
    allCliente: !f.cliente,
    soloContado: false,
    cliente: f.cliente ?? null,
    proveedor: f.proveedor ?? null,
    observaciones: null,
    page: f.page,
    size: f.size,
  };
}

server.registerTool(
  "ark_buscar_factura",
  {
    title: "Buscar facturas",
    description:
      "Busca facturas de venta. Devuelve nº de documento, cliente, fecha, importe total e importe pendiente. Para localizar deudores, filtra por estado pendiente y revisa 'importePendiente'. Si no indicas fechas, usa los últimos 31 días (acótalo con fechaDesde/fechaHasta para otros periodos).",
    inputSchema: filtroBusqueda,
  },
  async (f) => {
    try {
      return okPaginado(
        await client.putSearch("/facturas/searchFacturaDTO", cuerpoBusqueda(f, { defaultDias: 31 })),
        f.page,
        f.size,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_buscar_cobro",
  {
    title: "Buscar cobros",
    description:
      "Busca cobros (pagos recibidos de clientes). Devuelve fecha, importe, forma de pago y documento asociado. Si no indicas fechas, usa los últimos 31 días.",
    inputSchema: filtroBusqueda,
  },
  async (f) => {
    try {
      return okPaginado(
        await client.putSearch("/cobros/searchCobroDTO", cuerpoBusqueda(f, { defaultDias: 31 })),
        f.page,
        f.size,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Compras / Pedidos (proveedores) ---
server.registerTool(
  "ark_buscar_compra",
  {
    title: "Buscar compras a proveedor",
    description:
      "Busca compras a proveedores. Devuelve nº de documento, proveedor, estado, fecha, importe total e importe pendiente (lo que le debemos al proveedor). Si no indicas fechas, usa los últimos 90 días. Para el pendiente de un proveedor concreto sin límite de fecha, usa ark_compras_pendientes_proveedor.",
    inputSchema: filtroBusqueda,
  },
  async (f) => {
    try {
      return okPaginado(
        await client.putSearch("/compras/searchCompraDTO", cuerpoBusqueda(f, { defaultDias: 90 })),
        f.page,
        f.size,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_ficha_compra",
  {
    title: "Ficha de una compra",
    description:
      "Devuelve el detalle completo de una compra por su id, incluyendo las líneas (artículos, cantidades y precios de compra).",
    inputSchema: { idCompra: z.number().int().describe("Id de la compra") },
  },
  async ({ idCompra }) => {
    try {
      return ok(await client.get(`/compras/${idCompra}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_compras_pendientes_proveedor",
  {
    title: "Compras pendientes de un proveedor",
    description:
      "Lista las compras pendientes de pago de un proveedor por su id (lo que le debemos).",
    inputSchema: { idProveedor: z.number().int().describe("Id del proveedor") },
  },
  async ({ idProveedor }) => {
    try {
      return ok(
        await client.get("/compras/findAllCompraPendienteByProveedor", { proveedorId: idProveedor }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_saldo_proveedor",
  {
    title: "Saldo de un proveedor",
    description: "Devuelve el saldo pendiente con un proveedor (lo que le debemos) por su id.",
    inputSchema: { idProveedor: z.number().int().describe("Id del proveedor") },
  },
  async ({ idProveedor }) => {
    try {
      return ok(await client.get("/proveedores/findSaldoProveedor", { idProveedor }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_buscar_pedido",
  {
    title: "Buscar pedidos a proveedor",
    description:
      "Busca pedidos a proveedores. Devuelve nº de documento, proveedor, estado y fecha. Si no indicas fechas, usa los últimos 90 días.",
    inputSchema: filtroBusqueda,
  },
  async (f) => {
    try {
      return okPaginado(
        await client.putSearch("/pedidos/searchPedidoDTO", cuerpoBusqueda(f, { defaultDias: 90 })),
        f.page,
        f.size,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_ficha_pedido",
  {
    title: "Ficha de un pedido",
    description:
      "Devuelve el detalle completo de un pedido a proveedor por su id, incluyendo sus líneas.",
    inputSchema: { idPedido: z.number().int().describe("Id del pedido") },
  },
  async ({ idPedido }) => {
    try {
      return ok(await client.get(`/pedidos/${idPedido}`));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Documentos de proveedor (facturas/albaranes recibidos) ---
server.registerTool(
  "ark_documentos_proveedor_pendientes",
  {
    title: "Documentos de proveedor pendientes",
    description:
      "Lista los documentos de proveedor (facturas/albaranes recibidos) que aún no se han convertido en compra ('no recibidos'). Punto de partida para regularizar entradas de mercancía.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await client.get("/documentosProveedor/findAllDocumentoProveedorNoRecibido"));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Terminales (necesario para crear pedidos/compras) ---
server.registerTool(
  "ark_terminales",
  {
    title: "Terminales activos",
    description:
      "Lista los terminales (cajas/puestos) activos de la tienda. El id de terminal es necesario para crear pedidos y compras.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await client.get("/terminales/findByTiendaActiva"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ===================== ESCRITURA (con confirmación) =====================
// Estas herramientas MODIFICAN datos de producción. Por defecto (confirmar=false)
// devuelven una vista previa de lo que enviarían, sin escribir. Solo ejecutan si
// confirmar=true. El esquema del cuerpo es el mejor conocido por ingeniería inversa
// de la API; la primera ejecución real debe hacerse supervisada.

const lineaTransaccion = z
  .object({
    idArticulo: z.number().int().describe("Id del artículo"),
    cantidad: z.number().describe("Unidades"),
    precioCompra: z.number().optional().describe("Precio de compra unitario (sin IVA)"),
    descripcion: z.string().optional().describe("Descripción de la línea"),
  })
  .passthrough();

const cuerpoTransaccion = z
  .object({
    idProveedor: z.number().int().describe("Id del proveedor"),
    observaciones: z.string().optional(),
    numDocumentoProveedor: z
      .string()
      .optional()
      .describe("Nº de la factura/albarán del proveedor"),
    fechaDocumentoProveedor: z.string().optional().describe("Fecha del documento (ISO)"),
    operaciones: z.array(lineaTransaccion).describe("Líneas (artículos) de la transacción"),
  })
  .passthrough();

const ctxEscritura = {
  idTerminal: z
    .number()
    .int()
    .optional()
    .describe("Id del terminal (si no, usa ARK_TERMINAL_ID). Descúbrelo con ark_terminales."),
  idEmpleado: z
    .number()
    .int()
    .optional()
    .describe("Id del empleado (si no, usa ARK_EMPLEADO_ID). Descúbrelo con ark_empleado_por_clave."),
  centroEsperado: z
    .string()
    .optional()
    .describe(
      "Centro que el usuario ha confirmado (nombre real de la tienda). " +
        "Es obligatorio para ejecutar; debe coincidir con la tienda del terminal.",
    ),
  confirmar: z
    .boolean()
    .default(false)
    .describe("false = vista previa sin escribir; true = ejecuta la escritura en producción"),
};

function resolverParams(idTerminal?: number, idEmpleado?: number) {
  const terminal = idTerminal ?? writeCtx.idTerminal;
  const empleado = idEmpleado ?? writeCtx.idEmpleado;
  const query: Record<string, string | number | undefined> = {
    username: writeCtx.username,
  };
  if (terminal !== undefined) query.idTerminal = terminal;
  if (empleado !== undefined) query.idEmpleado = empleado;
  return { query, terminal };
}

type TerminalArk = {
  id: number;
  codigo?: string | null;
  tienda?: {
    id?: number;
    nombre?: string | null;
    datosContacto?: { poblacion?: string | null } | null;
  } | null;
};

type ContextoCentro = {
  terminal: { id: number; codigo: string | null };
  tienda: { id: number | null; nombre: string | null; poblacion: string | null };
};

async function contextoCentroDeTerminal(idTerminal: number): Promise<ContextoCentro> {
  const terminales = (await client.get("/terminales/findByTiendaActiva")) as TerminalArk[];
  const terminal = Array.isArray(terminales)
    ? terminales.find((item) => item.id === idTerminal)
    : undefined;
  if (!terminal) {
    throw new Error(
      `El terminal ${idTerminal} no está activo o no pertenece a una tienda disponible. ` +
        "Consulta ark_terminales y elige el centro correcto.",
    );
  }
  return {
    terminal: { id: terminal.id, codigo: terminal.codigo ?? null },
    tienda: {
      id: terminal.tienda?.id ?? null,
      nombre: terminal.tienda?.nombre ?? null,
      poblacion: terminal.tienda?.datosContacto?.poblacion ?? null,
    },
  };
}

function validarCentroConfirmado(
  contexto: ContextoCentro,
  centroEsperado: string | undefined,
  confirmar: boolean,
): void {
  if (!confirmar) return;
  if (!centroEsperado?.trim()) {
    throw new Error(
      `Falta centroEsperado. El terminal ${contexto.terminal.id} corresponde a ` +
        `"${contexto.tienda.nombre ?? contexto.tienda.poblacion ?? "centro desconocido"}". ` +
        "Muestra la vista previa y pide al usuario que confirme el centro mostrado en la vista previa.",
    );
  }
  const esperado = normalizarTexto(centroEsperado);
  const nombresValidos = [contexto.tienda.nombre, contexto.tienda.poblacion]
    .map(normalizarTexto)
    .filter(Boolean);
  const coincide = nombresValidos.some(
    (nombre) => nombre === esperado || nombre.endsWith(` ${esperado}`),
  );
  if (!coincide) {
    throw new Error(
      `CENTRO NO COINCIDE: se confirmó "${centroEsperado}", pero el terminal ` +
        `${contexto.terminal.id} (${contexto.terminal.codigo ?? "sin código"}) pertenece a ` +
        `"${contexto.tienda.nombre ?? contexto.tienda.poblacion ?? "centro desconocido"}". ` +
        "No se ha escrito nada en ARK.",
    );
  }
}

function previewConCentro(
  method: string,
  path: string,
  query: unknown,
  body: unknown,
  contextoCentro: ContextoCentro,
): ToolResult {
  return ok({
    vistaPrevia: true,
    nota:
      "No se ha escrito nada en ARK. Para ejecutar, confirma expresamente el centro mostrado " +
      "y repite con centroEsperado y confirmar=true.",
    contextoCentro,
    method,
    path,
    query,
    body,
  });
}

server.registerTool(
  "ark_crear_pedido",
  {
    title: "Crear pedido a proveedor",
    description:
      "Crea un pedido a proveedor en ARK (ESCRIBE en producción). La vista previa muestra tienda y terminal. Para ejecutar exige centroEsperado (nombre de la tienda) coincidente y confirmar=true. El pedido queda en borrador hasta emitirlo con ark_emitir_pedido.",
    inputSchema: { pedido: cuerpoTransaccion, ...ctxEscritura },
  },
  async ({ pedido, idTerminal, idEmpleado, centroEsperado, confirmar }) => {
    try {
      const { query, terminal } = resolverParams(idTerminal, idEmpleado);
      if (terminal === undefined)
        return fail(new Error("Falta idTerminal (pásalo o define ARK_TERMINAL_ID / usa ark_terminales)."));
      const contextoCentro = await contextoCentroDeTerminal(terminal);
      validarCentroConfirmado(contextoCentro, centroEsperado, confirmar);
      if (!confirmar) return previewConCentro("POST", "/pedidos", query, pedido, contextoCentro);
      return ok(await client.post("/pedidos", pedido, query));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_emitir_pedido",
  {
    title: "Emitir un pedido",
    description:
      "Emite (envía) un pedido a proveedor ya creado (ESCRIBE en producción). La vista previa muestra tienda y terminal; para ejecutar exige centroEsperado coincidente y confirmar=true. Se le pasa el objeto del pedido obtenido de ark_ficha_pedido.",
    inputSchema: {
      pedido: z.record(z.any()).describe("Objeto del pedido a emitir (de ark_ficha_pedido)"),
      ...ctxEscritura,
    },
  },
  async ({ pedido, idTerminal, idEmpleado, centroEsperado, confirmar }) => {
    try {
      const { query, terminal } = resolverParams(idTerminal, idEmpleado);
      if (terminal === undefined)
        return fail(new Error("Falta idTerminal (pásalo o define ARK_TERMINAL_ID)."));
      const contextoCentro = await contextoCentroDeTerminal(terminal);
      validarCentroConfirmado(contextoCentro, centroEsperado, confirmar);
      if (!confirmar)
        return previewConCentro(
          "PUT",
          "/pedidos/issuePedido",
          query,
          pedido,
          contextoCentro,
        );
      return ok(await client.put("/pedidos/issuePedido", pedido, query));
    } catch (e) {
      return fail(e);
    }
  },
);

const loteCompra = z.object({
  numeroLote: z.string().describe("Número de lote impreso en el albarán"),
  caducidad: z
    .string()
    .optional()
    .describe("Caducidad: 'YYYY-MM-DD' o 'MM/YYYY' (fin de mes). Opcional si el lote YA EXISTE (se autocompleta); OBLIGATORIA si es un lote nuevo"),
  cantidad: z
    .number()
    .optional()
    .describe("Unidades de este lote. Si la línea tiene un solo lote, por defecto la cantidad de la línea"),
});

const lineaCompra = z.object({
  idArticulo: z.number().int().describe("Id del artículo en ARK (usa ark_buscar_articulo; para fungibles sin ficha usa CONCEPTOS VARIOS al 4/10/21%)"),
  cantidad: z.number().describe("Unidades compradas (envase clínico: si el artículo se vende por unidad pero se compra en caja de N, indica las unidades que entran en stock)"),
  precio: z.number().describe("Precio de compra unitario SIN IVA, antes de descuento (columna 'Precio' del albarán)"),
  descuento: z
    .number()
    .optional()
    .describe("Descuento de la línea: fracción (0.14) o porcentaje (14). Por defecto 0"),
  descuentos: z
    .array(z.number())
    .optional()
    .describe("Descuentos compuestos, p. ej. [0.33, 0.14] para '33%+14%'; se combinan"),
  descripcion: z.string().optional().describe("Descripción de la línea (por defecto, la del artículo)"),
  lotes: z
    .array(loteCompra)
    .optional()
    .describe("Lotes (obligatorio en artículos con trazabilidad). Reparte las unidades por lote"),
});

const cuerpoCompra = z.object({
  idProveedor: z.number().int().describe("Id del proveedor (usa ark_buscar_proveedor)"),
  numeroDocumento: z.string().describe("Nº del albarán o factura del proveedor"),
  fechaDocumento: z.string().optional().describe("Fecha del documento (YYYY-MM-DD). Por defecto, hoy"),
  esFactura: z.boolean().optional().describe("true = factura; false = albarán (por defecto)"),
  observaciones: z.string().optional(),
  lineas: z.array(lineaCompra).describe("Líneas del albarán/factura"),
});

server.registerTool(
  "ark_crear_compra",
  {
    title: "Crear compra a proveedor",
    description:
      "Crea una compra (entrada de mercancía) a proveedor en ARK (ESCRIBE en producción: afecta stock y cuenta del proveedor). Construye el documento real, calcula IVA y totales y gestiona lotes. La vista previa muestra tienda y terminal; para ejecutar exige centroEsperado coincidente y confirmar=true. Excluye las líneas 'pendiente de servir'.",
    inputSchema: { compra: cuerpoCompra, ...ctxEscritura },
  },
  async ({ compra, idTerminal, idEmpleado, centroEsperado, confirmar }) => {
    try {
      const { query, terminal } = resolverParams(idTerminal, idEmpleado);
      if (terminal === undefined)
        return fail(new Error("Falta idTerminal (pásalo o define ARK_TERMINAL_ID / usa ark_terminales)."));
      const contextoCentro = await contextoCentroDeTerminal(terminal);
      validarCentroConfirmado(contextoCentro, centroEsperado, confirmar);
      const { payload, resumen } = await construirCompra(client, compra as EntradaCompra, terminal);
      if (!confirmar)
        return ok({
          vistaPrevia: true,
          aviso:
            "No se ha escrito nada en ARK. Revisa centro, terminal, importes e IVA; " +
            "después repite con centroEsperado y confirmar=true.",
          contextoCentro,
          resumen,
          payload,
        });
      const respuesta = await client.post("/compras", payload, query);
      return ok({ creada: true, resumen, respuesta });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_crear_compra_desde_documento",
  {
    title: "Crear compra desde un documento de proveedor",
    description:
      "Convierte un documento de proveedor existente en una compra (ESCRIBE en producción). La vista previa muestra tienda y terminal; para ejecutar exige centroEsperado coincidente y confirmar=true. Antes puede ser necesario dar de alta los artículos nuevos.",
    inputSchema: {
      idDocumentoProveedor: z.number().int().describe("Id del documento de proveedor"),
      ...ctxEscritura,
    },
  },
  async ({ idDocumentoProveedor, idTerminal, idEmpleado, centroEsperado, confirmar }) => {
    try {
      const { query, terminal } = resolverParams(idTerminal, idEmpleado);
      if (terminal === undefined)
        return fail(new Error("Falta idTerminal (pásalo o define ARK_TERMINAL_ID)."));
      const q = { ...query, idDocumentoProveedor };
      const contextoCentro = await contextoCentroDeTerminal(terminal);
      validarCentroConfirmado(contextoCentro, centroEsperado, confirmar);
      if (!confirmar)
        return previewConCentro(
          "PUT",
          "/documentosProveedor/createCompraFromDocumentoProveedor",
          q,
          null,
          contextoCentro,
        );
      return ok(
        await client.put("/documentosProveedor/createCompraFromDocumentoProveedor", null, q),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ark_crear_articulos_desde_documento",
  {
    title: "Dar de alta artículos nuevos de un documento de proveedor",
    description:
      "Crea en el catálogo los artículos nuevos detectados en un documento de proveedor (ESCRIBE en producción). Por defecto vista previa; confirmar=true para ejecutar.",
    inputSchema: {
      idDocumentoProveedor: z.number().int().describe("Id del documento de proveedor"),
      confirmar: ctxEscritura.confirmar,
    },
  },
  async ({ idDocumentoProveedor, confirmar }) => {
    try {
      const q = { idDocumentoProveedor };
      if (!confirmar)
        return preview(
          "PUT",
          "/documentosProveedor/createArticulosNuevosFromDocumentoProveedor",
          q,
          null,
        );
      return ok(
        await client.put(
          "/documentosProveedor/createArticulosNuevosFromDocumentoProveedor",
          null,
          q,
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);


return server;
}
