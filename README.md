!FULLY AI!

# Aviator — Flight & Crash

A complete 3D arcade flight game for the browser. Fly a physically simulated aircraft over endless
procedural terrain, play a provably-fair "Aviator" crash round with **play money**, work through a
14-mission campaign, or relax in a free-flight sandbox. Build your own aircraft in the **Plane
Builder** and your own courses in the **Map Builder**, then fly them.

No build step, no server, no package manager: **open `index.html` in Chrome or Firefox.**
An internet connection is needed once to load three.js from cdnjs. Everything else
(terrain, aircraft, clouds, effects, sound and music) is generated at runtime.

> All balances are play money. Nothing in this game involves real-money wagering.

## Getting started

1. Open `aviator/index.html` (double-click it, or drag it into a browser window).
2. Wait for the terrain to generate, then pick a mode from the main menu.
3. Audio starts after your first click or key press, because browsers block autoplay.

## Controls

| Action | Keyboard (default) | Gamepad | Touch |
|---|---|---|---|
| Pitch (nose down / up) | W / S or ↑ / ↓ | Left stick Y | Left stick |
| Roll left / right | A / D or ← / → | Left stick X | Left stick |
| Rudder (yaw) | Q / E | Right stick X | — |
| Throttle up / down | Left Shift / Left Ctrl (or R / F) | RT / LT | Right slider |
| Landing gear | G | A | GEAR |
| Cycle flaps (0 → 50 → 100 %) | V | B | FLAP |
| Wheel brakes (hold) | B | X | BRK |
| Camera (chase → cockpit → orbit) | C | Y | CAM |
| Photo mode (free flight) | P | D-pad up | — |
| Free-flight panel / map | M | Back | — |
| Toggle HUD | H | — | — |
| Bet / cash out, slot 1 / slot 2 | Space / Enter | LB / RB | on-screen buttons |
| Pause | Esc | Start | ❚❚ |

All keys can be rebound in **Settings → Keys**. Optional mouse-yoke flying (cursor offset
from the screen centre steers) is in **Settings → Controls**. In orbit and photo cameras,
drag to rotate and scroll to zoom.

**Flying tips.** Take off at full throttle and ease back on the stick once you're past rotation
speed (about 1.1 × stall speed). Retract the gear for speed. For landing, lower the gear, set
flaps, slow down and touch down gently: more than about 3 m/s sink damages the airframe, and
more than about 6.5 m/s destroys it. If you stall, push the nose down; to recover from a spin,
push forward with opposite rudder. Assist levels change how much the aircraft helps you:

- **Off**: raw control surfaces.
- **Light** (default): auto-trim, turn coordination and a stall guard.
- **Heavy**: the stick commands pitch rate, plus a wing leveller and a bank limit.

## Modes

### Play: Crash round (Aviator)
- During the **bet timer** (7 s) the plane waits on the runway. Place up to **two bets**, each with
  an optional **auto cash-out** target.
- At takeoff the multiplier starts at 1.00× and climbs along an accelerating curve,
  `m(t) = e^(0.075·t)`. The plane climbs harder as it grows.
- **Cash out** at any moment to win stake × current multiplier. If the round ends first, the plane
  either flies away or explodes and any open bet is lost.
- After a short "waiting for next round" phase the next round begins. Bets placed mid-round are
  queued for the next one.
- The history strip colours recent results: red below 1.2×, blue below 2×, purple below 10×,
  gold below 50×, pink above that.
- **Provably fair** (the "Fair ✓" button):
  - `roundSeed = SHA-256(masterSeed:nonce)` (a seeded chain).
  - The commitment `hash = SHA-256(roundSeed)` is shown *before* takeoff, and the seed is revealed after.
  - `r` = the first 52 bits of `SHA-256(roundSeed:clientSeed)` ÷ 2⁵².
  - `crash = floor(100·(1−edge)/(1−r))/100`, so `P(crash ≥ x) = (1−edge)/x`.
  - You can change the client seed, rotate the master seed, and re-verify any past round.
  - The distribution and pacing live in one constant, `CRASH_DISTRIBUTION`, in `js/economy.js`.
- If your balance drops below 10, a **Top up** button adds 1,000 play money.

