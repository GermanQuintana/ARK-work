import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conciliarFactura, prepararPago, fechaValida, fechaMadrid } from '../dist/proveedores.js';

const proveedor = { id: 3, nombreCompleto: 'Proveedor ficticio' };
const terminal = { id: 7, tienda: { id: 2, nombre: 'Centro ficticio Norte' } };
const compra = (id, numero, total = 121, pendiente = total) => ({ id, version: 1,
  documento: { tienda: terminal.tienda, proveedor, documentoProveedor: { id: 100 + id, numero }, importeTotal: total, importePendiente: pendiente } });
const factura = () => ({ numero: 'F-9', fecha: '2026-11-01', importeTotal: 363,
  albaranes: [{ numero: 'A-001', importeTotal: 121 }, { numero: 'A-002', importeTotal: 242 }], listaAlbaranesCompleta: true });
test('reconciliation compares supplier references, includes paid delivery notes and retains leading zeroes', () => {
  const compras = [compra(1, 'A-001', 121, 0), compra(2, 'A-002', 242)];
  const r = conciliarFactura(factura(), compras, 3);
  assert.equal(r.conciliada, true); assert.equal(r.sumaAlbaranes, 363);
  compras[0].documento.documentoProveedor.numero = 'A-1';
  compras[0].documento.numDocumento = 'A-001';
  assert.equal(conciliarFactura(factura(), compras, 3).conciliada, false);
});
test('missing pages, duplicate candidates, other suppliers and unmatched totals cannot reconcile', () => {
  const f = factura(); const a = compra(1, 'A-001'); const b = compra(2, 'A-002', 242);
  assert.equal(conciliarFactura({ ...f, listaAlbaranesCompleta: false }, [a, b], 3).conciliada, false);
  assert.equal(conciliarFactura(f, [a, b, compra(9, 'A-001')], 3).conciliada, false);
  b.documento.proveedor = { id: 99 };
  assert.equal(conciliarFactura(f, [a, b], 3).conciliada, false);
  b.documento.proveedor = proveedor;
  assert.equal(conciliarFactura({ ...f, importeTotal: 364 }, [a, b], 3).conciliada, false);
  assert.equal(conciliarFactura({ ...f, vencimientos: [{ fecha: '2026-12-01', importe: 300 }] }, [a, b], 3).conciliada, false);
});
const pago = () => ({ idProveedor: 3, aplicaciones: [{ idCompra: 2, importe: 100, pendienteEsperado: 242 }],
  metodo: 'transferencia', situacion: 'realizado', referencia: 'F-9', evidencia: 'El usuario confirma el pago por 100 euros', fechaPagoReal: fechaMadrid() });
test('partial payment payload applies to existing purchases and keeps the outstanding balance untouched locally', () => {
  const compras = [compra(2, 'A-002', 242)];
  const p = prepararPago(pago(), compras, terminal, proveedor);
  assert.equal(p.payload.documento.formasPago.transferencia, 100);
  assert.deepEqual(p.payload.documento.entradasCompra[0].compra, { id: 2 });
  assert.equal(compras[0].documento.importePendiente, 242);
  assert.match(p.resumen.nota, /no ordena transferencias/);
});
test('payments reject stale balances, overpayments, repeated purchases, wrong centres and unsupported completed debit notes', () => {
  const compras = [compra(2, 'A-002', 242)];
  for (const partial of [
    { aplicaciones: [{ idCompra: 2, importe: 100, pendienteEsperado: 200 }] },
    { aplicaciones: [{ idCompra: 2, importe: 243, pendienteEsperado: 242 }] },
    { aplicaciones: [pago().aplicaciones[0], pago().aplicaciones[0]] },
    { evidencia: '' }, { fechaPagoReal: '2099-01-01' }, { metodo: 'reciboDomiciliado' },
  ]) assert.throws(() => prepararPago({ ...pago(), ...partial }, compras, terminal, proveedor));
  compras[0].documento.tienda = { id: 99 };
  assert.throws(() => prepararPago(pago(), compras, terminal, proveedor));
});
test('planned direct debit stores maturity but never claims to be settled', () => {
  const p = prepararPago({ ...pago(), situacion: 'previsto', metodo: 'reciboDomiciliado', evidencia: undefined,
    fechaPagoReal: undefined, vencimiento: '2026-12-01' }, [compra(2, 'A-002', 242)], terminal, proveedor);
  assert.equal(p.payload.documento.formasPago.reciboDomiciliado, 100);
  assert.equal(p.payload.documento.formasPago.verificacionReciboDomiciliado, null);
  assert.equal(p.resumen.situacion, 'previsto'); assert.match(p.resumen.nota, /no consta liquidado/);
  assert.equal(fechaValida('2026-02-30'), false);
});
