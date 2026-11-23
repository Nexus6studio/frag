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

A fresh load shows a content warning before play. The title is Content warning. The body says the prototype contains fast-paced combat against robotic enemies, with explosions, sparks and debris, plus flashing lights and rapid motion. Continue acknowledges it for that page load only. It is not stored, and the next load shows it again. Continue then reveals a click-to-play overlay titled Frag. Click it, or press Enter, to lock the pointer and hide the overlay. Esc releases the pointer and pauses. Click the pause overlay to resume. Resuming does not show the warning again. Backquote or F1 toggles a small FPS readout, which is off until then. The scene behind the overlays is the Neon Atrium: a closed 32 m map with a sunken well, a ground concourse, corner ramps and stairs, and an upper ring. Nothing there is a loaded asset. Looking, movement, the control table, and the field of view are below.

## Controls

Looking and buttons are read from one input state each frame. `down` is held. `pressed` and `released` are the edges since the previous frame. The state is empty while the pointer is unlocked or the game is paused, so look and buttons do nothing then. Losing the pointer lock clears edges. It does not emit a release for a key that was held. A key still held when play resumes is `down` again without a new `pressed`.

| Input | State | Action |
| --- | --- | --- |
| W A S D | `forward` `left` `back` `right` | Walk and strafe in the atrium. |
| Mouse | `lookX` `lookY` | Yaw and pitch while the pointer is locked. Pitch clamps to ±89°. |
| Space | `jump` | Jump. |
| Left mouse | `fire` | VEC-9 Quill Driver. Full-auto while held: one flechette per pulse, eight per second. A click that is already up by the next sample still fires once. Clicks cannot exceed that eight per second, and a burst inside one frame does not queue extra shots. `down.fire` stays set for the whole hold. `pressed.fire` is only the down edge. `firePresses` is how many left clicks landed since the last sample. |
| R | `reload` | Reload the Quill Driver. An empty magazine reloads on its own when rounds remain. |
| Esc | `pause` | Pause and release the pointer. Click the pause overlay to resume. |
| Backquote or F1 | `debug` | Toggle the FPS and position readout. The shell toggle still works while paused. |
| `[` `]` | `sensDown` `sensUp` | Temporary mouse sensitivity. Not saved. |

There is no gamepad or touch input.

Default look sensitivity is 0.12° per pointer-lock pixel (`movementX` / `movementY`). The Pointer Lock specification reports those deltas in CSS pixels. Frag does not scale them by `devicePixelRatio`, so one CSS pixel of mouse travel is 0.12° at every display scale. Pointer acceleration applied by the operating system is left as the browser reports it. `[` and `]` step that sensitivity by 0.02° while playing. The debug readout shows FPS, camera position, yaw, pitch, sensitivity, planar speed, and whether the body is grounded. Nothing is written to `localStorage`.

## Movement

The atrium is 1 unit = 1 meter. The body is a capsule 0.35 m in radius and 1.60 m tall, with the eye 1.45 m off the ground. Simulation steps at a fixed 120 Hz inside the frame, so the feel does not follow the display rate. A frame is simulated in full down to 20 fps, and the debug readout keeps a slow frame. A stall longer than 250 ms is clamped. A hidden tab drops that gap instead of catching up, so returning does not step the sim. The step takes the current state, the wish from the input, and the timestep, and returns the next state. Spawn is on the south concourse. A kill plane under the map, and a step outside the outer walls, puts the body back on that concourse.

On the ground, forward, back, and strafe share an 8 m/s wish. Acceleration toward that wish is 10 m/s². With the keys released, drag at 6/s brings a full run to rest in about 0.3 s. In the air the wish is still 8 m/s but acceleration is 2 m/s², so a strafe can correct a jump without flying. Gravity is 20 m/s². A jump sets vertical speed to 6.8 m/s (apex about 1.15 m) and only works while grounded. Slopes up to 45° and steps up to 0.30 m are walkable. Steeper faces slide or block. Ground drag stays off for 80 ms after a landing, so a jump in that window keeps the speed you landed with. Horizontal speed never exceeds 9.2 m/s.

## VEC-9 Quill Driver

The prototype weapon is a magnetic flechette carbine. Holding the left mouse fires one rail-spike every 0.125 s, with no spread. A click that ends before the next frame still fires one shot when the weapon is ready. Clicking faster than eight a second does not, and clicks during a reload or an empty magazine do not fire once that gate ends. Each flechette is a projectile: it travels at 70 m/s, is about 0.35 m long with a 0.06 m radius, and despawns after 1 s or 70 m. A hit deals 9 damage with no falloff. The magazine holds 40 and the reserve starts at 40, capped at 80. Reserve never goes negative. Reload takes 1.4 s, from R or automatically when the magazine is empty and rounds remain, and the trigger does nothing during that reload. Pulling the trigger with an empty magazine and an empty reserve does not fire and does not cycle. Each shot adds a 0.12° upward view punch that settles before the next shot if aim is held. The viewmodel, the cyan-magenta muzzle flash, the flechettes, and the tracers are procedural geometry. There is no audio.

