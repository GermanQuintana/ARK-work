import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createArkServer } from '../dist/tools.js';
import { fechaMadrid } from '../dist/proveedores.js';

async function fixture(run) {
  const proveedor = { id: 3, nombreCompleto: 'Proveedor ficticio' };
  const terminal = { id: 7, tienda: { id: 2, nombre: 'Centro ficticio Norte' } };
  const compra = { id: 9, version: 1, documento: { tienda: terminal.tienda, proveedor,
    documentoProveedor: { id: 99, numero: 'A-001', observaciones: 'Nota original', version: 1 }, importeTotal: 121, importePendiente: 121 } };
  const visita = { id: 11, version: 1, documento: { tienda: terminal.tienda, mascota: { id: 12, nombre: 'Paciente ficticio' },
    anamnesis: 'Texto previo', entradasTratamiento: [{ id: 5 }], recetas: [{ id: 6 }], pruebas: [{ id: 8 }] } };
  const writes = []; let savedPayment; let disconnectPayment = false;
  const http = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = new URL(req.url, 'http://fixture.invalid').pathname.replace('/ark/rest', '');
    res.setHeader('Content-Type', 'application/json');
    const reply = d => res.end(JSON.stringify(d));
    if (path === '/auth/signin') return reply({ accessToken: 'fake-token' });
    if (req.method === 'GET') {
      if (path === '/terminales/findByTiendaActiva') return reply([terminal]);
      if (path === '/proveedores/3') return reply(proveedor);
      if (path === '/compras/9') return reply(compra);
      if (path === '/visitas/11') return reply(visita);
      if (path === '/pagos/33') return reply(savedPayment);
    }
    if (path === '/pagos' && req.method === 'POST') {
      writes.push({ path, body });
      savedPayment = { ...body, id: 33 };
      compra.documento.importePendiente -= body.documento.formasPago.total;
      if (disconnectPayment) { req.socket.destroy(); return; }
      return reply(savedPayment);
    }
    if (path === '/documentosProveedor/99' && req.method === 'PUT') {
      writes.push({ path, body }); compra.documento.documentoProveedor = { ...body, version: body.version + 1 }; return reply(compra.documento.documentoProveedor);
    }
    if (path === '/visitas/11' && req.method === 'PUT') {
      writes.push({ path, body }); Object.assign(visita, body); visita.version++; return reply(visita);
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  const servers = [], clients = [];
  const connect = async writesEnabled => {
    const server = createArkServer({ baseUrl: `http://127.0.0.1:${http.address().port}/ark/rest`, tenant: 'FAKE', username: 'fake', password: 'fake' }, writesEnabled);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'accounting-fixture', version: '1' });
    await server.connect(b); await client.connect(a); servers.push(server); clients.push(client);
    return client;
  };
  const call = async (c, name, args) => {
    const result = await c.callTool({ name, arguments: args });
    return { error: result.isError === true, value: JSON.parse(result.content[0].text) };
  };
  try { await run({ connect, call, compra, visita, writes, disconnect: () => { disconnectPayment = true; } }); }
  finally { for (const c of clients) await c.close(); for (const s of servers) await s.close(); await new Promise(r => http.close(r)); }
}
const ctx = { idTerminal: 7 };
const factura = { numero: 'F-1', fecha: '2026-11-01', importeTotal: 121,
  listaAlbaranesCompleta: true, albaranes: [{ numero: 'A-001', importeTotal: 121 }], formaPago: 'Transferencia', vencimientos: [{ fecha: '2026-12-01', importe: 121 }] };
const pago = () => ({ idProveedor: 3, aplicaciones: [{ idCompra: 9, importe: 100, pendienteEsperado: 121 }],
  metodo: 'transferencia', situacion: 'realizado', referencia: 'F-1', evidencia: 'Confirmación concreta del usuario: transferencia de 100 euros realizada', fechaPagoReal: fechaMadrid() });

