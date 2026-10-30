'use strict';

// Draws the buddy from a character pack (src/main/characters.js,
// docs/characters.md). Each buddy lives in its own shadow root, so a pack's
// ids and CSS can't clash with the widget or with each other, and style.css
// paint-contains its box. The pack's CSS does all the animation, keyed off
// classes set here on the pack's <svg>:
//   mood-*    idle | thinking | working | waiting | done | error | sleeping | compacting | pet
//   act-*     read | search | edit | run | web | agent | plan | tool | ask (working and waiting only)
//   do-*      typing | coding | reading | searching | running | browsing | planning
//             (what the buddy acts out, always with mood-working; activity.js)
//   quirk-*   look | stretch | scratch | hop | yawn (a one-off, while idle or thinking)
//   enter     re-added on every mood change, to restart one-shot animations
//   busy      working for more than 90 seconds
//   motion-*  full | reduced | off (Settings → Look → Movement)
//   v-*       main | mate | helper: the big buddy, another session, a subagent

const MOODS = ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'sleeping', 'compacting', 'pet'];
const ACTS = ['read', 'search', 'edit', 'run', 'web', 'agent', 'plan', 'tool', 'ask'];
const ACTIVITIES = ['typing', 'coding', 'reading', 'searching', 'running', 'browsing', 'planning'];
const QUIRKS = ['look', 'stretch', 'scratch', 'hop', 'yawn'];
const MOTIONS = ['full', 'reduced', 'off'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_GAZE = {
  reach: [4, 3.5],
  moods: { thinking: [-0.5, -1], working: [0.9, 0.35], compacting: [0, 0], sleeping: [0, 0] },
  activities: { typing: [0, 0.8], coding: [0, 0.8], reading: [0, 0.9], searching: [0, 0], running: [0.9, 0.3], browsing: [0.9, 0.1], planning: [0.1, 0.8] },
};

// Rules every pack gets before its own CSS (which can override the first two).
const BASE_CSS = `
:host { display: block; width: 100%; height: 100%; }
.char { display: block; width: 100%; height: 100%; overflow: visible; }
.char * { transform-box: fill-box; }
.motion-off, .motion-off * { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  .char, .char * { animation-duration: 0.01s !important; animation-iteration-count: 1 !important; }
}`;

// ---- sanitising ---------------------------------------------------------------

// SVG elements a pack may use. Everything else goes (with its children):
// scripts, links, foreignObject and anything that isn't SVG.
const ELEMENTS = new Set(
  (
    'svg g defs symbol use title desc style switch view path rect circle ellipse line polyline polygon text tspan textPath image ' +
    'linearGradient radialGradient stop pattern clipPath mask marker filter animate animateTransform animateMotion set mpath ' +
    'feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight ' +
    'feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset ' +
    'fePointLight feSpecularLighting feSpotLight feTile feTurbulence'
  ).split(' '),
);
const SMIL = new Set(['animate', 'animateTransform', 'animateMotion', 'set']);
const IMAGE_URL = /^data:image\/(png|apng|jpeg|gif|webp|avif|svg\+xml)[;,]/i;

// Links may only point inside the SVG (#id), or at an image the main
// process already inlined. Returns what was removed, for the author.
function sanitize(root) {
  const removed = new Set();
  const walk = (el) => {
    for (const child of [...el.children]) {
      const name = child.localName;
      const smilHref = SMIL.has(name) && /^(xlink:)?href$|^on/i.test(child.getAttribute('attributeName') || '');
      if (child.namespaceURI !== SVG_NS || !ELEMENTS.has(name) || smilHref) {
        removed.add(`<${child.nodeName}>`);
        child.remove();
        continue;
      }
      clean(child);
      walk(child);
    }
  };
  const clean = (el) => {
    for (const attr of [...el.attributes]) {
      const local = attr.localName.toLowerCase();
      let drop = false;
      if (local.startsWith('on')) drop = true;
      else if (local === 'href') {
        const v = attr.value.trim();
        drop = !(v.startsWith('#') || ((el.localName === 'image' || el.localName === 'feImage') && IMAGE_URL.test(v)));
      } else if (attr.namespaceURI && attr.namespaceURI !== 'http://www.w3.org/XML/1998/namespace') {
        // Editor bookkeeping (inkscape:*, sodipodi:*) and namespace declarations.
        el.removeAttributeNode(attr);
        continue;
      }
      if (drop) {
        removed.add(`${attr.name}="…"`);
        el.removeAttributeNode(attr);
      }
    }
  };
  clean(root);
  walk(root);
  return [...removed];
}

function parseSvg(source) {
  const parse = (s) => new DOMParser().parseFromString(s, 'image/svg+xml');
  let doc = parse(source);
  // Forgetting xmlns is the most common slip; be kind about it.
  if (!doc.querySelector('parsererror') && doc.documentElement.localName === 'svg' && !doc.documentElement.namespaceURI) {
    doc = parse(source.replace(/<svg\b/, `<svg xmlns="${SVG_NS}"`));
  }
  const err = doc.querySelector('parsererror');
  if (err) {
    const m = /error on line \d+ at column \d+:[^\n]*/.exec(err.textContent);
    throw new Error(`The SVG can't be read: ${m ? m[0].trim() : err.textContent.trim().slice(0, 200)}`);
  }
  const svg = doc.documentElement;
  if (svg.localName !== 'svg' || svg.namespaceURI !== SVG_NS) throw new Error('The SVG must start with an <svg> element');
  return svg;
}

// ---- packs ------------------------------------------------------------------

let pack = null; // { id, template, sheet, gaze }
let motion = 'full';
const live = new Set(); // every Character on the page, to redraw when the pack changes
let baseSheet = null;

function sheetOf(css) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet;
}