### Campaign: 14 missions in 3 chapters
Each mission has a briefing card (objectives and star rules), a par time, and a result card with
1–3 stars. Missions unlock in order. Chapter 2 needs Chapter 1 complete plus 7 ★; Chapter 3 needs
Chapter 2 complete plus 20 ★.

| # | Mission | Type |
|---|---|---|
| 1-1 | Circuit Training | Time trial through rings |
| 1-2 | Meadow Coins | Collect coins |
| 1-3 | Back to Earth | Precision landing |
| 1-4 | Wind Farm Slalom | Rings between turbines |
| 2-1 | Canyon Run | Fly through a tunnel |
| 2-2 | Coastal Sprint | Time trial along the beach |
| 2-3 | Courier Escort | Escort a drone |
| 2-4 | Desert Treasure | Collect coins over the mesas |
| 2-5 | Dune Strip Landing | Crosswind precision landing |
| 3-1 | Eye of the Storm | Survive a storm, reach beacons (lightning, turbulence) |
| 3-2 | Peak Pursuit | Small rings through the mountains (thin air) |
| 3-3 | Summit Landing | Short, high, gusty landing pad |
| 3-4 | Ice Tunnel | Narrow, twisting tunnel |
| 3-5 | The Iron Zeppelin | Boss: weak points, homing mines, belly core |

Missions pay **coins**, which you spend in the **Hangar**:
- **4 aircraft**, each with its own physics block in `CONFIG.aircraft`:
  - **Kestrel**: forgiving trainer.
  - **Bulldog**: agile biplane with fixed gear.
  - **Swift**: fast, twitchy racer.
  - **Titan**: heavy, tough twin.
- **6 paint schemes**, unlocked by total stars.
- **3 upgrades**, each with 3 levels: engine (+8 % thrust), handling (+8 % control authority)
  and durability (+20 % strength).

### Free Flight
A sandbox that starts on the Meadow Field runway.
- **M** opens the panel: weather (clear / cloudy / storm), time of day, time speed, wind strength
  and direction, and a **map of landmarks**. Click a landmark to fly there.
- **P** toggles **photo mode**: the simulation pauses, the HUD hides, you can orbit the plane, and
  a button saves a PNG.
- After a crash you respawn in the air.

## Plane Builder
Open **Plane Builder** from the main menu. It starts with a starter trainer, so you can see a working
layout straight away. Your work-in-progress design is kept while you test-fly it and come back.

**Parts.** There are 26 parts in 7 categories, all from the shared catalog in `js/parts.js`:
- 3 fuselage lengths; sections chain nose-to-tail.
- 4 engines: small prop, medium prop, jet (mounts on the nose or under a wing) and twin-prop nacelle (under a wing).
- 4 fuel tanks.
- 4 wings: short, long, swept and delta (delta wings have elevons).
- 3 tails: conventional, T-tail and V-tail.
- 3 landing gears: retractable wheels, skis and floats (floats can land on and take off from water).
- 5 cosmetic parts: canopy, nose cone, winglet, roundel decal and stripe decal.

Every part has an id, name, colour, dimensions, attachment points and stat contributions (mass,
drag, thrust, lift area, fuel, control surfaces).

**Editing.**
- Drag a part from the palette. Compatible free mounts glow and the part snaps to the nearest
  one. Click a palette item (or focus it and press Enter) to attach it to the best free mount
  without the mouse.
- Click a part to select it, and drag it to move it to another mount. **N** / **Shift+N** hop the
  selection to the next or previous mount; this is how you slide wings fore and aft to balance the
  aircraft.
- **R / E / Q** rotate 90° about the roll, pitch and yaw axes (hold Shift to reverse).
  **Ctrl+D** duplicates, **M** mirrors across the centreline and **Delete** removes a part
  together with everything attached to it.
- **Symmetry mode** (**X**, on by default) mirrors side parts automatically. Moving, rotating or
  deleting one half of a pair does the same to the other half.
- **Ctrl+Z** undoes and **Ctrl+Shift+Z** (or **Ctrl+Y**) redoes; every action is undoable.
- Camera: right-drag orbits, middle-drag (or Shift+right-drag) pans, the wheel zooms, **Alt+Arrows**
  orbit and **F** frames the selection or the whole aircraft. Press **?** for the full shortcut list.

