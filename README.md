# Frag

Frag is a browser first-person shooter by Nexus6 Studio. It is a three.js / WebGL game written in TypeScript and built with Vite. The shipped site is static files only and runs entirely in the browser. Hosting is Azure Static Web Apps.

## License

Frag is MIT licensed. Copyright (c) 2026 Nexus6 Studio. See [LICENSE](LICENSE).

Every non-code asset (models, textures, sounds, music, fonts, maps) needs one provenance row in [ASSETS.md](ASSETS.md) before it can be merged.

No id Software / Quake code, maps, art or sounds. No GPL/AGPL/LGPL code. Installed dependencies must be MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, or ISC. 0BSD and the Unlicense are also accepted as public-domain-equivalent permissive licenses. See [LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md).

## Run locally

Requires Node.js 22 (see `.nvmrc`).

```bash
npm install
npm run dev
```

`npm ci` installs from `package-lock.json` and is what CI runs. `npm run dev` serves a full-viewport three.js scene at `http://127.0.0.1:5173`. The page is static and client-side: no server, accounts, analytics, or third-party CDN calls.

```bash
npm run build
npm run preview
```

`npm run build` typechecks with `tsc` and writes the static site to `dist/`. `npm run preview` serves that build.

A fresh load shows a content warning before play. The title is Content warning. The body says the prototype contains fast-paced combat against fictional enemies, with blood, gibs, explosions, sparks and debris, plus flashing lights and rapid motion. Continue acknowledges it for that page load only. It is not stored, and the next load shows it again. The card also shows a seven-character build id in small type, such as `build 2a02f86`, so a playtest note can name the build. Vite inlines it from `GITHUB_SHA` when that is set, otherwise from `git rev-parse --short HEAD`, otherwise `dev`. On a GitHub Actions pull request, `GITHUB_SHA` is the merge commit of the head into the base branch, not the branch head, so the id on a PR preview can differ from the latest commit on the branch. Continue then reveals a click-to-play overlay titled Frag. Click it, or press Enter, to lock the pointer and hide the overlay. Esc releases the pointer and pauses. Losing the pointer without that key, including alt-tab, a browser-forced release, or the window blurring, pauses once. Press Enter, or the Resume button, to continue. The pause card does not open over the death recap. The pause card sets mouse sensitivity from 0.05° to 0.30° per pixel, horizontal field of view from 90° to 115°, mute, and invert Y. Those four are written to localStorage under `frag:settings:v1` only after they change. Resuming does not show the warning again. Backquote or F1 toggles a small FPS readout, which is off until then. The scene behind the overlays is the Neon Atrium: a closed 32 m map with a sunken well, a ground concourse, corner ramps and stairs, and an upper ring. Nothing there is a loaded asset. Looking, movement, the control table, and the field of view are below.

## Controls

Looking and buttons are read from one input state each frame. `down` is held. `pressed` and `released` are the edges since the previous frame. The state is empty while the pointer is unlocked or the game is paused, so look and buttons do nothing then. Losing the pointer lock clears edges. It does not emit a release for a key that was held. A key still held when play resumes is `down` again without a new `pressed`.

| Input | State | Action |
| --- | --- | --- |
| W A S D | `forward` `left` `back` `right` | Walk and strafe in the atrium. |
| Mouse | `lookX` `lookY` | Yaw and pitch while the pointer is locked. Pitch clamps to ±89°. |
| Space | `jump` | Jump. |
| Left mouse | `fire` | VEC-9 Quill Driver. Full-auto while held: one flechette per pulse, eight per second. A click that is already up by the next sample still fires once. Clicks cannot exceed that eight per second, and a burst inside one frame does not queue extra shots. `down.fire` stays set for the whole hold. `pressed.fire` is only the down edge. `firePresses` is how many left clicks landed since the last sample. |
| Right mouse | `alt` | Charged pierce burst. Hold for 0.45 s, then three flechettes fire down the bore. They cost 5 magazine rounds, each deals 9, and each passes through the first enemy to hit the one behind it. The next charge waits 0.8 s. Letting go early, or charging with fewer than 5 rounds left, aborts. Reload will not fire it. The canvas does not open a context menu. `down.alt` is the hold. `pressed.alt` is the down edge. |
| R | `reload` | Reload the Quill Driver. An empty magazine reloads on its own when rounds remain. |
| Esc | `pause` | Pause and release the pointer. Enter or Resume continues. The settings controls do not. |
| Backquote or F1 | `debug` | Toggle the FPS and position readout. The shell toggle still works while paused. |
| M | `mute` | Toggle procedural audio. The HUD shows MUTE while silenced. The pause card's mute box is the same switch, and it is saved with the other pause settings. Works while paused, and it does not start play. |
| `[` `]` | `sensDown` `sensUp` | Temporary mouse sensitivity. Not saved. |

