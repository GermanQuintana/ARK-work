# ARK Work

Versión web de la integración con ARK Gestión Veterinaria para **ChatGPT Work**. Servidor MCP remoto por HTTPS, OAuth con PKCE y skills de clínica, almacén y compras. No requiere Node.js en el ordenador de cada usuario.

**Estado: código preparado y probado con un ARK simulado. Todavía no existe un endpoint público desplegado ni un plugin web registrado. Este repositorio por sí solo no instala una conexión funcional en ChatGPT.**

## Qué hace

- Reutiliza las 39 herramientas del plugin local [ark-vet](https://github.com/GermanQuintana/ark-vet), con contexto de clínica aislado por conexión. Añade `get_profile` para identificar el perfil autenticado.
- Cada usuario se conecta con el código de empresa, usuario y contraseña de su ARK en una pantalla HTTPS del servicio; no los escribe en el chat.
- Permite consentir solo lectura (34 herramientas contando perfil) o lectura y escritura (40 herramientas). Compras, pedidos y comunicaciones mantienen vista previa y confirmación expresa; el permiso OAuth no sustituye la confirmación de cada operación.
- Guarda credenciales y registros OAuth cifrados con AES-256-GCM en SQLite; los tokens opacos se buscan por hash. No almacena historias clínicas ni documentos consultados en su base de datos. Los resultados solicitados viajan a ChatGPT.
- Usa sesiones MCP sin estado: cada petición crea un cliente ARK exclusivo para el perfil autenticado. Ninguna herramienta acepta un tenant o contraseña para cambiar de conexión.

## Cómo lo utilizará un compañero cuando esté publicado

1. Instalar **ARK Work** desde el enlace del plugin o el catálogo compartido disponible para su cuenta.
2. Pulsar **Conectar** y completar la autorización HTTPS con su acceso a ARK. Puede autorizar solo consultas o marcar el permiso para compras, pedidos y comunicaciones.
3. Abrir un chat de Work, mencionar el plugin y pedir «Consulta mi empresa y los centros disponibles».
4. Pedir consultas o adjuntar un albarán y solicitar «Usa la skill de compras y prepara este albarán para el centro [nombre]».

Instalar el repositorio desde una conversación web no despliega el servidor. El registro del MCP y la distribución del plugin dependen de los controles disponibles en la cuenta o workspace de ChatGPT.

## Despliegue del mantenedor

Hace falta un servidor con Docker, almacenamiento persistente, un dominio con DNS dirigido a él y salida HTTPS hacia la API de ARK. Esta versión está pensada para **una instancia del servicio con volumen persistente**, no para funciones sin disco o varias réplicas. El coste del alojamiento depende del proveedor.

1. Clona el repositorio en el servidor. Copia `.env.example` a `.env` y configura `WORK_DOMAIN`.
2. Genera una clave de 32 bytes: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Guarda el resultado como `WORK_ENCRYPTION_KEY` en el gestor de secretos o `.env` del servidor. Conserva una copia segura separada: sin ella no podrás descifrar los perfiles. No la pegues en chats ni la subas a GitHub.
3. Configura `OAUTH_REDIRECT_URIS` con la **URI exacta mostrada en la pantalla de gestión del MCP en ChatGPT**. Si hay varias, sepáralas por comas. No se permiten comodines. La URI estable solo debe usarse si ChatGPT muestra esa para tu conexión.
4. Revisa `ARK_BASE_URL`. Es una dirección del administrador, no una URL arbitraria suministrada por cada usuario. Para otra instalación de ARK con distinta API, configura otra instancia del servicio.
5. Ejecuta `docker compose up -d --build`. Caddy gestiona HTTPS; los puertos públicos son 80 y 443. El backend no publica su puerto directamente. Comprueba `https://TU_DOMINIO/healthz` y los metadatos OAuth.

No hay acceso de una clínica preconfigurado. No uses ni copies el `.env` del plugin local: en este servicio las conexiones de usuarios se crean por OAuth.

## Registro y paquete del plugin para Work web

1. En ChatGPT, abre **Plugins > + > Add custom MCP server**. Introduce `https://TU_DOMINIO/mcp` y configura OAuth con los scopes `ark:read ark:write` si quieres ofrecer ambas modalidades. El usuario aún debe consentir las escrituras. El servidor ofrece registro dinámico de clientes (DCR) y admite `none` o `client_secret_post`; no `client_secret_basic`. Copia del panel la URI de retorno exacta y añádela a la configuración del servidor antes de autorizar.
2. Crea y prueba la conexión. Su identificador técnico comienza por `plugin_asdk_app...` y aparece en la gestión del plugin.
3. Ejecuta en este repositorio:

```sh
node scripts/configure-plugin.mjs --url https://TU_DOMINIO --app-id plugin_asdk_app_ID_REAL
```

El script genera `plugin/plugin.json`, `.app.json` con la conexión registrada, `mcp.json` remoto y `.agents/plugins/marketplace.json`. Los archivos generados contienen identificadores públicos de conexión, nunca contraseñas. Revisa los valores y publícalos junto a las skills.

4. Vincula o importa el paquete con las opciones de plugins de tu cuenta. En Work también puedes proporcionar el ID técnico a `@plugin-creator` para asociar el MCP y las skills. Para compartirlo ampliamente, usa el flujo de publicación de plugins de OpenAI; no confundas tener un repositorio público con estar publicado en su directorio.
5. Prueba instalación y autorización desde una segunda cuenta antes de invitar a compañeros. Comprueba que ve su empresa y que una compra solo se guarda tras mostrar la vista previa y recibir confirmación. No uses una escritura real como primera prueba.

Documentación oficial: [inicio rápido](https://developers.openai.com/plugins/quickstart), [autenticación](https://developers.openai.com/plugins/build/auth) y [empaquetado](https://developers.openai.com/plugins/build/plugins).

## Desarrollo y pruebas

Node.js 24 o posterior en el servidor/desarrollo:

```sh
npm ci
npm test
npm audit
```

Las pruebas usan un ARK falso local y comprueban aislamiento entre clínicas, PKCE, audiencia, códigos de un solo uso, CSRF, permisos de escritura, perfiles estables, cifrado en disco, rotación y revocación de tokens. No usan datos de producción.

## Operación y límites

- Conserva y protege el volumen SQLite y la clave de cifrado. Las actualizaciones de código no deben borrar ese volumen ni generar otra clave.
- Revocar la conexión invalida sus tokens. El perfil cifrado permanece en el almacenamiento; la eliminación de perfiles y las políticas de retención requieren un procedimiento del operador antes de un lanzamiento general. No hay panel administrativo de borrado en esta versión.
- El endpoint de salud no verifica disponibilidad ni credenciales de una clínica.
- No actives registro de cuerpos, contraseñas, cookies o tokens en el proxy ni en el alojamiento. El servicio no imprime esos datos.
- Las pruebas automatizadas no sustituyen validar OAuth con una cuenta real de ChatGPT, revisar el despliegue y realizar una revisión de seguridad antes de ofrecer un servicio multiclínica público.
- El mismo perfil se identifica por la combinación de URL de ARK, código de empresa y usuario. Si el proveedor cambia esos identificadores, se considerará otro perfil.
