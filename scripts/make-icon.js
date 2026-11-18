// Draws the EchoFlow monogram (forest disc, brass ring, ivory E) as PNGs, no dependencies.
const zlib = require("zlib"), fs = require("fs"), path = require("path");
function png(size) {
  const px = Buffer.alloc(size * size * 4), c = (size - 1) / 2, R = size / 2 - 0.5;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const forest = [31, 66, 50], deep = [20, 46, 35], brass = [186, 150, 82], ivory = [250, 246, 236];
  const s = size / 256;
  const rect = (x, y, x0, y0, x1, y1) => x >= x0 * s && x <= x1 * s && y >= y0 * s && y <= y1 * s;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c), i = (y * size + x) * 4;
    let col = null, a = 0;
    if (d <= R) {
      a = Math.min(1, R - d + 1);
      const g = Math.max(0, Math.min(1, (x + y) / (2 * size)));
      col = mix(forest, deep, g);
      if (d > R - 11 * s && d < R - 6 * s) col = brass;
      const E = rect(x, y, 88, 70, 112, 186) || rect(x, y, 88, 70, 176, 92) || rect(x, y, 88, 116, 164, 138) || rect(x, y, 88, 164, 176, 186);
      if (E) col = ivory;
    }
    if (col) { px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = Math.round(255 * a); }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let k = n; for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0; });
  const crc = (b) => { let k = 0xffffffff; for (const v of b) k = crcT[(k ^ v) & 255] ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]), o = Buffer.alloc(4 + b.length + 4); o.writeUInt32BE(d.length, 0); b.copy(o, 4); o.writeUInt32BE(crc(b), 4 + b.length); return o; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const out = path.join(__dirname, "..", "assets");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.png"), png(256));
fs.writeFileSync(path.join(out, "tray.png"), png(32));
console.log("icons written");
