# TaskDock – Tauri application icon assets

Two independent application-icon sets (not blended):

- `01-flat-2d/` – first image, clean 2D outline style. **Default recommendation**.
- `02-soft-3d/` – second image, soft-shaded 3D style. **Alternative**.

Each folder contains a `1024x1024` RGBA transparent-corner `icon.png`, macOS `icon.icns`, Windows `icon.ico`, and various PNG sizes for desktop and store assets. Generated from the two images supplied by the user on Oct 25, 2026; only canvas isolation/cropping/resizing/transparent rounded corners/shadow normalization was done.

The preview JPEGs at the package root show both icons against light and dark backgrounds.

## Integrate

1. Inspect `src-tauri/tauri.conf.json` or existing Tauri configuration and its current `bundle.icon` settings, plus existing tray icons.
2. Back up existing app icon assets. Keep both variant folders in the repository in a convenient location, such as `assets/branding/icons/`.
3. As an initial default, copy desktop build assets from `01-flat-2d/` to `src-tauri/icons/` as the active icons. Preserve other platform-specific mobile or icon resources if the project requires them.
4. Set `bundle.icon` references to the files required by the actual Tauri version. For Tauri v2, a typical desktop configuration is:

```json
"bundle": {
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ]
}
```

5. Do not automatically replace tray/menu-bar template icons with a full-color application icon: they usually require a distinct monochrome, highly simplified asset.
6. Run the project's existing check/build scripts, inspect Dock/taskbar, installed executable icons and installers on supported host platforms, and report any platform verification not possible in the local environment.
7. Keep `02-soft-3d` for an easy, build-time switch later; do not implement a runtime icon switch unless requested.

Source: https://v2.tauri.app/develop/icons/

**Note:** These are production-ready raster icon exports, not hand-drawn SVG/vector masters. At extremely small sizes such as 16px, some detail will naturally be reduced.
