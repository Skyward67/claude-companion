'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const characters = require('../src/main/characters');
const { updateDisplay } = require('../src/main/display');

// A 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-chars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pack(root, id, files) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  return dir;
}

test('character ids are plain folder names', () => {
  for (const ok of ['buddy', 'My Robo', 'robo-2', 'ünï']) assert.ok(characters.validId(ok), ok);
  for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'trailing.', ' padded', 'c:', 'x'.repeat(65), 42, null]) assert.ok(!characters.validId(bad), String(bad));
  assert.equal(updateDisplay({}, { character: '../../etc' }).character, 'buddy');
  assert.equal(updateDisplay({}, { character: 'robo' }).character, 'robo');
});

test('built-in characters load, the buddy first', (t) => {
  const user = tmp(t);
  const list = characters.listCharacters(user);
  assert.deepEqual(
    list.map((c) => c.id),
    ['buddy', 'blip', 'ghost'],
  );
  assert.ok(list.every((c) => c.builtIn && !c.error));
  for (const { id } of list) {
    const c = characters.loadCharacter(id, user);
    assert.match(c.svg, /<svg/);
    assert.deepEqual(c.warnings, [], id);
  }
  const buddy = characters.loadCharacter('buddy', user);
  assert.equal(buddy.colorable, true);
  assert.match(buddy.css, /\.mood-done/);
  assert.deepEqual(buddy.gaze.moods.thinking, [-0.5, -1]);
  assert.equal(characters.loadCharacter('ghost', user).colorable, false);
});

