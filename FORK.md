# JD's Fluxer fork

This is a fork of [fluxerapp/fluxer](https://github.com/fluxerapp/fluxer) that carries a few
fixes to the web client for a self-hosted instance. It is not affiliated with the Fluxer project.

## Branches

- `main` follows upstream and has no changes.
- `jd/patches` is the branch the instance runs: one commit per fix, on top of the upstream
  commit that the matching official release was built from. It is rebased onto each new release,
  and a fix is dropped once upstream has its own.

## What is patched

Only the web client (`fluxer_app`), which ships in the `fluxer-app-proxy-self-hosted` image. All
other services run the official images unchanged.

| Fix | Upstream report |
| --- | --- |
| Leaving a channel that denies Speak (such as an AFK channel) no longer leaves you self-muted | [Feedback #4789](https://feedback.fluxer.com/p/4789) |
| A "Noise suppression strength" slider in voice settings: DeepFilterNet's noise reduction, fixed upstream at 30 dB, can be set from 6 dB to no limit, and changes apply live | [Feedback #4791](https://feedback.fluxer.com/p/4791) |

The official desktop app bundles its own copy of the web client, so these fixes reach people who
use the instance in a browser.

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
