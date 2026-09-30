# Guía para facturar en Honduras con ChatBotPro

Esta guía aplica a negocios cuyo país en ChatBotPro es **Honduras**. El módulo usa la modalidad de **autoimpresor**: el SAR autoriza previamente un CAI, un rango de números y una fecha límite. ChatBotPro administra esos números y genera los comprobantes; no solicita rangos ni envía cada factura al SAR por una API.

## 1. Prepara la documentación ante el SAR

1. Confirma que tu RTN está inscrito en el Régimen de Facturación.
2. Solicita en la Oficina Virtual del SAR la autorización de impresión por **autoimpresor** para **Factura, tipo 01**. Si emitirás notas de crédito por devoluciones, solicita también la autorización de **Nota de Crédito, tipo 07**.
3. Conserva el PDF **SAR-927** de cada autorización. Revisa que el RTN, establecimiento, punto de emisión, tipo, CAI, primer y último correlativo y fecha límite correspondan a tu negocio y sucursal.
4. Si ya facturabas con otro sistema, identifica el **último número utilizado** y cualquier documento anulado. El siguiente número que cargues en ChatBotPro debe ser el primero que aún no se haya emitido. No uses el mismo rango en dos sistemas sin llevar una conciliación única.

[Ayuda oficial del SAR para solicitar autorización por autoimpresor](https://www.sar.gob.hn/download/ayuda-solicitud-de-autorizacion-de-impresion-por-imprenta-y-auto-impresor-2025/) · [Oficina Virtual del SAR](https://oficinavirtual.sar.gob.hn/)

## 2. Registra el emisor y el CAI

En **Facturación Honduras → Datos y CAI**:

1. Guarda el RTN de 14 dígitos, razón social, nombre comercial, domicilio fiscal y teléfono según tu documentación.
2. Elige cómo se clasifica fiscalmente el servicio de entrega, si lo ofreces. Revisa esta decisión con tu contador.
3. Selecciona la sucursal y carga **un SAR-927 por cada tipo autorizado**. Captura CAI, establecimiento, punto de emisión, rango, siguiente correlativo, fecha límite y adjunta el PDF.
4. Verifica la tabla **Rangos autorizados** antes de emitir. Si tu emisor, sucursal o punto no coincide con la autorización, corrígelo antes de continuar.

**Ejemplo:** un rango del `000-002-01-00001001` al `000-002-01-00002000` contiene 1,000 números. Si el número `00001025` ya se usó en otro sistema, el siguiente a cargar es `1026`, no `1001`.

## 3. Clasifica productos y precios

En **Productos e ISV**, revisa cada artículo con tu contador y márcalo como **exento**, **gravado al 15 %** o **gravado al 18 %**. ChatBotPro interpreta el precio del catálogo como precio final con ISV incluido. Evita aplicar además el impuesto genérico de productos a las ventas que facturarás en Honduras.

Las compras de inventario y las ventas no tienen automáticamente el mismo tratamiento fiscal. Conserva la factura del proveedor y registra por separado el ISV acreditable que corresponda.

## 4. Emite una primera factura real

1. Confirma que el CAI está vigente, hay folios disponibles y la venta corresponde a la sucursal autorizada.
2. Registra y cobra una **venta auténtica** en Punto de venta. También puedes facturar una venta a crédito confirmada.
3. En **Facturas**, busca la venta, captura el nombre y RTN o identidad del comprador cuando corresponda y pulsa **Emitir factura**.
4. Revisa el comprobante impreso: emisor, comprador, número consecutivo, CAI, rango, fecha límite, productos, ISV y total.
5. Consulta RTN, número y fecha en el [Validador de Documentos Fiscales del SAR](https://oficinavirtual.sar.gob.hn/fac/validador-doc-fiscales/). Si el resultado es no válido, detén la emisión y revisa el SAR-927 con tu contador o el SAR.

**Una prueba real consume un folio.** El validador consulta los datos del documento; no comprueba el detalle de productos o importes de la venta.

## 5. Notas de crédito, devoluciones y exoneraciones

- Para una devolución, abre la factura emitida y selecciona **Nota de crédito**. Elige las partidas y cantidades, escribe el motivo y usa un rango autorizado **tipo 07**. Después registra la devolución de dinero o reducción del crédito pendiente. Repón inventario sólo si el producto vuelve a estar disponible para vender.
- Si emitiste un documento con error, registra la anulación y conserva el original y la copia con la leyenda **Anulado**. El correlativo no se reutiliza. Consulta con tu contador si corresponde una nueva factura o una nota de crédito.
- Para un comprador exonerado, captura en Punto de venta su nombre, RTN y referencia de OCE, constancia o registro SAG antes del cobro. Adjunta el PDF de sustento en Facturación Honduras antes de emitir. Verifica su vigencia y alcance.

[SAR: qué hacer con documentos emitidos con errores](https://www.sar.gob.hn/helpie_faq/que-hacer-en-caso-de-emitir-un-documento-fiscal-con-errores-en-el-llenado/)

## 6. Registra compras y prepara el cierre mensual

En **Compras**, captura la factura o nota recibida del proveedor con su RTN, CAI, número, fechas, bases, ISV, total y PDF si lo tienes. Puedes vincularla a una orden de compra. Las notas recibidas deben relacionarse con la factura original.

En **Cierre mensual**, consulta la conciliación, prepara el expediente de trabajo para **ISV 201** y **DMC**, y entrégalo a tu contador. Presenta las declaraciones en la **Oficina Virtual del SAR** y luego guarda en ChatBotPro el acuse oficial. El archivo Excel que genera ChatBotPro es un papel de trabajo; no es la plantilla oficial de carga DMC ni presenta la declaración por sí mismo.

## 7. Cuando se agoten o venzan los folios

ChatBotPro bloquea nuevas emisiones al acabar el rango o pasar la fecha límite. Solicita una nueva autorización en la Oficina Virtual, descarga el nuevo SAR-927 y regístralo en **Datos y CAI**. Si quedan documentos vencidos sin utilizar, notifica esos números al SAR según el trámite oficial.

[SAR: notificación de documentos vencidos y no utilizados](https://www.sar.gob.hn/helpie_faq/como-notificar-los-documentos-fiscales-vencidos-y-no-utilizados/)

## Antes de operar diariamente

Pide a tu contador que revise el formato impreso, la clasificación de tu catálogo, las exoneraciones, el crédito fiscal de compras y la numeración anterior. La autorización real del SAR y los registros correctos del negocio son necesarios para emitir comprobantes válidos.
