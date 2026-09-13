const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');

const app = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
const start = app.indexOf('async function aiDataUrlToFile(dataUrl, productName) {');
const end = app.indexOf('\nfunction aiImageStateMeta', start);
assert.ok(start >= 0 && end > start);

const context = {
  File,
  Uint8Array,
  atob,
  fetch: () => { throw new Error('No debe usarse fetch para aceptar una imagen data:'); },
};
vm.runInNewContext(`${app.slice(start, end)}\nthis.convert = aiDataUrlToFile; this.accept = acceptAiDraftImage;`, context);

test('acepta recortes del menú localmente sin fetch, también en lote', async () => {
  const image = `data:image/webp;base64,${Buffer.from('imagen de prueba').toString('base64')}`;
  const items = [
    { name: 'Alitas', imagePreviewUrl: image, imageSource: 'menu_crop', imageStatus: 'suggested', imageFile: null },
    { name: 'Papas y Pollo', imagePreviewUrl: image, imageSource: 'menu_crop', imageStatus: 'suggested', imageFile: null },
  ];
  const accepted = await Promise.all(items.map(context.accept));
  assert.deepEqual(accepted, [true, true]);
  assert.ok(items.every((item) => item.imageStatus === 'accepted'));
  assert.equal(items[0].imageFile.name, 'Alitas.webp');
  assert.equal(items[1].imageFile.name, 'Papas-y-Pollo.webp');
  assert.equal(items[0].imageFile.type, 'image/webp');
  assert.equal(Buffer.from(await items[0].imageFile.arrayBuffer()).toString(), 'imagen de prueba');
});

test('muestra una indicación clara si la imagen sugerida está dañada', async () => {
  await assert.rejects(context.convert('data:image/webp;base64,?invalido', 'Alitas'), /formato válido/);
});
