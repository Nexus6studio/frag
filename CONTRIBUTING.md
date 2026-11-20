# Contributing

Pull requests need a green CI `build` check. That job typechecks and builds the static site, rejects a dependency license outside the allowlist, rejects an asset with no provenance row, and runs the headless smoke test.

If a pull request adds a non-code asset (a model, texture, sound, music track, font, or map), add one provenance row for it in ASSETS.md in the same pull request.
