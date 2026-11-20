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

CI job `build` runs `npm ci`, `npm run build`, the license and provenance gate, the gate's self-test, and a headless Playwright smoke test.

## Deploys

Deploy workflows build with `npm ci` and `npm run build`, then upload the prebuilt `dist/` folder. `public/staticwebapp.config.json` ships with that build (SPA fallback, `X-Content-Type-Options`, and a same-origin content security policy).

Pull requests from this repository deploy a preview environment and comment the preview URL. Closing the pull request deletes the preview. Forks are skipped, because they cannot read the deployment token.

Pushes to `main` deploy the named Static Web Apps environment `staging`.

Production does not deploy on push, pull request, or a schedule. Run it from GitHub: Actions → Deploy prod → Run workflow, with the branch set to `main`. That job uses the `production` environment, so it waits for approval, checks out `main`, and deploys the production slot.
