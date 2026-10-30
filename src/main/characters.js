'use strict';

// Character packs: what the buddy looks like and how it moves. A pack is a
// folder with a character.json and either an SVG plus CSS (full control,
// like the built-in buddy) or one image per mood ("poses", optionally sprite
// sheets). Built-in packs live in src/characters, yours in
// <userData>/characters, one folder each. See docs/characters.md.
//
// This file reads and checks packs and turns their image files into data:
// URLs. The widget parses and sanitises the SVG again with the browser's own
// parser before showing it, and keeps every buddy in a shadow root inside a
// paint-contained box (renderer/character.js), so a pack can't reach the
// rest of the widget.

const fs = require('fs');
const path = require('path');

const BUILT_IN_DIR = path.join(__dirname, '..', 'characters');
const DEFAULT_ID = 'buddy';
const MANIFEST = 'character.json';

const MOODS = ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'sleeping', 'compacting', 'pet'];
const ACTS = ['read', 'search', 'edit', 'run', 'web', 'agent', 'plan', 'tool', 'ask'];

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};
const MB = 1024 * 1024;
const MAX = { manifest: 64 * 1024, svg: 2 * MB, css: 512 * 1024, image: 4 * MB, images: 16 * MB, copy: 64 * MB };

// Where the eyes (the pack's `.look` group) point in moods that don't follow
// the pointer, from -1 to 1, and how far they move, in SVG units.
const DEFAULT_GAZE = { reach: [4, 3.5], moods: { thinking: [-0.5, -1], working: [0.9, 0.35], compacting: [0, 0], sleeping: [0, 0] } };

// A pack's id is its folder name: no path separators, nothing Windows can't
// use in a folder name, no leading dot.
function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && id === id.trim() && !/[\\/:*?"<>|\u0000-\u001f]/.test(id) && !id.startsWith('.') && !id.endsWith('.');
}

const mb = (n) => `${(n / MB).toFixed(1)} MB`;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const text = (buf) => buf.toString('utf8').replace(/^﻿/, '');

function readLimited(file, max, what) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`${what} is missing`);
  }
  if (!st.isFile()) throw new Error(`${what} is not a file`);
  if (st.size > max) throw new Error(`${what} is too big (${mb(st.size)}; the limit is ${mb(max)})`);
  return fs.readFileSync(file);
}

// A file name from a pack, resolved inside its folder; null for anything
// that points elsewhere (absolute paths, `..`, URLs).
function inside(dir, rel) {
  if (typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel) || /^[a-z][a-z0-9+.-]*:/i.test(rel)) return null;
  let name = rel.trim().replace(/[?#].*$/, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not URL-encoded; use it as it is.
  }
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  return file.startsWith(root + path.sep) ? file : null;
}

// Two numbers, clamped, or null.
function pair(v, lo, hi) {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return v.map((n) => Math.min(hi, Math.max(lo, n)));
}

function readGaze(v) {
  const gaze = { reach: DEFAULT_GAZE.reach, moods: { ...DEFAULT_GAZE.moods } };
  if (!v || typeof v !== 'object') return gaze;
  gaze.reach = pair(v.reach, 0, 100) || gaze.reach;
  for (const mood of MOODS) {
    // null: this mood follows the pointer too.
    if (v[mood] === null) delete gaze.moods[mood];
    else gaze.moods[mood] = pair(v[mood], -1, 1) || gaze.moods[mood];
  }
  return gaze;
}

function readPoses(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('"poses" must be an object, like { "idle": "idle.png" }');
  const poses = {};
  for (const [key, p] of Object.entries(v)) {
    if (!MOODS.includes(key) && !ACTS.includes(key)) throw new Error(`Unknown pose "${key}". Poses are named after moods (${MOODS.join(', ')}) or tools (${ACTS.join(', ')})`);
    const o = typeof p === 'string' ? { file: p } : p;
    if (!o || typeof o !== 'object' || typeof o.file !== 'string') throw new Error(`Pose "${key}" needs a file, like "${key}.png"`);
    const frames = o.frames === undefined ? 1 : Number(o.frames);
    if (!Number.isInteger(frames) || frames < 1 || frames > 240) throw new Error(`Pose "${key}": "frames" must be a whole number from 1 to 240`);
    const fps = o.fps === undefined ? 8 : Number(o.fps);
    if (!(fps > 0 && fps <= 60)) throw new Error(`Pose "${key}": "fps" must be more than 0 and at most 60`);
    poses[key] = { file: o.file, frames, fps, loop: o.loop !== false };
  }
  if (!poses.idle) throw new Error('"poses" needs at least an "idle" pose');
  return poses;
}

