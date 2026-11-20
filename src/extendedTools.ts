import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ArkClient, ArkError } from './arkClient.js';
import { conciliarFactura, prepararPago, huella, fechaValida, fechaMadrid, type Entity } from './proveedores.js';

export const EXTENDED_WRITE_TOOLS = ['ark_anotar_factura_proveedor', 'ark_registrar_pago_proveedor', 'ark_actualizar_visita'];
const fecha = z.string().refine(fechaValida, 'Usa una fecha real YYYY-MM-DD');
const dinero = z.number().finite();
const id = z.number().int().positive();
const facturaSchema = z.object({
  numero: z.string().trim().min(1).max(150), fecha, importeTotal: dinero,
  albaranes: z.array(z.object({ numero: z.string().trim().min(1).max(150), importeTotal: dinero.optional() })).max(300),
  listaAlbaranesCompleta: z.boolean(), formaPago: z.string().max(200).optional(),
  vencimientos: z.array(z.object({ fecha, importe: dinero })).max(24).optional(),
});
const ctx = { idTerminal: id, idEmpleado: id.optional(), centroEsperado: z.string().optional(),
  confirmar: z.boolean().default(false), huellaEsperada: z.string().length(64).optional() };
const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ ...ok({ error: e instanceof ArkError ? `ARK respondió ${e.status}. Revisa la operación antes de repetir.` : e instanceof Error ? e.message : 'No se pudo completar la operación.' }), isError: true });
const normalize = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('es');
async function mapLimit<T, R>(values: T[], fn: (v: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let i = 0; i < values.length; i += 4) result.push(...await Promise.all(values.slice(i, i + 4).map(fn)));
  return result;
}

