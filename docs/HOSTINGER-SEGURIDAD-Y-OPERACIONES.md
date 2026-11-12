# ARK Work en Hostinger — runbook de despliegue y seguridad
**Estado:** versión revisada en rama `security/multi-tenant-hardening-nov2026`; NO desplegar a terceros sin pasar la CI y la auditoría operativa. Última revisión: 13-11-2026.

## Fuente de verdad y recuperación del código
Repositorio completo: https://github.com/GermanQuintana/ARK-work
Rama de revisión: https://github.com/GermanQuintana/ARK-work/tree/security/multi-tenant-hardening-nov2026
Todo el código de servidor, Dockerfile, pruebas, herramientas MCP y paquetes está versionado en esa rama. La configuración privada de producción **NO** está ni debe estar en GitHub.

## Diseño instalado (observado en terminal, noviembre de 2026)
- Hostinger KVM 4, Ubuntu 24.04, IP pública `2.24.10.96`.
- Subdominio: `mcp-ark.wairua.xyz` -> registro A a esa IP.
- Repo de producción: `/opt/mcp-ark/ARK-work`.
- Compose específico: `/opt/mcp-ark/ARK-work/compose.vps.yaml` (creado a mano, no pertenece al repositorio original).
- Datos: volumen Docker `ark-work_ark-data`, con SQLite y credenciales cifradas; no borrar ni restaurar sin su `WORK_ENCRYPTION_KEY`.
- Variables en `.env` (permisos 0600; nunca copiar a GitHub/chat).
- Backend: contenedor `ark-work-ark-work-1`, publicado exclusivamente en `127.0.0.1:8787`.
- Entrada HTTPS: contenedor `proxy-nginx-hybrid`, `/root/kit-agente/components/edc/edc-hybrid/proxy-nginx/nginx.conf` montado como `/etc/nginx/conf.d/default.conf`. También sirve `provider.cvamarosa.cloud`: extremo cuidado.
- Certificado: `/etc/letsencrypt/live/mcp-ark-wairua/`; copia al directorio Docker `/root/kit-agente/components/edc/edc-hybrid/proxy-nginx/certs/` como `mcp-ark.wairua.xyz.crt` y `.key`. Certbot `--webroot -w /var/www/html` mediante Nginx de Ubuntu (puerto 80).
- Nginx Ubuntu escucha 80 y 444; 443 lo ocupa el proxy Docker.
- Red inicial de MCP `ark-work_default`; por integración se agregó el MCP también a `agente_1-edc-hybrid-connector-airflow_edc-network`. Esto **debe corregirse** para reducir superficie lateral.

## Modelo multiempresa
Cada instalación OAuth se autoriza por `tenant`, usuario y contraseña de ARK. La API de ARK configurada es `https://ark.gestionveterinariaark.es/ark/rest`; el código de empresa NO es la URL de login. Terminal y empleado son distintos del tenant y deben escogerse/validarse para operaciones por centro. Burela, Viveiro y Furgoneta son ejemplos de terminales, no de tenant.

El `get_profile` devuelve el perfil autenticado; comprobarlo para cada cuenta. El MCP crea un `ArkClient` nuevo por petición de herramienta y la autorización OAuth determina el perfil (no aceptar tenant indicado por argumentos de herramientas).
La rama reforzada deja de reutilizar globalmente perfiles según `tenant+username`. Cada autorización recibe un ID de perfil exclusivo. Los perfiles nuevos se eliminan al revocar su familia de tokens, y los que no completan el intercambio caducan. Las familias tienen vida máxima de 30 días. **Limitación:** perfiles heredados de la versión previa permanecen hasta su eliminación controlada; no realizar borrado global sin inventario/copia.