function readManifest(dir, id) {
  let raw;
  try {
    raw = JSON.parse(text(readLimited(path.join(dir, MANIFEST), MAX.manifest, MANIFEST)));
  } catch (err) {
    throw new Error(err instanceof SyntaxError ? `${MANIFEST} isn't valid JSON: ${err.message}` : err.message);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${MANIFEST} must hold a JSON object, like { "name": "My buddy" }`);
  const poses = raw.poses === undefined ? null : readPoses(raw.poses);
  return {
    name: str(raw.name, 40) || id,
    author: str(raw.author, 60),
    description: str(raw.description, 200),
    version: str(raw.version, 20),
    svg: raw.svg === undefined ? 'character.svg' : raw.svg,
    css: raw.css === undefined ? 'character.css' : raw.css,
    cssOptional: raw.css === undefined,
    colorable: typeof raw.colorable === 'boolean' ? raw.colorable : !poses,
    size: pair(raw.size, 1, 4096) || [160, 160],
    pixelated: raw.pixelated === true,
    gaze: readGaze(raw.gaze),
    poses,
  };
}

// Inlines a pack's images as data: URLs, since the widget only shows what
// it's handed. References to anything outside the folder are dropped.
class Assets {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.bytes = 0;
    this.warnings = [];
  }

  dataUrl(ref, where) {
    const file = inside(this.dir, ref);
    if (!file) {
      this.warnings.push(`${where}: "${ref.slice(0, 80)}" isn't loaded. Only files inside the character's folder are.`);
      return null;
    }
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type) {
      this.warnings.push(`${where}: "${ref}" isn't an image the buddy can show (use ${Object.keys(IMAGE_TYPES).join(' ')})`);
      return null;
    }
    if (this.cache.has(file)) return this.cache.get(file);
    let buf;
    try {
      buf = readLimited(file, MAX.image, ref);
    } catch (err) {
      this.warnings.push(`${where}: ${err.message}`);
      return null;
    }
    this.bytes += buf.length;
    if (this.bytes > MAX.images) throw new Error(`The character's images add up to more than ${mb(MAX.images)}`);
    const url = `data:${type};base64,${buf.toString('base64')}`;
    this.cache.set(file, url);
    return url;
  }

  // url(...) in CSS (and in SVG attributes and <style>).
  css(source, where) {
    return source.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gis, (all, _q, ref) => {
      if (ref.startsWith('#') || /^data:image\//i.test(ref)) return all;
      const url = ref ? this.dataUrl(ref, where) : null;
      return url ? `url("${url}")` : 'none';
    });
  }

  // href="..." on <image>, <use> and friends, then any url(...).
  svg(source, where) {
    const hrefs = source.replace(/\b((?:xlink:)?href)\s*=\s*(["'])(.*?)\2/gis, (all, attr, q, ref) => {
      if (!ref || ref.startsWith('#') || /^data:image\//i.test(ref)) return all;
      const url = this.dataUrl(ref, where);
      return url ? `${attr}=${q}${url}${q}` : '';
    });
    return this.css(hrefs, where);
  }
}

// A pose pack becomes an SVG with one picture per pose and CSS that shows
// the one for the current mood (falling back to idle). Tools win over moods.
// Sprite sheets are frames side by side, slid through with steps().
function poseArt(m, assets) {
  const [w, h] = m.size;
  let art = '';
  let css = '.pose { display: none; }\n.pose-idle { display: inline; }\n';
  for (const key of [...MOODS, ...ACTS].filter((k) => m.poses[k])) {
    const p = m.poses[key];
    const href = assets.dataUrl(p.file, `pose "${key}"`);
    if (!href) throw new Error(assets.warnings[assets.warnings.length - 1] || `Pose "${key}": can't load ${p.file}`);
    if (key !== 'idle') {
      const when = MOODS.includes(key) ? `.mood-${key}` : `.act-${key}`;
      css += `${when} .pose { display: none; }\n${when} .pose-${key} { display: inline; }\n`;
    }
    if (p.frames > 1) {
      art += `<svg class="pose pose-${key}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden"><image class="frames" width="${w * p.frames}" height="${h}" preserveAspectRatio="none" href="${href}"/></svg>`;
      // Looping: slide the whole strip in n steps. Once: stop on the last frame.
      const steps = p.loop ? p.frames : p.frames - 1;
      const end = p.loop ? -100 : (-100 * (p.frames - 1)) / p.frames;
      css += `.pose-${key} .frames { animation: frames-${key} ${(steps / p.fps).toFixed(3)}s steps(${steps}) ${p.loop ? 'infinite' : '1 forwards'}; }\n`;
      css += `@keyframes frames-${key} { to { transform: translateX(${end.toFixed(4)}%); } }\n`;
    } else {
      art += `<image class="pose pose-${key}" width="${w}" height="${h}" preserveAspectRatio="xMidYMax meet" href="${href}"/>`;
    }
  }
  if (m.pixelated) css += '.pose, .pose image { image-rendering: pixelated; }\n';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMax meet"><g class="wrap"><g class="body">${art}</g></g></svg>`;
  return { svg, css };
}

function builtInIds() {
  return subdirs(BUILT_IN_DIR)
    .filter((id) => fs.existsSync(path.join(BUILT_IN_DIR, id, MANIFEST)))
    .sort((a, b) => (a === DEFAULT_ID ? -1 : b === DEFAULT_ID ? 1 : a.localeCompare(b)));
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && validId(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Built-in packs win over a folder of yours with the same name.
function packDir(id, userDir) {
  if (!validId(id)) throw new Error(`"${String(id).slice(0, 64)}" isn't a valid character folder name`);
  const builtIn = path.join(BUILT_IN_DIR, id);
  if (fs.existsSync(path.join(builtIn, MANIFEST))) return { dir: builtIn, builtIn: true };
  const dir = path.join(userDir, id);
  if (!fs.existsSync(dir)) throw new Error(`There's no character folder called "${id}" in ${userDir}`);
  return { dir, builtIn: false };
}

// Everything the widget needs to draw a pack. Throws with a message meant
// for the person making the character.
function loadCharacter(id, userDir) {
  const { dir, builtIn } = packDir(id, userDir);
  const m = readManifest(dir, id);
  const assets = new Assets(dir);
  let svg;
  let css = '';
  if (m.poses) {
    ({ svg, css } = poseArt(m, assets));
  } else {
    const file = inside(dir, m.svg);
    if (!file) throw new Error('"svg" must be the name of a file in the character\'s folder');
    svg = assets.svg(text(readLimited(file, MAX.svg, String(m.svg))), m.svg);
  }
  // Pose packs can add CSS too, on top of the generated rules.
  const cssFile = inside(dir, m.css);
  if (cssFile && (!m.cssOptional || fs.existsSync(cssFile))) css += `\n${assets.css(text(readLimited(cssFile, MAX.css, String(m.css))), m.css)}`;
  return { id, name: m.name, builtIn, dir, svg, css, colorable: m.colorable, gaze: m.gaze, warnings: assets.warnings };
}

// Built-ins first (the buddy leading), then yours by name. Broken packs are
// listed too, with what's wrong, so you can fix them.
function listCharacters(userDir) {
  const builtIns = builtInIds();
  const entry = (id, dir, builtIn) => {
    const item = { id, builtIn, folder: dir, name: id, author: '', description: '', colorable: true, error: '' };
    try {
      const m = readManifest(dir, id);
      Object.assign(item, { name: m.name, author: m.author, description: m.description, colorable: m.colorable });
    } catch (err) {
      item.error = err.message;
    }
    return item;
  };
  const mine = subdirs(userDir).map((id) => {
    const item = entry(id, path.join(userDir, id), false);
    if (builtIns.includes(id)) item.error = 'This folder has the same name as a built-in character. Rename it to use it.';
    return item;
  });
  mine.sort((a, b) => a.name.localeCompare(b.name));
  return [...builtIns.map((id) => entry(id, path.join(BUILT_IN_DIR, id), true)), ...mine];
}

function slug(name) {
  const s = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'character';
}

// A folder name that's free in your folder and not a built-in one, and the
// number added to make it so (1 when none was needed).
function freeId(base, userDir) {
  const taken = (id) => fs.existsSync(path.join(userDir, id)) || fs.existsSync(path.join(BUILT_IN_DIR, id));
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken(id)) return { id, n };
  }
  throw new Error('Too many characters with that name');
}

// Plain reads and writes, so copying works out of the app's asar archive too.
function copyDir(src, dest, budget = { bytes: 0 }, depth = 0) {
  if (depth > 8) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to, budget, depth + 1);
    else if (e.isFile()) {
      const buf = fs.readFileSync(from);
      budget.bytes += buf.length;
      if (budget.bytes > MAX.copy) throw new Error(`That folder holds more than ${mb(MAX.copy)}`);
      fs.writeFileSync(to, buf);
    }
  }
}