**Live stats.** The panel shows total mass, thrust/weight, stall speed, maximum level speed,
range from fuel, turn rate at cruise and static margin. They are computed by
`AV.Physics.buildSpecFromDesign()` and `estimatePerformance()`, which turn the parts into the same
kind of aircraft spec that the stock aircraft use and run it through the game's flight model:
- mass and centre of gravity from the parts;
- Helmbold lift slope from the real span and area;
- neutral point and static margin from the wing and tail positions;
- tail and fin volumes for stability and control.

The yellow dot marks the centre of mass and the cyan dot the neutral point.

**Validation.** Problems link to the part that causes them (click to select it).
- Warnings do not block anything: no wings, no engine, no gear, no tail, an unbalanced centre of
  mass (fore/aft or left/right), the centre of mass behind the main wheels, underpowered, or little
  fuel.
- Errors (red) block saving and test flights: overlapping parts, floating or unattached parts, and
  two parts on one mount.

**Test flight, saving and sharing.**
- **Test flight** (Ctrl+Enter) flies the design in free flight with the normal physics. Use the
  **Back to Plane Builder** button, or Esc → *Back to editor*, to return. Float planes start on the
  sea, and planes without landing gear start in the air.
- **Save** (Ctrl+S) keeps up to 10 designs, each with a name and thumbnail.
- **Designs** loads, deletes or marks a design to **fly in crash mode and free flight**; the same
  choice is available in the Hangar, which also previews custom designs.
- **Export** / **Import** use versioned JSON (`"format": "aviator-plane", "version": 1`). Imports
  are validated: unknown parts are skipped with a note, and broken files are rejected with a
  message.

Custom aircraft carry fuel; when the tanks run dry the engine stops (the HUD shows **FUEL**).
Crash rounds give custom aircraft unlimited fuel and replace a wrecked aircraft mid-round, so only
the seeded crash point ever decides a round. Hangar upgrades apply to custom designs too.

## Map Builder
Open **Map Builder** from the main menu. A sample course is loaded the first time.

**Shapes.**
- Primitives: cube, sphere, cylinder, cone, ramp, arch, ring and tunnel segments (box or round,
  open-ended).
- Gameplay tags, each with a distinct marker: start pad (green, arrow shows the heading), goal pad
  (gold, flag), checkpoint ring and coin.
- Each shape has a position, a rotation (90° steps, or free rotation with rotation snap off) and a
  scale.
- Colour: 12-colour palette or a custom colour picker.
- Material: solid, transparent or emissive.
- **Collidable** or **decorative** (fly-through), and an optional **hazard** flag that is deadly on
  contact.
- Collidable cubes, cylinders, ramps and pads have tops you can land on.

**Tools.**
- **Q** select (click; Shift-click adds; drag on empty space for a box select).
- **W** move (drag; Shift drags vertically).
- **E** rotate (drag).
- **S** scale (drag).
- **P** place (click, or Enter at the cursor; **1–9** pick a palette shape).
- **T** tunnel.
- **Ctrl+D** duplicate, **Ctrl+G** / **Ctrl+Shift+G** group / ungroup (clicking a group member
  selects the whole group; Alt-click selects just one), **Delete** delete, **Ctrl+A** select all.
- Keyboard editing:
  - **Arrows** / **PgUp** / **PgDn** nudge by one grid step (Shift ×5).
  - **[ ]**, **{ }** and **Alt+[ ]** rotate about Y, X and Z.
  - **+ / −** scale by one grid step.
  - **H / C / M** toggle hazard, collidable and material.
  - **Tab** cycles the selection.
- **Ctrl+Z** / **Ctrl+Shift+Z** undo and redo everything. **?** shows all shortcuts.

**Grid and snapping.** Pick a grid size (1–50 m). **N** toggles snap to grid and **J** toggles snap
to face, so a new or dragged shape sits flush against the face under the cursor for stacking and
joining.

**Tunnels.** With the tunnel tool, click points along a path and press **Enter** (or double-click)
to build a smooth Catmull-Rom tunnel with the chosen width, height and box or round profile.
Backspace removes the last point. The interior is open and the walls are solid. Select a tunnel to
drag its yellow control-point handles (Shift = vertical), select a point in the panel to nudge it
with the arrows, insert points, or delete them; the tunnel rebuilds as you edit.

