const sharp = require('sharp');

function toDataUrl(bytes, mime = 'image/jpeg') {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function detailRegions(width, height, requestedTiles = 0) {
  const count = Math.max(0, Math.min(4, Math.floor(Number(requestedTiles) || 0)));
  if (!count || width < 500 || height < 500) return [];

  if (count === 1) {
    const cropWidth = Math.max(1, Math.round(width * 0.82));
    const cropHeight = Math.max(1, Math.round(height * 0.82));
    return [{
      left: Math.floor((width - cropWidth) / 2),
      top: Math.floor((height - cropHeight) / 2),
      width: cropWidth,
      height: cropHeight,
    }];
  }

  if (count <= 3) {
    const portrait = height >= width;
    return Array.from({ length: count }, (_, index) => {
      const ratio = count === 2 ? 0.58 : 0.44;
      const progress = count === 1 ? 0 : index / (count - 1);
      if (portrait) {
        const cropHeight = Math.max(1, Math.round(height * ratio));
        return {
          left: 0,
          top: Math.round((height - cropHeight) * progress),
          width,
          height: cropHeight,
        };
      }
      const cropWidth = Math.max(1, Math.round(width * ratio));
      return {
        left: Math.round((width - cropWidth) * progress),
        top: 0,
        width: cropWidth,
        height,
      };
    });
  }

  const cropWidth = Math.max(1, Math.round(width * 0.58));
  const cropHeight = Math.max(1, Math.round(height * 0.58));
  return [
    { left: 0, top: 0, width: cropWidth, height: cropHeight },
    { left: width - cropWidth, top: 0, width: cropWidth, height: cropHeight },
    { left: 0, top: height - cropHeight, width: cropWidth, height: cropHeight },
    { left: width - cropWidth, top: height - cropHeight, width: cropWidth, height: cropHeight },
  ];
}

async function prepareAiMenuImage(bytes, { detailTiles = 0 } = {}) {
  const oriented = await sharp(bytes, { failOn: 'none' })
    .rotate()
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const width = Number(oriented.info.width || 0);
  const height = Number(oriented.info.height || 0);

  const overview = await sharp(oriented.data, { failOn: 'none' })
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();

  const details = [];
  for (const region of detailRegions(width, height, detailTiles)) {
    const detail = await sharp(oriented.data, { failOn: 'none' })
      .extract(region)
      .resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: false })
      .sharpen({ sigma: 0.7 })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    details.push({ dataUrl: toDataUrl(detail), bytes: detail.length });
  }

  return {
    overview: { dataUrl: toDataUrl(overview), bytes: overview.length },
    details,
    width,
    height,
  };
}

async function cropAiMenuProductImage(bytes, region) {
  const oriented = await sharp(bytes, { failOn: 'none' })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const sourceWidth = Number(oriented.info.width || 0);
  const sourceHeight = Number(oriented.info.height || 0);
  if (!sourceWidth || !sourceHeight) throw new Error('No se pudieron leer las dimensiones del menú');

  const left = Math.max(0, Math.min(sourceWidth - 1, Math.floor(sourceWidth * Number(region.x || 0) / 100)));
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.floor(sourceHeight * Number(region.y || 0) / 100)));
  const width = Math.max(1, Math.min(sourceWidth - left, Math.round(sourceWidth * Number(region.width || 0) / 100)));
  const height = Math.max(1, Math.min(sourceHeight - top, Math.round(sourceHeight * Number(region.height || 0) / 100)));
  if (width < 40 || height < 40) throw new Error('La región de fotografía detectada es demasiado pequeña');

  const image = await sharp(oriented.data, { failOn: 'none' })
    .extract({ left, top, width, height })
    .resize({ width: 900, height: 900, fit: 'cover', position: 'centre', withoutEnlargement: false })
    .sharpen({ sigma: 0.55 })
    .webp({ quality: 84, effort: 4 })
    .toBuffer();

  return { dataUrl: toDataUrl(image, 'image/webp'), bytes: image.length, width, height };
}

module.exports = { cropAiMenuProductImage, detailRegions, prepareAiMenuImage };
