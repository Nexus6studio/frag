# Asset provenance

Every non-code asset must have one row in the table below before it can be merged. That covers models, textures, sounds, music, fonts, and maps.

Asset binaries live under `public/` or `src/assets/`. CI job `build` runs `scripts/check-provenance.mjs`, which fails when one of those files (images, audio, video, models, fonts, maps) has no row, or when a row has an empty source or license. TypeScript and CSS in those folders are not assets.

| path | type | source (AI tool name + version, or CC0 source URL) | license | author/creator | date added |
| --- | --- | --- | --- | --- | --- |

No id Software / Quake code, maps, art or sounds. No GPL/AGPL/LGPL code. Installed dependencies, including transitive ones, must be MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, or ISC. 0BSD and the Unlicense are also accepted as public-domain-equivalent permissive licenses. Notices for direct dependencies are in [LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md).