function copyInto(src, dest) {
  try {
    copyDir(src, dest);
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  }
}

function readRawManifest(dir) {
  try {
    const raw = JSON.parse(text(fs.readFileSync(path.join(dir, MANIFEST))));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

// A copy of any pack in your folder, ready to edit: "Buddy" becomes
// "My Buddy", one of yours "Robo copy". Returns the new folder name.
function copyCharacter(fromId, userDir) {
  const { dir, builtIn } = packDir(fromId, userDir);
  const raw = readRawManifest(dir);
  const base = (raw && str(raw.name, 40)) || fromId;
  const name = builtIn ? `My ${base}` : `${base} copy`;
  const { id, n } = freeId(slug(name), userDir);
  fs.mkdirSync(userDir, { recursive: true });
  copyInto(dir, path.join(userDir, id));
  if (raw) {
    raw.name = n > 1 ? `${name} ${n}` : name;
    fs.writeFileSync(path.join(userDir, id, MANIFEST), `${JSON.stringify(raw, null, 2)}\n`);
  }
  return id;
}

// Adds a pack from anywhere (say, one someone shared) by copying it into
// your folder. Returns its folder name there.
function importCharacter(srcDir, userDir) {
  const src = path.resolve(srcDir);
  const base = path.basename(src);
  if (path.dirname(src) === path.resolve(userDir) && validId(base)) return base;
  const m = readManifest(src, base);
  const { id } = freeId(validId(base) && !base.includes(' ') ? base : slug(m.name), userDir);
  fs.mkdirSync(userDir, { recursive: true });
  copyInto(src, path.join(userDir, id));
  return id;
}

// Calls onChange(ids) shortly after files in pack folders change, so the
// buddy picks up your edits as you save. Returns a function that stops.
function watchCharacters(dirs, onChange) {
  const watchers = [];
  const pending = new Set();
  let timer = null;
  for (const dir of dirs) {
    try {
      const w = fs.watch(dir, { recursive: true }, (_event, file) => {
        pending.add(file ? String(file).split(/[\\/]/)[0] : '');
        clearTimeout(timer);
        timer = setTimeout(() => {
          const ids = new Set(pending);
          pending.clear();
          onChange(ids);
        }, 150);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // The folder is missing, or this system can't watch it: edits then
      // show up after choosing the character again.
    }
  }
  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}

module.exports = {
  BUILT_IN_DIR,
  DEFAULT_ID,
  MOODS,
  ACTS,
  validId,
  readManifest,
  loadCharacter,
  listCharacters,
  copyCharacter,
  importCharacter,
  watchCharacters,
};