**Map settings.** Time of day, optional custom sky colour, water on/off and level, wind strength and
direction, size bound and ground colour.

**Validation (warnings only).**
- No start pad, no goal pad, or more than one start pad.
- Shapes outside the size bound (also tinted red).
- A goal buried in solid shapes.
- An **unreachable goal**: a voxel flood fill through open air from the start pad to the goal, run
  shortly after edits settle.

Only malformed data is rejected (on import).

**Test play, saving and sharing.**
- **Test play** (Ctrl+Enter) loads the map into the flight view with your aircraft on the start
  pad. Pass the checkpoints in placement order, collect coins and land on the goal pad; a crash
  respawns you at the start.
- **Save** keeps up to 12 maps with thumbnails. They appear in **Free Flight → panel (M) → Custom
  maps**, where *Main world* returns to the terrain.
- **Export** / **Import** use versioned JSON (`"format": "aviator-map", "version": 1`). The loader
  ignores unknown fields and logs a warning instead of failing.

Both editors have a mute toggle (♪) for their sounds: a soft click on snap, a tone on delete and a
buzz on invalid actions. Audio starts only after your first click or key press. Leaving an editor
keeps its work in memory for the session; save to keep it permanently.

## HUD
- Airspeed (km/h), altitude and vertical speed / height above ground
- Heading compass
- Artificial horizon with bank scale and angle of attack
- Throttle bar; gear, flaps and brake flags; G-meter; hull damage bar
- North-up minimap
- Stall and pull-up warnings
- Objective tracker and on-screen target markers (campaign)
- Multiplier and bet panel (crash mode)

## Settings
- **Audio**: master, music and effects volume.
- **Controls**: sensitivity, invert pitch, mouse yoke, assist level, default camera.
- **Keys**: rebinding.
- **Graphics**: quality presets (low / medium / high) and an FPS / draw-call overlay.
- **Accessibility**: UI text scale, reduced motion (removes shake, speed lines and flashes, and
  follows the OS setting by default), high-contrast HUD.
- **Data**: run the physics self-test, reset progress.

Progress is saved to `localStorage` under the key `aviator.save`. The save has a version number,
and older layouts are migrated forward; version 4 added saved designs and maps without changing
existing data. A corrupted save is backed up to `aviator.save.corrupt` and replaced with a fresh
one instead of crashing. A single unreadable saved design or map is dropped (with a console
warning) and everything else loads normally.

## File layout

```
aviator/
  index.html        shell, menus, cards, HUD and crash-panel markup; loads scripts in dependency order
  css/style.css     all styling: menus, HUD, crash panel, touch controls, animations, compact layout
  js/parts.js       shared part catalog (Plane Builder, Hangar, physics), design resolve/validate/import, part meshes
  js/physics.js     flight model (pure maths, no DOM/three.js), CONFIG, fixed-step simulator, selfTest(),
                    buildSpecFromDesign() / estimatePerformance() for built aircraft
  js/economy.js     SHA-256, crash distribution, provably-fair rounds, wallet, bet slots, history
  js/mapformat.js   shared map format + tolerant loader, collision/ground runtime, validation, reachability, MapView renderer
  js/campaign.js    versioned save system (v4: + designs and maps), chapters, missions, star rules, unlocks, upgrades
  js/audio.js       Web Audio: engine, wind, stall horn, one-shot effects, sequenced music loop
  js/input.js       keyboard (rebindable), mouse, touch stick/slider/buttons, gamepad
  js/world.js       terrain noise and biomes (AV.Terrain), chunk streaming, instanced props,
                    sky, sun and lens flare, clouds, water shader, rain, lightning, time of day
  js/aircraft.js    procedural aircraft models and animated parts; particles, vapour trails,
                    speed lines, debris, camera shake
  js/modes.js       camera rig, shared FlightSession, mission objects, and the Menu / Hangar /
                    Crash / Campaign / FreeFlight modes
  js/ui.js          screens, HUD instruments, minimap, markers, crash panel, settings, toasts
  js/editorcore.js  shared editor pieces: undo/redo history, orbit camera, editor scene, thumbnails, help, file I/O
  js/planebuilder.js  Plane Builder mode
  js/mapbuilder.js  Map Builder mode
  js/main.js        bootstrap, state machine, render loop, pause, settings, WebGL context loss
  README.md         this file
```

