const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

fs.mkdirSync(path.join(__dirname, 'public', 'icons'), { recursive: true });

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" width="192" height="192">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6c47ff"/>
      <stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
  </defs>
  <rect width="192" height="192" rx="40" fill="url(#g)"/>
  <circle cx="96" cy="82" r="30" fill="white" fill-opacity="0.95"/>
  <rect x="80" y="112" width="32" height="28" rx="6" fill="white" fill-opacity="0.95"/>
  <circle cx="96" cy="148" r="10" fill="white" fill-opacity="0.95"/>
  <rect x="88" y="52" width="16" height="6" rx="3" fill="white" fill-opacity="0.7"/>
</svg>`);

async function makeIcon(size, file) {
  await sharp(svg).resize(size, size).png().toFile(path.join(__dirname, file));
  console.log('OK', file);
}

Promise.all([
  makeIcon(192, 'public/icons/icon-192.png'),
  makeIcon(512, 'public/icons/icon-512.png'),
  makeIcon(72,  'public/icons/badge-72.png'),
]).then(() => console.log('All icons generated')).catch(e => console.error(e));
