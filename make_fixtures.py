"""Regenerate the two searchable synthetic reports using Pycairo."""
import hashlib
import json
from pathlib import Path

import cairo

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def write_report(filename, pages):
    path = FIXTURES / filename
    with cairo.PDFSurface(str(path), 612, 440) as pdf:
        pdf.set_metadata(cairo.PDF_METADATA_CREATE_DATE, "2026-10-18T00:00:00Z")
        pdf.set_metadata(cairo.PDF_METADATA_TITLE, pages[0][0])
        ctx = cairo.Context(pdf)
        for index, lines in enumerate(pages, 1):
            ctx.set_source_rgb(.07, .24, .17)
            ctx.rectangle(0, 0, 612, 77)
            ctx.fill()
            ctx.set_source_rgb(1, 1, 1)
            ctx.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(22)
            ctx.move_to(42, 47)
            ctx.show_text(lines[0])
            ctx.set_source_rgb(.12, .19, .16)
            ctx.select_font_face("Sans")
            ctx.set_font_size(14)
            for y, line in enumerate(lines[1:]):
                ctx.move_to(42, 111 + y * 25)
                ctx.show_text(line)
            ctx.set_source_rgb(.32, .39, .36)
            ctx.set_font_size(11)
            ctx.move_to(42, 411)
            ctx.show_text(f"SYNTHETIC DEMO / PAGE {index} OF {len(pages)}")
            pdf.show_page()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    cedar = write_report("cedar-lab.pdf", [[
        "Cedar Lab",
        "Lipid panel  |  Report CL-260214",
        "Collection date: 2026-02-14",
        "Report date: 2026-02-15",
        "Specimen: Serum",
        "Method: Direct",
        "Test / Result / Lab reference range",
        "LDL Cholesterol (Direct) | 112 mg/dL | <100",
    ]])
    meridian = write_report("meridian-diagnostics.pdf", [[
        "Meridian Diagnostics",
        "Laboratory report  |  MD-261008",
        "Collection date: 2026-10-08",
        "Report date: 2026-10-09",
        "See page 2 for the analytical result.",
    ], [
        "Meridian Diagnostics",
        "Lipid analysis  |  MD-261008",
        "Specimen: Serum",
        "Method: Direct",
        "Analyte / Concentration / Lab reference range",
        "LDL-C, measured | 3.60 mmol/L | <3.00",
    ]])
    manifest = {
        "documents": [
            {"id": "meridian", "file": "meridian-diagnostics.pdf", "sha256": meridian},
            {"id": "cedar", "file": "cedar-lab.pdf", "sha256": cedar},
        ],
        "deliveries": [
            {"id": "delivery-meridian", "document": "meridian", "date": "2026-10-10",
             "channel": "Simulated lab delivery"},
            {"id": "delivery-cedar", "document": "cedar", "date": "2026-10-18",
             "channel": "Simulated email copy"},
        ],
    }
    (FIXTURES / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