export function registerExtendedTools(server: McpServer, client: ArkClient) {
  async function terminal(idTerminal: number): Promise<Entity> {
    const list = await client.get('/terminales/findByTiendaActiva') as Entity[];
    const found = Array.isArray(list) ? list.find(t => t.id === idTerminal) : undefined;
    if (!found?.tienda?.id || !found.tienda.nombre) throw new Error('Terminal o centro no disponible; consulta ark_terminales.');
    return found;
  }
  function check(t: Entity, confirmar: boolean, centroEsperado?: string, actual?: string, expected?: string) {
    if (!confirmar) return;
    if (!centroEsperado || normalize(centroEsperado) !== normalize(t.tienda.nombre)) throw new Error('Confirma el nombre exacto del centro mostrado en la vista previa.');
    if (!expected || expected !== actual) throw new Error('Falta la huella de la vista previa o los datos han cambiado; vuelve a revisar.');
  }
  function preview(t: Entity, h: string, resumen: unknown) {
    return ok({ vistaPrevia: true, guardado: false, contextoCentro: { terminal: t.id, tienda: t.tienda.nombre },
      huellaEsperada: h, resumen, nota: 'No se ha escrito nada. Tras confirmar esta operación concreta, repetir con confirmar=true, centroEsperado y huellaEsperada.' });
  }
  const query = (a: { idTerminal: number; idEmpleado?: number }) => ({ idTerminal: a.idTerminal, idEmpleado: a.idEmpleado });

  server.registerTool('ark_conciliar_factura_proveedor', {
    title: 'Conciliar factura de proveedor con albaranes',
    description: 'Compara la factura extraída de PDF/foto con compras candidatas de ARK. Verifica proveedor, referencias exactas, duplicados y totales. No crea stock ni acredita pago. Buscar primero todas las compras relevantes y pasar sus ids.',
    inputSchema: { idProveedor: id, factura: facturaSchema, idComprasCandidatas: z.array(id).max(300) },
  }, async a => {
    try {
      const compras = await mapLimit(a.idComprasCandidatas, n => client.get(`/compras/${n}`) as Promise<Entity>);
      return ok(conciliarFactura(a.factura, compras, a.idProveedor));
    } catch (e) { return fail(e); }
  });

  const searchSchema = { proveedor: z.string().min(1), fechaDesde: fecha, fechaHasta: fecha,
    numeroDocumento: z.string().optional(), page: z.number().int().min(0).default(0), size: z.number().int().min(1).max(100).default(20) };
  const searchBody = (a: { proveedor: string; fechaDesde: string; fechaHasta: string; numeroDocumento?: string }) => ({
    nombreSerieTransacccion: null, numeroDocumento: a.numeroDocumento ?? null, estadoTransaccion: null,
    nombreTienda: null, importeTotalDesde: null, importeTotalHasta: null, codigoArticulo: 0,
    fechaDocumentoDesde: a.fechaDesde + 'T00:00:00.000Z', fechaDocumentoHasta: a.fechaHasta + 'T23:59:59.999Z',
    allCliente: true, soloContado: false, cliente: null, proveedor: a.proveedor, observaciones: null,
  });
  server.registerTool('ark_buscar_pago_proveedor', {
    title: 'Consultar pagos a proveedores', description: 'Busca PAGOS emitidos a proveedores (no cobros de clientes). Usar para evitar duplicar pagos y revisar recibos/pagarés. Rango de fechas obligatorio.', inputSchema: searchSchema,
  }, async a => {
    try {
      if (a.fechaDesde > a.fechaHasta) throw new Error('Rango de fechas invertido.');
      const data = await client.putSearch('/pagos/searchPagoDTO', searchBody(a));
      if (!Array.isArray(data)) throw new Error('Respuesta de búsqueda no reconocida; no se puede afirmar que no haya pagos.');
      return ok({ total: data.length, page: a.page, size: a.size, items: data.slice(a.page * a.size, (a.page + 1) * a.size) });
    } catch (e) { return fail(e); }
  });
  server.registerTool('ark_ficha_pago_proveedor', {
    title: 'Ficha de pago a proveedor', description: 'Detalle de un pago: compras aplicadas, forma de pago, vencimientos y verificaciones de recibos/pagarés.', inputSchema: { idPago: id },
  }, async a => { try { return ok(await client.get(`/pagos/${a.idPago}`)); } catch (e) { return fail(e); } });
  server.registerTool('ark_vencimientos_proveedor', {
    title: 'Consultar vencimientos de pagos', description: 'Informe de pagos pendientes de vencimiento. Que venza un recibo no demuestra que se haya cargado.',
    inputSchema: { proveedor: z.string().min(1), fechaDesde: fecha, fechaHasta: fecha },
  }, async a => {
    try {
      if (a.fechaDesde > a.fechaHasta) throw new Error('Rango de fechas invertido.');
      return ok(await client.putSearch('/informes/findInformePagosPendienteVencimiento', {
        ...searchBody({ ...a, fechaDesde: '2000-01-01', fechaHasta: fechaMadrid() }),
        fechaDocumentoDesde: null, fechaDocumentoHasta: null,
        fechaVencimientoDesde: a.fechaDesde + 'T00:00:00.000Z', fechaVencimientoHasta: a.fechaHasta + 'T23:59:59.999Z',
      }));
    } catch (e) { return fail(e); }
  });

  server.registerTool('ark_anotar_factura_proveedor', {
    title: 'Anotar factura y condiciones de pago sin duplicar stock',
    description: 'Añade número/fecha de factura, forma de pago y vencimientos a las observaciones del documento proveedor de una compra existente. Conserva el albarán original. No adjunta el PDF ni crea una factura nativa ni registra un pago. Vista previa por defecto.',
    inputSchema: { idCompra: id, idProveedor: id, factura: facturaSchema, ...ctx },
  }, async a => {
    try {
      const t = await terminal(a.idTerminal);
      const compra = await client.get(`/compras/${a.idCompra}`) as Entity;
      const d = compra.documento;
      if (d?.proveedor?.id !== a.idProveedor || d?.tienda?.id !== t.tienda.id || !d.documentoProveedor?.id) throw new Error('Compra de otro proveedor/centro o sin documento de proveedor editable.');
      const doc = d.documentoProveedor;
      // Keep the existing delivery note number and all its fields.
      const contenido = { factura: a.factura.numero, fecha: a.factura.fecha, total: a.factura.importeTotal,
        formaPago: a.factura.formaPago ?? null, vencimientos: a.factura.vencimientos ?? [], albaranes: a.factura.albaranes };
      const marca = `[ARK Work factura ${huella(contenido).slice(0, 20)}]`;
      if (String(doc.observaciones ?? '').includes(marca)) return ok({ guardado: false, yaAnotada: true, idCompra: a.idCompra, nota: 'No se ha duplicado la anotación.' });
      const texto = `${marca}\n${JSON.stringify(contenido)}`;
      const body = { ...doc, observaciones: [doc.observaciones, texto].filter(Boolean).join('\n\n') };
      if (body.observaciones.length > 1500) throw new Error('La anotación excede 1500 caracteres; reducir los datos antes de guardar.');
      const h = huella({ doc, contenido });
      check(t, a.confirmar, a.centroEsperado, h, a.huellaEsperada);
      if (!a.confirmar) return preview(t, h, { idCompra: compra.id, albaranOriginal: doc.numero, anotacion: contenido });
      const result = await client.put(`/documentosProveedor/${doc.id}`, body);
      return ok({ guardado: true, idCompra: compra.id, documentoProveedor: result,
        nota: 'Condiciones anotadas en observaciones. Albarán y stock conservados. No se ha registrado un pago.' });
    } catch (e) { return fail(e); }
  });

  const entradaPago = z.object({ idProveedor: id,
    aplicaciones: z.array(z.object({ idCompra: id, importe: dinero.positive(), pendienteEsperado: dinero.positive() })).min(1).max(100),
    metodo: z.enum(['efectivo', 'tarjeta', 'transferencia', 'pagare', 'reciboDomiciliado']),
    situacion: z.enum(['realizado', 'previsto']), referencia: z.string().trim().min(1).max(200),
    evidencia: z.string().trim().max(800).optional(), fechaPagoReal: fecha.optional(),
    vencimiento: fecha.optional(), numeroPagare: z.string().max(100).optional(),
  });
  server.registerTool('ark_registrar_pago_proveedor', {
    title: 'Registrar pago realizado o previsto a proveedor',
    description: 'Crea un asiento de pago aplicándolo a compras existentes, sin ordenar transferencias. Revisa antes pagos existentes. Pagado solo con confirmación concreta o justificante; recibo/pagaré futuro queda previsto. Verifica centro, proveedor, saldos esperados y huella de vista previa. No reintentar a ciegas si falla.',
    inputSchema: { pago: entradaPago, ...ctx },
  }, async a => {
    let enviado = false;
    try {
      const t = await terminal(a.idTerminal);
      const proveedor = await client.get(`/proveedores/${a.pago.idProveedor}`) as Entity;
      const compras = await mapLimit(a.pago.aplicaciones.map(e => e.idCompra), n => client.get(`/compras/${n}`) as Promise<Entity>);
      const { payload, resumen } = prepararPago(a.pago, compras, t, proveedor);
      const h = huella({ compras, pago: a.pago, idTerminal: t.id });
      check(t, a.confirmar, a.centroEsperado, h, a.huellaEsperada);
      if (!a.confirmar) return preview(t, h, resumen);
      enviado = true;
      const respuesta = await client.post('/pagos', payload, query(a)) as Entity;
      let verificacion: unknown;
      try { verificacion = { pago: respuesta?.id ? await client.get(`/pagos/${respuesta.id}`) : respuesta,
        compras: await mapLimit(a.pago.aplicaciones.map(e => e.idCompra), n => client.get(`/compras/${n}`)) }; }
      catch { return ok({ guardado: true, respuesta, verificacionPendiente: true, noReintentar: true,
        nota: 'ARK aceptó el pago pero no pudo releerse. Consultar pagos y saldos antes de cualquier otra escritura.' }); }
      return ok({ guardado: true, resumen, verificacion });
    } catch (e) {
      if (enviado) return { ...ok({ resultadoDesconocido: true, noReintentar: true,
        nota: 'Se envió la solicitud de pago. No consta si ARK la guardó; consultar pagos y saldos antes de repetir.' }), isError: true };
      return fail(e);
    }
  });

  server.registerTool('ark_ficha_visita', { title: 'Ficha completa de visita',
    description: 'Obtiene una visita antes de completar el historial; conserva su versión y campos actuales.', inputSchema: { idVisita: id },
  }, async a => { try { return ok(await client.get(`/visitas/${a.idVisita}`)); } catch (e) { return fail(e); } });
  const camposClinicos = z.object({ anamnesis: z.string().max(30000).optional(), diagnostico: z.string().max(30000).optional(),
    tratamiento: z.string().max(30000).optional(), anotaciones: z.string().max(30000).optional() })
    .refine(v => Object.keys(v).length > 0, 'Indicar al menos un campo clínico');
  server.registerTool('ark_actualizar_visita', {
    title: 'Completar una visita clínica existente',
    description: 'Añade o sustituye textos clínicos de una visita existente. Por defecto anexa para conservar el historial. Comprueba paciente, centro y huella; no altera tratamientos facturados, recetas, pruebas ni existencias. Vista previa antes de guardar.',
    inputSchema: { idVisita: id, idMascotaEsperado: id, campos: camposClinicos, modo: z.enum(['anexar', 'sustituir']).default('anexar'), ...ctx },
  }, async a => {
    try {
      const t = await terminal(a.idTerminal);
      const visita = await client.get(`/visitas/${a.idVisita}`) as Entity;
      const doc = visita.documento;
      if (doc?.tienda?.id !== t.tienda.id || doc?.mascota?.id !== a.idMascotaEsperado) throw new Error('El centro o el paciente de la visita no coincide.');
      if (/cerrad|cancelad|anulad/i.test(String(visita.estadoTransaccion?.nombre ?? ''))) throw new Error('Visita cerrada o anulada: revisar en ARK antes de editar.');
      const cambios: Entity = {};
      const cuerpo = structuredClone(visita);
      for (const [campo, texto] of Object.entries(a.campos)) {
        if (texto === undefined) continue;
        const anterior = doc[campo] ?? '';
        const propuesto = a.modo === 'anexar' ? [anterior, texto].filter(Boolean).join('\n\n') : texto;
        cuerpo.documento[campo] = propuesto; cambios[campo] = { anterior, propuesto };
      }
      const h = huella({ visita, campos: a.campos, modo: a.modo });
      check(t, a.confirmar, a.centroEsperado, h, a.huellaEsperada);
      if (!a.confirmar) return preview(t, h, { idVisita: visita.id, paciente: doc.mascota.nombre, cambios });
      const respuesta = await client.put(`/visitas/${visita.id}`, cuerpo, query(a));
      return ok({ guardado: true, respuesta });
    } catch (e) { return fail(e); }
  });
}