There is no gamepad or touch input.

Default look sensitivity is 0.12° per pointer-lock pixel (`movementX` / `movementY`). The pause card can set 0.05°–0.30°. The Pointer Lock specification reports those deltas in CSS pixels. Frag does not scale them by `devicePixelRatio`, so one CSS pixel of mouse travel is the same angle at every display scale. Pointer acceleration applied by the operating system is left as the browser reports it. `[` and `]` step the live sensitivity by 0.02° while playing and are not saved. The debug readout shows FPS, camera position, yaw, pitch, sensitivity, planar speed, and whether the body is grounded. Sensitivity, field of view, mute, and invert Y are saved under `frag:settings:v1` when they change.

## Movement

The atrium is 1 unit = 1 meter. The body is a capsule 0.35 m in radius and 1.60 m tall, with the eye 1.45 m off the ground. Simulation steps at a fixed 120 Hz inside the frame, so the feel does not follow the display rate. A frame is simulated in full down to 20 fps, and the debug readout keeps a slow frame. A stall longer than 250 ms is clamped. A hidden tab drops that gap instead of catching up, so returning does not step the sim. The step takes the current state, the wish from the input, and the timestep, and returns the next state. Spawn is on the south concourse. A kill plane under the map, and a step outside the outer walls, puts the body back on that concourse.

On the ground, forward, back, and strafe share an 8 m/s wish. Acceleration toward that wish is 10 m/s². With the keys released, drag at 6/s brings a full run to rest in about 0.3 s. In the air the wish is still 8 m/s but acceleration is 2 m/s², so a strafe can correct a jump without flying. Gravity is 20 m/s². A jump sets vertical speed to 6.8 m/s (apex about 1.15 m) and only works while grounded. Slopes up to 45° and steps up to 0.30 m are walkable. Steeper faces slide or block. Ground drag stays off for 80 ms after a landing, so a jump in that window keeps the speed you landed with. Horizontal speed never exceeds 9.2 m/s.

Two jump pads sit on the east and west edges of the sunken well, clear of the center ammo pad and the south spawn. Stepping on one replaces the body's velocity with a fixed arc: 15.6 m/s up and 8.5 m/s toward that side's catwalk. No strafe is required. The crest stays at least a meter under the ceiling. The east and west rails drop to catwalk height in front of each pad, and the landing is that shelf, about 3 m in from the outer wall. Each plate is fully saturated, cyan to the east and magenta to the west, with chevrons that scroll along the launch about once a second. A faint additive column rises off each pad. The launch plays an upward synth whoosh through the same procedural Web Audio cues as the weapon. Nothing is loaded from a file.

Dust motes drift down under the open skylight, inside the shaft over the well, clear of the pillars and the jump pads. They are a faint cool dust, about three fifths the old square, so they do not sit on the crosshair in the same orange as the pillar bands. Two thin amber bands crawl up each ground pillar, between the plinth and the cap. Exponential fog uses the same near-black as the clear color, light enough that the far walls, enemies, and slot lips stay readable. The bands are drawn with the pillar beacons. The dust shares the faint additive column pass, so it does not add a draw. Nothing is loaded from a file.

## VEC-9 Quill Driver

