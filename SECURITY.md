# Seguridad operativa

## Acciones obligatorias antes del siguiente despliegue

1. Rotar de inmediato la contraseña de Neon porque una cadena de conexión estuvo versionada en `deploy/deploy.sh`.
2. Generar valores nuevos e independientes para `JWT_SECRET` y `SUPERADMIN_JWT_SECRET` (mínimo 32 caracteres aleatorios).
3. Definir `SUPERADMIN_USERNAME` y una `SUPERADMIN_PASSWORD` única de al menos 12 caracteres. Al iniciar en producción, el sistema desactiva la cuenta heredada `mike` si se configura otro usuario.
4. Mantener `PG_SSL_REJECT_UNAUTHORIZED=true`.
5. Configurar el demo únicamente con un tenant exclusivo, una clave aleatoria y las variables `DEMO_*` documentadas en `.env.example`.

## Rotación de datos cifrados

`DATA_ENCRYPTION_KEY` también estuvo expuesta en el historial. No debe cambiarse directamente: los teléfonos y datos de clientes existentes quedarían ilegibles. La rotación requiere un proceso controlado que descifre con la clave anterior, vuelva a cifrar con una nueva y valide todos los registros antes de retirar la clave anterior.

## Historial de Git

Eliminar el secreto del archivo actual no lo borra de commits anteriores. Después de rotar todas las credenciales, un administrador del repositorio debe limpiar el historial con una herramienta como `git filter-repo`, coordinar el cambio con el equipo y volver a clonar los repositorios de trabajo. La rotación es obligatoria aunque se limpie el historial.

## Verificación periódica

- Ejecutar `npm audit --omit=dev` antes de cada despliegue.
- Revisar intentos fallidos y respuestas `429`/`403` en los registros del proxy y la aplicación.
- Probar login, demo, POS, KDS y cargas de imágenes después de cualquier cambio de autenticación o proxy.
