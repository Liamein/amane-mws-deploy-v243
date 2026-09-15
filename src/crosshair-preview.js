import { deflateSync } from 'node:zlib';

const WIDTH = 720;
const HEIGHT = 360;
const COLOR_PRESETS = ['FFFFFF', '55FF7A', 'FFFF55', '4DFFB8', '5DE0FF', 'FFFFFF', 'FF4D9D', 'FF4655', '111111'];

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }

function hexColor(value, fallback = 'FFFFFF') {
  const normalized = String(value || '').replace(/^#/, '').slice(0, 8);
  const hex = /^[0-9a-f]{6,8}$/i.test(normalized) ? normalized : fallback;
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16), hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255];
}

function parseSettings(code) {
  const parts = String(code || '').split(';');
  const keys = new Set(['c', 'u', 'h', 'd', 'z', '0t', '0l', '0o', '0a', '1b', '1t', '1l', '1o', '1a']);
  const values = {};
  for (let index = 0; index < parts.length - 1; index += 1) if (keys.has(parts[index])) values[parts[index]] = parts[index + 1];
  const colorIndex = Number(values.c);
  const color = values.u ? hexColor(values.u) : hexColor(COLOR_PRESETS[Number.isInteger(colorIndex) ? colorIndex : 0]);
  return {
    color,
    centerDot: values.d === '1',
    dotSize: clamp(Number(values.z) || 1, 1, 10),
    innerThickness: clamp(Number(values['0t']) || 1, 1, 10),
    innerLength: clamp(Number(values['0l']) || 0, 0, 30),
    innerOffset: clamp(Number(values['0o']) || 0, 0, 30),
    innerOpacity: clamp(Number(values['0a']) || 1, 0.1, 1),
    outerLines: values['1b'] === '1',
    outerThickness: clamp(Number(values['1t']) || 1, 1, 10),
    outerLength: clamp(Number(values['1l']) || 0, 0, 30),
    outerOffset: clamp(Number(values['1o']) || 0, 0, 30),
    outerOpacity: clamp(Number(values['1a']) || 1, 0.1, 1),
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function blend(pixels, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const index = (y * WIDTH + x) * 4;
  const opacity = clamp((color[3] / 255) * alpha, 0, 1);
  pixels[index] = Math.round(pixels[index] * (1 - opacity) + color[0] * opacity);
  pixels[index + 1] = Math.round(pixels[index + 1] * (1 - opacity) + color[1] * opacity);
  pixels[index + 2] = Math.round(pixels[index + 2] * (1 - opacity) + color[2] * opacity);
  pixels[index + 3] = 255;
}

function rect(pixels, x, y, width, height, color, alpha = 1) {
  for (let row = Math.floor(y); row < Math.ceil(y + height); row += 1) for (let column = Math.floor(x); column < Math.ceil(x + width); column += 1) blend(pixels, column, row, color, alpha);
}

function outlinedRect(pixels, x, y, width, height, color, alpha) {
  rect(pixels, x - 2, y - 2, width + 4, height + 4, [0, 0, 0, 255], 0.82);
  rect(pixels, x, y, width, height, color, alpha);
}

function drawCrosshair(pixels, settings) {
  const centerX = Math.floor(WIDTH / 2);
  const centerY = Math.floor(HEIGHT / 2);
  const drawLines = (length, offset, thickness, opacity) => {
    if (!length) return;
    const scaledLength = length * 6;
    const scaledOffset = offset * 5;
    const scaledThickness = Math.max(2, thickness * 2);
    outlinedRect(pixels, centerX - scaledThickness / 2, centerY - scaledOffset - scaledLength, scaledThickness, scaledLength, settings.color, opacity);
    outlinedRect(pixels, centerX - scaledThickness / 2, centerY + scaledOffset, scaledThickness, scaledLength, settings.color, opacity);
    outlinedRect(pixels, centerX - scaledOffset - scaledLength, centerY - scaledThickness / 2, scaledLength, scaledThickness, settings.color, opacity);
    outlinedRect(pixels, centerX + scaledOffset, centerY - scaledThickness / 2, scaledLength, scaledThickness, settings.color, opacity);
  };
  drawLines(settings.outerLines ? settings.outerLength : 0, settings.outerOffset + settings.innerLength + settings.innerOffset + 2, settings.outerThickness, settings.outerOpacity);
  drawLines(settings.innerLength, settings.innerOffset, settings.innerThickness, settings.innerOpacity);
  if (settings.centerDot) {
    const size = Math.max(4, settings.dotSize * 4);
    outlinedRect(pixels, centerX - size / 2, centerY - size / 2, size, size, settings.color, 1);
  }
}

export function createCrosshairPreview(code) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4, 255);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = (y * WIDTH + x) * 4;
      const light = Math.round(58 + (x / WIDTH) * 20 + (y / HEIGHT) * 14);
      const grain = ((x * 17 + y * 31) % 23) - 11;
      pixels[index] = clamp(light + grain, 0, 255);
      pixels[index + 1] = clamp(light + 4 + grain, 0, 255);
      pixels[index + 2] = clamp(light + 7 + grain, 0, 255);
    }
  }
  // A soft abstract background keeps the crosshair readable without copying a source image.
  for (const [x, y, radius] of [[120, 90, 100], [600, 105, 130], [210, 290, 125], [560, 270, 115]]) {
    for (let py = Math.max(0, y - radius); py < Math.min(HEIGHT, y + radius); py += 1) for (let px = Math.max(0, x - radius); px < Math.min(WIDTH, x + radius); px += 1) {
      const distance = Math.hypot(px - x, py - y);
      if (distance < radius) blend(pixels, px, py, [145, 126, 93, 255], ((1 - distance / radius) ** 2) * 0.22);
    }
  }
  drawCrosshair(pixels, parseSettings(code));
  const scanlines = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    scanlines[y * (WIDTH * 4 + 1)] = 0;
    pixels.copy(scanlines, y * (WIDTH * 4 + 1) + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(HEIGHT, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
