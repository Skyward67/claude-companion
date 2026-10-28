'use strict';

// The buddy: an original little terracotta bean with a sparkle sprout.
// All animation lives in style.css, keyed off classes on the <svg>:
//   mood-*  idle | thinking | working | waiting | done | error | sleeping | compacting | pet
//   act-*   read | search | edit | run | web | agent | plan | tool | ask

const CHARACTER_SVG = `
<svg class="char mood-idle" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg" aria-label="Claude buddy">
  <defs>
    <radialGradient id="bodyGrad" cx="38%" cy="32%" r="75%">
      <stop offset="0%" style="stop-color: var(--body-hi)"/>
      <stop offset="55%" style="stop-color: var(--body)"/>
      <stop offset="100%" style="stop-color: var(--body-lo)"/>
    </radialGradient>
    <radialGradient id="miniGrad" cx="38%" cy="32%" r="75%">
      <stop offset="0%" style="stop-color: var(--belly)"/>
      <stop offset="100%" style="stop-color: var(--body)"/>
    </radialGradient>
  </defs>

  <ellipse class="shadow" cx="80" cy="147" rx="36" ry="6"/>

  <g class="wrap">
    <g class="body">
      <g class="arm arm-l"><ellipse cx="37" cy="104" rx="9" ry="13"/></g>
      <g class="arm arm-r"><ellipse cx="123" cy="104" rx="9" ry="13"/></g>
      <ellipse class="foot foot-l" cx="64" cy="139" rx="11" ry="6.5"/>
      <ellipse class="foot foot-r" cx="96" cy="139" rx="11" ry="6.5"/>

      <path class="blob" d="M80 52 C112 52 127 74 127 100 C127 126 107 140 80 140 C53 140 33 126 33 100 C33 74 48 52 80 52 Z"/>
      <ellipse class="belly" cx="80" cy="117" rx="27" ry="17"/>

      <g class="sprout">
        <path class="stem" d="M80 53 Q79 47 80 42"/>
        <path class="spark" d="M80 25 Q82.5 34 91 36.5 Q82.5 39 80 48 Q77.5 39 69 36.5 Q77.5 34 80 25 Z"/>
      </g>

      <g class="face">
        <g class="eyes">
          <g class="look">
            <g class="eye eye-l"><ellipse class="pupil" cx="64" cy="88" rx="7" ry="9"/><circle class="shine" cx="66.6" cy="84.4" r="2.6"/><circle class="shine sm" cx="62" cy="91.5" r="1.2"/></g>
            <g class="eye eye-r"><ellipse class="pupil" cx="96" cy="88" rx="7" ry="9"/><circle class="shine" cx="98.6" cy="84.4" r="2.6"/><circle class="shine sm" cx="94" cy="91.5" r="1.2"/></g>
          </g>
        </g>
        <g class="eyes-alt eyes-closed"><path d="M57 89 Q64 94 71 89"/><path d="M89 89 Q96 94 103 89"/></g>
        <g class="eyes-alt eyes-happy"><path d="M57 91 Q64 81 71 91"/><path d="M89 91 Q96 81 103 91"/></g>
        <g class="eyes-alt eyes-squeeze"><path d="M58 84 L69 89 L58 94"/><path d="M102 84 L91 89 L102 94"/></g>
        <g class="eyes-alt eyes-dizzy">
          <path d="M64 88 m-6 0 a6 6 0 1 1 6 6 a4 4 0 1 1 -4 -4 a2 2 0 1 1 2 2"/>
          <path d="M96 88 m-6 0 a6 6 0 1 1 6 6 a4 4 0 1 1 -4 -4 a2 2 0 1 1 2 2"/>
        </g>

        <ellipse class="blush" cx="51" cy="104" rx="8" ry="4.5"/>
        <ellipse class="blush" cx="109" cy="104" rx="8" ry="4.5"/>

        <path class="mouth m-smile" d="M72 104 Q80 111 88 104"/>
        <path class="mouth m-flat" d="M74 106 Q80 107.5 86 106"/>
        <ellipse class="mouth m-o" cx="80" cy="107" rx="4.2" ry="5.2"/>
        <path class="mouth m-grin" d="M70 102 Q80 117 90 102 Z"/>
        <path class="mouth m-wavy" d="M70 107 q2.5 -3 5 0 t5 0 t5 0 t5 0"/>
      </g>
    </g>

    <g class="props">
      <g class="prop p-read p-search">
        <circle cx="139" cy="93" r="9.5" class="lens"/>
        <circle cx="136" cy="90" r="3" class="glint"/>
        <path d="M146 100 L155 110" class="handle"/>
      </g>
      <g class="prop p-edit">
        <g transform="rotate(32 140 98)">
          <rect x="135" y="78" width="10" height="28" rx="2" class="pencil"/>
          <rect x="135" y="74" width="10" height="6" rx="2" class="eraser"/>
          <path d="M135 106 L140 116 L145 106 Z" class="wood"/>
          <path d="M138.5 113 L140 116 L141.5 113 Z" class="lead"/>
        </g>
      </g>
      <g class="prop p-run">
        <rect x="124" y="96" width="32" height="24" rx="4" class="term"/>
        <circle cx="129" cy="100.5" r="1.3" class="dot-r"/><circle cx="133" cy="100.5" r="1.3" class="dot-y"/><circle cx="137" cy="100.5" r="1.3" class="dot-g"/>
        <path d="M128 107 L132 110.5 L128 114" class="prompt"/>
        <rect x="134" y="112.5" width="7" height="2.2" class="cursor"/>
      </g>
      <g class="prop p-web">
        <circle cx="141" cy="96" r="11" class="globe"/>
        <ellipse cx="141" cy="96" rx="5" ry="11" class="meridian"/>
        <path d="M130 96 H152 M132 90 H150 M132 102 H150" class="meridian"/>
      </g>
      <g class="prop p-agent">
        <ellipse cx="146" cy="128" rx="11" ry="10" fill="url(#miniGrad)" class="mini"/>
        <circle cx="142.5" cy="127" r="1.7" class="mini-eye"/><circle cx="149.5" cy="127" r="1.7" class="mini-eye"/>
        <path d="M146 118 L146 114" class="mini-stem"/>
        <circle cx="146" cy="112.5" r="2" class="mini-spark"/>
      </g>
      <g class="prop p-plan p-ask">
        <rect x="128" y="88" width="24" height="30" rx="3" class="clip-board"/>
        <rect x="134" y="85" width="12" height="6" rx="2" class="clip"/>
        <path d="M132 98 l2 2 l4 -4 M141 99 H148 M132 106 l2 2 l4 -4 M141 107 H148 M133 113 H148" class="clip-lines"/>
      </g>
      <g class="prop p-tool">
        <circle cx="141" cy="98" r="9" class="gear"/>
        <circle cx="141" cy="98" r="3.5" class="gear-hole"/>
      </g>
    </g>
  </g>

  <g class="fx fx-thought">
    <circle cx="112" cy="40" r="3"/><circle cx="123" cy="29" r="4.5"/><circle cx="137" cy="17" r="6.5"/>
  </g>
  <g class="fx fx-zzz">
    <text x="108" y="44" class="z1">Z</text><text x="121" y="31" class="z2">z</text><text x="131" y="20" class="z3">z</text>
  </g>
  <g class="fx fx-sparkles">
    <path class="sp s1" d="M28 46 l2.2 6 6 2.2 -6 2.2 -2.2 6 -2.2 -6 -6 -2.2 6 -2.2 Z"/>
    <path class="sp s2" d="M132 28 l1.8 5 5 1.8 -5 1.8 -1.8 5 -1.8 -5 -5 -1.8 5 -1.8 Z"/>
    <path class="sp s3" d="M18 96 l1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 4 -1.5 Z"/>
    <path class="sp s4" d="M146 68 l2 5.5 5.5 2 -5.5 2 -2 5.5 -2 -5.5 -5.5 -2 5.5 -2 Z"/>
  </g>
  <g class="fx fx-alert">
    <circle cx="120" cy="40" r="11"/>
    <path d="M120 33 V42"/><circle cx="120" cy="46.5" r="1.6" class="dot"/>
  </g>
  <g class="fx fx-hearts">
    <path class="h1" d="M118 46 c-4 -5 -11 -1 -7 5 l7 7 7 -7 c4 -6 -3 -10 -7 -5 Z"/>
    <path class="h2" d="M38 52 c-3 -4 -8 -1 -5 4 l5 5 5 -5 c3 -5 -2 -8 -5 -4 Z"/>
  </g>
  <g class="fx fx-sweat">
    <path d="M114 62 q-5 8 0 11 q5 -3 0 -11 Z"/>
  </g>
</svg>`;

const MOODS = ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'sleeping', 'compacting', 'pet'];
const ACTS = ['read', 'search', 'edit', 'run', 'web', 'agent', 'plan', 'tool', 'ask'];

class Character {
  constructor(host) {
    host.innerHTML = CHARACTER_SVG;
    this.svg = host.querySelector('svg');
    this.look = this.svg.querySelector('.look');
    this.mood = 'idle';
    this.act = null;
    this.gaze = { x: 0, y: 0 };
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

  // dx, dy in -1..1: where the buddy looks.
  lookAt(dx, dy) {
    this.gaze = { x: Math.max(-1, Math.min(1, dx)), y: Math.max(-1, Math.min(1, dy)) };
    this.applyGaze();
  }

  applyGaze() {
    let { x, y } = this.gaze;
    if (this.mood === 'thinking') [x, y] = [-0.5, -1];
    else if (this.mood === 'working') [x, y] = [0.9, 0.35];
    else if (this.mood === 'compacting' || this.mood === 'sleeping') [x, y] = [0, 0];
    this.look.style.transform = `translate(${(x * 4).toFixed(2)}px, ${(y * 3.5).toFixed(2)}px)`;
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
window.setBodyColor = setBodyColor;