test('your packs are listed, broken ones with what is wrong', (t) => {
  const user = tmp(t);
  pack(user, 'robo', { 'character.json': { name: 'Robo', author: 'Me' }, 'character.svg': '<svg/>' });
  pack(user, 'broken', { 'character.json': '{ "name": ' });
  pack(user, 'empty', {});
  pack(user, 'buddy', { 'character.json': { name: 'Impostor' } });
  const list = characters.listCharacters(user);
  const by = Object.fromEntries(list.filter((c) => !c.builtIn).map((c) => [c.id, c]));
  assert.equal(by.robo.name, 'Robo');
  assert.equal(by.robo.author, 'Me');
  assert.equal(by.robo.error, '');
  assert.match(by.broken.error, /isn't valid JSON/);
  assert.match(by.empty.error, /character\.json is missing/);
  assert.match(by.buddy.error, /same name as a built-in/);
  // The built-in still wins.
  assert.equal(characters.loadCharacter('buddy', user).builtIn, true);
});

test('images inside the pack are inlined; anything else is dropped', (t) => {
  const user = tmp(t);
  pack(user, 'hat', {
    'character.json': { name: 'Hat', gaze: { reach: [6, 2], thinking: null, working: [1, 0] } },
    'character.svg': `<svg viewBox="0 0 160 160">
      <image href="art/hat%20big.png"/><image xlink:href='./art/hat big.png'/>
      <image href="https://example.com/x.png"/><image href="../outside.png"/><use href="#ok"/>
      <rect style="fill: url(#grad)"/></svg>`,
    'character.css': '.a { background: url(art/hat\\ big.png); } .b { background: url("art/hat big.png"); } .c { background: url(http://example.com/b.png); } .d { fill: url(#grad); }',
    'art/hat big.png': PNG,
  });
  fs.writeFileSync(path.join(user, 'outside.png'), PNG);
  const c = characters.loadCharacter('hat', user);
  const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
  assert.equal(c.svg.split(dataUrl).length - 1, 2, 'both <image> hrefs inlined');
  assert.ok(!c.svg.includes('example.com') && !c.svg.includes('outside.png'));
  assert.match(c.svg, /href="#ok"/);
  assert.match(c.svg, /url\(#grad\)/);
  assert.ok(c.css.includes(`.b { background: url("${dataUrl}"); }`));
  assert.match(c.css, /\.c \{ background: none; \}/);
  assert.match(c.css, /\.d \{ fill: url\(#grad\); \}/);
  assert.equal(c.warnings.length, 4, c.warnings.join('\n')); // remote and ../ in the SVG, the escaped name and remote in CSS
  assert.deepEqual(c.gaze.reach, [6, 2]);
  assert.equal(c.gaze.moods.thinking, undefined, 'null: follows the pointer');
  assert.deepEqual(c.gaze.moods.working, [1, 0]);
});

test('pose packs become pictures switched by mood, with sprite-sheet animation', (t) => {
  const user = tmp(t);
  pack(user, 'pix', {
    'character.json': {
      name: 'Pix',
      size: [32, 24],
      pixelated: true,
      poses: { idle: 'idle.png', working: { file: 'work.png', frames: 4, fps: 8 }, edit: 'edit.png', done: { file: 'done.png', frames: 5, fps: 10, loop: false } },
    },
    'idle.png': PNG,
    'work.png': PNG,
    'edit.png': PNG,
    'done.png': PNG,
    'character.css': '.mood-idle .wrap { animation: float 2s infinite; }',
  });
  const c = characters.loadCharacter('pix', user);
  assert.equal(c.colorable, false);
  assert.match(c.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 24"/);
  assert.match(c.svg, /<image class="pose pose-idle" width="32" height="24"/);
  assert.match(c.svg, /<svg class="pose pose-working"[^>]*><image class="frames" width="128" height="24"/);
  assert.match(c.css, /\.pose-working \.frames \{ animation: frames-working 0\.500s steps\(4\) infinite; \}/);
  assert.match(c.css, /@keyframes frames-working \{ to \{ transform: translateX\(-100\.0000%\); \} \}/);
  // Played once: four steps, stopping on the last of five frames.
  assert.match(c.css, /frames-done 0\.400s steps\(4\) 1 forwards/);
  assert.match(c.css, /translateX\(-80\.0000%\)/);
  // Tools come after moods, so they win.
  assert.ok(c.css.indexOf('.act-edit .pose-edit') > c.css.indexOf('.mood-working .pose-working'));
  assert.match(c.css, /image-rendering: pixelated/);
  assert.match(c.css, /animation: float/, 'own CSS is added after the generated rules');
});

test('pack mistakes come back as readable errors', (t) => {
  const user = tmp(t);
  const cases = {
    'no-idle': [{ poses: { working: 'w.png' } }, /needs at least an "idle" pose/],
    'bad-pose': [{ poses: { idle: 'i.png', dancing: 'd.png' } }, /Unknown pose "dancing"/],
    'bad-frames': [{ poses: { idle: { file: 'i.png', frames: 0 } } }, /"frames" must be a whole number/],
    'missing-image': [{ poses: { idle: 'nope.png' } }, /nope\.png is missing/],
    'missing-svg': [{ name: 'x' }, /character\.svg is missing/],
    'missing-css': [{ css: 'style.css' }, /style\.css is missing/],
    'escape-svg': [{ svg: '../x.svg' }, /"svg" must be the name of a file/],
    array: [[1, 2], /must hold a JSON object/],
  };
  for (const [id, [manifest]] of Object.entries(cases)) pack(user, id, { 'character.json': manifest, 'i.png': PNG, ...(id === 'missing-css' ? { 'character.svg': '<svg/>' } : {}) });
  for (const [id, [, re]] of Object.entries(cases)) assert.throws(() => characters.loadCharacter(id, user), re, id);
  assert.throws(() => characters.loadCharacter('../buddy', user), /isn't a valid character folder name/);
  assert.throws(() => characters.loadCharacter('ghosted', user), /There's no character folder called "ghosted"/);
  // The default CSS file is optional.
  pack(user, 'plain', { 'character.json': {}, 'character.svg': '<svg/>' });
  assert.equal(characters.loadCharacter('plain', user).css, '');
  assert.equal(characters.loadCharacter('plain', user).name, 'plain');
});

test('copies and imports land in your folder under a free name', (t) => {
  const root = tmp(t);
  const user = path.join(root, 'characters');
  assert.equal(characters.copyCharacter('buddy', user), 'my-buddy');
  assert.equal(characters.copyCharacter('buddy', user), 'my-buddy-2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(user, 'my-buddy-2', 'character.json'), 'utf8')).name, 'My Buddy 2');
  assert.ok(fs.existsSync(path.join(user, 'my-buddy', 'character.svg')));
  assert.equal(characters.loadCharacter('my-buddy', user).name, 'My Buddy');
  assert.equal(characters.copyCharacter('my-buddy', user), 'my-buddy-copy');

  const shared = pack(root, 'Shared Pack', { 'character.json': { name: 'Sparky!' }, 'character.svg': '<svg/>', 'sub/a.png': PNG, '.git/HEAD': 'x' });
  assert.equal(characters.importCharacter(shared, user), 'sparky');
  assert.ok(fs.existsSync(path.join(user, 'sparky', 'sub', 'a.png')));
  assert.ok(!fs.existsSync(path.join(user, 'sparky', '.git')), 'dot folders are skipped');
  assert.equal(characters.importCharacter(path.join(user, 'sparky'), user), 'sparky', 'already there');
  assert.throws(() => characters.importCharacter(path.join(root, 'nothing'), user), /character\.json is missing/);
});

test('editing a pack reports its folder', async (t) => {
  const user = tmp(t);
  pack(user, 'live', { 'character.json': {}, 'character.svg': '<svg/>' });
  const seen = new Set();
  let done;
  const changed = new Promise((r) => (done = r));
  const stop = characters.watchCharacters([user], (ids) => {
    for (const id of ids) seen.add(id);
    if (seen.has('live')) done();
  });
  t.after(stop);
  // Some systems report events a moment late, so keep touching until one arrives.
  const touch = setInterval(() => fs.writeFileSync(path.join(user, 'live', 'character.css'), `.a{} /* ${Date.now()} */`), 200);
  t.after(() => clearInterval(touch));
  await Promise.race([changed, new Promise((_, no) => setTimeout(() => no(new Error('no change seen')), 8000))]);
  assert.ok(seen.has('live'));
});
