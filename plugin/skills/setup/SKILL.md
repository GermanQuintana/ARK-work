---
name: setup
description: Conectar la clínica del usuario al MCP remoto de ARK Work, comprobar el perfil y resolver una conexión que falta. Úsala al configurar el plugin en ChatGPT Work web.
---

# Conectar ARK Work

Este plugin utiliza el MCP remoto registrado y asociado en `.app.json`. No arranques procesos locales, instales Node.js ni abras formularios PowerShell para el usuario de Work web.

1. Si el plugin aún no tiene un endpoint y una conexión registrada, explica que el mantenedor debe desplegarlo y registrar su URL HTTPS; enlazar GitHub por sí solo no lo pone en marcha. No inventes una URL ni afirmes que está conectado.
2. Invita al usuario a conectar la cuenta mediante la autorización del plugin en ChatGPT. Introduce las credenciales de ARK únicamente en el formulario HTTPS del servicio de confianza; nunca las pidas en el chat, las pases como parámetros de herramientas ni las guardes en GitHub.
3. Cada conexión pertenece al perfil de empresa/usuario autenticado. No reutilices una conexión de otra clínica. El usuario puede autorizar solo consultas o permitir también escrituras. Si falta una herramienta de compras, comprueba si la conexión tiene permiso de escritura y guía una nueva autorización solo si el usuario lo solicita.
4. Verifica `get_profile`, `ark_empresa` y `ark_terminales`; presenta la clínica y los centros que realmente responden. Si la autenticación falla, solicita reconectar; no cambies de perfil ni inventes valores.
5. Para guardar compras o pedidos, sigue la skill de compras y muestra el centro, tienda, terminal, artículos, cantidades e importes de la vista previa; espera confirmación expresa antes de guardar. Conserva el orden inverso de introducción de las líneas del documento.

Las credenciales de ARK se guardan cifradas en el servidor del servicio para mantener la conexión. Los resultados solicitados se procesan en ChatGPT. No describas esta conexión como local ni como almacenamiento exclusivo en el equipo del usuario.
