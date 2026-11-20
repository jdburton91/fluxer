# JD's Fluxer fork

This is a fork of [fluxerapp/fluxer](https://github.com/fluxerapp/fluxer) that carries a few
fixes to the web client for a self-hosted instance. It is not affiliated with the Fluxer project.

## Branches

- `main` follows upstream and has no changes.
- `jd/patches` is the branch the instance runs: one commit per fix, on top of the upstream
  commit that the matching official release was built from. It is rebased onto each new release,
  and a fix is dropped once upstream has its own.

## What is patched

The web client (`fluxer_app`), which ships in the `fluxer-app-proxy-self-hosted` image, and the
desktop app (`fluxer_desktop`). All other services run the official images unchanged.

| Fix | Upstream report |
| --- | --- |
| Leaving a channel that denies Speak (such as an AFK channel) no longer leaves you self-muted | [Feedback #4789](https://feedback.fluxer.com/p/4789) |
| A "Noise suppression strength" slider in voice settings: DeepFilterNet's noise reduction, fixed upstream at 30 dB, can be set from 6 dB to no limit, and changes apply live | [Feedback #4791](https://feedback.fluxer.com/p/4791) |
| A "DPDFNet" noise suppression choice: Ceva's DPDFNet-2 48 kHz model (Apache-2.0), run by onnxruntime-web in a worker, about 70 ms of delay, strength set by the same slider | None yet |
| Voice defaults: the Custom profile with DPDFNet noise suppression and a fixed 40% activity threshold (upstream: the Voice profile, RNNoise, an automatic threshold). Every install is moved onto them once; later changes stay | Not a bug; a choice for this instance |
| A "Toggle streaming" shortcut (Keybinds, add a keybind; it can be global): starts a stream (opens the source picker and, in the desktop app, brings the window forward) or stops the current one | None yet |
| The volume and local mute you set for each person are kept with your account as well as on the device, so an update, a reinstall or another device keeps them. A value set on another device wins for that person. Stored as a fork field (`jd_participant_volumes = 9001`) in the synced preferences; official servers and clients keep it unchanged | None yet |
| A screen share no longer drops out of the call and rejoins when the server rates its connection "lost" (for example when the stream's audio goes quiet). LiveKit's client forced a full reconnect after 10 seconds of that rating; the rule is off, and real connection failures still reconnect | None yet |

The official desktop app bundles its own copy of the web client, so it does not get these fixes.
Use the fork's desktop app instead (below).

## Desktop app

The [releases](https://github.com/jdburton91/fluxer/releases) carry fork builds of the desktop
app for Linux (AppImage, `.deb`, `.rpm`, `.tar.gz`) and Windows (a portable ZIP), built by
`.github/workflows/jd-desktop.yaml` on GitHub Actions. They differ from the official app in three
ways:

- **The web fixes above are built in.** The module system that would download Fluxer's
  official web client into the app is off.
- **They update from this fork, never from Fluxer.** Fluxer's update feed would replace them with
  the official build. The AppImage checks this fork's releases at start and then hourly,
  downloads a newer `desktop-<version>` release in the background, checks it against the SHA-256
  digest GitHub lists for the file, and swaps it in place of itself: the new version runs at the
  next start, or at once from "Update now". The Windows ZIP, `.deb`, `.rpm` and `.tar.gz` cannot
  replace themselves, so they say when a newer release is out and download it (Windows) or open
  its page.
- **They are not code-signed.** Windows SmartScreen warns on first start ("More info", then
  "Run anyway"). There is no Windows installer, because Fluxer's packaging only makes signed ones.
- **The Windows ZIP keeps its data in `%APPDATA%\fluxer`**, like the installed official app, not
  in a folder next to the program. Unzip a new version anywhere and you stay signed in with your
  settings; moving from the official Windows app keeps its sign-in and settings too. (Builds before
  2026-11-18 kept everything in a `data` folder beside `Fluxer.exe`.)

Each release lists SHA-256 checksums. At sign-in, enter your instance's address as usual.

| Desktop-only change | Why |
| --- | --- |
| Updates come from this fork's releases only (the AppImage installs them itself); download links go to this fork | Keeps the fixes through updates |
| The web client can ask for the main window to be shown and focused (used by the stream shortcut) | Lets the shortcut work while the app is in the background |
| "Toggle streaming" is also offered to the system's shortcut settings (on Linux, the desktop's global shortcuts list) | Upstream's list of system shortcuts leaves it out |
| Linux with an NVIDIA card plus built-in Intel or AMD graphics: video encoding for screen share uses the built-in graphics (VA-API), when its driver is installed. The app's own menu entry and autostart entry start it with the matching `LIBVA_DRIVER_NAME`; started another way with `LIBVA_DRIVER_NAME=nvidia`, it keeps software encoding. Opt out with `FLUXER_DISABLE_IGPU_VIDEO_ENCODE=1` | NVIDIA's VA-API driver only decodes, so streams fell back to slow software encoding |

## Using it

Build the self-hosted web client image from this branch:

```sh
podman build --format docker -f fluxer_app_proxy/Dockerfile \
  --build-arg BUILD_VERSION=<YYYY.MDD.HHMMSS> --build-arg FLUXER_SELF_HOSTED=true \
  -t fluxer-app-proxy-self-hosted:<version> .
```

Then point the `app-proxy` service of a compose install at it with an override file. Build from
the `jd/patches` commit that matches your instance's release; mixing a newer client with older
services is not tested.

Licence: AGPL-3.0-or-later, as upstream.
