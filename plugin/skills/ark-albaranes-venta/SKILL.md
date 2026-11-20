---
name: ark-albaranes-venta
description: Prepara y registra un albarán de venta a cliente desde ChatGPT tras revisar en la pantalla o terminal de ARK el cliente, productos, tarifa, descuentos, stock y total. Puede dejar el albarán pendiente de cobro.
---

# Albaranes de venta a clientes en ARK

1. Verifica la empresa y resuelve tienda/terminal con `ark_terminales`. Busca el cliente con `ark_buscar_cliente` y revisa `ark_ficha_cliente` cuando haga falta distinguir homónimos. Añade la mascota si el usuario la identifica y corresponde a la venta.
2. Resuelve artículos por código, EAN o descripción exacta. Usa cantidades en unidades de venta y verifica existencias y lotes caducables si corresponde. Para medicamentos sujetos a prescripción, usa el flujo clínico autorizado si ARK lo requiere. Si llegan conceptos de una visita, presupuesto o reserva, comprueba si la pantalla ya los incorpora antes de añadirlos otra vez.
3. Abre la pantalla de venta del cliente en ARK. Valida el centro y la terminal visibles. Comprueba la tarifa real del cliente, conceptos precargados, descuentos y sus bases de aplicación, IVA y total. Si se indica descuento adicional, comprueba en la pantalla cómo ARK lo aplica a la tarifa del cliente y aclara cualquier ambigüedad. Revisa que no exista ya el mismo albarán antes de guardar.
4. Presenta al usuario la revisión de la pantalla: cliente, centro, terminal, artículos, unidades, lotes pertinentes, precios, descuentos, impuestos, total y estado de cobro. Espera confirmación expresa de esa vista previa. Si cambian centro, cliente, cantidades o importes, presenta la nueva vista previa.
5. Guarda como albarán de venta. Déjalo pendiente cuando así se solicite o cuando no se haya autorizado facturar o registrar un cobro. Si la pantalla agrupa esas acciones, verifica los controles antes de finalizar. Un albarán de venta no es un albarán de compra a proveedor.
6. Reabre o consulta el albarán y verifica número, cliente, centro, total y estado. Ante un guardado de resultado incierto, busca primero el documento para evitar duplicados.

## Capacidad de la conexión

Usa la interfaz de venta autorizada de ARK si el MCP no ofrece una herramienta específica de albaranes de venta, como ocurre en esta versión del repositorio. Si no hay acceso a la pantalla ni herramienta de escritura, entrega la vista previa y deja explícito que está pendiente. Para la operativa de la interfaz, consulta la ayuda de ARK disponible en la sesión y la [guía pública de venta de ARK](https://gestionveterinariaark.es/venta-centro-veterinario/). Los nombres de los controles pueden variar con la versión.
