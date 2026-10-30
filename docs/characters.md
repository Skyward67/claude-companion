# Make your own character

The buddy is drawn from a **character pack**: a folder with a `character.json` and the art. You can swap in a different character, change one that exists, or make your own from scratch, with its own animation for everything Claude does.

There are two ways to make one:

| | **Pictures** | **SVG + CSS** |
| --- | --- | --- |
| You make | One image per mood (PNG, GIF, WebP…), or a sprite sheet of frames | A vector drawing and a stylesheet |
| Animation | Frames in a sprite sheet, or animated GIF / APNG / WebP | CSS animations and transitions (SMIL works too) |
| Good for | Pixel art, drawings from any paint program | Smooth, bouncy, recolourable characters |
| Start from | **Ghost** | **Blip** (simple) or **Buddy** (everything) |

Three characters come built in: **Buddy** (the default), **Blip**, a small robot that's a short, commented starting point, and **Ghost**, a pixel-art ghost made of sprite sheets.

## Quick start

1. Open **Settings → Look → Character**.
2. Pick the character closest to what you want to make, and press **Make an editable copy**. The copy is selected and its folder opens.
3. Edit the files in that folder. The buddy updates every time you save.
4. Use **Preview** (same section) to show any mood on the buddy while you work, or **All moods in turn** to watch them all.
5. If something's wrong, the error appears right under the character list, with the file, line and column.

## Where characters live

Each character is a folder in your characters folder. **Open characters folder** in Settings takes you there.

| System | Characters folder |
| --- | --- |
| Windows | `%APPDATA%\claude-companion\characters\` |
| macOS | `~/Library/Application Support/claude-companion/characters/` |
| Linux | `~/.config/claude-companion/characters/` |

The folder's name is the character's id. A pack looks like this:

```
characters/
  my-robot/
    character.json    name, author, and how the art is made
    character.svg     the drawing (SVG packs)
    character.css     the animation (optional for picture packs)
    hat.png           any images the art uses
