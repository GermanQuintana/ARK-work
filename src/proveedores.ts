// Supplier invoice checks and payment payloads. Shapes observed in the public
// ARK web client on 2026-11-13; no production writes are used for development.
import { createHash } from 'node:crypto';

export type Entity = Record<string, any>;
export interface FacturaProveedor {
  numero: string;
  fecha: string;
  importeTotal: number;
  albaranes: { numero: string; importeTotal?: number }[];
  listaAlbaranesCompleta: boolean;
  formaPago?: string;
  vencimientos?: { fecha: string; importe: number }[];
}
export const huella = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const centimos = (n: number) => {
  if (!Number.isFinite(n)) throw new Error('Importe no válido.');
  return Math.round((n + Math.sign(n) * Number.EPSILON) * 100);
};
const ref = (s: string) => s.normalize('NFKC').trim().toUpperCase();
export function fechaValida(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
export const fechaMadrid = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
export function documentoCompra(compra: Entity): Entity {
  if (!compra?.documento || !Number.isSafeInteger(compra.id)) throw new Error('Ficha de compra incompleta.');
  return compra.documento;
}

export function conciliarFactura(factura: FacturaProveedor, compras: Entity[], idProveedor: number) {
  const incidencias: string[] = [];
  const refs = factura.albaranes.map(a => ref(a.numero));
  if (!factura.listaAlbaranesCompleta || refs.length === 0) incidencias.push('No se dispone de una relación completa de albaranes.');
  if (new Set(refs).size !== refs.length) incidencias.push('La factura repite referencias de albaranes.');
  const ids = compras.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('Hay compras repetidas en los candidatos.');
  const validas = compras.filter(c => documentoCompra(c).proveedor?.id === idProveedor);
  if (validas.length !== compras.length) incidencias.push('Se han descartado candidatos de otro proveedor.');
  const filas = factura.albaranes.map(a => {
    // Compare the SUPPLIER reference, never ARK's internal numDocumento.
    const matches = validas.filter(c => ref(String(c.documento.documentoProveedor?.numero ?? '')) === ref(a.numero));
    let estado: string = matches.length === 0 ? 'no_localizado_en_candidatos' : matches.length > 1 ? 'duplicado_o_ambiguo' : 'coincide';
    const doc = matches.length === 1 ? matches[0].documento : undefined;
    if (doc && /cancelad|anulad/i.test(String(matches[0].estadoTransaccion?.nombre ?? ''))) estado = 'compra_anulada';
    if (doc && (!Number.isFinite(doc.importeTotal) || !Number.isFinite(doc.importePendiente))) estado = 'datos_incompletos';
    if (doc && a.importeTotal !== undefined && centimos(doc.importeTotal) !== centimos(a.importeTotal)) estado = 'importe_distinto';
    return { numero: a.numero, estado, idCompras: matches.map(c => c.id), centro: doc?.tienda?.nombre ?? null, idTienda: doc?.tienda?.id ?? null, importeFactura: a.importeTotal ?? null,
      importeArk: doc?.importeTotal ?? null, pendienteArk: doc?.importePendiente ?? null };
  });
  const coinciden = filas.every(f => f.estado === 'coincide');
  const suma = coinciden ? filas.reduce((n, f) => n + centimos(f.importeArk!), 0) : null;
  const diferencia = suma === null ? null : (centimos(factura.importeTotal) - suma) / 100;
  if (diferencia !== null && diferencia !== 0) incidencias.push('El total de los albaranes no coincide con la factura; revisar abonos, portes, descuentos e impuestos.');
  const vencimientos = factura.vencimientos ?? [];
  if (vencimientos.length && vencimientos.reduce((n, v) => n + centimos(v.importe), 0) !== centimos(factura.importeTotal)) incidencias.push('Los vencimientos no suman el total de la factura.');
  const conciliada = refs.length > 0 && factura.listaAlbaranesCompleta && coinciden && diferencia === 0 && incidencias.length === 0;
  return { numeroFactura: factura.numero, idProveedor, conciliada, alcance: 'Solo compras candidatas indicadas; una ausencia no demuestra que el albarán no exista en ARK.',
    albaranes: filas, importeFactura: factura.importeTotal, sumaAlbaranes: suma === null ? null : suma / 100, diferencia,
    formaPago: factura.formaPago ?? null, vencimientos, incidencias,
    nota: 'La conciliación no crea compras, no duplica stock y no acredita que la factura esté pagada.' };
}

export interface EntradaPago {
  idProveedor: number;
  aplicaciones: { idCompra: number; importe: number; pendienteEsperado: number }[];
  metodo: 'efectivo' | 'tarjeta' | 'transferencia' | 'pagare' | 'reciboDomiciliado';
  situacion: 'realizado' | 'previsto';
  referencia: string;
  evidencia?: string;
  fechaPagoReal?: string;
  vencimiento?: string;
  numeroPagare?: string;
}

export function prepararPago(entrada: EntradaPago, compras: Entity[], terminal: Entity, proveedor: Entity) {
  if (proveedor.id !== entrada.idProveedor || !terminal.tienda?.id) throw new Error('Proveedor o centro no válido.');
  if (!entrada.aplicaciones.length || new Set(entrada.aplicaciones.map(a => a.idCompra)).size !== entrada.aplicaciones.length) throw new Error('Indicar compras distintas, sin duplicados.');
  if (entrada.situacion === 'realizado') {
    if (!['efectivo', 'tarjeta', 'transferencia'].includes(entrada.metodo)) throw new Error('Para un recibo o pagaré ya emitido, verificar el pago existente en ARK; no crear un segundo pago.');
    if (!entrada.evidencia?.trim() || !entrada.fechaPagoReal || !fechaValida(entrada.fechaPagoReal) || entrada.fechaPagoReal > fechaMadrid()) throw new Error('Un pago realizado necesita evidencia o confirmación concreta del usuario y fecha real no futura.');
  } else if (!['pagare', 'reciboDomiciliado'].includes(entrada.metodo) || !entrada.vencimiento || !fechaValida(entrada.vencimiento)) {
    throw new Error('Un pago previsto necesita recibo domiciliado o pagaré y fecha de vencimiento; no está acreditado como pagado.');
  }
  if (entrada.metodo === 'pagare' && !entrada.numeroPagare?.trim()) throw new Error('Falta el número de pagaré.');
  const entradasCompra = entrada.aplicaciones.map(a => {
    const compra = compras.find(c => c.id === a.idCompra);
    if (!compra) throw new Error('No se encontró una compra indicada.');
    const d = documentoCompra(compra);
    if (d.proveedor?.id !== entrada.idProveedor || d.tienda?.id !== terminal.tienda.id) throw new Error('Compra de otro proveedor o centro.');
    if (/cancelad|anulad/i.test(String(compra.estadoTransaccion?.nombre ?? ''))) throw new Error('No se puede pagar una compra anulada.');
    if (!Number.isFinite(d.importePendiente) || centimos(d.importePendiente) !== centimos(a.pendienteEsperado)) throw new Error('El saldo pendiente ha cambiado o no se conoce; revisar de nuevo antes de registrar el pago.');
    if (centimos(a.importe) <= 0 || centimos(a.importe) > centimos(d.importePendiente)) throw new Error('El pago debe ser positivo y no superar el pendiente.');
    return { id: null, uid: null, version: null, compra: { id: compra.id }, importe: centimos(a.importe) / 100, cancelada: null };
  });
  const total = entradasCompra.reduce((n, e) => n + centimos(e.importe), 0) / 100;
  const formasPago: Entity = { id: null, uid: null, version: null, efectivo: 0, tarjeta: 0, transferencia: 0,
    pagare: 0, numeroPagare: null, vencimientoPagare: null, verificacionPagare: null,
    talon: 0, numeroTalon: null, reciboDomiciliado: 0, vencimientoReciboDomiciliado: null, verificacionReciboDomiciliado: null, total };
  formasPago[entrada.metodo] = total;
  if (entrada.metodo === 'pagare') { formasPago.numeroPagare = entrada.numeroPagare; formasPago.vencimientoPagare = entrada.vencimiento + 'T12:00:00.000Z'; }
  if (entrada.metodo === 'reciboDomiciliado') formasPago.vencimientoReciboDomiciliado = entrada.vencimiento + 'T12:00:00.000Z';
  const observaciones = `[ARK Work] ${entrada.referencia}\nSituación: ${entrada.situacion}.` +
    (entrada.fechaPagoReal ? ` Fecha de pago acreditada: ${entrada.fechaPagoReal}.` : '') +
    (entrada.evidencia ? ` Evidencia: ${entrada.evidencia}` : '');
  if (observaciones.length > 1500) throw new Error('La referencia y evidencia exceden 1500 caracteres.');
  const payload = { id: null, uid: null, version: null, documento: { id: null, uid: null, version: null,
    tienda: terminal.tienda, numDocumento: null, fechaDocumento: new Date().toISOString(), observaciones,
    terminal, formasPago, serieTransaccion: null, proveedor, entradasCompra }, docCierreCajaId: null };
  return { payload, resumen: { idProveedor: entrada.idProveedor, centro: terminal.tienda.nombre, total,
    metodo: entrada.metodo, situacion: entrada.situacion, vencimiento: entrada.vencimiento ?? null,
    nota: entrada.situacion === 'previsto' ? 'Pago previsto; no consta liquidado. No volver a registrar este importe cuando venza: verificar el pago existente en ARK.' :
      'Asiento de un pago ya realizado; esta operación no ordena transferencias bancarias. La fecha contable será la actual.',
    aplicaciones: entrada.aplicaciones } };
}