All modules attach to a single global namespace, `window.AV`, and are loaded as classic `<script>`
tags (no ES modules), so the game runs from `file://`. three.js is pinned to **r160.1**, the last
release that ships a classic (non-module) build, and is loaded with a Subresource Integrity hash.

## Flight model (js/physics.js)

A 6-DOF rigid body integrated at a fixed **1/120 s** step, using an accumulator plus interpolated
rendering so it behaves the same at any frame rate.

- **State**: position, velocity, orientation quaternion, body angular velocity.
- **Forces**:
  - throttle- and speed-dependent propeller thrust
  - gravity
  - lift `½ρV²·S·CL(α)`, with a linear range, a stall break and flat-plate post-stall behaviour
  - drag `CD0 + k·CL²` (induced) plus separated-flow drag
  - side force from sideslip
  - ground effect
- **Moments**:
  - elevator, aileron and rudder deflections (actuators slew at a finite rate, and propwash keeps
    the tail effective at low speed)
  - static stability `Cmα·sin α` (this is what makes a tailslide flip back over)
  - rate damping, dihedral effect, weather-vaning, adverse yaw
- **Stall and spin**: when the wing stalls, roll damping reverses (autorotation, which saturates at
  large helix angles) and a random wing drops. This produces spins you can recover from.
- **Ground**: spring-damper wheels with rolling friction per surface, brakes, nose-wheel steering
  and lateral grip. Takeoff rotation happens naturally once elevator authority beats the
  nose-wheel load. Touchdown checks sink rate and bank against thresholds. Hull points (nose,
  wingtips, tail, belly) detect crashes and scrapes, and water contact is a ditching.
- **Damage**: from hard landings, over-G, scrapes, lightning and mines. It reduces thrust and
  produces smoke.
- **CONFIG**: every tuning number is in the `CONFIG` object at the top of the file, including the
  four airframes.

Run the self-checks in the browser console:

```js
AV.Physics.selfTest()
```

For each of the four aircraft this checks that:
- level flight holds altitude at the computed cruise throttle, even after a speed disturbance;
- the aircraft stalls below its critical speed and does not stall above it, and lift drops past
  the critical angle of attack;
- energy is conserved in a glide (drag-free drift under 0.01 %, and the energy lost matches the
  integrated drag work within 3 %);
- a takeoff run gets airborne within a sensible distance.

## Performance notes
- Terrain streams in 500 m chunks, building at most 2 chunks per frame. Each chunk is a single
  vertex-coloured mesh.
- Props are one `InstancedMesh` per type across all chunks (trees, rocks, houses, churches,
  turbines, masts, hangars, lights), rebuilt only when the chunk set changes.
- Clouds are instanced camera-facing billboards. Particles are a single `Points` draw per blend mode.
- There is no post-processing pass. Quality presets scale view distance, mesh density, prop
  density, shadow-map size, cloud count, rain and pixel ratio.

## Known limitations
- three.js has to come from the CDN, so the very first launch needs an internet connection.
  three.js logs one console warning that its classic build is deprecated; that is expected.
- The world is deterministic: the designed core region is about 30 km across and blends into
  endless noise terrain beyond it, so missions always sit in the same places.
- The crash round is single-player. There are no simulated "other players" in the bet list.
- Collision against props uses simple cylinders, and the aircraft is treated as a point for prop
  and tunnel-wall checks.
- On a WebGL context loss the game offers a reload; it does not rebuild GPU resources in place.
- Plane Builder physics is an estimate built from part geometry: wings and tails are treated as
  flat surfaces at their mount positions, engines only push along the flight direction, fuel
  burn does not reduce mass in flight, and only the first landing-gear part provides wheels.
- Builder overlap checks use boxes per part (several for wings, tails and gear), so very tight
  layouts can be flagged conservatively. Prop and tunnel-wall collisions treat the aircraft as a
  point.
- Custom maps are flat ground plus shapes. They do not use the procedural terrain, and free
  rotation of landable shapes (anything other than yaw) turns their tops into plain obstacles.
- The reachability check is a coarse voxel search, so very narrow gaps can be misjudged; it only
  ever warns.
