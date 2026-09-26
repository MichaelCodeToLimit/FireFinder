# FireFinder brand

The mark is a flame ringed by map contour lines: a fire located on the map. The icon puts the flame in a fire finder's sighting ring on a dark tile.

| File | Use |
| --- | --- |
| `firefinder-logo.svg` / `-dark.svg` | The mark, for light / dark backgrounds |
| `firefinder-lockup.svg` / `-dark.svg` | Mark + wordmark, for light / dark backgrounds |
| `firefinder-icon.svg` | App icon, favicon, avatars (works on any background) |
| `png/` | Raster exports: logo 1024px, lockup 992px, icon 16/32/180/192/512px |

The lockup SVGs set the wordmark in Archivo (weight 820, 120% width) and load it from Google Fonts. Where web fonts can't load (e.g. an SVG in an `<img>` tag), the text falls back to Helvetica/Arial at the same width; use the PNGs when it must match exactly.

Below 24px, use the icon rather than the mark: the contour rings need room.

| Colour | Light | Dark |
| --- | --- | --- |
| Ink | `#14201a` | `#e6ede8` |
| Flare | `#e0520e` | `#ff7a3d` |
| Ground | `#eff3ee` | `#0e1512` |
