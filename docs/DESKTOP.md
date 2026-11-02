# Desktop build — Windows `.exe`

Echoes of Blackwood Valley ships as a desktop game. The same TypeScript
engine that powers the web preview is wrapped by a thin **Electron** shell
(`desktop/main.cjs`) and packaged with **electron-builder** into a portable
Windows executable.

## Build the `.exe` (on your machine)

```bash
npm ci                 # installs dependencies + the Electron runtime
npm run build          # tsc + vite → dist/ (relative asset base for app://)
npm run dist:win       # electron-builder → release/EchoesOfBlackwoodValley-<version>-win64.exe
```

The result is a single portable `.exe` (no installer, no admin rights
needed) that runs the full game: main menu, campaign, city map, save slots.

Other useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run desktop` | Run the game as a desktop window (dev check) |
| `npm run preview` | Web preview of the same build (http) |
| `npm test` | Full unit/integration suite |

## Notes

- **Why Electron and not Unreal Engine templates?** This game is built on
  the existing Three.js/WebGPU + Rapier + TypeScript engine (per the
  project's "layer, don't rewrite" rule). Unreal `.uasset` templates cannot
  be imported into a WebGL/WebGPU codebase — instead, all visuals, the city
  layout, lighting and audio are **generated procedurally at runtime**
  (canvas window textures, instanced geometry, WebAudio synthesis), so the
  shipped game contains **zero third-party media assets and zero licensing
  obligations**.
- The Electron shell loads the game through a privileged `app://` scheme
  (required for ES modules, workers and WASM under a packaged binary).
- F11 toggles fullscreen; the in-game pointer lock behaves the same as the
  web build.
- Sandbox environments that block GitHub's release CDN cannot download the
  Electron runtime; on a normal developer machine `npm ci` fetches it
  automatically.
