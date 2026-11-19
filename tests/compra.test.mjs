import assert from 'node:assert/strict';
import test from 'node:test';
import { construirCompra } from '../dist/compra.js';

test('envía la caja, el precio por caja y el lote en unidades de compra', async () => {
  const articulo = { id: 41, descripcion: 'Caja de 15 comprimidos', trazabilidad: true };
  const client = {
    async get(path) {
      switch (path) {
        case '/terminales/findByTiendaActiva':
          return [{ id: 9, tienda: { id: 2 } }];
        case '/articulos/41':
          return articulo;
        case '/lotes/findAllLoteDTOByArticulo':
          return [];
        default:
          assert.fail(`Consulta inesperada: ${path}`);
      }
    },
  };

  const { payload, resumen } = await construirCompra(client, {
    idProveedor: 3,
    numeroDocumento: 'ALB-1',
    lineas: [{
      idArticulo: 41,
      cantidad: 1,
      unidadCompra: 'caja',
      precio: 24,
      descuento: 10,
      lotes: [{ numeroLote: 'L1', caducidad: '12/2028' }],
    }],
  }, 9);

  const [linea] = payload.documento.entradas;
  assert.equal(linea.cantidad, 1);
  assert.equal(linea.precio, 24);
  assert.equal(linea.porcentajeDescuento, 0.1);
  assert.equal(linea.trazas[0].cantidad, 1);
  assert.equal(linea.articulo, articulo);
  assert.ok(!Object.hasOwn(linea, 'unidadCompra'));
  assert.equal(resumen.lineas[0].unidadCompra, 'caja');
  assert.equal(resumen.lineas[0].base, 21.6);
});
