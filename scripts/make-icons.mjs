import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const buildDirectory = path.join(root, "build");
fs.mkdirSync(buildDirectory, { recursive: true });

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#10233f"/>
      <stop offset="0.58" stop-color="#2f7df6"/>
      <stop offset="1" stop-color="#1aa6a0"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <rect x="18" y="18" width="476" height="476" rx="100" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="6"/>
  <path d="M126 392h260" stroke="#9cebe4" stroke-width="22" stroke-linecap="round"/>
  <path d="M166 352 256 126l90 226h-56l-15-42h-78l-16 42h-55Zm76-86h28l-14-42-14 42Z" fill="#ffffff"/>
  <circle cx="398" cy="126" r="24" fill="#f59f38"/>
</svg>`;

const pngBuffer = await sharp(Buffer.from(svg))
  .resize(512, 512)
  .png()
  .toBuffer();
fs.writeFileSync(path.join(buildDirectory, "icon.png"), pngBuffer);

const icoPng = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 0;
header[7] = 0;
header[8] = 0;
header[9] = 0;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(icoPng.length, 14);
header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(buildDirectory, "icon.ico"), Buffer.concat([header, icoPng]));

console.log("ArkPet icons generated: build/icon.png, build/icon.ico");
