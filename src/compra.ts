// Construcción del payload real de una COMPRA para ARK (POST /compras).
//
// ARK no acepta un {idProveedor, operaciones} plano: espera un objeto
// { id, uid, version, documento, pedido } donde `documento` lleva la tienda,
// el proveedor, el documentoProveedor (albarán/factura), las `entradas` (líneas
// con su artículo completo, IVA de compra, descuento y trazas/lote) y el
// desglose de IVA + totales ya calculados. Este módulo lo arma a partir de una
// entrada sencilla (idArticulo, cantidad, precio sin IVA, descuento, lotes).

export interface ClienteArk {
  get(path: string, query?: Record<string, string | number | null | undefined>): Promise<unknown>;
}

export interface LoteEntrada {
  numeroLote: string;
  caducidad?: string; // "YYYY-MM-DD" | "MM/YYYY" | "MM/YY". Opcional si el lote ya existe (se autocompleta)
  cantidad?: number; // unidades de este lote; por defecto, la cantidad de la línea
}

interface LoteArk {
  id: number;
  numeroLote: string;
  fechaCaducidad: string;
}

export interface LineaCompra {
  idArticulo: number;
  cantidad: number;
  precio: number; // precio de compra unitario SIN IVA, antes de descuento
  descuento?: number; // fracción 0-1 (0.14) o porcentaje (14); por defecto 0
  descuentos?: number[]; // descuentos compuestos (p. ej. [0.33, 0.14]); se combinan
  descripcion?: string;
  lotes?: LoteEntrada[];
}

export interface EntradaCompra {
  idProveedor: number;
  numeroDocumento: string; // nº del albarán/factura del proveedor
  fechaDocumento?: string; // fecha del documento (YYYY-MM-DD); por defecto hoy
  esFactura?: boolean; // true = factura, false = albarán (por defecto)
  observaciones?: string;
  lineas: LineaCompra[];
}

const round = (n: number, d: number): number => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};

// Un descuento puede llegar como fracción (0.14) o como porcentaje (14).
const aFraccion = (d: number): number => (d > 1 ? d / 100 : d);

export function combinarDescuento(linea: LineaCompra): number {
  const lista =
    linea.descuentos && linea.descuentos.length > 0
      ? linea.descuentos
      : linea.descuento !== undefined
        ? [linea.descuento]
        : [];
  const combinado = lista.reduce((acc, d) => acc * (1 - aFraccion(d)), 1);
  return round(1 - combinado, 6);
}

// Convierte una caducidad de usuario a ISO. "MM/YYYY" o "MM/YY" -> último día
// del mes; "YYYY-MM-DD" -> ese día. Se fija a mediodía UTC para evitar que el
// huso horario desplace el día.
export function caducidadISO(valor: string): string {
  const v = valor.trim();
  const mmYYYY = v.match(/^(\d{1,2})\/(\d{2,4})$/);
  if (mmYYYY) {
    const mes = Number(mmYYYY[1]);
    let anio = Number(mmYYYY[2]);
    if (anio < 100) anio += 2000;
    const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    const mm = String(mes).padStart(2, "0");
    const dd = String(ultimoDia).padStart(2, "0");
    return `${anio}-${mm}-${dd}T12:00:00.000Z`;
  }
  const ymd = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return `${v}T12:00:00.000Z`;
  // Último intento: que lo parsee Date.
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  throw new Error(`Caducidad no reconocida: "${valor}" (usa YYYY-MM-DD o MM/YYYY).`);
}

// Referencia mínima a un proveedor tal como la envía la web de ARK (id + nulos).
function proveedorRef(id: number) {
  return {
    id,
    uid: null,
    version: null,
    nombre: null,
    primerApellido: null,
    segundoApellido: null,
    observaciones: null,
    estado: null,
    datosContacto: null,
    fechaAlta: null,
    fechaUltimaModificacion: null,
    fechaBaja: null,
    nombreCompleto: null,
    documentoIdentidad: null,
    tipoIRPF: null,
    recargoEquivalencia: false,
    saldo: 0,
    pendienteVencimiento: 0,
    porcentajeDescuento: 0,
    domiciliacionBancaria: false,
    proveedorIntegrationType: null,
    proveedorIntegrationPedidos: false,
  };
}

