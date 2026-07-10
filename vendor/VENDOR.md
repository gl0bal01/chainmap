# Vendored third-party libraries

All runtime libraries are vendored locally and loaded from `./vendor/**` — **no CDN
`<script>` tags**, so the app has exactly one runtime outbound host (the Etherscan API).
Pinned, checksummed, license included. To upgrade: re-download the exact version,
update the version + SHA-256 below, and re-run the export/render tests (Stage B).

| Library     | Version | Global      | File                                   | Source (unpkg)                                                        |
|-------------|---------|-------------|----------------------------------------|----------------------------------------------------------------------|
| vis-network | 10.1.0  | `window.vis`   | `vendor/vis-network/vis-network.min.js` | `vis-network@10.1.0/standalone/umd/vis-network.min.js` (bundles vis-data) |
| jsPDF       | 4.2.1   | `window.jspdf` | `vendor/jspdf/jspdf.umd.min.js`         | `jspdf@4.2.1/dist/jspdf.umd.min.js`                                   |

## SHA-256

```
fd730e304a5b877a937a896be9536e7974dc473d8ac87fa66644bce52cb5f8e4  vendor/vis-network/vis-network.min.js
e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54  vendor/jspdf/jspdf.umd.min.js
```

Verify: `sha256sum -c` against the values above.

## Upgrade note vs. reference app

The reference (`app.js`) loaded vis-network **9.1.9** + jsPDF **2.5.1** from unpkg CDN.
v2 vendors the **latest stable** (vis-network 10.1.0, jsPDF 4.2.1) per the "latest stable"
policy. The public APIs used (`vis.Network`, `vis.DataSet`, `network.getPositions/moveNode/
DOMtoCanvas`, `new jspdf.jsPDF(...).addImage(...).save(...)`) are unchanged across these
majors, but the render/export modules (Stage B) are the contract owners and must be
verified against these exact vendored bundles.

## Licenses

- vis-network — Apache-2.0 / MIT dual — see `vendor/vis-network/LICENSE`.
- jsPDF — MIT — see `vendor/jspdf/LICENSE`.
