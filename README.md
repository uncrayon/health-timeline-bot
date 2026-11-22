# Health Timeline

> **For demonstration and educational purposes only.** This project uses synthetic data. It does not provide medical advice, diagnosis, or treatment, and is not a substitute for advice from a qualified healthcare professional. Do not use it to make decisions about your health.
>
> The local demo does not collect or transmit visitor data. If you connect an AI model or use a third-party-hosted version, that provider may process data under its own terms. AI-generated output can be inaccurate or fabricated. Verify information independently and do not rely on it for health decisions.

See [PRIVACY.md](PRIVACY.md) for information about data handling and deployment limits.

Did my cholesterol actually go up? The two synthetic reports show direct serum LDL rising from 112 mg/dL on Feb 14, 2026 to approximately 139 mg/dL on Oct 8, 2026. The demo shows a rounded change of +27 mg/dL.

## Run the local demo

On the EVO-X2, use Node.js 22.16 or later, npm, Python 3, and Poppler’s `pdftotext` and `pdftoppm`. The demo uses the checked-in PDFs and requires no package download.

```sh
cd ~/Documents/health-timeline
npm start
```

Open [Health Timeline](http://127.0.0.1:8765). Select either point or timeline row to open the highlighted result line. Select a collection or report date to highlight that date in the PDF. **Open original PDF** opens the source report at the displayed page. Expand **See receipt order** to see Meridian arrive Oct 10 and the February Cedar report arrive as a simulated email copy Oct 18.

The fixture PDFs supply collection dates and synthetic report dates. The fixture manifest supplies receipt dates. The comparison accepts explicitly recognized direct serum LDL results with known collection dates and supported units. It keeps each lab’s range with its original result. Meridian’s 3.60 mmol/L multiplied by 38.67 is 139.212 mg/dL. Records with an unknown collection date or an incomparable result appear under **Needs review** when present.

## Verify the data and OpenClaw tool

```sh
npm test
```

This rebuilds the SQLite snapshot twice, checks both source PDFs and date orders, exercises the missing and invalid data cases, then invokes the registered `health_ldl_trend` handler with `{"measurement":"ldl_direct_serum"}`. The tool reads the same SQLite snapshot as the UI. Its output includes the original value, unit, range, normalized value, and a relative evidence link for each report. Its input accepts one fixed synthetic measurement ID.

The native plugin entry is `openclaw.mjs`. For an existing dedicated OpenClaw demo profile, run `npm run ingest` before linking the folder with `openclaw plugins install --link ./health-timeline` from its parent directory. Allowlist `health_ldl_trend` only for the demo agent. The local handler test covers registration and execution through an OpenClaw-shaped stub. The live gateway and Kimi K3.1 Pro on Cerebras await verification. [OpenClaw tool plugin reference](https://docs.openclaw.ai/plugins/tool-plugins)

## Fixture scope

This build reads two allowlisted synthetic PDFs and their receipt manifest. It supports their searchable report layouts. It has no upload, OCR, inbox, or external data connection. To regenerate the included reports and manifest, run `python3 make_fixtures.py` with Pycairo installed.