## Límites y riesgos pendientes
1. `ark:write` habilita herramientas de escritura; en varios endpoints `confirmar=true` sigue dependiendo del cliente, sin un ticket transaccional de confirmación firmado y de un solo uso en servidor. Recomendado: no ofrecer escritura pública hasta tener ese control y tests de doble envío/replay.
2. La separación por tenant depende también del control de acceso de ARK. El MCP no puede garantizar que la API remota no devuelva datos cruzados si ARK falla; requiere pruebas con dos empresas reales autorizadas.
3. Se han observado avisos npm de dependencias incluyendo Zod y body-parser. La CI debe estar verde (tests + `npm audit --omit=dev --audit-level=high`) antes de distribución.
4. La rama no está desplegada por la creación del PR. Evitar sobrescribir cambios locales en `src/app.ts`, `.env` o la configuración del Nginx del espacio de datos.
5. El CSP del formulario exige `form-action 'self' https://chatgpt.com` para seguir el retorno OAuth. `Origin: null` solo se admite con navegación de mismo origen según Fetch Metadata, **además** de cookie opaca y CSRF. Desactivar esas barreras no es aceptable.
6. No publicar registros `LOGIN_DIAGNOSTIC`, cookies, secretos, cabeceras Authorization, URI de retorno con códigos `code` ni cuerpos de operaciones.
7. El repositorio es público: revisar ausencia de datos clínicos y claves en cada commit.

## Instalación reproducible (entorno nuevo)
```bash
sudo mkdir -p /opt/mcp-ark
cd /opt/mcp-ark
git clone https://github.com/GermanQuintana/ARK-work.git
cd ARK-work
# Para probar la rama reforzada, no hacerlo automáticamente en producción:
git fetch origin security/multi-tenant-hardening-nov2026
git switch --detach origin/security/multi-tenant-hardening-nov2026
```
Crear `.env` desde la plantilla, completar `WORK_DOMAIN=mcp-ark.wairua.xyz`, `OAUTH_REDIRECT_URIS` con el callback EXACTO del complemento de ChatGPT, `ARK_BASE_URL` autorizado, y una clave AES de 32 bytes en base64 (generar una sola vez con `openssl rand -base64 32`). `chmod 600 .env`. No imprimir ni renovar la clave accidentalmente.

El archivo `compose.vps.yaml` separa proyecto `ark-work` del EDC, publica `127.0.0.1:8787:8787`, monta `ark-data:/app/data` y utiliza la red que pueda alcanzar el Nginx. Antes de recrear, comprobar `docker compose -f compose.vps.yaml config --quiet`; evitar poner Caddy a escuchar 80/443 donde hay proxy existente.

Verificar:
```bash
docker compose -f compose.vps.yaml ps
curl -fsS https://mcp-ark.wairua.xyz/healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp-ark.wairua.xyz/.well-known/oauth-authorization-server
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp-ark.wairua.xyz/mcp
```
Esperado 200 en OAuth, 401 anónimo en MCP y OK en salud; esto no garantiza que la autenticación real funcione.

## Migración de red a menor privilegio
**Objetivo:** conectar el proxy al puente `ark-work_default` y retirar **MCP** de la red EDC, de forma que el MCP no pueda alcanzar otros contenedores del espacio de datos.
1. Hacer snapshot de VPS y copia de los Compose antes de alterar redes.
2. Conectar temporalmente el proxy a red `ark-work_default` (no recrea contenedor):
   `docker network connect ark-work_default proxy-nginx-hybrid`
3. Probar desde el proxy/sidecar Docker el nombre `ark-work:8787`, salud e HTTPS.
4. Quitar la red externa EDC de `compose.vps.yaml`, dejando solo la red privada del MCP; aplicar `docker compose -f compose.vps.yaml up -d --no-deps`.
5. Probar la ruta HTTPS y el aislamiento antes de desconectar el enlace antiguo: `docker network disconnect agente_1-edc-hybrid-connector-airflow_edc-network ark-work-ark-work-1` si siguiera conectado.
6. Hacer **persistente** la conexión del proxy al puente privado en la definición real de Docker Compose de Nginx, con ventana de mantenimiento y plan de rollback. Un `docker network connect` manual se pierde si se recrea el proxy. **No recrear el EDC automáticamente.**
7. Limitar, si procede, el proxy a un puente dedicado y reglas de egreso del MCP solo hacia la API ARK, servicios DNS y actualizaciones necesarias.
Comprobar redes: `docker inspect ... --format '{{json .NetworkSettings.Networks}}'`.

