// Copies the runtime libraries and fonts into src/vendor so the app never needs the network.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modules = path.join(root, 'node_modules');
const out = path.join(root, 'src', 'vendor');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });

for (const file of ['pdfjs-dist/build/pdf.min.js', 'pdfjs-dist/build/pdf.worker.min.js', 'pdf-lib/dist/pdf-lib.min.js']) {
  fs.copyFileSync(path.join(modules, file), path.join(out, path.basename(file)));
}

// Needed for PDFs that use fonts they don't embed, common in Korean documents.
for (const dir of ['cmaps', 'standard_fonts']) {
  fs.cpSync(path.join(modules, 'pdfjs-dist', dir), path.join(out, dir), { recursive: true });
}

// Same families and weights the page used to request from Google Fonts.
const fonts = [
  ['@fontsource/ibm-plex-sans-kr', [400, 500, 600, 700]],
  ['@fontsource/ibm-plex-mono', [500]],
];
let css = '';
for (const [pkg, weights] of fonts) {
  for (const weight of weights) {
    const source = fs.readFileSync(path.join(modules, pkg, `${weight}.css`), 'utf8');
    css += source.replace(/src:\s*url\(\.\/files\/([^)]+\.woff2)\)[^;]*;/g, (_, file) => {
      fs.copyFileSync(path.join(modules, pkg, 'files', file), path.join(out, 'fonts', file));
      return `src: url(fonts/${file}) format('woff2');`;
    });
  }
}
fs.writeFileSync(path.join(out, 'fonts.css'), css);
