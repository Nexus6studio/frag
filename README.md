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

A fresh load shows a content warning before play. The warning names blood and gibs, fictional violence, and flashing lights. Continue acknowledges it for that page load only. It is not stored, and the next load shows it again. Continue then reveals a click-to-play overlay titled Frag. Click it, or press Enter, to lock the pointer and hide the overlay. Esc releases the pointer and pauses. Click the pause overlay to resume. Resuming does not show the warning again. Backquote or F1 toggles a small FPS and position readout, which is off until then. The scene behind the overlays is the placeholder three.js cube. Looking, the control table, and the field of view are below.

## Controls

Looking and buttons are read from one input state each frame. `down` is held. `pressed` and `released` are the edges since the previous frame. The state is empty while the pointer is unlocked or the game is paused, so look and buttons do nothing then. Losing the pointer lock clears edges. It does not emit a release for a key that was held. A key still held when play resumes is `down` again without a new `pressed`.

| Input | State | Action |
| --- | --- | --- |
| W A S D | `forward` `left` `back` `right` | Move intent. No movement physics yet. |
| Mouse | `lookX` `lookY` | Yaw and pitch while the pointer is locked. Pitch clamps to ±89°. |
| Space | `jump` | Jump intent. |
| Left mouse | `fire` | Full-auto fire intent. `down.fire` stays set for the whole hold. `pressed.fire` is only the down edge. The gun is a later ticket. |
| R | `reload` | Reload intent. |
| Esc | `pause` | Pause and release the pointer. Click the pause overlay to resume. |
| Backquote or F1 | `debug` | Toggle the FPS and position readout. The shell toggle still works while paused. |
| `[` `]` | `sensDown` `sensUp` | Temporary mouse sensitivity. Not saved. |

There is no gamepad or touch input.

Default look sensitivity is 0.12° per pointer-lock pixel (`movementX` / `movementY`). The Pointer Lock specification reports those deltas in CSS pixels. Frag does not scale them by `devicePixelRatio`, so one CSS pixel of mouse travel is 0.12° at every display scale. Pointer acceleration applied by the operating system is left as the browser reports it. `[` and `]` step that sensitivity by 0.02° while playing. The debug readout shows FPS, camera position, yaw, pitch, and the current sensitivity. Nothing is written to `localStorage`.

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
