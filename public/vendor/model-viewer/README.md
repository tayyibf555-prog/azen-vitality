# Vendored `<model-viewer>` (self-hosted)

This is a pinned, self-hosted copy of Google's `<model-viewer>` web component. It
powers the optional **3D showcase** section on AI landing pages
(`/go/<client>/<slug>`). There is deliberately **no npm dependency**: the landing
renderer loads `/vendor/model-viewer/model-viewer.min.js` with a `<script>` tag
only on pages whose content includes a `showcase3d` section.

## Provenance

| | |
|---|---|
| Package | `@google/model-viewer` |
| Version | **4.0.0** |
| File | `dist/model-viewer.min.js` |
| Source URL | `https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js` |
| Retrieved | 2026-07-17 |
| Size | 955,556 bytes |
| SRI (sha384) | `sha384-sr9b4Ux0WhAUGclJ0ym0FSY2zSOMmNSn0bP/SA0e6bNCrpn/5W3QL8mm+LdlQMKw` |
| Licence | Apache-2.0 (see `LICENSE`); bundles three.js (MIT) and lit (BSD-3-Clause), see `NOTICE` |

The bundle is self-contained (no bare/external ES module imports). To re-verify
integrity:

```sh
openssl dgst -sha384 -binary model-viewer.min.js | openssl base64 -A
# expected: sr9b4Ux0WhAUGclJ0ym0FSY2zSOMmNSn0bP/SA0e6bNCrpn/5W3QL8mm+LdlQMKw
```

## Updating

1. Download the new pinned version from jsDelivr (or unpkg) at
   `@google/model-viewer@<version>/dist/model-viewer.min.js`.
2. Recompute the sha384 above and update this table.
3. Confirm `grep customElements.define model-viewer.min.js` is present and that
   there are no non-relative `import"..."` / `from"..."` specifiers (self-contained).

## Supplying a model (`.glb`)

No 3D asset ships with the platform. A practice supplies its own, properly
licensed model (a scanner export or a commissioned asset). Place the file under
`public/models/` and set the landing content's `showcase3d.modelUrl` to its path
(e.g. `/models/aligner.glb`).

**Format and size guidance**

- Format: **`.glb`** (binary glTF). A single self-contained file.
- Size: aim for **under 5 MB** so the section stays fast on mobile (90% of
  landing traffic is phone). Under 2 MB is better still.
- Compression: Draco geometry compression and KTX2 textures are supported and
  keep files small, **but** model-viewer then fetches the matching decoder from
  `www.gstatic.com` at runtime (see `NOTICE`). For a fully self-hosted page,
  prefer an uncompressed `.glb`, or self-host the decoders.
- Always provide a `showcase3d.posterUrl` (a static image, e.g. a WebP/PNG under
  `public/models/`): it is shown while the model loads, to reduced-motion users,
  and if the script or model fails. The section degrades to this image cleanly.