```

To remove a character, delete its folder. Built-in characters live in [`src/characters`](../src/characters) in this repository.

## `character.json`

```json
{
  "name": "My Robot",
  "author": "You",
  "description": "Beeps a lot.",
  "version": "1.0.0"
}
```

| Field | What it does | Default |
| --- | --- | --- |
| `name` | Shown in Settings (up to 40 characters) | The folder name |
| `author`, `description`, `version` | Shown in Settings | |
| `svg` | The SVG file (SVG packs) | `"character.svg"` |
| `css` | The stylesheet. Optional unless you name it here | `"character.css"` |
| `poses` | Makes this a picture pack (see [Pictures](#pictures)) | |
| `size` | `[width, height]` of one picture or frame, in pixels (picture packs) | `[160, 160]` |
| `pixelated` | `true` keeps pixel art crisp when it's scaled up (picture packs) | `false` |
| `colorable` | Whether **Settings → Look → Colour** applies (see [Colours](#colours)) | `true` for SVG packs, `false` for picture packs |
| `gaze` | Where the eyes look (see [Eyes](#eyes-that-follow-the-pointer)) | |

## What the buddy shows

Your character only needs an `idle` look. Anything you leave out falls back: a picture pack shows its idle picture, and an SVG pack simply doesn't change.

**Moods**

| Mood | When |
| --- | --- |
| `idle` | Nothing is happening, or Claude is waiting for you to type |
| `thinking` | Claude is thinking between steps |
| `working` | Claude is using a tool (see the table below) |
| `waiting` | Claude needs you: a permission prompt, a question or a plan to approve |
| `done` | Claude finished its turn |
| `error` | Something went wrong (an API error, a rate limit) |
| `sleeping` | Idle for a while (**Settings → Data → Fall asleep after**) |
| `compacting` | Claude is summarising the conversation to free up context |
| `pet` | You clicked the buddy |

**Tools**, shown while `working` (and `ask` while `waiting`)

| Tool | When Claude is… |
| --- | --- |
| `read` | Reading files |
| `search` | Searching files (Grep, Glob) |
| `edit` | Editing or writing files |
| `run` | Running a command |
| `web` | Fetching a page, searching the web, using a browser |
| `agent` | Sending a helper (subagent) |
| `plan` | Updating its task list, loading a skill |
| `tool` | Using any other tool (MCP servers and so on) |
| `ask` | Waiting on your answer to a question or plan |

**Activities**, acted out while Claude works (**Settings → Look → Activities**)

Tool calls are quick, and most of a turn is Claude writing. So instead of thinking most of the time, the buddy acts out what Claude is most likely doing: the current tool, the last one for a moment after it ends, and typing (or coding, right after an edit) once Claude starts writing. An activity always comes with the `working` mood, plus the matching tool when there is one, so a character that doesn't draw activities shows its working look.

| Activity | When Claude is… | Tool |
| --- | --- | --- |
| `typing` | Writing its reply | |
| `coding` | Editing files, or writing more code after an edit | `edit` |
| `reading` | Reading files, and taking in what it read | `read` |
| `searching` | Searching files | `search` |
| `running` | Running a command | `run` |
| `browsing` | On the web | `web` |
| `planning` | Updating its task list | `plan` |

**Quirks**: little things the buddy does on its own for a couple of seconds, now and then, while idle or thinking for a while: `look` (looks around), `stretch`, `scratch` (scratches its head), `hop` and `yawn`.

People can turn each activity and the quirks off, or make them more or less frequent, so don't put anything only there that the moods need.

The same character is also used for the **mini buddies** (your other sessions, 44 px) and the **helpers** at the buddy's feet (subagents, 32 px). The main buddy is 150 px at Normal size. Keep the art readable when it's small.

## Pictures

List your pictures under `poses`. Name each pose after a mood, tool, activity or quirk from the tables above. Only `idle` is required.

```json
{
  "name": "Pixel Cat",
  "size": [32, 32],
  "pixelated": true,
  "poses": {
    "idle": { "file": "idle.png", "frames": 4, "fps": 4 },
    "thinking": "thinking.gif",
    "working": { "file": "working.png", "frames": 6, "fps": 10 },
    "edit": { "file": "typing.png", "frames": 2, "fps": 8 },
    "waiting": { "file": "waiting.png", "frames": 2, "fps": 4 },
    "done": { "file": "done.png", "frames": 5, "fps": 10, "loop": false },
    "sleeping": "sleeping.png"
  }
}
```

A pose is either a file name or an object:

| Key | What it does | Default |
| --- | --- | --- |
| `file` | The image: `.png`, `.apng`, `.gif`, `.webp`, `.avif`, `.jpg`, or `.svg` | |
| `frames` | How many frames the image holds, side by side in one row (a sprite sheet) | `1` |
| `fps` | Frames per second | `8` |
| `loop` | `false` plays the frames once and stops on the last one | `true` |

How poses are picked: a **quirk** or **activity** pose (like `coding`) wins over a **tool** pose (like `edit`), which wins over a **mood** pose (like `working`), which wins over `idle`. So with the file above, the buddy shows `typing.png` while editing, `working.png` while running a command, and `idle.png` while compacting. Activities come with their tool, so the `edit` pose also shows while Claude writes code between edits. A quirk pose with `"loop": false` plays once, which suits them.

**Sprite sheets.** Put all the frames of one pose in a single row, left to right, each exactly `size` pixels: four 32 × 32 frames make a 128 × 32 image. Most pixel-art tools export this directly: in Aseprite use **File → Export Sprite Sheet** with *Horizontal Strip*; in Piskel, **Export → PNG** with one row. Animated GIF, APNG and WebP files also work as a single picture, with no `frames` needed.

**Size.** Set `size` to the size of one frame. The picture is scaled to fit the buddy's square box, standing on the bottom edge, so square frames work best. Turn on `pixelated` for pixel art.

**Adding movement.** A picture pack can have a `character.css` too. The pictures sit inside `<g class="wrap"><g class="body">…</g></g>`, each with the classes `pose` and `pose-<name>`, so you can make the whole character float, shake or hop with the classes described in [SVG + CSS](#svg--css). Lengths are in your frame's pixels. Ghost's [`character.css`](../src/characters/ghost/character.css) is a short example.

## SVG + CSS

Draw your character as an SVG and animate it with CSS. The app never moves anything itself. It only adds **classes** to your `<svg>` element, and your CSS decides what each one looks like.

### The classes

| Class | When |
| --- | --- |
| `mood-<mood>` | Always exactly one: `mood-idle`, `mood-working`… |
| `act-<tool>` | The tool in use, while working or waiting: `act-edit`, `act-ask`… |
| `do-<activity>` | What the buddy acts out, always with `mood-working`: `do-typing`, `do-reading`… |
| `quirk-<quirk>` | A quirk, for 2.4 seconds while idle or thinking: `quirk-stretch`… |
| `enter` | Added again every time the mood changes, so one-shot animations replay |
| `busy` | Working for more than 90 seconds |
| `motion-full`, `motion-reduced`, `motion-off` | **Settings → Look → Movement** |
| `v-main`, `v-mate`, `v-helper` | The big buddy, a mini buddy (another session), a helper (subagent) |
| `char` | Always |

So the whole recipe is: draw every part you need, hide the parts that only show in some moods, and write rules like these:

```css
/* Bob up and down while working. */
.mood-working .body {
  animation: bob 0.6s ease-in-out infinite;
}
/* Show the pencil while editing. */
.prop { display: none; }
.act-edit .pencil { display: inline; }
/* Jump once when a turn is done (.enter restarts it on every mood change). */
.mood-done.enter .body {
  animation: jump 0.6s ease-out 2;
}
@keyframes bob { 50% { transform: translateY(-3px); } }
@keyframes jump { 40% { transform: translateY(-20px); } }
```

**Activities and quirks** go on top of a mood, so their rules need to win over the mood's: put them after the mood rules and start them with `.char` (the `<svg>` has that class too). A quirk plays once, so a plain animation with no repeat count is enough:

```css
/* A laptop while typing, and the arms stay down behind it. */
.laptop { display: none; }
.do-typing .laptop { display: inline; }
.char.do-typing .arm { animation: none; }
/* Look around now and then. */
.char.quirk-look .eyes { animation: look 2.4s ease-in-out; }
@keyframes look { 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
```

### A complete small character

`character.json`

```json
{ "name": "Dot" }
```

`character.svg`

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
  <ellipse class="shadow" cx="80" cy="146" rx="30" ry="5"/>
  <g class="body">
    <circle class="head" cx="80" cy="96" r="46"/>
    <g class="look">
      <circle class="eye" cx="64" cy="90" r="6"/>
      <circle class="eye" cx="96" cy="90" r="6"/>
    </g>
    <path class="mouth" d="M70 110 Q80 118 90 110"/>
  </g>
  <text class="zzz" x="118" y="40">z</text>
</svg>
```

`character.css`

```css
.shadow { fill: rgba(0, 0, 0, 0.2); }
.head { fill: var(--body); stroke: var(--body-line); stroke-width: 3; }
.eye { fill: #222; transform-origin: center; }
.mouth { fill: none; stroke: #222; stroke-width: 3; stroke-linecap: round; }
.zzz { display: none; font: bold 20px sans-serif; fill: #9ab; }
.body { transform-origin: 50% 100%; }

.mood-idle .body { animation: breathe 3s ease-in-out infinite; }
.mood-working .body { animation: bob 0.5s ease-in-out infinite; }
.mood-waiting .body { animation: hop 1s ease-in-out infinite; }
.mood-done.enter .body { animation: hop 0.6s ease-out 2; }
.mood-error.enter .body { animation: shake 0.4s ease-in-out 2; }
.mood-sleeping .eye { transform: scaleY(0.15); }
.mood-sleeping .zzz { display: inline; }

/* Calm movement: no hopping. (Still turns off every animation by itself.) */
.motion-reduced .body { animation: none !important; }

@keyframes breathe { 50% { transform: scale(0.98, 1.03); } }
@keyframes bob { 50% { transform: translateY(-3px); } }
@keyframes hop { 45% { transform: translateY(-12px); } }
@keyframes shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
```

For a complete example with every mood, a prop for every tool, a few activities and every quirk, copy **Blip** ([`character.svg`](../src/characters/blip/character.svg), [`character.css`](../src/characters/blip/character.css)). **Buddy** shows how far you can take it, with its own art for every activity.

### Drawing tips

- **Use a square `viewBox`**, like the built-in `0 0 160 160`. The drawing is scaled to fit the buddy's box, and **anything outside the box is cut off**, including the top of a jump. Leave some room.
- **Give parts classes, not just ids.** The same drawing appears many times on screen (the buddy, mini buddies, helpers). Each copy is kept separate, so ids such as gradient ids are fine to use.
- **Group parts that move together**, for example `.wrap` for the whole character, `.body` for squash and stretch, `.eyes` for blinking, `.arm-l` and `.arm-r` for waving. The names are up to you; the built-in characters use these.
- **`transform-origin` is relative to each shape** (`.char * { transform-box: fill-box }` is on), so `transform-origin: center` spins a shape around its own middle and `50% 100%` squashes it from its feet. A `transform="rotate(30 140 98)"` attribute in your SVG counts from the shape too. If you need SVG coordinates instead, add `transform-box: view-box` to that element.
- **Editors** like Inkscape, Illustrator, Figma and Boxy SVG all work: export as plain SVG. Editor-only attributes (`inkscape:*`, `sodipodi:*`) are removed. Text drawn with a font that isn't installed falls back to another font, so convert important text to paths.
- **Images in the drawing**: `<image href="hat.png"/>` and `url(hat.png)` in CSS work for images inside the pack folder.

### Colours

Packs with `"colorable": true` (the default for SVG packs) follow **Settings → Look → Colour** through these CSS variables:

| Variable | Use |
| --- | --- |
| `--body` | Main body colour |
| `--body-hi` | Highlight (lighter) |
| `--body-lo` | Shade (darker) |
| `--body-line` | Outline |
| `--body-limb` | Arms and feet |
| `--belly` | A light accent |

A gradient can use them too: `<stop offset="0" style="stop-color: var(--body-hi)"/>`. If your character has fixed colours, set `"colorable": false` so Settings says so instead of offering colours that do nothing.

### Eyes that follow the pointer

Put the eyes (or whatever should look around) in a group with the class `look`. The app moves it a few units toward the mouse pointer, or to a fixed direction in some moods. Tune it in `character.json`:

```json
"gaze": {
  "reach": [4, 3.5],
  "thinking": [-0.5, -1],
  "working": [0.9, 0.35],
  "sleeping": [0, 0],
  "compacting": [0, 0],
  "typing": [0, 0.8],
  "coding": [0, 0.8],
  "reading": [0, 0.9],
  "searching": [0, 0],
  "running": [0.9, 0.3],
  "browsing": [0.9, 0.1],
  "planning": [0.1, 0.8]
}
```

`reach` is how far `.look` moves, in SVG units, sideways and up and down. Each mood and activity can have a fixed direction from `-1` to `1` (left/up to right/down); the defaults are shown above. An activity's direction wins over its mood's. Set a mood to `null` to make it follow the pointer too, or an activity to `null` to look where its mood does. With **Eyes follow the mouse pointer** off, the eyes look straight ahead except in the moods with a fixed direction.

### Movement settings

People can choose how much the buddy moves in **Settings → Look → Movement**. Please respect it:

- **Still** (`motion-off`): every animation and transition is stopped for you. If a part only shows up through an animation (say, it fades in), give it a visible style for `.motion-off`.
- **Calm** (`motion-reduced`): yours to handle. Stop big movements like hopping, bobbing and jumping, and keep small ones like breathing and blinking: `.motion-reduced .wrap { animation: none !important; }`.
- Quirks don't happen at all when the movement is set to Still.
- The system's *reduce motion* setting shortens every animation to a single, instant run.

## Testing your character

- **Preview** in **Settings → Look → Character** shows any mood, tool, activity or quirk on the buddy, or all of them in turn, while Settings is open. Activities and quirks in the preview show even when they're turned off.
- **Every save reloads the character.** If a file has a mistake, Settings shows what and where, and the last version that worked stays on screen.
- **Things that were left out** (an image that wasn't found, a link that isn't allowed) are listed in Settings too.
- Running from source, `npm run demo` walks through every mood with made-up data, and `npx electron . --demo=done --snapshot=done.png --exit` saves a picture of one. Changes to the built-in characters in `src/characters` reload as you save.

## Sharing a character

Send the folder, zipped. To add a character someone shared, unzip it and use **Add from folder…** in Settings (or copy the folder into your characters folder yourself).

Characters can't do anything except draw: there's no JavaScript, and they can't load anything from the internet or reach outside their own folder. When a character is loaded:

- **Removed from the SVG**: `<script>`, links (`<a>`), `<foreignObject>`, anything that isn't SVG, event attributes like `onclick`, and links other than `#id` references and images from the pack's folder.
- **CSS** can only use images from the pack's folder. `@import` and fonts from elsewhere don't load (use fonts people have installed, or paths).
- **Everything stays inside the buddy's box**: a character can't draw over the cards, the speech bubble or its buttons.
- **Size limits**: `character.json` 64 KB, the SVG 2 MB, the CSS 512 KB, each image 4 MB and 16 MB of images in all.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The character isn't in the list | It needs its own folder in the characters folder, with a `character.json` directly inside. Folder names can't start with a dot |
| "isn't valid JSON" | A missing comma or quote, or a comma after the last item. The message gives the line and column |
| "The SVG can't be read" | The SVG isn't well-formed XML: an unclosed tag, a stray `&` (write `&amp;`). The message gives the line and column |
| Part of the drawing is cut off | It's outside the `viewBox`, or a jump or wave takes it there |
| A shape spins or scales around the wrong point | Set `transform-origin` on it, or `transform-box: view-box` to use SVG coordinates (see [Drawing tips](#drawing-tips)) |
| An animation doesn't play | Movement may be set to Still. An animation that runs a set number of times plays only when its rule starts to apply: tie one-shot animations to `.enter` (`.mood-done.enter .body`) so they replay on every mood change |
| An activity shows the working look instead of mine | A mood rule wins over it: start the activity's rules with `.char` (`.char.do-reading .arm`) and put them after the mood rules. Or the activity is turned off in **Settings → Look → Activities** |
| The colour swatches are greyed out | The pack has `"colorable": false` (picture packs have it by default) |
| The tray icon didn't change | The tray icon is always the built-in buddy |