// Shows a pack (as loaded by the main process) on every buddy. Returns
// { id, ok, error, warnings } for Settings. A pack that fails keeps the
// previous one on screen.
function setCharacter(data) {
  const warnings = [...((data && data.warnings) || [])];
  try {
    if (!data || typeof data.svg !== 'string') throw new Error('No character');
    const svg = parseSvg(data.svg);
    const removed = sanitize(svg);
    if (removed.length) warnings.push(`Left out of the SVG (not allowed in characters): ${removed.slice(0, 8).join(', ')}`);
    if (!svg.hasAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width')) || 160;
      const h = parseFloat(svg.getAttribute('height')) || 160;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    const gaze = data.gaze && Array.isArray(data.gaze.reach) ? data.gaze : DEFAULT_GAZE;
    pack = { id: data.id, template: document.importNode(svg, true), sheet: sheetOf(data.css || ''), gaze };
  } catch (err) {
    return { id: data && data.id, ok: false, error: err.message, warnings, showing: pack && pack.id };
  }
  for (const c of live) {
    if (c.host.isConnected) c.build();
    else live.delete(c);
  }
  return { id: data.id, ok: true, warnings, showing: data.id };
}

// Settings → Look → Movement, for every buddy.
function setCharacterMotion(level) {
  motion = MOTIONS.includes(level) ? level : 'full';
  for (const c of live) {
    if (!c.host.isConnected) {
      live.delete(c);
      continue;
    }
    for (const m of MOTIONS) c.svg.classList.toggle(`motion-${m}`, m === motion);
  }
}

class Character {
  // variant: 'main' (the big buddy), 'mate' (another session) or 'helper'.
  constructor(host, variant = 'main') {
    this.host = host;
    this.variant = variant;
    const root = document.createElement('div');
    root.className = 'char-root';
    host.replaceChildren(root);
    this.shadow = root.attachShadow({ mode: 'open' });
    this.mood = 'idle';
    this.act = null;
    this.activity = null;
    this.quirk = null;
    this.busy = false;
    this.gaze = { x: 0, y: 0 };
    for (const c of live) if (!c.host.isConnected) live.delete(c);
    live.add(this);
    this.build();
  }

  // (Re)draws from the current pack, keeping mood, tool and gaze.
  build() {
    baseSheet = baseSheet || sheetOf(BASE_CSS);
    this.shadow.adoptedStyleSheets = pack ? [baseSheet, pack.sheet] : [baseSheet];
    const svg = pack ? pack.template.cloneNode(true) : document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('char', `v-${this.variant}`, `motion-${motion}`, `mood-${this.mood}`, 'enter');
    if (this.act) svg.classList.add(`act-${this.act}`);
    if (this.activity) svg.classList.add(`do-${this.activity}`);
    if (this.quirk) svg.classList.add(`quirk-${this.quirk}`);
    if (this.busy) svg.classList.add('busy');
    this.shadow.replaceChildren(svg);
    this.svg = svg;
    this.look = svg.querySelector('.look');
    this.applyGaze();
  }

  setMood(mood, act) {
    if (mood !== this.mood) {
      for (const m of MOODS) this.svg.classList.remove(`mood-${m}`);
      this.svg.classList.add(`mood-${mood}`);
      // Restart one-shot animations (jump, shake) on every change.
      this.svg.classList.remove('enter');
      void this.svg.getBoundingClientRect();
      this.svg.classList.add('enter');
      this.mood = mood;
    }
    const a = mood === 'working' || mood === 'waiting' ? act : null;
    if (a !== this.act) {
      for (const x of ACTS) this.svg.classList.remove(`act-${x}`);
      if (a) this.svg.classList.add(`act-${a}`);
      this.act = a;
    }
    this.applyGaze();
  }

  // What the buddy acts out (do-*) and a one-off quirk (quirk-*), or null.
  setDoing(activity, quirk) {
    const a = ACTIVITIES.includes(activity) ? activity : null;
    if (a !== this.activity) {
      for (const x of ACTIVITIES) this.svg.classList.remove(`do-${x}`);
      if (a) this.svg.classList.add(`do-${a}`);
      this.activity = a;
      this.applyGaze();
    }
    const q = QUIRKS.includes(quirk) ? quirk : null;
    if (q !== this.quirk) {
      for (const x of QUIRKS) this.svg.classList.remove(`quirk-${x}`);
      if (q) this.svg.classList.add(`quirk-${q}`);
      this.quirk = q;
    }
  }

  setBusy(on) {
    if (!!on === this.busy) return;
    this.busy = !!on;
    this.svg.classList.toggle('busy', this.busy);
  }

  // dx, dy in -1..1: where the buddy looks.
  lookAt(dx, dy) {
    this.gaze = { x: Math.max(-1, Math.min(1, dx)), y: Math.max(-1, Math.min(1, dy)) };
    this.applyGaze();
  }

  applyGaze() {
    if (!this.look) return;
    const g = pack ? pack.gaze : DEFAULT_GAZE;
    const [x, y] = (this.activity && g.activities && g.activities[this.activity]) || g.moods[this.mood] || [this.gaze.x, this.gaze.y];
    this.look.style.transform = `translate(${(x * g.reach[0]).toFixed(2)}px, ${(y * g.reach[1]).toFixed(2)}px)`;
  }
}

// ---- colours ----------------------------------------------------------------

// The hand-tuned default palette; any other body colour is derived from its hue.
const DEFAULT_BODY = '#e07b56';
const DEFAULT_PALETTE = { hi: '#f6a986', body: '#e07b56', lo: '#c45f3d', line: '#9c4a2d', limb: '#d4704b', belly: '#ffd0b8' };

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function hsl(h, s, l) {
  return `hsl(${h.toFixed(1)} ${Math.max(0, Math.min(100, s)).toFixed(1)}% ${Math.max(4, Math.min(96, l)).toFixed(1)}%)`;
}

function bodyPalette(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '') || hex.toLowerCase() === DEFAULT_BODY) return DEFAULT_PALETTE;
  const [h, s, l] = hexToHsl(hex);
  return {
    hi: hsl(h, s + 4, l + 12),
    body: hex,
    lo: hsl(h, s, l - 11),
    line: hsl(h, s - 6, l - 27),
    limb: hsl(h, s, l - 4),
    belly: hsl(h, s + 10, Math.max(l + 24, 84)),
  };
}

// Applies the body colour to every buddy on the page (main, crew, helpers).
// The variables inherit into each buddy's shadow root.
function setBodyColor(hex) {
  const p = bodyPalette(hex);
  const root = document.documentElement.style;
  root.setProperty('--body-hi', p.hi);
  root.setProperty('--body', p.body);
  root.setProperty('--body-lo', p.lo);
  root.setProperty('--body-line', p.line);
  root.setProperty('--body-limb', p.limb);
  root.setProperty('--belly', p.belly);
}

window.Character = Character;
window.setCharacter = setCharacter;
window.setCharacterMotion = setCharacterMotion;
window.setBodyColor = setBodyColor;
