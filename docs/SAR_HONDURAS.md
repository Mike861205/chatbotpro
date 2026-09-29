# Facturación SAR para tenants de Honduras

## Alcance

El módulo aparece únicamente cuando el país elegido para el tenant es Honduras (`tenants.phone_country = 'HN'`). El propietario configura el emisor, registra las autorizaciones de **autoimpresor** obtenidas en la Oficina Virtual del SAR, clasifica productos por ISV y consulta ventas, facturas emitidas y comprobantes recibidos de proveedores. El cajero o personal con permiso de POS puede emitir e imprimir una factura desde el historial de ventas de su sucursal.

No hay integración de solicitudes de rangos o validación en tiempo real con una API pública del SAR. ChatBotPro **no solicita folios al SAR**: el obligado tributario obtiene el SAR-927 y copia el CAI, establecimiento, punto de emisión, rango y fecha límite. La autorización de emisión debe existir antes de facturar.

## Preparación del cliente

1. Confirmar que el tenant eligió Honduras y que su configuración regional usa HNL y `America/Tegucigalpa`.
2. Inscribirse o comprobar que está inscrito en el Régimen de Facturación; gestionar ante el SAR la autorización de impresión por autoimpresor para **Factura (tipo 01)** y, si atenderá devoluciones mediante notas, **Nota de Crédito (tipo 07)**. Cada tipo necesita el rango que figure en su SAR-927. Conservar ambos documentos.
3. En **Facturación Honduras**, guardar RTN, razón social, nombre comercial, domicilio y teléfono exactamente como correspondan al emisor autorizado.
4. Asignar a cada sucursal un establecimiento y punto de emisión según el SAR-927. Cargar tipo, CAI, primer/último correlativo, fecha límite y PDF. Si parte del rango se utilizó en otro sistema, indicar el **siguiente** correlativo aún no emitido. Verificarlo contra el libro previo; el sistema no puede descubrir automáticamente números usados fuera de ChatBotPro.
5. En **Productos** o en la clasificación en lote de **Facturación Honduras**, clasificar cada artículo como exento, gravado al 15% o al 18%, con revisión del contador. El precio de catálogo que llega a POS se trata como **precio final con ISV incluido**. Configurar también el tratamiento del servicio de entrega. No usar el impuesto genérico de productos del sistema en las ventas que se facturarán con SAR.
6. Hacer una venta de prueba en una sucursal y comprobar encabezado, RTN, CAI, rango, fecha límite, correlativo, desglose e impresión antes de operar con clientes.

## Flujo diario

