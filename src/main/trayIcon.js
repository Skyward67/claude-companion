'use strict';

// Draws the tray icon pixel by pixel so the app ships without image assets.
// Returns raw BGRA for nativeImage.createFromBitmap.

const SIZE = 32;
const SAMPLES = 4;

const BODY = [217, 119, 87];
const OUTLINE = [168, 82, 56];
const EYE = [43, 27, 23];
const BADGES = { waiting: [245, 166, 35], done: [76, 175, 80], error: [229, 72, 77] };

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function colorAt(x, y, mood) {
  const badge = BADGES[mood];
  if (badge && inEllipse(x, y, 25.5, 6.5, 5.5, 5.5)) {
    return inEllipse(x, y, 25.5, 6.5, 4.2, 4.2) ? badge : [255, 255, 255];
  }
  // Little spark on the head.
  const sx = Math.abs(x - 16);
  const sy = Math.abs(y - 4.5);
  if (sx + sy * 2.2 < 2.6 || sy + sx * 2.2 < 2.6) return [251, 227, 201];
  if (!inEllipse(x, y, 16, 18.5, 13.5, 12.5)) return null;
  if (!inEllipse(x, y, 16, 18.5, 12, 11)) return OUTLINE;
  if (mood === 'sleeping') {
    if (Math.abs(y - 18) < 0.9 && (Math.abs(x - 11.5) < 2.4 || Math.abs(x - 20.5) < 2.4)) return EYE;
  } else if (inEllipse(x, y, 11.5, 17.5, 2.1, 2.9) || inEllipse(x, y, 20.5, 17.5, 2.1, 2.9)) {
    return EYE;
  }
  if (inEllipse(x, y, 8, 22, 2.2, 1.3) || inEllipse(x, y, 24, 22, 2.2, 1.3)) return [236, 140, 120];
  return BODY;
}

function drawTrayIcon(mood = 'idle') {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colorAt(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES, mood);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }
      const i = (py * SIZE + px) * 4;
      if (!hits) continue;
      const alpha = hits / (SAMPLES * SAMPLES);
      // Premultiplied BGRA.
      buf[i] = Math.round((b / hits) * alpha);
      buf[i + 1] = Math.round((g / hits) * alpha);
      buf[i + 2] = Math.round((r / hits) * alpha);
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return { buffer: buf, width: SIZE, height: SIZE };
}

module.exports = { drawTrayIcon };