test('new write tools require permission and preview; payment validates centre and balances then verifies the write', async () => fixture(async f => {
  const read = await f.connect(false), write = await f.connect(true);
  const readTools = (await read.listTools()).tools;
  assert.ok(!readTools.some(t => t.name === 'ark_registrar_pago_proveedor'));
  assert.ok(readTools.some(t => t.name === 'ark_conciliar_factura_proveedor' && t.annotations.readOnlyHint));
  const args = { pago: pago(), ...ctx };
  const p = await f.call(write, 'ark_registrar_pago_proveedor', args);
  assert.equal(p.error, false); assert.equal(p.value.vistaPrevia, true); assert.equal(f.writes.length, 0);
  const bad = await f.call(write, 'ark_registrar_pago_proveedor', { ...args, confirmar: true, centroEsperado: 'Otro centro', huellaEsperada: p.value.huellaEsperada });
  assert.equal(bad.error, true); assert.equal(f.writes.length, 0);
  const saved = await f.call(write, 'ark_registrar_pago_proveedor', { ...args, confirmar: true, centroEsperado: 'Centro ficticio Norte', huellaEsperada: p.value.huellaEsperada });
  assert.equal(saved.error, false); assert.equal(saved.value.guardado, true); assert.equal(f.writes.length, 1);
  assert.equal(saved.value.verificacion.compras[0].documento.importePendiente, 21);
  const retry = await f.call(write, 'ark_registrar_pago_proveedor', { ...args, confirmar: true, centroEsperado: 'Centro ficticio Norte', huellaEsperada: p.value.huellaEsperada });
  assert.equal(retry.error, true); assert.equal(f.writes.length, 1);
}));

test('invoice metadata preserves delivery note, stock and earlier observations; repeated annotation is a no-op', async () => fixture(async f => {
  const c = await f.connect(true);
  const args = { idCompra: 9, idProveedor: 3, factura, ...ctx };
  const p = await f.call(c, 'ark_anotar_factura_proveedor', args);
  assert.equal(f.writes.length, 0);
  const saveArgs = { ...args, confirmar: true, centroEsperado: 'Centro ficticio Norte', huellaEsperada: p.value.huellaEsperada };
  assert.equal((await f.call(c, 'ark_anotar_factura_proveedor', saveArgs)).value.guardado, true);
  assert.equal(f.compra.documento.documentoProveedor.numero, 'A-001');
  assert.match(f.compra.documento.documentoProveedor.observaciones, /^Nota original/);
  assert.equal(f.compra.documento.importePendiente, 121);
  assert.equal((await f.call(c, 'ark_anotar_factura_proveedor', saveArgs)).value.yaAnotada, true);
  assert.equal(f.writes.length, 1);
}));

test('clinical updates append text and preserve treatments, reject wrong patients and changed versions', async () => fixture(async f => {
  const c = await f.connect(true);
  const args = { idVisita: 11, idMascotaEsperado: 12, campos: { anamnesis: 'Nuevo dato dictado por el veterinario' }, ...ctx };
  assert.equal((await f.call(c, 'ark_actualizar_visita', { ...args, idMascotaEsperado: 13 })).error, true);
  const p = await f.call(c, 'ark_actualizar_visita', args);
  assert.equal(f.writes.length, 0);
  f.visita.version++;
  assert.equal((await f.call(c, 'ark_actualizar_visita', { ...args, confirmar: true, centroEsperado: 'Centro ficticio Norte', huellaEsperada: p.value.huellaEsperada })).error, true);
  const fresh = await f.call(c, 'ark_actualizar_visita', args);
  const saved = await f.call(c, 'ark_actualizar_visita', { ...args, confirmar: true, centroEsperado: 'Centro ficticio Norte', huellaEsperada: fresh.value.huellaEsperada });
  assert.equal(saved.value.guardado, true); assert.equal(f.writes.length, 1);
  assert.equal(f.visita.documento.anamnesis, 'Texto previo\n\nNuevo dato dictado por el veterinario');
  assert.deepEqual(f.visita.documento.recetas, [{ id: 6 }]); assert.deepEqual(f.visita.documento.entradasTratamiento, [{ id: 5 }]);
}));

test('unknown payment response never retries a potentially accepted write', async () => fixture(async f => {
  const c = await f.connect(true); f.disconnect();
  const args = { pago: pago(), ...ctx };
  const p = await f.call(c, 'ark_registrar_pago_proveedor', args);
  const r = await f.call(c, 'ark_registrar_pago_proveedor', { ...args, confirmar: true, centroEsperado: 'Centro ficticio Norte', huellaEsperada: p.value.huellaEsperada });
  assert.equal(r.error, true); assert.equal(r.value.resultadoDesconocido, true); assert.equal(r.value.noReintentar, true); assert.equal(f.writes.length, 1);
}));