interface ArticuloArk {
  id: number;
  descripcion?: string;
  trazabilidad?: boolean;
  tipoGravamenCompra?: { tasaGravamen?: number; recargoEquivalencia?: number };
}

async function fetchTiendaDeTerminal(client: ClienteArk, idTerminal: number): Promise<unknown> {
  const terminales = (await client.get("/terminales/findByTiendaActiva")) as Array<{
    id: number;
    tienda: unknown;
  }>;
  const t = Array.isArray(terminales) ? terminales.find((x) => x.id === idTerminal) : undefined;
  if (!t) throw new Error(`No se encontró el terminal id ${idTerminal} en la tienda activa.`);
  return t.tienda;
}

export interface ResultadoCompra {
  payload: unknown;
  resumen: {
    proveedor: number;
    documento: string;
    fecha: string;
    lineas: Array<{
      idArticulo: number;
      descripcion: string;
      cantidad: number;
      precioSinIva: number;
      descuento: number;
      ivaCompra: number;
      base: number;
      trazable: boolean;
      lotes: Array<{ numeroLote: string; caducidad: string; cantidad: number; estado: "existente" | "nuevo" }>;
    }>;
    desgloseIva: Array<{ tasa: number; base: number; cuota: number }>;
    baseTotal: number;
    ivaTotal: number;
    total: number;
    avisos: string[];
  };
}

