function operationalOrderNote(order) {
  const explicit = String(order?.order_notes || '').trim();
  if (explicit) return explicit;

  // Antes de separar las columnas, el POS guardaba su nota en `notes`.
  // En chatbot ese campo contiene la referencia de entrega, por lo que no
  // debe presentarse como instrucción de preparación.
  const channel = String(order?.channel || '').trim().toLowerCase();
  return channel === 'pos' || channel === 'table_round'
    ? String(order?.notes || '').trim()
    : '';
}

module.exports = { operationalOrderNote };
