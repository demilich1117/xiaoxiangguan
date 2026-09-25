# Bundled reader fonts

The parallel reader uses self-hosted Fontsource 5.3.0 builds so glyph shape and
weight do not depend on fonts installed on the reader's computer.

- `noto-serif-jp`: Japanese source text (`ja`)
- `noto-serif`: English, French, German, and Spanish source text
- `noto-serif-sc`: Simplified Chinese translations (`zh-CN`)

Each directory contains the package metadata and its OFL-1.1 `LICENSE`. The CJK
families are split into Unicode-range WOFF2 files; browsers fetch only the
fragments used by the current page. Only normal variable-weight files are used.