## Nginx y TLS
El bloque `server { listen 443 ssl; server_name mcp-ark.wairua.xyz; ... location / { proxy_pass http://ark-work:8787; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; ... } }` reside agregado al Nginx existente; NO sobreescribir otros `server`. Copia previa y `docker exec proxy-nginx-hybrid nginx -t` antes de `docker exec proxy-nginx-hybrid nginx -s reload`. `HTTP 401` en `provider.cvamarosa.cloud` con `WWW-Authenticate` significa que sigue protegido, no caída.

Certbot renueva el PEM original, pero la copia dentro del volumen Nginx **NO** se actualiza automáticamente. Instalar y probar el hook `scripts/deploy-hostinger-cert.sh` de esta rama. Auditar permisos del certificado (0644) y clave privada (0600). Verificar `certbot renew --dry-run` y efectividad del hook por separado.

## Errores ya encontrados
| Síntoma | Diagnóstico | Solución |
|---|---|---|
| `npm: command not found` | Ubuntu sin Node/npm | Construir y probar dentro de `node:24-bookworm-slim` |
| `Invalid Host: 127.0.0.1` | Restricción de Host | Usar `curl -H 'Host: mcp-ark.wairua.xyz' http://127.0.0.1:8787/healthz` |
| `wget: executable file not found` | Imagen Nginx mínima | Usar contenedor temporal `curlimages/curl` |
| `Connection timed out` entre redes | Redes Docker aisladas | Crear conexión de proxy a puente dedicado (no abrir puertos indiscriminadamente) |
| `OAUTH_REDIRECT_URIS is missing` | Variable no configurada | Callback exacto de ChatGPT en `.env` |
| `POST /login 403` | Cookie, CSRF u Origin | Verificar metadatos Fetch; no deshabilitar CSRF |
| `Origin: null` Chrome | Navegación del formulario | Excepción limitada con Fetch Metadata y CSRF |
| `302` pero navegador no vuelve a ChatGPT | CSP `form-action 'self'` bloquea retorno | Añadir solo `https://chatgpt.com` a form-action |
| `POST /login 302` | Verificación de ARK y redirección correctas | Comprobar finalización del retorno en ChatGPT |
| `/mcp` anónimo 401 | Protección OAuth | Resultado esperado |
| Certificado caducado aunque Certbot renovó | Copia estática en Docker | Hook de despliegue y recarga controlada |
| Fallo de login con código de empresa | Tenant confundido con terminal | Verificar tenant con ARK; terminal se selecciona aparte |
| Errores después de `git pull` | Cambios locales no versionados y configuración propia | Copia + revisión de diferencias; actualizar en release separada |

## Restauración y controles
- Backup completo de `.env`, SQLite y WAL/SHM de forma consistente, archivo Compose y configuración Nginx; claves en almacén cifrado diferente del VPS.
- Para SQLite en producción usar API de backup SQLite en vez de copiar base activa sin sincronizar WAL; no registrar credenciales descifradas.
- Restaurar solo con clave original; probar restauración en máquina aislada con cuentas de prueba.
- Diagnóstico `docker logs --tail 50 ark-work-ark-work-1` con sanitización, `docker compose ... ps`, `nginx -t`, `certbot certificates`, `docker network inspect`.
- No rotar la clave de cifrado sin migración formal.
- Seguridad antes de publicar: CI verde, auditoría de dependencias resuelta, dos clínicas de prueba, revocación inmediata, escrituras atómicas, selección correcta de terminal/centro, pruebas de restauración, revisión RGPD/encargo de tratamiento/transferencia de datos hacia ChatGPT, política de retención y gestión de incidentes.

## Alcance de esta documentación
Este runbook describe la instalación observada y la versión GitHub de revisión. No certifica por sí mismo el cumplimiento legal ni prueba la configuración real actual del VPS. Toda publicación pública queda condicionada a la verificación operativa antes señalada.