// Arma el payload completo de la compra (haciendo lecturas de artículos y
// tienda). No escribe nada: quien llame decide si hace el POST.
export async function construirCompra(
  client: ClienteArk,
  entrada: EntradaCompra,
  idTerminal: number,
): Promise<ResultadoCompra> {
  if (!entrada.lineas || entrada.lineas.length === 0)
    throw new Error("La compra no tiene líneas.");
  if (!entrada.numeroDocumento)
    throw new Error("Falta el número de albarán/factura del proveedor (numeroDocumento).");

  const avisos: string[] = [];
  const cacheArt = new Map<number, ArticuloArk>();
  const getArticulo = async (id: number): Promise<ArticuloArk> => {
    if (cacheArt.has(id)) return cacheArt.get(id)!;
    const a = (await client.get(`/articulos/${id}`)) as ArticuloArk;
    if (!a || typeof a.id !== "number")
      throw new Error(`No se encontró el artículo id ${id}.`);
    cacheArt.set(id, a);
    return a;
  };

  // Lotes ya existentes del artículo, para reutilizarlos (autocompletar) en vez
  // de crear duplicados. Se busca por número de lote (sin distinguir may/min ni
  // espacios). Si no aparece, se crea uno nuevo (lote.id = null).
  const cacheLotes = new Map<number, LoteArk[]>();
  const getLotes = async (idArticulo: number): Promise<LoteArk[]> => {
    if (cacheLotes.has(idArticulo)) return cacheLotes.get(idArticulo)!;
    const r = (await client.get("/lotes/findAllLoteDTOByArticulo", { idArticulo })) as LoteArk[];
    const lotes = Array.isArray(r) ? r : [];
    cacheLotes.set(idArticulo, lotes);
    return lotes;
  };
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
  const buscarLote = (lotes: LoteArk[], numeroLote: string): LoteArk | undefined =>
    lotes.find((l) => norm(l.numeroLote ?? "") === norm(numeroLote));
  // Al reutilizar un lote existente hay que enviarlo COMPLETO (con su uid y
  // version reales); si no, el control de versiones del servidor falla (500).
  // findAllLoteDTOByArticulo solo trae id/numeroLote/caducidad, así que pedimos
  // la ficha completa por id.
  const cacheLoteFull = new Map<number, Record<string, unknown>>();
  const getLoteCompleto = async (id: number): Promise<Record<string, unknown>> => {
    if (cacheLoteFull.has(id)) return cacheLoteFull.get(id)!;
    const l = (await client.get(`/lotes/${id}`)) as Record<string, unknown>;
    cacheLoteFull.set(id, l);
    return l;
  };

  const tienda = await fetchTiendaDeTerminal(client, idTerminal);
  // La web de ARK usa DOS fechas distintas: la del asiento (fechaDocumento) es el
  // momento en que se guarda (ahora), y la del albarán/factura del proveedor va en
  // documentoProveedor.fecha. Poner una fechaDocumento pasada puede romper la caja.
  const ahora = new Date().toISOString();
  const fechaAlbaran = entrada.fechaDocumento
    ? caducidadISO(entrada.fechaDocumento)
    : ahora;

  const entradas: unknown[] = [];
  const resumenLineas: ResultadoCompra["resumen"]["lineas"] = [];
  // Agrupa bases por tasa de IVA de compra (IVA escalonado).
  const porTasa = new Map<number, { tasa: number; re: number; base: number }>();

  for (const linea of entrada.lineas) {
    const art = await getArticulo(linea.idArticulo);
    const tasa = art.tipoGravamenCompra?.tasaGravamen ?? 0;
    const re = art.tipoGravamenCompra?.recargoEquivalencia ?? 0;
    const dto = combinarDescuento(linea);
    const baseLinea = linea.precio * (1 - dto) * linea.cantidad;

    // Trazabilidad: validar lotes y reutilizar los existentes.
    let trazas: unknown[] = [];
    const lotesResumen: Array<{ numeroLote: string; caducidad: string; cantidad: number; estado: "existente" | "nuevo" }> = [];
    if (art.trazabilidad) {
      const lotes = linea.lotes ?? [];
      if (lotes.length === 0)
        throw new Error(
          `El artículo "${art.descripcion ?? linea.idArticulo}" tiene trazabilidad: ` +
            `debes indicar lote(s) con numeroLote y caducidad.`,
        );
      const sumaLotes = lotes.reduce(
        (s, l) => s + (l.cantidad ?? (lotes.length === 1 ? linea.cantidad : 0)),
        0,
      );
      if (round(sumaLotes, 4) !== round(linea.cantidad, 4))
        throw new Error(
          `Las unidades de los lotes (${sumaLotes}) no cuadran con la cantidad de la ` +
            `línea (${linea.cantidad}) en "${art.descripcion ?? linea.idArticulo}".`,
        );
      const existentes = await getLotes(linea.idArticulo);
      trazas = await Promise.all(lotes.map(async (l) => {
        const cant = l.cantidad ?? (lotes.length === 1 ? linea.cantidad : 0);
        const yaExiste = buscarLote(existentes, l.numeroLote);
        let loteObj: Record<string, unknown>;
        let iso: string;
        if (yaExiste) {
          // Lote existente: se reutiliza tal cual lo devuelve ARK (con uid,
          // version y artículo completos), como hace la web.
          loteObj = await getLoteCompleto(yaExiste.id);
          iso = (loteObj.fechaCaducidad as string) ?? yaExiste.fechaCaducidad;
        } else {
          // Lote nuevo: hay que crearlo, así que la caducidad es obligatoria.
          if (!l.caducidad)
            throw new Error(
              `El lote "${l.numeroLote}" de "${art.descripcion ?? linea.idArticulo}" no existe ` +
                `y falta su caducidad para crearlo.`,
            );
          iso = caducidadISO(l.caducidad);
          loteObj = {
            id: null,
            uid: null,
            version: null,
            numeroLote: l.numeroLote,
            fechaCaducidad: iso,
            articulo: art,
          };
        }
        lotesResumen.push({
          numeroLote: l.numeroLote,
          caducidad: iso.slice(0, 10),
          cantidad: cant,
          estado: yaExiste ? "existente" : "nuevo",
        });
        return { id: null, uid: null, version: null, lote: loteObj, cantidad: cant, observaciones: null };
      }));
    } else if (linea.lotes && linea.lotes.length > 0) {
      avisos.push(
        `El artículo "${art.descripcion ?? linea.idArticulo}" no es trazable; se ignoran sus lotes.`,
      );
    }

    entradas.push({
      id: null,
      uid: null,
      version: null,
      articulo: art,
      descripcion: linea.descripcion ?? art.descripcion ?? null,
      cantidad: linea.cantidad,
      tasaGravamen: tasa,
      recargoEquivalencia: re,
      porcentajeDescuento: dto,
      precio: linea.precio,
      trazas,
      importe: 0,
      documento: null,
    });

    const grupo = porTasa.get(tasa) ?? { tasa, re, base: 0 };
    grupo.base += baseLinea;
    porTasa.set(tasa, grupo);

    resumenLineas.push({
      idArticulo: linea.idArticulo,
      descripcion: art.descripcion ?? String(linea.idArticulo),
      cantidad: linea.cantidad,
      precioSinIva: linea.precio,
      descuento: dto,
      ivaCompra: tasa,
      base: round(baseLinea, 4),
      trazable: !!art.trazabilidad,
      lotes: lotesResumen,
    });
  }

  const desglose = [...porTasa.values()]
    .sort((a, b) => b.tasa - a.tasa)
    .map((g) => ({
      id: null,
      uid: null,
      version: null,
      base: round(g.base, 4),
      tasaGravamen: g.tasa,
      recargoEquivalencia: g.re,
      importeGravamen: round(g.base * g.tasa, 4),
      importeRecargoEquivalencia: 0,
    }));

  const baseTotal = round(
    desglose.reduce((s, d) => s + d.base, 0),
    4,
  );
  const ivaTotal = round(
    desglose.reduce((s, d) => s + d.importeGravamen, 0),
    4,
  );
  const total = round(baseTotal + ivaTotal, 2);

  const documento = {
    id: null,
    uid: null,
    version: null,
    tienda,
    numDocumento: null,
    fechaDocumento: ahora,
    observaciones: entrada.observaciones ?? null,
    porcentajeDescuento: 0,
    entradasDesgloseTipoGravamen: desglose,
    tasaIRPF: 0,
    aplicarRE: false,
    importeTotal: total,
    baseTotal,
    importeGravamenTotal: ivaTotal,
    importeRecargoEquivalenciaTotal: 0,
    importeIRPF: 0,
    serieTransaccion: null,
    proveedor: proveedorRef(entrada.idProveedor),
    importePendiente: 0,
    entradas,
    documentoProveedor: {
      id: null,
      uid: null,
      version: null,
      proveedor: proveedorRef(entrada.idProveedor),
      factura: entrada.esFactura ?? false,
      numero: entrada.numeroDocumento,
      fecha: fechaAlbaran,
      numeroPedido: null,
      codigoCliente: null,
      codigoCentro: null,
      centro: null,
      porcentajeDescuento: 0,
      observaciones: null,
      entradas: [],
      compra: null,
      descartado: false,
    },
  };

  return {
    payload: { id: null, uid: null, version: null, documento, pedido: null },
    resumen: {
      proveedor: entrada.idProveedor,
      documento: entrada.numeroDocumento,
      fecha: fechaAlbaran.slice(0, 10),
      lineas: resumenLineas,
      desgloseIva: desglose.map((d) => ({ tasa: d.tasaGravamen, base: d.base, cuota: d.importeGravamen })),
      baseTotal,
      ivaTotal,
      total,
      avisos,
    },
  };
}