The prototype weapon is a magnetic flechette carbine. Holding the left mouse fires one rail-spike every 0.125 s, with no spread. A click that ends before the next frame still fires one shot when the weapon is ready. Clicking faster than eight a second does not, and clicks during a reload or an empty magazine do not fire once that gate ends. Each flechette is a projectile: it travels at 70 m/s, is about 0.35 m long with a 0.06 m radius, and despawns after 1 s or 70 m. A hit deals 9 damage with no falloff. The magazine holds 40 and the reserve starts at 40, capped at 80. Reserve never goes negative. Reload takes 1.4 s, from R or automatically when the magazine is empty and rounds remain, and the trigger does nothing during that reload. Pulling the trigger with an empty magazine and an empty reserve does not fire and does not cycle. Each shot adds a 0.12° upward view punch that settles before the next shot if aim is held. The viewmodel, the cyan-magenta muzzle flash, the flechettes, and the tracers are procedural geometry. A lamp on the top spine shows the magazine: full length and cyan at 40 rounds, amber at 18, and gone at empty, shifting between those colors as the count falls. It changes when the magazine changes, including the moment a reload finishes. A reserve pickup does not move it until those rounds are loaded. Shots, reloads, hits, pickups, and the low-HP pulse are procedural Web Audio. M mutes them. Nothing is loaded from a file.

Right-click charges that carbine for 0.45 s. The muzzle flash mesh glows while the charge rises, and a sawtooth hum sweeps from 196 Hz to 880 Hz through the same 1200 Hz lowpass as the other cues. At 0.45 s it fires three flechettes with no spread. Each deals 9 and pierces one enemy, so two enemies standing on the bore each take 27. The burst spends 5 magazine rounds and the spine lamp shortens by those 5. Another charge cannot begin for 0.8 s. A magazine under 5, or a reload already running, does not fire. Releasing before 0.45 s, or dropping under 5 rounds while the charge is up, shows a brief abort flash and a short falling blip. Left-click stays at eight shots a second.

## Pickups and damage

Two health pads, two armor pads, and three ammo pads sit on the atrium landmarks. The body collects one by walking the capsule into its trigger. A collected pad stays in place and goes dark until its timer elapses, then it can be taken again. Health adds 25 and stops at 100, and returns after 20 s. Armor adds 25 and stops at 100, and returns after 25 s. Ammo adds 40 flechettes to the Quill Driver reserve and does not top up the magazine. Reserve stops at 80, so 40 in the magazine and 70 in reserve becomes 40+80, and the pad returns after 15 s. A pad that cannot add anything, because health or armor is already 100 or the reserve is already 80, stays lit. The health pad is an acid-green canister with a cross. The armor pad is a cyan vest plate on a lit pad. The ammo pad is a magenta crate. All three are procedural geometry.

Armor absorption is the damage rule a WISP-4 bolt, a UNIT-7 stun blast, and a flechette into an enforcer all call. For damage D and armor A, wanted is floor(D·2/3), armor takes min(A, wanted), and HP loses max(1, D − absorbed). The player starts at 0 armor. HP at 0 is death: the fight stops damaging the player and the recap takes over. The HUD shows HP, ARMOR, and AMMO while playing.

## Hit feedback

A flechette that hits an enemy flashes a white-cyan X on the crosshair for 80 ms, and the drone or enforcer itself flashes white-cyan for 60 ms. A killing blow uses a larger magenta X. Damage taken by the player draws a red arc on the screen edge toward the shot. The arc fades over 400 ms. At most three arcs are kept, and their opacities are scaled so a burst cannot cover the view. Each Quill shot adds a small viewmodel kick. Walking adds a slight bob and strafing a slight lean. Those offsets stay within about two centimeters and three degrees, so the carbine stays in the frame. The 0.12° aim punch is unchanged. None of this is written to storage.

## WISP-4

The early release ships two enemies. The WISP-4 is a rogue security drone. Wave 1 spawns two, already hostile, at least 8 m from the player and clear of the hulls. Each is a low-poly hovering disc with cyan running lights and a visor slit that is red while it is aggro. It has 40 HP and no armor. Only VEC-9 flechettes damage it, through the projectile hitbox sweep. There is no hitscan.

It hovers at 5.5 m/s and strafe-orbits, preferring 8–14 m. Altitude stays 1.2–2.4 m above the deck under it. Inside 6 m it takes the high end of that band. A player on a catwalk makes it climb clear of the parapet, then drop to the low band to peek. It does not use cover, and it stays inside the 32 × 32 × 9 atrium.

The attack is a two-bolt plasma burst. Each bolt travels at 18 m/s, is 0.25 m in radius, and deals 8 damage through the armor rule above. Bolts in a burst are 0.15 s apart. On wave 1 the next burst's first bolt is 2.78 s after the second. Later waves keep 1.8 s. The last 0.3 s of that gap is a glow telegraph. Bolts die on the atrium hulls. A death is a spark burst, small metal and plastic scraps, and dark hydraulic fluid. Bolts, scraps, and the drones themselves are pooled. The drone, the bolts, and the scraps are procedural geometry.