## Pickups and damage

Two health pads and three ammo pads sit on the atrium landmarks. The body collects one by walking the capsule into its trigger. A collected pad stays in place and goes dark until its timer elapses, then it can be taken again. Health adds 25 and stops at 100, and returns after 20 s. Ammo adds 40 flechettes to the Quill Driver reserve and does not top up the magazine. Reserve stops at 80, so 40 in the magazine and 70 in reserve becomes 40+80, and the pad returns after 15 s. A pad that cannot add anything, because health is already 100 or the reserve is already 80, stays lit. The health pad is an acid-green canister with a cross. The ammo pad is a magenta crate. Both are procedural geometry.

The two armor landmarks stay in the map data. `ARMOR_ENABLED` is false, so those pads are not drawn and cannot be collected. The armor number on the HUD stays hidden. Armor absorption is the damage rule a WISP-4 bolt calls: for damage D and armor A, armor takes min(A, floor(D·2/3)) and the rest comes off HP. A hit that would remove less than 1 HP still removes 1. In this release armor is 0, so the whole hit lands on HP. HP at 0 is death: the fight stops damaging the player and the recap takes over.

## WISP-4

The early release ships one enemy, the WISP-4 rogue security drone. Wave 1 spawns two, already hostile, at least 8 m from the player and clear of the hulls. Each is a low-poly hovering disc with cyan running lights and a visor slit that is red while it is aggro. It has 40 HP and no armor. Only VEC-9 flechettes damage it, through the projectile hitbox sweep. There is no hitscan.

It hovers at 5.5 m/s and strafe-orbits, preferring 8–14 m. Altitude stays 1.2–2.4 m above the deck under it. Inside 6 m it takes the high end of that band. A player on a catwalk makes it climb clear of the parapet, then drop to the low band to peek. It does not use cover, and it stays inside the 32 × 32 × 9 atrium.

The attack is a two-bolt plasma burst. Each bolt travels at 18 m/s, is 0.25 m in radius, and deals 8 damage through the armor rule above. Bolts in a burst are 0.15 s apart. The next burst's first bolt is 1.8 s after the second, and the last 0.3 s of that gap is a glow telegraph. Bolts die on the atrium hulls. A death is a spark burst, small metal and plastic scraps, and dark hydraulic fluid. Bolts, scraps, and the drones themselves are pooled. The drone, the bolts, and the scraps are procedural geometry.

## Waves

There is no last wave and no arena-clear screen. `waveComposition` is the schedule: wave 1 is 2 drones and 1 enforcer, each clear adds one drone, a second enforcer arrives on wave 3, and the cap is 4 drones and 2 enforcers. `ENFORCER_ENABLED` is false in this release, so enforcers are not spawned. Clearing waves spawns 2, then 3, then 4, then 4 drones. With the flag on, the same waves are 2+1, 3+1, 4+2, 4+2. The next wave waits about 2 seconds after the current one is fully dead. Spawns stay at least 8 m from the player, inside the atrium, and outside the hulls. At most 4 drones are alive at once.

## Death

HP at 0 hides the combat HUD and shows waves cleared, frags, time alive as mm:ss, and "click to restart". The sim does not keep damaging a downed player. Click restarts that same page load: the body is back on the south concourse at 100 HP, 0 armor, and 40+40 ammo, wave 1 spawns clean, live bolts and scraps are cleared, pickup pads are lit, and the recap counters return to zero. The content warning stays dismissed until a reload. Nothing is written to `localStorage`. There is no score and no main menu.

## Field of view

The horizontal field of view is 105°. three.js `PerspectiveCamera.fov` is the vertical field of view, so Frag derives the vertical angle from 105° and the viewport aspect ratio (`width / height`) and writes that into `camera.fov` on load and on resize:

```
vertical = 2 * atan(tan(horizontal / 2) / aspect)
```

A square viewport is 105° vertical. A wider viewport keeps 105° horizontal and uses a smaller vertical angle.

CI job `build` runs `npm ci`, `npm run build`, the license and provenance gate, the gate's self-test, and a headless Playwright smoke test.

## Deploys

Deploy workflows build with `npm ci` and `npm run build`, then upload the prebuilt `dist/` folder. `public/staticwebapp.config.json` ships with that build (SPA fallback, `X-Content-Type-Options`, and a same-origin content security policy).

Pull requests from this repository deploy a preview environment and comment the preview URL. Closing the pull request deletes the preview. Forks are skipped, because they cannot read the deployment token.

Pushes to `main` deploy the named Static Web Apps environment `staging`.

Production does not deploy on push, pull request, or a schedule. Run it from GitHub: Actions → Deploy prod → Run workflow, with the branch set to `main`. That job uses the `production` environment, so it waits for approval, checks out `main`, and deploys the production slot.
