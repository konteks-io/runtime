# Authenticated published text fixtures

`sources.json.gz` contains only published JavaScript, JSON metadata and license/documentation text from `@nanonets/graft@0.18.0`, `tree-sitter-swift@0.7.1` and `tree-sitter-cli@0.23.2`. The independent npm archives were verified against SHA-512 registry integrity; their SHA-256 values are retained inside the fixture. No native binaries are included or executed by these tests.

The exact fixture SHA-256 is `1c9a972090437b75ac065d3e568e736c588dcec5ed8484216bebba2e8c7c62d7`. Graft's 144 published `dist/` and `scripts/` JavaScript/JSON members bind the reviewed runtime consumer closure. The Swift binding loads `node-gyp-build`; its CLI dependency is used by development scripts. The CLI's install script downloads its separate native generator executable.

These packages retain their MIT licenses beside the fixture. Current registry resolution of Swift's `^0.23` is 0.23.2; this does not prove which CLI version an earlier unlocked CI installation resolved. Production refuses any other installed CLI version/source.