- El POS guarda la venta y una copia de la categoría ISV de cada artículo. Las promociones quedan reflejadas en el precio final de la partida. Las órdenes del chatbot o autoservicio deben **cobrarse/importarse al POS** antes de emitir desde este módulo. Una orden de compra de inventario no equivale a una factura del proveedor.
- En el historial de ventas POS, pulsar **Facturar SAR**, indicar receptor y RTN si corresponde, revisar y emitir. También se puede hacer en **Facturación Honduras**. Se permiten ventas cobradas y ventas a crédito confirmadas.
- El servidor bloquea la venta y el rango autorizado dentro de una transacción; comprueba sucursal, emisor, vigencia, correlativos, clasificación ISV y que el total fiscal coincida con la venta. Si todo es válido, guarda un comprobante inmutable con los datos fiscales cifrados y avanza el siguiente correlativo. La reimpresión usa esa copia fiscal, incluso si después cambian el producto o el perfil del negocio.
- La anulación conserva el correlativo y el comprobante con la leyenda **ANULADA**. No devuelve el número al rango. Después puede emitirse una factura corregida con otro número. Una factura con notas de crédito vigentes no se puede anular sin resolver antes esas notas.
- Para una devolución, abrir la factura y seleccionar cantidades por partida. El sistema bloquea cantidades mayores a las pendientes, toma el tratamiento tributario de la factura original, emite una **Nota de Crédito tipo 07** con rango propio y la relaciona con el número, CAI y fecha de la factura. Después registrar la devolución por efectivo, tarjeta o transferencia. Si la venta sigue a crédito, aplicar la nota al saldo pendiente; la cola de cobro y el corte muestran el importe reducido. El efectivo sale del corte abierto de la sucursal. Elegir reposición de inventario únicamente cuando la mercancía vuelva a ser vendible; comida preparada normalmente no se repone. Una nota con devolución registrada no se anula desde este flujo: requiere conciliación contable.
- Para una venta a comprador exonerado, seleccionar **Venta a comprador exonerado** en POS antes de cobrar, capturar nombre, RTN y referencia de OCE, constancia o registro SAG. El precio del catálogo incluye ISV; el servidor calcula la base sin impuesto para cada producto gravado, cobra ese importe y lo conserva separado de los productos exentos. En **Facturación Honduras**, adjuntar el PDF de sustento antes de emitir la factura. El nombre y RTN del comprobante deben ser los capturados en caja. El emisor debe comprobar la vigencia y alcance de la exoneración con el documento del cliente.
- Las facturas recibidas de proveedores se registran aparte y se pueden vincular al ID de una orden de compra. Se capturan RTN/CAI/número, fechas de emisión y contabilización, bases exentas, exoneradas y gravadas, ISV, porción de ISV acreditable, total y opcionalmente el PDF. La clasificación de crédito fiscal se decide con el contador; el sistema no presupone que todo ISV de compra sea acreditable. La nota de crédito del proveedor, tipo 07, se vincula a la factura original y disminuye compras y crédito fiscal sin borrar el original. Si la captura fue errónea se invalida con motivo y se vuelve a ingresar.
- En **Expediente mensual SAR**, el propietario obtiene un libro de trabajo Excel con facturas, notas de crédito, compras y un resumen indicativo para ISV 201 y DMC. Las retenciones, pagos, saldos anteriores, compensaciones y cesiones se agregan manualmente con comprobante PDF; el contador comprueba que procedan en ese período. Debe presentar las declaraciones desde la [Oficina Virtual](https://www.sar.gob.hn/ovi/) y después cargar el acuse PDF/número. Si cambian los registros fiscales o ajustes luego del acuse, el sistema marca el expediente para revisión. El Excel **no es la plantilla oficial de carga DMC**.

## Cuando se acaban o vencen los folios

Ejemplo: el SAR autorizó `000-002-01-00001001` al `000-002-01-00002000` (1,000 números). Después de la factura `...00002000`, **Disponibles = 0** y la siguiente emisión responde con bloqueo. El cliente entra a la Oficina Virtual del SAR, solicita una nueva autorización de autoimpresor y descarga el nuevo SAR-927. El propietario carga el nuevo CAI, rango y fecha límite en ChatBotPro. Sólo entonces se reanuda la emisión. Si un rango vence con números sin usar, se deben seguir las instrucciones del SAR para notificar documentos vencidos y no utilizados; la app no envía esa notificación.

## API interna

Todas las rutas `/api/sar/*` requieren sesión y país `HN` en el servidor. Las configuraciones, compras, conciliación y anulaciones requieren propietario. La emisión exige permiso de POS y sucursal coincidente.

| Ruta | Uso |
| --- | --- |
| `GET /api/sar/overview` | Emisor, rangos, ventas POS, documentos y compras recientes. |
| `PUT /api/sar/profile` | Emisor fiscal. |
| `POST /api/sar/authorizations` | Alta de rango 01 o 07 y PDF SAR-927 (`multipart/form-data`). |
| `POST /api/sar/authorizations/:id/invalidate` | Corregir un registro local aún no usado. |
| `GET /api/sar/authorizations/:id/pdf` | Descargar SAR-927 cargado. |
| `POST /api/sar/orders/:id/issue` | Emisión idempotente para venta vigente. |
| `POST /api/sar/orders/:id/exoneration-proof` | Adjuntar sustento PDF de exoneración antes de facturar. |
| `GET /api/sar/documents/:id/print` | Copia imprimible. |
| `POST /api/sar/documents/:id/annul` | Anulación con motivo, sin recuperar correlativo. |
| `GET /api/sar/documents/:id/credit-balance` | Cantidades aún acreditables por partida. |
| `POST /api/sar/documents/:id/credit-notes` | Emitir nota tipo 07 vinculada a la factura. |
| `POST /api/sar/credit-notes/:id/refund` | Registrar devolución y reposición de stock opcional. |
| `POST /api/sar/purchases` | Registrar factura o nota de crédito recibida. |
| `POST /api/sar/purchases/:id/void` | Invalidar captura errónea conservando auditoría. |
| `GET /api/sar/report?from=YYYY-MM-DD&to=YYYY-MM-DD` | Conciliación neta de ventas, notas y compras por período hondureño. |
| `GET /api/sar/filings/:period/workbook` | Libro Excel de trabajo para ISV 201 y DMC. |
| `POST /api/sar/filings/:period/adjustments` | Documentar crédito o retención aplicable al período. |
| `POST /api/sar/filings/:period` | Registrar acuse oficial de una presentación hecha en OVI. |

## Presentación y límites operativos

La Oficina Virtual del SAR ofrece los trámites y formularios ISV 201 y DMC 527. No se identificó una API pública oficial de emisión, solicitud de CAI ni presentación de declaraciones para conectar este módulo. Por eso **cargar un acuse no presenta la declaración**: sólo registra una presentación ya realizada en la Oficina Virtual. Tampoco se valida en línea al proveedor ni la vigencia de una OCE. No generar documentos si faltan rango, fecha o clasificación tributaria válidos.

La hoja Excel es un **papel de trabajo** y debe contrastarse con la plantilla vigente DMC y los campos vigentes de ISV 201 antes de presentar. La base para crédito fiscal depende del destino de las compras y de la actividad del contribuyente. Las retenciones y arrastres sólo se registran con sustento proporcionado por el cliente; no se calculan ni verifican con terceros automáticamente. Casos fuera de productos/comida habituales, como importaciones, exportaciones, otros documentos fiscales, notas de débito y regímenes especiales, requieren tratamiento adicional y revisión profesional antes de considerarlos cubiertos.

Antes de producción, el contador del tenant debe revisar categorías tributarias de todo el catálogo, exoneraciones, crédito fiscal de compras, el formato impreso, la numeración previamente usada y los casos especiales de su actividad. Hacer pruebas con CAI y rangos auténticos del tenant, sin consumir correlativos de producción para ensayos descartables.

Fuentes oficiales: [Régimen de Facturación](https://www.sar.gob.hn/facturacion/), [reglamento Acuerdo 481-2017](https://www.sar.gob.hn/download/acuerdo-481-2017-no-4413-del-10-de-agosto-2017-reglamento-del-regimen-de-facturacion-y-otros-documentos-fiscales-y-registro-fiscal-de-imprentas/), [Oficina Virtual y ayudas ISV/DMC](https://www.sar.gob.hn/ovi/), [documentos no utilizados](https://www.sar.gob.hn/helpie_faq/como-notificar-los-documentos-fiscales-vencidos-y-no-utilizados/), [errores en documentos fiscales](https://www.sar.gob.hn/helpie_faq/que-hacer-en-caso-de-emitir-un-documento-fiscal-con-errores-en-el-llenado/).
