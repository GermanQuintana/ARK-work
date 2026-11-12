# Instalar ARK Gestión Veterinaria en tu ChatGPT

**ARK Work by Wairua — guía para veterinarios (beta privada)**

Este complemento conecta tu propia cuenta de ARK Gestión Veterinaria con ChatGPT mediante un servidor MCP central alojado por Wairua. **No necesitas instalar software, contratar un servidor ni facilitar tu contraseña a Wairua por correo o chat.** Tus credenciales se introducen directamente en el formulario HTTPS de autorización, donde el servidor las almacena cifradas durante la conexión.

## Requisitos
- Tener acceso legítimo a un centro dado de alta en ARK Gestión Veterinaria, con código de empresa, usuario y contraseña personales.
- Tener una cuenta de ChatGPT con permisos para añadir un servidor MCP personalizado (la disponibilidad depende de la cuenta o del espacio de trabajo). 
- Para **beta**, usar primero solo consultas, sin operaciones de escritura.

## Instalación (cuando Wairua confirme que la beta está habilitada)
1. Abre ChatGPT en un navegador e inicia sesión.
2. Ve a **Complementos → Añadir → Servidor MCP personalizado**. Si tu cuenta no ofrece esa opción, pide acceso a tu administrador o utiliza una cuenta compatible.
3. Introduce:
   - **Nombre**: ARK Gestión Veterinaria by Wairua
   - **URL de conexión**: `https://mcp-ark.wairua.xyz/mcp`
   - **Autenticación**: OAuth
4. Deja que ChatGPT detecte OAuth automáticamente. Si te solicita **registro del cliente**, utiliza DCR (registro dinámico) y no inventes un ID de cliente.
5. Si aparecen los ámbitos, empieza con `ark:read`. No habilites `ark:write` hasta que tu clínica autorice las operaciones.
6. Crea el complemento; pulsa **Conectar**.
7. En el formulario de `https://mcp-ark.wairua.xyz/login`, indica el **código de empresa ARK** (no la URL del programa), tu usuario y contraseña. Verifica el dominio antes de introducirlos.
8. Pulsa **Comprobar y autorizar**. Debes regresar a ChatGPT y ver el estado **Conectado**.
9. Selecciona **Probar en el chat** y pide: «Usa ARK Gestión Veterinaria para identificar mi empresa. No modifiques ningún dato». 
10. Comprueba que ChatGPT muestra **tu centro**, nunca otro centro. Si no coincide, detén el uso y comunícalo a Wairua sin enviar información clínica.

## ¿Dónde están los datos?
- ARK Work consulta en tiempo real la API de ARK mediante los permisos de tus credenciales.
- El servidor de Wairua almacena **credenciales de ARK cifradas** y tokens de sesión; **no** copia deliberadamente el historial clínico a su base de datos.
- Las respuestas clínicas solicitadas **atraviesan** el servidor y se envían a ChatGPT, por lo que debes asegurarte de que cuentas con base jurídica, contrato y autorización corporativa para usar este flujo con datos personales.
- La beta no equivale a una certificación de cumplimiento normativo; evita introducir datos de pacientes reales hasta que tu entidad confirme el tratamiento de datos.

## Problemas habituales
- **No aparece «Añadir servidor MCP»**: tu plan o espacio de trabajo no lo permite.
- **Error de registro de OAuth**: verifica que el callback mostrado por ChatGPT sigue el formato esperado y que la versión beta del servidor ya se ha desplegado. No se deben añadir dominios arbitrarios.
- **Error 401**: comprueba tus credenciales y el código de empresa en ARK.
- **Error 403**: puede ser un formulario caducado o una validación CSRF; cierra esa autorización y comienza una nueva desde ChatGPT.
- **Conectado pero no hay herramientas**: vuelve a comprobar la conexión y los permisos del complemento.
- **No vuelve a ChatGPT**: anota el error sin publicar cookies ni la URL con el código OAuth; puede tratarse de la política CSP.
- **Empresa incorrecta**: interrumpe las consultas y notifica un posible incidente de aislamiento.

## Administradores y despliegue
Instrucciones operativas, controles de seguridad, copias, rollback y Docker: [Runbook Hostinger](HOSTINGER-SEGURIDAD-Y-OPERACIONES.md).

**Estado**: esta guía corresponde a una rama de revisión y todavía no implica que el servidor público esté actualizado para aceptar múltiples complementos. Wairua debe completar un despliegue controlado antes de invitar a terceros.
