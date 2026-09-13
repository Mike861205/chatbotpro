const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { cropAiMenuProductImage, detailRegions, prepareAiMenuImage } = require('../src/utils/aiMenuImages');

test('genera cuatro recortes superpuestos para ampliar menús con texto pequeño', () => {
  const regions = detailRegions(1000, 1400, 4);
  assert.equal(regions.length, 4);
  assert.deepEqual(regions[0], { left: 0, top: 0, width: 580, height: 812 });
  assert.deepEqual(regions[3], { left: 420, top: 588, width: 580, height: 812 });
});

test('prepara vista completa y detalles ampliados en JPEG', async () => {
  const source = await sharp({
    create: { width: 800, height: 1200, channels: 3, background: '#ffffff' },
  }).png().toBuffer();
  const result = await prepareAiMenuImage(source, { detailTiles: 4 });
  assert.equal(result.width, 800);
  assert.equal(result.height, 1200);
  assert.equal(result.details.length, 4);
  assert.match(result.overview.dataUrl, /^data:image\/jpeg;base64,/);
  assert.ok(result.details.every((item) => item.bytes > 0));
});

test('recorta una fotografía detectada usando coordenadas porcentuales', async () => {
  const source = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: '#d97706' },
  }).png().toBuffer();
  const result = await cropAiMenuProductImage(source, { x: 10, y: 20, width: 40, height: 50 });
  assert.equal(result.width, 400);
  assert.equal(result.height, 400);
  assert.match(result.dataUrl, /^data:image\/webp;base64,/);
  const metadata = await sharp(Buffer.from(result.dataUrl.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.width, 900);
  assert.equal(metadata.height, 900);
});
