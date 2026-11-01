# WhatsApp Bot QR

Este canal usa un proceso Node.js independiente de Zernio. El panel principal conserva `/api/whatsapp` y sus tablas; el nuevo canal usa `/api/whatsapp-bot`, `whatsapp_bot_*` y un proceso PM2 separado. Ambos pueden existir para un mismo tenant, pero no se debe vincular el mismo número de WhatsApp a dos transportes simultáneos.

## Arquitectura

1. El propietario abre **WhatsApp Bot QR** y pulsa **Conectar**. La app crea un UUID por tenant en `whatsapp_bot_registry`.
2. La app solicita la sesión por HTTP a `127.0.0.1:3013`, autenticada con `WHATSAPP_BOT_GATEWAY_SECRET`. El proceso Baileys guarda credenciales en `data/whatsapp-bot/<tenant>/<uuid>` y devuelve estado y QR Base64 para polling cada 4 segundos.
3. Los mensajes nuevos de contactos se entregan por webhook local con HMAC SHA-256. La app resuelve el tenant desde el UUID, deduplica por identificador de mensaje y llama al motor de pedidos existente. Las opciones se presentan numeradas y se guardan por conversación para traducir las respuestas del cliente a comandos del motor. Los pedidos reciben origen `whatsapp_bot` para no mezclarse con el resumen de Zernio. Las imágenes se comprimen y se guardan en `data/whatsapp-bot-media/<tenant>`; el bot acusa recibo y el panel permite verlas.
4. El cliente escribe al número de WhatsApp vinculado, por ejemplo desde un enlace `https://wa.me/52...` que el negocio puede compartir en sus redes o en un QR propio. El QR del panel sirve únicamente para vincular el teléfono del negocio; no se comparte con compradores.
5. El bot guía la selección de productos con respuestas numeradas. Si el cliente elige domicilio, le pide compartir **Ubicación actual** con el clip o botón `+` de WhatsApp y luego escribir calle, colonia y referencias. Las coordenadas llegan al motor de pedidos, que usa las zonas y tarifas de entrega configuradas en el negocio. Si la zona requiere revisión, el envío y el total se muestran como pendientes de confirmar.
6. Al registrar el pedido, el bot envía una confirmación con productos, subtotal, costo de domicilio, total, dirección y enlace de ubicación tomados del pedido guardado. El panel también ofrece plantillas de bienvenida, preparación, pedido listo y pedido en camino. Al guardar una edición de las plantillas de **solicitud de ubicación** o **confirmación**, el bot la usará automáticamente en los siguientes pedidos. Las otras plantillas se pueden enviar manualmente seleccionando un pedido, que rellena sus valores reales y el destinatario. Las variables faltantes se rechazan.

## Operación

Configura el mismo archivo `.env.production` para los dos procesos:

```env
WHATSAPP_BOT_GATEWAY_SECRET=<secreto aleatorio de al menos 32 caracteres>
WHATSAPP_BOT_GATEWAY_PORT=3013
PORT=3003
```

Genera el secreto, por ejemplo, con `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. El puerto 3013 debe quedar accesible sólo desde `127.0.0.1`; no se publica en Nginx. En PM2, `ecosystem.config.js` incluye `chatbotpro-whatsapp-bot`. Los scripts de deploy lo arrancan cuando el secreto está configurado. El directorio `data/` debe persistir entre despliegues, mantenerse privado y respaldarse junto con la base de datos.

`useMultiFileAuthState` permite una primera integración simple, pero la [documentación de Baileys](https://github.com/WhiskeySockets/docs/blob/main/authentication/session-management.mdx) recomienda un almacén de autenticación SQL o NoSQL para producción. Antes de escalar muchas sesiones o ejecutar varias réplicas, migra esas credenciales a un almacén transaccional y añade una cola persistente para eventos entrantes. Una sola instancia PM2 del gateway evita acceso concurrente a archivos de credenciales.

Baileys evita configurar la Cloud API de Meta, pero es un cliente **no oficial**. No evita ni garantiza protección frente a bloqueos o restricciones de WhatsApp. Se debe usar para conversaciones iniciadas por los clientes y evitar envíos masivos o automatizaciones agresivas; su disponibilidad depende de WhatsApp y de cambios en su protocolo.