## UNIT-7 Hound

The enforcer is a low-poly armored humanoid with an opaque visor, bulky shoulders, and a fictional ORION-VEC chest mark. It is not a depiction of a real person. It spawns with 80 HP and 15 armor and uses the same absorb rule as the player. It walks at 4.2 m/s, does not jump, and climbs the atrium ramps and 0.30 m stairs. It paths toward the last place it saw the player, stays inside the atrium, and does not cut through the well or the parapet rails.

The stun-blaster is a short hitscan cone. It checks the atrium hull first, so it does not shoot through walls. A hit is 12 damage through the armor rule, the interval is 0.90 s, and the shot only counts inside 12 m. It tries to hold 4–8 m. The visor slit is an amber-red lamp, and each shot draws a short muzzle flash plus a hitscan tracer so the round reads in the dark. It does not fire for 2 seconds after a spawn, a restart, or a new wave. If it takes 25 or more damage inside one second, it sidesteps for about a second and then pushes again. A defeat is a collapse, a spark burst, and a blood spray with abstract gibs and short-lived blood decals on nearby floors and walls. The player, the pickups, and the atrium props do not gib. Those sparks, the gore, and the enforcers themselves are pooled.

## Waves

There is no last wave and no arena-clear screen. `waveComposition` is the schedule: wave 1 is 2 drones, the first enforcer arrives on wave 2, each clear adds one drone, a second enforcer arrives on wave 3, and the cap is 4 drones and 2 enforcers. With `ENFORCER_ENABLED` on, those waves are 2+0, 3+1, 4+2, 4+2. Wave 1 drones wait 3 seconds before they fire, and their bursts are 2.78 seconds apart. Later waves keep the 2 second spawn grace and the 1.8 second burst. The next wave waits about 2 seconds after the current one is fully dead. Spawns stay at least 8 m from the player, inside the atrium, and outside the hulls. At most 4 drones and 2 enforcers are alive at once.

## Death

HP at 0 hides the combat HUD and shows waves cleared, frags, time alive as mm:ss, and "click to restart". Esc or a lost pointer while that recap is up leaves it there. The sim does not keep damaging a downed player. Click restarts that same page load: the body is back on the south concourse at 100 HP, 0 armor, and 40+40 ammo, wave 1 spawns clean, live bolts, scraps, blood, gibs, and decals are cleared, pickup pads are lit, and the recap counters return to zero. The content warning stays dismissed until a reload. Nothing is written to `localStorage`. There is no score and no main menu.

## Field of view

The default horizontal field of view is 105°. The pause card can set 90°–115°. three.js `PerspectiveCamera.fov` is the vertical field of view, so Frag derives the vertical angle from that horizontal angle and the viewport aspect ratio (`width / height`) and writes that into `camera.fov` on load, on resize, and when the setting changes:

```
vertical = 2 * atan(tan(horizontal / 2) / aspect)
```

A square viewport is 105° vertical. A wider viewport keeps 105° horizontal and uses a smaller vertical angle.

CI job `build` runs `npm ci`, `npm run build`, the license and provenance gate, the gate's self-test, and a headless Playwright smoke test.

## Deploys

Staging, pull-request previews, and a production deploy with `target` set to `game` build with `npm ci` and `npm run build`, then upload the prebuilt `dist/` folder. `public/staticwebapp.config.json` ships with that build (SPA fallback, `X-Content-Type-Options`, and a same-origin content security policy).

Pull requests from this repository deploy a preview environment and comment the preview URL. Closing the pull request deletes the preview. Forks are skipped, because they cannot read the deployment token.

Pushes to `main` deploy the named Static Web Apps environment `staging`. Staging and previews always serve the game.

Production does not deploy on push, pull request, or a schedule. The production slot is what the future custom domain `frag.n6s.ai` will serve. Run it from GitHub: Actions → Deploy prod → Run workflow, with the branch set to `main`. The `target` input is `coming-soon` (the default) or `game`. `coming-soon` skips the Node install and build and uploads the `coming-soon/` folder. `game` uploads `dist/`. That job uses the `production` environment, so it waits for approval, checks out `main`, and deploys the production slot.
