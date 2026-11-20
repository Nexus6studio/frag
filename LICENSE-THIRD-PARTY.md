# Third-party licenses

Frag is MIT licensed. Direct npm dependencies:

| package | version | license | role |
| --- | --- | --- | --- |
| three | 0.187.0 | MIT | Runtime WebGL scene. The only runtime dependency. |
| vite | 7.3.8 | MIT | Dev server and static production build. |
| typescript | 7.0.2 | Apache-2.0 | `tsc --noEmit` during `npm run build`. |
| playwright | 1.65.1 | Apache-2.0 | Headless Chromium smoke test. Not part of the shipped site. |

`scripts/check-provenance.mjs` reads every installed `package.json` under `node_modules`, including transitive and dev dependencies. A license outside this set fails CI: MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD, and the Unlicense.

0BSD and the Unlicense are public-domain-equivalent permissive licenses with no copyleft. None of the current packages use them. `UNLICENSED` (npm's proprietary marker), GPL, AGPL, LGPL, and unknown licenses fail. An `OR` expression passes when one side is allowed, because that side can be chosen. An `AND` expression passes only when every side is allowed.

Vite 8 depends on `lightningcss` (MPL-2.0), so this repo stays on Vite 7. Vite also lists `lightningcss` as an optional peer for CSS transforms this app does not use. `.npmrc` sets `legacy-peer-deps=true` so that peer, and the other unused CSS and minifier peers, are not installed.

`@types/three` is not installed. That package depends on `@dimforge/rapier3d-compat`, a physics engine. The placeholder scene uses a small local type declaration in `src/three.d.ts` instead.
