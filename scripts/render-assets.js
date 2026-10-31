// Renders the app icon from the buddy's own SVG, and composes the README hero
// image from widget snapshots. Run with Electron:
//   npx electron scripts/render-assets.js icon
//   npx electron scripts/render-assets.js hero <a.png> <b.png> <c.png>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const characters = require('../src/main/characters');

const root = path.join(__dirname, '..');
const [mode, ...files] = process.argv.slice(process.argv.findIndex((a) => a.endsWith('render-assets.js')) + 1);

async function capture(html, width, height, transparent) {
  const file = path.join(app.getPath('temp'), `claude-companion-${mode}.html`);
  fs.writeFileSync(file, html);
  const win = new BrowserWindow({ width, height, show: false, transparent, backgroundColor: transparent ? '#00000000' : '#ffffff', frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage();
  fs.rmSync(file, { force: true });
  return img;
}

function iconHtml() {
  const css = pathToFileURL(path.join(root, 'src', 'renderer', 'style.css')).href;
  const js = pathToFileURL(path.join(root, 'src', 'renderer', 'character.js')).href;
  // The built-in buddy, as the widget gets it (`<` escaped for the script tag).
  const pack = JSON.stringify(characters.loadCharacter(characters.DEFAULT_ID, app.getPath('temp'))).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><link rel="stylesheet" href="${css}">
  <style>html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
  #host{width:1024px;height:1024px;display:block}</style></head>
  <body><div id="host"></div><script src="${js}"></script><script>
    setCharacterMotion('off');
    setCharacter(${pack});
    const c = new Character(document.getElementById('host'));
    // Crop to the character so it fills the icon.
    c.svg.setAttribute('viewBox', '17 19 126 132');
    c.lookAt(0.15, 0.1);
  </script></body></html>`;
}

function heroHtml(images) {
  const cells = images.map((f) => `<img src="${pathToFileURL(path.resolve(f)).href}">`).join('');
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:1500px;height:760px;overflow:hidden}
  body{display:flex;align-items:flex-end;justify-content:center;gap:80px;padding-bottom:20px;box-sizing:border-box;
    background:radial-gradient(circle at 20% 15%,#41567a 0,transparent 55%),radial-gradient(circle at 85% 80%,#6b4a5e 0,transparent 50%),linear-gradient(135deg,#1f2a3c,#2b2233)}
  img{height:640px;filter:drop-shadow(0 18px 30px rgba(0,0,0,.35))}
  </style></head><body>${cells}</body></html>`;
}

app.whenReady().then(async () => {
  if (mode === 'icon') {
    const img = await capture(iconHtml(), 1024, 1024, true);
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'icon.png'), img.toPNG());
    console.log('assets/icon.png');
  } else if (mode === 'hero') {
    const img = await capture(heroHtml(files), 1500, 760, false);
    fs.mkdirSync(path.join(root, 'docs', 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'screenshots', 'hero.png'), img.toPNG());
    console.log('docs/screenshots/hero.png');
  }
  app.exit(0);
});
