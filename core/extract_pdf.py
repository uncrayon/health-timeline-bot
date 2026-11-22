#!/usr/bin/env python3
"""Layout-aware multi-provider PDF extractor for Health Timeline.

Supports graceful backend fallback:
  Text + BBoxes: pdfplumber -> pdftotext (-bbox-layout) -> macOS PDFKit (swift) -> pypdf
  Page PNGs:     pdftoppm -> macOS PDFKit (swift) -> none (graceful)

Outputs a single JSON document payload on stdout suitable for core/ingest.mjs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Any


PDF_NS = {"pdf": "http://www.w3.org/1999/xhtml"}

SWIFT_PDFKIT_SCRIPT = r'''
import Foundation
import PDFKit
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else { exit(2) }
let pdfPath = args[1]
let pagesDir = args.count >= 4 ? args[2] : ""
let docPrefix = args.count >= 4 ? args[3] : ""

let url = URL(fileURLWithPath: pdfPath)
guard let doc = PDFDocument(url: url) else {
    fputs("Failed to open PDF\n", stderr)
    exit(1)
}

var outPages: [[String: Any]] = []
var rendered: [[String: Any]] = []

for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let pw = Double(bounds.width) > 0 ? Double(bounds.width) : 612.0
    let ph = Double(bounds.height) > 0 ? Double(bounds.height) : 792.0
    let text = page.string ?? ""
    var lineObjs: [[String: Any]] = []

    if let fullSel = page.selection(for: bounds) {
        let lineSels = fullSel.selectionsByLine()
        struct Frag {
            let text: String
            let x: Double
            let y: Double
            let w: Double
            let h: Double
        }
        var frags: [Frag] = []
        for lsel in lineSels {
            let ltext = (lsel.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if ltext.isEmpty { continue }
            let rect = lsel.bounds(for: page)
            let x = max(0.0, min(1.0, Double(rect.origin.x - bounds.origin.x) / pw))
            let topY = max(0.0, min(1.0, (ph - Double(rect.origin.y - bounds.origin.y + rect.size.height)) / ph))
            let w = max(0.001, min(1.0 - x, Double(rect.size.width) / pw))
            let h = max(0.001, min(1.0 - topY, Double(rect.size.height) / ph))
            frags.append(Frag(text: ltext, x: x, y: topY, w: w, h: h))
        }
        // Merge fragments on the same visual row (same normalized y within 0.0065) left-to-right
        frags.sort { a, b in
            if abs(a.y - b.y) > 0.0065 { return a.y < b.y }
            return a.x < b.x
        }
        var rows: [[Frag]] = []
        for f in frags {
            if let lastIdx = rows.indices.last, abs(rows[lastIdx][0].y - f.y) <= 0.0065 {
                rows[lastIdx].append(f)
            } else {
                rows.append([f])
            }
        }
        for (idx, row) in rows.enumerated() {
            let sorted = row.sorted { $0.x < $1.x }
            let joined = sorted.map { $0.text }.joined(separator: " ")
            let minX = sorted.map { $0.x }.min() ?? 0.0
            let minY = sorted.map { $0.y }.min() ?? 0.0
            let maxX = sorted.map { $0.x + $0.w }.max() ?? (minX + 0.01)
            let maxY = sorted.map { $0.y + $0.h }.max() ?? (minY + 0.01)
            lineObjs.append([
                "page": i + 1,
                "line": idx + 1,
                "text": joined,
                "box": [minX, minY, max(0.001, maxX - minX), max(0.001, maxY - minY)]
            ])
        }
    }

    if lineObjs.isEmpty && !text.isEmpty {
        let rawLines = text.components(separatedBy: .newlines)
        for (idx, rawLine) in rawLines.enumerated() {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            lineObjs.append([
                "page": i + 1,
                "line": idx + 1,
                "text": trimmed,
                "box": NSNull()
            ])
        }
    }

    outPages.append([
        "page": i + 1,
        "width": pw,
        "height": ph,
        "text": text,
        "lines": lineObjs
    ])

    if !pagesDir.isEmpty && !docPrefix.isEmpty {
        let scale: CGFloat = 120.0 / 72.0
        let targetSize = NSSize(width: CGFloat(pw) * scale, height: CGFloat(ph) * scale)
        let img = page.thumbnail(of: targetSize, for: .mediaBox)
        if let tiff = img.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            let outPath = (pagesDir as NSString).appendingPathComponent("\(docPrefix)-\(i + 1).png")
            try? png.write(to: URL(fileURLWithPath: outPath))
            rendered.append(["page": i + 1, "path": outPath])
        }
    }
}

let payload: [String: Any] = [
    "backend": "macos_pdfkit",
    "pageCount": doc.pageCount,
    "encrypted": doc.isEncrypted,
    "pages": outPages,
    "pagesRendered": rendered
]
if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
   let str = String(data: data, encoding: .utf8) {
    print(str)
}
'''


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_with_pdfplumber(pdf_path: Path) -> dict[str, Any] | None:
    try:
        import pdfplumber  # type: ignore
    except Exception:
        return None
    try:
        pages_out = []
        with pdfplumber.open(str(pdf_path), password="") as pdf:
            for idx, page in enumerate(pdf.pages, 1):
                pw = float(page.width or 612.0)
                ph = float(page.height or 792.0)
                words = page.extract_words(keep_blank_chars=False, use_text_flow=False) or []
                # Group words into visual lines by top coordinate tolerance
                rows: list[list[dict[str, Any]]] = []
                for w in sorted(words, key=lambda item: (round(float(item["top"]), 1), float(item["x0"]))):
                    placed = False
                    for row in rows:
                        if abs(float(row[0]["top"]) - float(w["top"])) <= 3.5:
                            row.append(w)
                            placed = True
                            break
                    if not placed:
                        rows.append([w])
                lines = []
                for lidx, row in enumerate(rows, 1):
                    row.sort(key=lambda item: float(item["x0"]))
                    text = " ".join(str(item["text"]) for item in row).strip()
                    if not text:
                        continue
                    x0 = min(float(item["x0"]) for item in row)
                    top = min(float(item["top"]) for item in row)
                    x1 = max(float(item["x1"]) for item in row)
                    bottom = max(float(item["bottom"]) for item in row)
                    lines.append({
                        "page": idx,
                        "line": lidx,
                        "text": text,
                        "box": [
                            max(0.0, min(1.0, x0 / pw)),
                            max(0.0, min(1.0, top / ph)),
                            max(0.001, min(1.0, (x1 - x0) / pw)),
                            max(0.001, min(1.0, (bottom - top) / ph)),
                        ],
                    })
                raw_text = "\n".join(line["text"] for line in lines)
                pages_out.append({
                    "page": idx,
                    "width": pw,
                    "height": ph,
                    "text": raw_text,
                    "lines": lines,
                })
        return {
            "backend": "pdfplumber",
            "pageCount": len(pages_out),
            "pages": pages_out,
            "pagesRendered": [],
        }
    except Exception:
        return None


def extract_with_pdftotext(pdf_path: Path) -> dict[str, Any] | None:
    if not shutil.which("pdftotext"):
        return None
    try:
        xml_bytes = subprocess.check_output(
            ["pdftotext", "-bbox-layout", str(pdf_path), "-"],
            stderr=subprocess.DEVNULL,
            timeout=25,
        )
        root = ET.fromstring(xml_bytes)
        pages_out = []
        for p_idx, page in enumerate(root.findall(".//pdf:page", PDF_NS), 1):
            pw = float(page.attrib.get("width", "612"))
            ph = float(page.attrib.get("height", "792"))
            lines = []
            for l_idx, line in enumerate(page.findall(".//pdf:line", PDF_NS), 1):
                words = [w.text or "" for w in line.findall("pdf:word", PDF_NS)]
                text = " ".join(w for w in words if w).strip()
                if not text:
                    continue
                x0 = float(line.attrib["xMin"])
                y0 = float(line.attrib["yMin"])
                x1 = float(line.attrib["xMax"])
                y1 = float(line.attrib["yMax"])
                lines.append({
                    "page": p_idx,
                    "line": l_idx,
                    "text": text,
                    "box": [
                        max(0.0, min(1.0, x0 / pw)),
                        max(0.0, min(1.0, y0 / ph)),
                        max(0.001, min(1.0, (x1 - x0) / pw)),
                        max(0.001, min(1.0, (y1 - y0) / ph)),
                    ],
                })
            pages_out.append({
                "page": p_idx,
                "width": pw,
                "height": ph,
                "text": "\n".join(l["text"] for l in lines),
                "lines": lines,
            })
        if pages_out:
            return {
                "backend": "pdftotext",
                "pageCount": len(pages_out),
                "pages": pages_out,
                "pagesRendered": [],
            }
    except Exception:
        pass
    return None


def extract_with_pypdf(pdf_path: Path) -> dict[str, Any] | None:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception:
        return None
    try:
        reader = PdfReader(str(pdf_path))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                pass
        pages_out = []
        for p_idx, page in enumerate(reader.pages, 1):
            text = page.extract_text() or ""
            lines = []
            for l_idx, raw in enumerate(text.splitlines(), 1):
                cleaned = " ".join(raw.split())
                if cleaned:
                    lines.append({"page": p_idx, "line": l_idx, "text": cleaned, "box": None})
            pages_out.append({
                "page": p_idx,
                "width": 612.0,
                "height": 792.0,
                "text": text,
                "lines": lines,
            })
        return {
            "backend": "pypdf",
            "pageCount": len(pages_out),
            "pages": pages_out,
            "pagesRendered": [],
        }
    except Exception:
        return None


def extract_with_macos_pdfkit(pdf_path: Path, pages_dir: Path | None, doc_prefix: str) -> dict[str, Any] | None:
    if sys.platform != "darwin" or not shutil.which("swift"):
        return None
    cmd = ["swift", "-", str(pdf_path)]
    if pages_dir is not None and doc_prefix:
        pages_dir.mkdir(parents=True, exist_ok=True)
        cmd.extend([str(pages_dir), doc_prefix])
    try:
        proc = subprocess.run(
            cmd,
            input=SWIFT_PDFKIT_SCRIPT,
            text=True,
            capture_output=True,
            timeout=45,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return None
        return json.loads(proc.stdout)
    except Exception:
        return None


def render_pages_pdftoppm(pdf_path: Path, pages_dir: Path, doc_prefix: str) -> list[dict[str, Any]]:
    if not shutil.which("pdftoppm"):
        return []
    pages_dir.mkdir(parents=True, exist_ok=True)
    prefix = pages_dir / f"__tmp_{doc_prefix}"
    try:
        subprocess.run(
            ["pdftoppm", "-png", "-r", "120", str(pdf_path), str(prefix)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except Exception:
        return []

    rendered = []
    for f in sorted(pages_dir.glob(f"__tmp_{doc_prefix}-*.png")):
        m = re.search(r"-(\d+)\.png$", f.name)
        if not m:
            continue
        page_num = int(m.group(1))
        target = pages_dir / f"{doc_prefix}-{page_num}.png"
        os.replace(f, target)
        rendered.append({"page": page_num, "path": str(target)})
    rendered.sort(key=lambda item: item["page"])
    return rendered


def parse_date_mx_or_iso(raw: str | None) -> str | None:
    if not raw:
        return None
    s = raw.strip()
    # ISO YYYY-MM-DD
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", s)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).strftime("%Y-%m-%d")
        except ValueError:
            return None
    # Mexican DD/MM/YYYY or DD/MM/YY
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b", s)
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if year < 100:
            year = 2000 + year if year <= 40 else 1900 + year
        try:
            return datetime(year, month, day).strftime("%Y-%m-%d")
        except ValueError:
            return None
    return None


def parse_num(text: str | None) -> float | None:
    if not text:
        return None
    s = text.strip().lstrip("*").rstrip("*").strip()
    if re.fullmatch(r"\d{2,3}\s*/\s*\d{2,3}", s):
        return None
    m = re.fullmatch(r"(?:<=|>=|<|>)?\s*(-?\d+(?:[.,]\d+)?)", s)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "."))
    except ValueError:
        return None


def detect_provider(all_text: str, lines: list[dict[str, Any]]) -> tuple[str, str, bool]:
    """Returns (provider_name, parser_family, is_synthetic_demo)."""
    first_line = lines[0]["text"].strip() if lines else ""
    upper = all_text.upper()

    if "SYNTHETIC DEMO" in upper or first_line in ("Cedar Lab", "Meridian Diagnostics"):
        provider = first_line if first_line in ("Cedar Lab", "Meridian Diagnostics") else "Synthetic Lab"
        return provider, "synthetic", True

    if (
        "INFORME DE RESULTADOS" in upper
        and ("NÚM. ORDEN" in upper or "NUM. ORDEN" in upper or "PUENTE DE PIEDRA" in upper or " LMS" in upper or " MCL" in upper)
    ):
        has_mcl = " MCL" in upper or "MAYO CLINIC" in upper
        has_lms = " LMS" in upper
        if has_mcl and not has_lms:
            return "Médica Sur (Mayo Clinic Send-Out)", "lms", False
        return "Médica Sur (LMS)", "lms", False

    if "LAPI, S.A. DE C.V." in upper or "PROMOCION LAPIFAN" in upper or "P A C I E N T E:" in upper:
        if "RIESGO DE SINDROME METABOLICO" in upper and "FECHAS: ATENCIÓN" not in upper and "FECHAS: ATENCION" not in upper:
            return "LAPI", "lapi_summary", False
        return "LAPI", "lapi_main", False

    return "Unknown Lab", "generic", False


def parse_synthetic(all_lines: list[dict[str, Any]], provider: str) -> dict[str, Any]:
    def find_field(label: str) -> tuple[str | None, dict[str, Any] | None]:
        prefix = f"{label}: "
        matches = [l for l in all_lines if l["text"].startswith(prefix)]
        if len(matches) != 1:
            return None, None
        return matches[0]["text"][len(prefix):].strip(), matches[0]

    raw_collected, coll_line = find_field("Collection date")
    raw_reported, rep_line = find_field("Report date")
    specimen, _ = find_field("Specimen")
    method, _ = find_field("Method")
    order_number = None
    for l in all_lines[:5]:
        m = re.search(r"\b((?:CL|MD)-\d+)\b", l["text"])
        if m:
            order_number = m.group(1)
            break

    collected_at = parse_date_mx_or_iso(raw_collected)
    reported_at = parse_date_mx_or_iso(raw_reported)
    observations = []
    review_items = []

    if collected_at is None:
        review_items.append({
            "code": "missing_collection_date",
            "severity": "warning",
            "message": "Collection date missing, invalid, or ambiguous",
            "details": {"raw": raw_collected},
        })

    pipe_re = re.compile(
        r"^(?P<test>[^|]+?)\s*\|\s*(?P<value>-?\d+(?:\.\d+)?)\s+(?P<unit>[^|]+?)\s*\|\s*(?P<range>[^|]+)$"
    )
    for line in all_lines:
        m = pipe_re.match(line["text"].strip())
        if not m:
            continue
        val_str = m.group("value").strip()
        observations.append({
            "rawName": m.group("test").strip(),
            "specimen": (specimen or "Serum").lower(),
            "panel": "Lipids",
            "valueNum": parse_num(val_str),
            "valueText": val_str,
            "unitRaw": m.group("unit").strip(),
            "refText": m.group("range").strip(),
            "method": method,
            "collectedAt": collected_at,
            "page": line["page"],
            "lineIndex": line["line"],
            "bbox": line["box"],
            "excerpt": line["text"],
            "meta": {
                "collectionSource": coll_line,
                "reportSource": rep_line,
            },
        })

    return {
        "provider": provider,
        "orderNumber": order_number,
        "reportStatus": "FINAL",
        "docType": "lab_report",
        "isSyntheticDemo": True,
        "patient": {"nameRaw": None, "dobRaw": None, "sexRaw": None},
        "collectedAt": collected_at,
        "reportedAt": reported_at,
        "receivedAt": None,
        "observations": observations,
        "findings": [],
        "reviewItems": review_items,
        "meta": {"parser": "synthetic"},
    }


NON_BIOMARKER_RE = re.compile(
    r"(alcald[ií]a|delegaci[oó]n|\bc\.?p\.?\s*\d|\bcol\.\s|lapi,\s*s\.?\s*a\.?|rosa\s+blanca|"
    r"molino\s+de\s+rosas|puente\s+de\s+piedra|tlalpan|\bcdmx\b|\btel\s*:|"
    r"ced\.?\s*prof|c[eé]dula|atentamente|universidad|instituto\s+polit[eé]cnico|"
    r"ver\s+alcance|cap\s+accredited|consultaema|https?://|www\.|"
    r"\bp[aá]gina\b|\bp[aá]g\s*:|\brfc\b|impresi[oó]n|responsable\s+sanitario|"
    r"promocion\s+lapifan|sindrome\s+metabolico|s[ií]ndrome\s+metab[oó]lico|"
    r"resultados\s+verificados|resultados\s+parciales|miguel$|"
    r"^\s*nota\s*:|^\s*positivo\s*:|^\s*negativo\s*:|contacto\s+con\s+vih)",
    re.IGNORECASE,
)


def is_noise_analyte(raw_name: str | None, value_text: str | None = None, excerpt: str | None = None) -> bool:
    name = (raw_name or "").strip()
    if not name or len(name) < 2:
        return True
    if NON_BIOMARKER_RE.search(name):
        return True
    if excerpt and NON_BIOMARKER_RE.search(excerpt):
        # Allow legitimate notes only if name itself is a real analyte (e.g. Aldosterone/Renin)
        if "aldosterona" not in name.lower():
            return True
    # Reject pure punctuation/digits or postal-code-like names
    if re.fullmatch(r"[\d\s.,:/-]+", name):
        return True
    return False


def _lms_detect_section(text: str, current_panel: str, current_specimen: str) -> tuple[str, str] | None:
    u = text.upper().strip()
    if "EXAMEN GENERAL DE ORINA" in u:
        return "Urinalysis", "urine"
    if "BIOMETRIA HEMATICA" in u or "BIOMETRÍA HEMÁTICA" in u:
        return "Complete Blood Count", "blood"
    if "QUIMICA SANGUINEA" in u or "QUÍMICA SANGUÍNEA" in u:
        return "Chemistry Panel", "serum"
    if "PERFIL TIROIDEO" in u:
        return "Thyroid", "serum"
    if "PERFIL DE LIPIDOS" in u or "PERFIL DE LÍPIDOS" in u:
        return "Lipids", "serum"
    if "HEMOGLOBINA GLUCOSILADA" in u and not re.search(r"\d", u):
        return "Glucose & Metabolic", "serum"
    if "RENINA PLASMATICA" in u or "METANEFRINAS PLASMA" in u:
        return "Endocrine", "plasma"
    if "ALDOSTERONA SUERO" in u:
        return "Endocrine", "serum"
    if "VITAMINA B12" in u and "FOLICO" in u:
        return "Iron & Vitamins", "serum"
    if "SEROLOGIA" in u or "VIH" in u and len(u) < 45 and not re.search(r"\bLMS\b", u):
        return "Serology", "serum"
    return None


def _is_lms_chrome(text: str) -> bool:
    t = text.strip()
    u = t.upper()
    if not t:
        return True
    prefixes = (
        "INFORMACIÓN DEL PACIENTE", "INFORMACION DEL PACIENTE", "ID PACIENTE:",
        "PACIENTE:", "FECHA NACIMIENTO:", "EDAD:", "SEXO:", "MÉDICO:", "MEDICO:",
        "CONS:", "INFORME DE RESULTADOS", "ESTATUS DE REPORTE:",
        "INFORMACIÓN DE ORDEN", "INFORMACION DE ORDEN",
        "NÚM. ORDEN:", "NUM. ORDEN:", "FECHA TOMA MUESTRA:",
        "FECHA REC. LABORATORIO:", "FECHA IMPRESIÓN:", "FECHA IMPRESION:",
        "UBICACIÓN:", "UBICACION:", "COMPAÑIA:", "COMPANIA:",
        "PRUEBA RESULTADO", "REFERENCIA", "INDICADOR CENTRO", "PROCESO",
        "DR. VÍCTOR", "DR. VICTOR", "RESPONSABLE SANITARIO", "CÉD. ESPECIALISTA", "CED. ESPECIALISTA",
        "FECHA Y HORA DE LA PRIMERA IMPRESIÓN", "FECHA Y HORA DE LA PRIMERA IMPRESION",
        "PÁG:", "PAG:", "PUENTE DE PIEDRA", "TLALPAN,", "TELS.", "PUEDE VERIFICAR ESTE REPORTE",
        "PERFIL SALUD", "EXAMEN FISICO-QUIMICO", "EXAMEN MICROSCOPICO",
        "EXAMEN FÍSICO-QUÍMICO", "EXAMEN MICROSCÓPICO",
        "SERIE ROJA", "SERIE BLANCA", "SERIE PLAQUETARIA", "DIFERENCIAL",
    )
    if any(u.startswith(p) for p in prefixes):
        return True
    if re.fullmatch(r"\d{2}/\d{2}/\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?", t, re.IGNORECASE):
        return True
    if re.fullmatch(r"P[aá]g\.?:\s*\d+\s+de\s+\d+", t, re.IGNORECASE):
        return True
    return False


LMS_UNITS_PATTERN = (
    r"(?:x\s*10\^\d+/[µμu]L|10\^\d+/[µμu]L|mg/dL|mg/L|g/dL|g/L|mmol/L|umol/L|[µμ]mol/L|"
    r"[µμu]g/dL|[µμu]g/L|ng/mL/h|ng/mL|ng/dL|pg/mL|pg|fL|U/L|UI/L|mUI/L|mIU/L|[µμu]UI/mL|[µμu]IU/mL|"
    r"mEq/L|mL/min/1\.73\s*m[²2\^]?|ml/min/1\.73\s*m[²2\^]?|mL/min|ml/min|nmol/L|pmol/L|"
    r"Cels/[µμu]L|cel/[µμu]L|/campo|mm/h|mmHg|mm/Hg|%|Cociente|Índice|Indice|Relación|Relacion)"
)


def _split_lms_measurement_line(line_text: str) -> dict[str, Any] | None:
    """Parse an LMS/MCL measurement row ending in 'LMS' or 'MCL' (or trailing value after center code)."""
    # Handle PDF column-order variant where numeric value trails the LMS/MCL token:
    # e.g. "COLESTEROL LDL (Cálculo) Metodología:Calculado mg/dL <130 LMS 128"
    m_trail = re.match(
        rf"^(?P<prefix>.*?)\s+(?P<unit>{LMS_UNITS_PATTERN})\b\s*(?P<ref>.*?)\s+(?P<center>LMS|MCL)\s+"
        rf"(?P<val>(?:<=|>=|<|>)?\s*\d+(?:[.,]\d+)?)\s*$",
        line_text,
        re.IGNORECASE,
    )
    if m_trail:
        val_str = re.sub(r"\s+", " ", m_trail.group("val").strip())
        prefix = re.sub(r"\s+Metodolog[ií]a\s*:.*$", "", m_trail.group("prefix").strip(), flags=re.IGNORECASE).strip()
        return {
            "prefix": prefix,
            "valueText": val_str,
            "valueNum": parse_num(val_str),
            "unitRaw": m_trail.group("unit").strip(),
            "refText": m_trail.group("ref").strip() or None,
            "center": m_trail.group("center"),
        }

    m_center = re.search(r"\s+(LMS|MCL)\s*$", line_text)
    if not m_center:
        return None
    center = m_center.group(1)
    body = line_text[:m_center.start()].strip()
    if not body:
        return None

    # Pattern 1: Numeric value (optionally with <, >, <=, >=) + optional unit + optional ref range
    num_pat = re.compile(
        rf"^(?P<prefix>.*?)\s*(?P<val>(?:<=|>=|<|>)?\s*\d+(?:[.,]\d+)?)\s+"
        rf"(?P<unit>{LMS_UNITS_PATTERN})\b\s*(?P<ref>.*)$",
        re.IGNORECASE,
    )
    m = num_pat.match(body)
    if m:
        prefix = m.group("prefix").strip()
        val_str = re.sub(r"\s+", " ", m.group("val").strip())
        unit = m.group("unit").strip()
        ref = m.group("ref").strip() or None
        # Guard against prefix ending with part of a unit or blank
        return {
            "prefix": prefix,
            "valueText": val_str,
            "valueNum": parse_num(val_str),
            "unitRaw": unit,
            "refText": ref,
            "center": center,
        }

    # Pattern 2: Numeric value WITHOUT unit (e.g. TyG Index 4.45 Menor a 9.04, pH 6.0 5.0 - 8.0, Densidad 1.020 1.005 - 1.030, Relación A/G 2.0 1.1 - 2.5)
    num_nounit = re.compile(
        r"^(?P<prefix>.*?)\s*(?P<val>(?:<=|>=|<|>)?\s*\d+(?:[.,]\d+)?)\s+"
        r"(?P<ref>(?:(?:<=|>=|<|>)?\s*\d+(?:[.,]\d+)?\s*(?:-|a)\s*\d+(?:[.,]\d+)?|"
        r"(?:<=|>=|<|>|Menor\s+a|Mayor\s+a|Igual\s+o\s+Mayor\s+a|Recomendable).*))$",
        re.IGNORECASE,
    )
    m = num_nounit.match(body)
    if m:
        val_str = re.sub(r"\s+", " ", m.group("val").strip())
        return {
            "prefix": m.group("prefix").strip(),
            "valueText": val_str,
            "valueNum": parse_num(val_str),
            "unitRaw": None,
            "refText": m.group("ref").strip() or None,
            "center": center,
        }

    # Pattern 3: Standalone numeric value without unit or ref (e.g., "1.020")
    m = re.match(r"^(?P<prefix>[A-Za-zÁÉÍÓÚÑáéíóúñ()/\s.-]*?)\s*(?P<val>(?:<=|>=|<|>)?\s*\d+(?:[.,]\d+)?)$", body)
    if m and not re.search(r"^\s*$", m.group("val")):
        val_str = re.sub(r"\s+", " ", m.group("val").strip())
        return {
            "prefix": m.group("prefix").strip(),
            "valueText": val_str,
            "valueNum": parse_num(val_str),
            "unitRaw": None,
            "refText": None,
            "center": center,
        }

    # Pattern 4: Qualitative result (EGO / Serology: NEGATIVO, AUSENTES, AMARILLO, CLARO, NO REACTIVA, ESCASAS, etc.)
    qual_words = (
        r"NO\s+REACTIVA|REACTIVA|NEGATIVO|POSITIVO|AUSENTES|PRESENTES|ESCASAS|ESCASOS|MODERADAS|MODERADOS|"
        r"ABUNDANTES|AMARILLO|INCOLORO|AMBAR|ÁMBAR|CLARO|TRANSPARENTE|LIG\.?\s*TURBIO|TURBIO|TRAZAS|NORMAL"
    )
    m = re.match(
        rf"^(?P<prefix>.*?)\s*(?P<val>{qual_words})\s*(?P<ref>.*)$",
        body,
        re.IGNORECASE,
    )
    if m:
        return {
            "prefix": m.group("prefix").strip(),
            "valueText": m.group("val").strip(),
            "valueNum": None,
            "unitRaw": None,
            "refText": m.group("ref").strip() or None,
            "center": center,
        }

    return None


def parse_lms(pages: list[dict[str, Any]], provider: str) -> dict[str, Any]:
    all_lines = [l for p in pages for l in p["lines"]]
    full_text = "\n".join(l["text"] for l in all_lines)

    def first_match(pattern: str) -> str | None:
        m = re.search(pattern, full_text, re.IGNORECASE | re.MULTILINE)
        return m.group(1).strip() if m else None

    patient_name = first_match(r"^PACIENTE:\s*(.+)")
    patient_dob = first_match(r"FECHA NACIMIENTO:\s*(\d{1,2}/\d{1,2}/\d{2,4})")
    patient_sex = first_match(r"SEXO:\s*([A-ZÁÉÍÓÚÑ]+)")
    order_number = first_match(r"N[ÚU]M\.?\s*ORDEN:\s*([A-Za-z0-9-]+)")
    report_status = (first_match(r"ESTATUS DE REPORTE:\s*([A-Z]+)") or "UNKNOWN").upper()
    collected_raw = first_match(r"FECHA TOMA MUESTRA:\s*(.+)")
    received_raw = first_match(r"FECHA REC\.?\s*LABORATORIO:\s*(.+)")
    reported_raw = first_match(r"FECHA IMPRESI[ÓO]N:\s*(.+)")

    collected_at = parse_date_mx_or_iso(collected_raw)
    received_at = parse_date_mx_or_iso(received_raw)
    reported_at = parse_date_mx_or_iso(reported_raw)

    observations = []
    findings = []
    review_items = []

    # Check for LMS platform/method shift notices
    method_notice_re = re.compile(
        r"(sampson|friedewald|cambio de metodolog[ií]a|cambio de plataforma|se modific[oó] el m[eé]todo)",
        re.IGNORECASE,
    )
    seen_notices: set[str] = set()
    for l in all_lines:
        if method_notice_re.search(l["text"]):
            key = l["text"][:80].lower()
            if key not in seen_notices:
                seen_notices.add(key)
                review_items.append({
                    "code": "method_change_notice",
                    "severity": "info",
                    "message": f"Lab method/platform notice on page {l['page']}: {l['text'][:180]}",
                    "details": {"page": l["page"], "excerpt": l["text"]},
                })

    # Group body lines into underscore-delimited test blocks across all pages
    current_panel = "Chemistry Panel"
    current_specimen = "serum"
    current_method: str | None = None
    blocks: list[dict[str, Any]] = []
    cur_block: list[dict[str, Any]] = []

    def flush_block():
        nonlocal cur_block
        if cur_block:
            blocks.append({
                "panel": current_panel,
                "specimen": current_specimen,
                "inherited_method": current_method,
                "lines": cur_block,
            })
            cur_block = []

    for page in pages:
        for line in page["lines"]:
            t = line["text"].strip()
            if re.fullmatch(r"_{5,}", t):
                flush_block()
                continue
            if _is_lms_chrome(t):
                continue
            sec = _lms_detect_section(t, current_panel, current_specimen)
            if sec and not re.search(r"\s+(LMS|MCL)\s*$", t):
                # Flush previous test before switching panel, EXCEPT keep title if it's an MCL single-test header like ALDOSTERONA SUERO
                if cur_block and any(re.search(r"\s+(LMS|MCL)\s*$", bl["text"]) for bl in cur_block):
                    flush_block()
                current_panel, current_specimen = sec
                # Keep MCL assay title line inside the block so "Resultado" row inherits it
                if any(k in t.upper() for k in ("ALDOSTERONA", "RENINA", "METANEFRINA")):
                    cur_block.append(line)
                continue
            cur_block.append(line)
        flush_block()

    for blk in blocks:
        blk_lines = blk["lines"]
        panel = blk["panel"]
        specimen = blk["specimen"]
        blk_text = "\n".join(l["text"] for l in blk_lines)

        # Handle MCL note block with embedded Aldosterone/Renin ratio
        if "Nota * MCL" in blk_text or "ALDOSTERONA/RENINA" in blk_text.upper():
            for l in blk_lines:
                m_arr = re.search(r"[IÍ]ndice\s+aldosterona/renina\s*:\s*(\d+(?:\.\d+)?)", l["text"], re.IGNORECASE)
                if m_arr:
                    val_str = m_arr.group(1)
                    cutoff_match = re.search(r"Punto de corte[^\n]+", blk_text, re.IGNORECASE)
                    observations.append({
                        "rawName": "Índice aldosterona/renina",
                        "specimen": "serum",
                        "panel": "Endocrine",
                        "valueNum": parse_num(val_str),
                        "valueText": val_str,
                        "unitRaw": "ratio",
                        "refText": cutoff_match.group(0).strip() if cutoff_match else "< 20",
                        "method": "Calculated (MCL send-out)",
                        "collectedAt": collected_at,
                        "page": l["page"],
                        "lineIndex": l["line"],
                        "bbox": l["box"],
                        "excerpt": l["text"],
                        "meta": {"processCenter": "MCL", "embeddedInNote": True},
                    })
            continue

        # Extract block-level Metodología
        block_method = blk["inherited_method"]
        method_line_indices: set[int] = set()
        for idx, l in enumerate(blk_lines):
            t = l["text"].strip()
            if re.match(r"^Metodolog[ií]a\s*:", t, re.IGNORECASE):
                method_line_indices.add(idx)
                m_after = re.sub(r"^Metodolog[ií]a\s*:\s*", "", t, flags=re.IGNORECASE).strip()
                # Check if Metodología line ALSO contains the LMS result (e.g. "Metodología:Inmunoturbidimétrica 93 ng/mL 30 - 400 LMS")
                if re.search(r"\s+(LMS|MCL)\s*$", m_after):
                    parsed_inline = _split_lms_measurement_line(m_after)
                    if parsed_inline:
                        block_method = parsed_inline["prefix"] or block_method
                        # Leave this line available for measurement parsing
                        method_line_indices.discard(idx)
                else:
                    # Gather wrapped continuation line of Metodología if short & lowercase/method-like
                    parts = [m_after]
                    if idx + 1 < len(blk_lines):
                        nxt = blk_lines[idx + 1]["text"].strip()
                        if (
                            nxt
                            and not re.search(r"\s+(LMS|MCL)\s*$", nxt)
                            and len(nxt) <= 45
                            and not nxt.isupper()
                            and not re.match(r"^(Resultado|Nota|Realizar|Valores|Ref\.|El %|Con priv|No priv)", nxt, re.IGNORECASE)
                        ):
                            parts.append(nxt)
                            method_line_indices.add(idx + 1)
                    block_method = " ".join(p for p in parts if p).strip() or block_method

        # Find all measurement lines in this block
        meas_indices = []
        for idx, l in enumerate(blk_lines):
            if idx in method_line_indices:
                continue
            parsed = _split_lms_measurement_line(l["text"].strip())
            if parsed is not None:
                meas_indices.append((idx, l, parsed))

        if not meas_indices:
            continue

        # Update current_method if single-panel block (like CBC) declared a shared method
        if len(meas_indices) == 1:
            m_idx, m_line, parsed = meas_indices[0]
            # Reconstruct analyte name strictly from lines adjacent to m_idx (before Metodología / footnotes!)
            name_parts: list[str] = []
            prefix = parsed["prefix"]
            if re.match(r"^Metodolog[ií]a\s*:", prefix, re.IGNORECASE):
                prefix = ""

            first_method_idx = min(method_line_indices) if method_line_indices else len(blk_lines)
            # Only look at lines up to first_method_idx (or m_idx + 1 if interleaved wrapped name precedes Metodología)
            upper_bound = min(len(blk_lines), max(m_idx + 2, first_method_idx))

            for idx in range(0, upper_bound):
                if idx == m_idx or idx in method_line_indices:
                    continue
                # Never grab lines that come AFTER a Metodología line
                if idx > first_method_idx:
                    break
                t = blk_lines[idx]["text"].strip()
                if not t:
                    continue
                if re.search(r"\s+(LMS|MCL)\s*$", t):
                    continue
                if is_noise_analyte(t):
                    continue
                if (
                    len(t) > 58
                    or re.search(r"(doi:|pubmed|cardiol\.|menos de \d|valores iguales|f[oó]rmula de|observe cambio|por favor notar)", t, re.IGNORECASE)
                    or re.match(
                        r"^(Nota|Ref\.|Realizar|El %|Valores|Con privaci|No privaci|Media:|Intervalos de referencia|"
                        r"Estadio|Riesgo|Deseable|Óptimo|Optimo|Normal:|Prediabetes|Diabetes|L[ií]mite|Alto|Muy alto|"
                        r"Bajo|Moderado|Elevado|Interpretaci|Comentario|Observaci|\*|situaci[oó]n\b|colesterol unido)",
                        t,
                        re.IGNORECASE,
                    )
                ):
                    continue
                if _lms_detect_section(t, panel, specimen) and not any(k in t.upper() for k in ("ALDOSTERONA", "RENINA", "METANEFRINA")):
                    continue
                # If m_idx already has a prefix, only accept an immediate wrapped continuation (no digits, not a new panel header)
                if prefix and prefix.lower() != "resultado":
                    if idx > m_idx:
                        if re.search(r"\d", t) or len(t) > 34 or re.match(r"^(HEMOGLOBINA GLUCOSILADA|PERFIL|QUIMICA|EXAMEN|BIOMETRIA)", t, re.IGNORECASE):
                            continue
                name_parts.append(t)

            if prefix and prefix.lower() != "resultado":
                if m_idx == 0:
                    raw_name = " ".join([prefix] + name_parts).strip()
                else:
                    raw_name = " ".join(name_parts + [prefix]).strip()
            else:
                raw_name = " ".join(name_parts).strip() or prefix
            raw_name = re.sub(r"\s+Metodolog[ií]a\s*:.*$", "", raw_name, flags=re.IGNORECASE).strip()

            # Special ref extraction for Renin (normal sodium diet) if refText was empty
            ref_text = parsed["refText"]
            if not ref_text and "No privación de sodio" in blk_text:
                m_renin = re.search(r"No privaci[oó]n de sodio[\s\S]*?Intervalos de referencia:\s*([^\n]+)", blk_text, re.IGNORECASE)
                if m_renin:
                    ref_text = m_renin.group(1).strip()

            if raw_name:
                eff_specimen = specimen
                if "SUERO" in raw_name.upper():
                    eff_specimen = "serum"
                elif "PLASMA" in raw_name.upper() or "RENINA" in raw_name.upper() or "METANEFRINA" in raw_name.upper():
                    eff_specimen = "plasma"
                observations.append({
                    "rawName": re.sub(r"\s+", " ", raw_name).strip(),
                    "specimen": eff_specimen,
                    "panel": panel,
                    "valueNum": parsed["valueNum"],
                    "valueText": parsed["valueText"],
                    "unitRaw": parsed["unitRaw"],
                    "refText": ref_text,
                    "method": block_method,
                    "collectedAt": collected_at,
                    "page": m_line["page"],
                    "lineIndex": m_line["line"],
                    "bbox": m_line["box"],
                    "excerpt": m_line["text"],
                    "meta": {"processCenter": parsed["center"]},
                })
        else:
            # Multiple measurements inside one block (e.g. without underscore separator)
            for m_idx, m_line, parsed in meas_indices:
                raw_name = parsed["prefix"]
                if not raw_name and m_idx > 0:
                    prev_t = blk_lines[m_idx - 1]["text"].strip()
                    if not re.match(r"^Metodolog[ií]a", prev_t, re.IGNORECASE):
                        raw_name = prev_t
                if raw_name:
                    observations.append({
                        "rawName": re.sub(r"\s+", " ", raw_name).strip(),
                        "specimen": specimen,
                        "panel": panel,
                        "valueNum": parsed["valueNum"],
                        "valueText": parsed["valueText"],
                        "unitRaw": parsed["unitRaw"],
                        "refText": parsed["refText"],
                        "method": block_method,
                        "collectedAt": collected_at,
                        "page": m_line["page"],
                        "lineIndex": m_line["line"],
                        "bbox": m_line["box"],
                        "excerpt": m_line["text"],
                        "meta": {"processCenter": parsed["center"]},
                    })

    return {
        "provider": provider,
        "orderNumber": order_number,
        "reportStatus": report_status,
        "docType": "lab_report",
        "isSyntheticDemo": False,
        "patient": {
            "nameRaw": patient_name,
            "dobRaw": patient_dob,
            "sexRaw": patient_sex,
        },
        "collectedAt": collected_at,
        "reportedAt": reported_at,
        "receivedAt": received_at,
        "observations": observations,
        "findings": findings,
        "reviewItems": review_items,
        "meta": {"parser": "lms", "collectedRaw": collected_raw, "reportedRaw": reported_raw},
    }


LAPI_TIER_PREFIXES = (
    "prediabetes", "diabetes", "limite alto", "límite alto", "limite recomendable",
    "límite recomendable", "alto ", "muy alto", "riesgo alto", "riesgo intermedio",
    "riesgo moderado", "riesgo bajo", "valores establecidos", "es importante",
    "esta prueba", "nota:", "ver alcance", "https://", "http://", "resultados verificados",
    "resultados parciales", "lapi, s.a.", "tel:", "miguel", "estadio ", "normal:",
    "deseable:", "óptimo", "optimo", "sin riesgo", "borderline", "hombres:", "mujeres:",
)

LAPI_METHOD_LINES = {
    "espectrofotometría", "espectrofotometria", "quimioluminiscencia", "floculación",
    "floculacion", "turbidimetría", "turbidimetria", "inmunoturbidimetría",
    "inmunoturbidimetria", "potenciometría", "potenciometria", "citometría de flujo",
    "citometria de flujo", "electroquimioluminiscencia", "cálculo", "calculo",
    "espectrofotometría, quimioluminiscencia", "inmunoensayo", "colorimetría",
    "tira reactiva", "microscopía", "microscopia", "cromatografía", "hplc",
}


def _lapi_section_update(line: str, cur_panel: str, cur_specimen: str) -> tuple[str, str] | None:
    u = line.upper().strip()
    if "EXAMEN GENERAL DE ORINA" in u or "- ORINA -" in u:
        return "Urinalysis", "urine"
    if "BIOMETRIA HEMATICA" in u or "BIOMETRÍA HEMÁTICA" in u:
        return "Complete Blood Count", "blood"
    if "PERFIL DE LIPIDOS" in u or "PERFIL DE LÍPIDOS" in u:
        return "Lipids", "serum"
    if "RIESGO DE DIABETES" in u:
        return "Glucose & Metabolic", "serum"
    if "RIESGO DE SINDROME METABOLICO" in u or "SÍNDROME METABÓLICO" in u:
        return "Vitals & Anthropometrics", "vitals"
    if "FUNCION HEPATICA" in u or "FUNCIÓN HEPÁTICA" in u:
        return "Liver & Pancreas", "serum"
    if "FUNCION PANCREATICA" in u or "FUNCIÓN PANCREÁTICA" in u:
        return "Liver & Pancreas", "serum"
    if "PERFIL HIERRO" in u:
        return "Iron & Vitamins", "serum"
    if "FUNCION RENAL" in u or "FUNCIÓN RENAL" in u or "ELECTROLITOS" in u:
        return "Kidney & Electrolytes", "serum"
    if "PERFIL TIROIDEO" in u:
        return "Thyroid", "serum"
    if "BIOMARCADOR CARDIACO" in u:
        return "Inflammation", "serum"
    if "PERFIL DE ETS" in u or "HEPATITIS" in u or "VIH" in u:
        return "Serology", "serum"
    return None


def parse_lapi_main(pages: list[dict[str, Any]], provider: str) -> dict[str, Any]:
    all_lines = [l for p in pages for l in p["lines"]]
    full_text = "\n".join(l["text"] for l in all_lines)

    order_number = None
    patient_name = None
    patient_dob = None
    collected_at = None
    reported_at = None

    for idx, l in enumerate(all_lines[:40]):
        t = l["text"].strip()
        if t.startswith("Orden:") and idx + 1 < len(all_lines):
            m_ord = re.search(r"(\d{4,})", t + " " + all_lines[idx + 1]["text"])
            if m_ord and not order_number:
                order_number = m_ord.group(1)
        if "Fechas:" in t and idx + 1 < len(all_lines) and not collected_at:
            date_line = all_lines[idx + 1]["text"]
            dates = re.findall(r"\d{2}/\d{2}/\d{4}", date_line)
            if len(dates) >= 2:
                collected_at = parse_date_mx_or_iso(dates[1])
            elif dates:
                collected_at = parse_date_mx_or_iso(dates[0])
            if len(dates) >= 3:
                reported_at = parse_date_mx_or_iso(dates[2])
        if "P A C I E N T E:" in t and idx + 1 < len(all_lines) and not patient_name:
            raw_p = all_lines[idx + 1]["text"].strip()
            raw_p = re.sub(r"\s+Dr\.?$", "", raw_p, flags=re.IGNORECASE).strip()
            patient_name = raw_p
        if t.startswith("F/N:") and not patient_dob:
            m_dob = re.search(r"F/N:\s*(\d{1,2}/\d{1,2}/\d{2,4})", t)
            if m_dob:
                patient_dob = m_dob.group(1)

    report_status = "PARCIAL" if "RESULTADOS PARCIALES" in full_text.upper() else "FINAL"

    observations: list[dict[str, Any]] = []
    cur_panel = "Chemistry Panel"
    cur_specimen = "serum"
    cur_method: str | None = None

    for page in pages:
        plines = page["lines"]
        in_body = False
        i = 0
        while i < len(plines):
            l = plines[i]
            t = l["text"].strip()
            low = t.lower()

            if t.startswith("Examen Resultado"):
                in_body = True
                i += 1
                continue
            if not in_body:
                i += 1
                continue
            # Geometry guard: LAPI footer/accreditation/address block lives at y > 0.88
            box = l.get("box")
            if box and len(box) >= 2 and float(box[1]) > 0.88:
                i += 1
                continue
            # Stop body parsing when reaching LAPI footer or legal/signature block
            if re.search(r"(ver\s+alcance|lapi,\s*s\.?\s*a\.?|rosa\s+blanca|alcald[ií]a\s+[aá]lvaro|atentamente|responsable\s+sanitario|ced\.?\s*prof|universidad\s+aut[oó]noma)", t, re.IGNORECASE):
                i += 1
                continue
            if t == "Brincos" or t == "*" or re.fullmatch(r"\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2}", t):
                i += 1
                continue
            # Section header (check BEFORE noise filter so "- RIESGO DE SINDROME METABOLICO -" updates panel/specimen!)
            sec = _lapi_section_update(t, cur_panel, cur_specimen)
            if sec and (t.startswith("-") or len(t) < 42) and not re.search(r"\d", t):
                cur_panel, cur_specimen = sec
                i += 1
                continue

            if any(low.startswith(p) for p in LAPI_TIER_PREFIXES):
                i += 1
                continue
            if is_noise_analyte(t):
                i += 1
                continue
            # Skip wrapped lowercase explanatory prose sentences
            if t[0].islower() or low.startswith("recomendable "):
                i += 1
                continue

            # Out-of-range asterisk + unit (or standalone unit) wrapped onto next line: "* mg/dL", "mg/dL", "* g/dL", "* /l.0"
            m_wrap_unit = re.match(
                r"^(?:\*\s*(\S.*)|"
                r"(mg/dL|mg/L|g/dL|g/L|ug/dL|[µμ]g/dL|ng/mL|ng/dL|pg/mL|UI/L|U/L|mUI/L|mIU/L|mEq/L|mmol/L|%|/l\.0))$",
                t,
                re.IGNORECASE,
            )
            if m_wrap_unit and observations:
                unit_cand = (m_wrap_unit.group(1) or m_wrap_unit.group(2) or "").strip()
                if unit_cand and not observations[-1].get("unitRaw"):
                    observations[-1]["unitRaw"] = unit_cand
                i += 1
                continue

            if low in LAPI_METHOD_LINES:
                cur_method = t
                i += 1
                continue

            # Special LAPI Blood Pressure row:
            # Either two lines ("Presión Arterial Menor a 130/85" + "118/76 mm/Hg")
            # OR Y-merged single line ("Presión Arterial 118/76 mm/Hg Menor a 130/85")
            if re.match(r"^Presi[oó]n Arterial", t, re.IGNORECASE):
                bp_val = None
                bp_unit = "mm/Hg"
                bp_line = l
                ref_bp = None
                m_merged_after = re.match(
                    r"^Presi[oó]n Arterial\s+(Menor a \d{2,3}/\d{2,3})\s+(\d{2,3}/\d{2,3})\s*(mm/?Hg)?",
                    t,
                    re.IGNORECASE,
                )
                m_merged = re.match(
                    r"^Presi[oó]n Arterial\s+(\d{2,3}/\d{2,3})\s*(mm/?Hg)?\s*(.*)$",
                    t,
                    re.IGNORECASE,
                )
                if m_merged_after:
                    ref_bp = m_merged_after.group(1).strip()
                    bp_val = m_merged_after.group(2)
                    bp_unit = m_merged_after.group(3) or "mm/Hg"
                elif m_merged:
                    bp_val = m_merged.group(1)
                    bp_unit = m_merged.group(2) or "mm/Hg"
                    ref_bp = m_merged.group(3).strip() or None
                else:
                    ref_bp = re.sub(r"^Presi[oó]n Arterial\s*", "", t, flags=re.IGNORECASE).strip() or None
                    if i + 1 < len(plines):
                        nxt = plines[i + 1]["text"].strip()
                        m_nxt = re.match(r"^(\d{2,3}/\d{2,3})\s*(mm/?Hg)?", nxt, re.IGNORECASE)
                        if m_nxt:
                            bp_val = m_nxt.group(1)
                            bp_unit = m_nxt.group(2) or "mm/Hg"
                            bp_line = plines[i + 1]
                            i += 1
                if bp_val:
                    observations.append({
                        "rawName": "Presión Arterial",
                        "specimen": "vitals",
                        "panel": "Vitals & Anthropometrics",
                        "valueNum": None,
                        "valueText": bp_val,
                        "unitRaw": bp_unit,
                        "refText": ref_bp,
                        "method": cur_method,
                        "collectedAt": collected_at,
                        "page": bp_line["page"],
                        "lineIndex": bp_line["line"],
                        "bbox": bp_line["box"],
                        "excerpt": f"{t} | {bp_line['text']}" if bp_line != l else t,
                        "meta": {},
                    })
                    sys_v, dia_v = bp_val.split("/")
                    observations.append({
                        "rawName": "Presión Sistólica",
                        "canonicalKey": "vitals:systolic_bp",
                        "specimen": "vitals",
                        "panel": "Vitals & Anthropometrics",
                        "valueNum": float(sys_v),
                        "valueText": sys_v,
                        "unitRaw": "mmHg",
                        "refText": "< 130",
                        "method": cur_method,
                        "collectedAt": collected_at,
                        "page": bp_line["page"],
                        "lineIndex": bp_line["line"],
                        "bbox": bp_line["box"],
                        "excerpt": bp_line["text"],
                        "meta": {"derivedFrom": "vitals:blood_pressure"},
                    })
                    observations.append({
                        "rawName": "Presión Diastólica",
                        "canonicalKey": "vitals:diastolic_bp",
                        "specimen": "vitals",
                        "panel": "Vitals & Anthropometrics",
                        "valueNum": float(dia_v),
                        "valueText": dia_v,
                        "unitRaw": "mmHg",
                        "refText": "< 85",
                        "method": cur_method,
                        "collectedAt": collected_at,
                        "page": bp_line["page"],
                        "lineIndex": bp_line["line"],
                        "bbox": bp_line["box"],
                        "excerpt": bp_line["text"],
                        "meta": {"derivedFrom": "vitals:blood_pressure"},
                    })
                i += 1
                continue

            # Qualitative rows (e.g. "VDRL (Cualitativo) Negativo", "Anti HVC No Reactiva", "Ac. Anti - H.I.V. 1 + 2 No Reactiva No Reactiva")
            # Guard: do NOT trigger on "Proteína C Reactiva (Ultra sensible) 1.10 ..." where digits follow!
            m_qual = re.match(
                r"^(?P<name>[A-Za-zÁÉÍÓÚÑáéíóúñ0-9()+./\s-]{3,55}?)\s+"
                r"(?P<val>No Reactiva|No Reactivo|Reactiva|Reactivo|Negativo|Positivo|Ausentes|Presentes)\s*"
                r"(?P<rest>(?:No Reactiva|No Reactivo|Reactiva|Reactivo|Negativo|Positivo|Ausentes|Presentes)?)$",
                t,
                re.IGNORECASE,
            )
            if m_qual and not re.match(r"^(Negativo|Positivo|No Reactiva|No Reactivo|Reactiva|Reactivo)$", t, re.IGNORECASE):
                observations.append({
                    "rawName": m_qual.group("name").strip(),
                    "specimen": cur_specimen,
                    "panel": cur_panel,
                    "valueNum": None,
                    "valueText": m_qual.group("val").strip(),
                    "unitRaw": None,
                    "refText": m_qual.group("rest").strip() or m_qual.group("val").strip(),
                    "method": cur_method,
                    "collectedAt": collected_at,
                    "page": l["page"],
                    "lineIndex": l["line"],
                    "bbox": l["box"],
                    "excerpt": t,
                    "meta": {},
                })
                i += 1
                continue

            # Numeric LAPI row: "<Name> <Value> [<RefRange>] [<Unit>]"
            # Examples:
            #   Glucosa 93 70 - 99 mg/dL
            #   Fracción A1C 5.4 Menor a 5.7 %
            #   Colesterol Total 183 Recomendable 130 - 199 mg/dL
            #   Colesterol de Baja Densidad (LDL) 111 Recomendable Menor a 100
            #   Peso 72.0 Kg
            #   Medición de Perímetro Abdominal 80.0 cm.
            #   Globulina 2.2 2.3 - 3.4
            m_num = re.match(
                r"^(?P<name>[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9()./%°\s-]{1,65}?)\s+"
                r"(?P<val>(?:<=|>=|<|>)?\s*\d+(?:\.\d+)?)\s*(?P<tail>.*)$",
                t,
            )
            if m_num:
                name = m_num.group("name").strip()
                val_str = re.sub(r"\s+", " ", m_num.group("val").strip())
                tail = m_num.group("tail").strip()
                # Skip non-analyte headers, addresses, licenses, footers
                if re.match(r"^(QUIMICA|QUÍMICA|P[AÁ]GINA|PERFIL|GRAN SUR|ORDEN)", name, re.IGNORECASE) or is_noise_analyte(name, val_str, t):
                    i += 1
                    continue

                unit_raw = None
                ref_text = None
                if tail:
                    # Strip stray out-of-range asterisk from tail
                    tail_clean = re.sub(r"\s*\*\s*$", "", tail).strip()
                    lapi_unit_re = (
                        r"(mg/dL|mg/L|g/dL|g/L|ug/dL|[µμ]g/dL|ng/mL|ng/dL|pg/mL|UI/L|U/L|"
                        r"mUI/L|mIU/L|[µμu]UI/mL|mEq/L|mmol/L|mL/min/1\.73\s*m[²2]?|ml/min|fL|pg|"
                        r"x\s*10\^\d+/[µμu]L|10\^\d+/[µμu]L|mm/Hg|mmHg|Kg|kg|cm\.?|m|%|/l\.0)"
                    )
                    # Check leading "[*] <unit> <ref>" (Y-merged LAPI out-of-range layout: "* mg/dL Recomendable Menor a 100")
                    m_lead = re.match(rf"^\*?\s*{lapi_unit_re}(?:\s+(.*))?$", tail_clean, re.IGNORECASE)
                    if m_lead:
                        unit_raw = m_lead.group(1).strip()
                        ref_text = (m_lead.group(2) or "").strip() or None
                    else:
                        # Extract trailing unit if present: "<ref> <unit>"
                        m_u = re.search(rf"(?:^|\s){lapi_unit_re}\s*$", tail_clean, re.IGNORECASE)
                        if m_u:
                            unit_raw = m_u.group(1).strip()
                            ref_part = re.sub(r"\s*\*\s*$", "", tail_clean[:m_u.start()]).strip()
                            ref_text = ref_part or None
                        else:
                            ref_text = tail_clean or None

                observations.append({
                    "rawName": name,
                    "specimen": cur_specimen,
                    "panel": cur_panel,
                    "valueNum": parse_num(val_str),
                    "valueText": val_str,
                    "unitRaw": unit_raw,
                    "refText": ref_text,
                    "method": cur_method,
                    "collectedAt": collected_at,
                    "page": l["page"],
                    "lineIndex": l["line"],
                    "bbox": l["box"],
                    "excerpt": t,
                    "meta": {},
                })
            i += 1

    return {
        "provider": provider,
        "orderNumber": order_number,
        "reportStatus": report_status,
        "docType": "lab_report",
        "isSyntheticDemo": False,
        "patient": {
            "nameRaw": patient_name,
            "dobRaw": patient_dob,
            "sexRaw": None,
        },
        "collectedAt": collected_at,
        "reportedAt": reported_at,
        "receivedAt": None,
        "observations": observations,
        "findings": [],
        "reviewItems": [],
        "meta": {"parser": "lapi_main"},
    }


def parse_lapi_summary(pages: list[dict[str, Any]], provider: str) -> dict[str, Any]:
    all_lines = [l for p in pages for l in p["lines"]]
    full_text = "\n".join(l["text"] for l in all_lines)

    collected_at = parse_date_mx_or_iso(all_lines[0]["text"]) if all_lines else None
    patient_name = None
    patient_dob = None
    patient_sex = None
    order_number = None

    for idx, l in enumerate(all_lines):
        t = l["text"].strip()
        if "P A C I E N T E:" in t:
            # Handle Y-merged "P A C I E N T E: Orden : 123456" or "P A C I E N T E:" followed by patient name on next line
            m_ord_inline = re.search(r"Orden\s*:?\s*(\d{5,})", t, re.IGNORECASE)
            if m_ord_inline and not order_number:
                order_number = m_ord_inline.group(1)
            if idx + 1 < len(all_lines):
                nxt = all_lines[idx + 1]["text"].strip()
                m_fn = re.search(r"F/N:\s*(\d{1,2}/\d{1,2}/\d{2,4})", nxt)
                if m_fn:
                    patient_dob = m_fn.group(1)
                    patient_name = nxt[:m_fn.start()].strip()
                else:
                    patient_name = nxt
        if "Sexo:" in t:
            m_sex = re.search(r"Sexo:\s*([A-Za-zÁÉÍÓÚÑ]+)", t, re.IGNORECASE)
            if m_sex:
                patient_sex = m_sex.group(1)
        if not order_number:
            m_ord = re.search(r"\bOrden\s*:?\s*(\d{5,})", t, re.IGNORECASE)
            if m_ord:
                order_number = m_ord.group(1)
            elif t == "Orden" and idx + 4 < len(all_lines):
                for k in range(idx + 1, min(idx + 6, len(all_lines))):
                    if re.fullmatch(r"\d{5,}", all_lines[k]["text"].strip()):
                        order_number = all_lines[k]["text"].strip()
                        break

    observations: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []

    def add_obs(raw_name: str, val_text: str, unit_raw: str | None, specimen: str, panel: str, line_obj: dict[str, Any]):
        val_clean = val_text.strip()
        # Sanity check: numeric or BP value only in summary observations
        if not (re.fullmatch(r"\d+(?:\.\d+)?", val_clean) or re.fullmatch(r"\d{2,3}/\d{2,3}", val_clean)):
            return
        observations.append({
            "rawName": raw_name,
            "specimen": specimen,
            "panel": panel,
            "valueNum": parse_num(val_clean),
            "valueText": val_clean,
            "unitRaw": unit_raw,
            "refText": None,
            "method": None,
            "collectedAt": collected_at,
            "page": line_obj["page"],
            "lineIndex": line_obj["line"],
            "bbox": line_obj["box"],
            "excerpt": f"{raw_name}: {val_clean} {unit_raw or ''}".strip(),
            "meta": {"summarySource": "ordenextrac"},
        })

    for idx, l in enumerate(all_lines):
        t = l["text"].strip()
        # Skip footer/notes
        box = l.get("box")
        if box and len(box) >= 2 and float(box[1]) > 0.88:
            continue
        if re.match(r"^(NOTA:|Positivo:|Negativo:|1/1|MIGUEL)", t, re.IGNORECASE):
            continue

        # 1. Y-merged single-line Peso/Talla/Presión: "Peso Talla Presión 72.0 1.75 118/76 Kg m mm/Hg"
        m_ptp = re.search(
            r"Peso\s+Talla\s+Presi[oó]n\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d{2,3}/\d{2,3})\s*(Kg|kg)?\s*(m|cm)?\s*(mm/?Hg)?",
            t,
            re.IGNORECASE,
        )
        if m_ptp:
            add_obs("Peso", m_ptp.group(1), m_ptp.group(4) or "Kg", "vitals", "Vitals & Anthropometrics", l)
            add_obs("Talla", m_ptp.group(2), m_ptp.group(5) or "m", "vitals", "Vitals & Anthropometrics", l)
            add_obs("Presión Arterial", m_ptp.group(3), m_ptp.group(6) or "mm/Hg", "vitals", "Vitals & Anthropometrics", l)
            continue
        # Stacked fallback for pypdf (unmerged)
        if "Peso" in t and "Talla" in t and not re.search(r"\d", t) and idx + 2 < len(all_lines):
            vals = all_lines[idx + 1]["text"].split()
            units = all_lines[idx + 2]["text"].split()
            if len(vals) >= 3:
                add_obs("Peso", vals[0], units[0] if len(units) > 0 else "Kg", "vitals", "Vitals & Anthropometrics", all_lines[idx + 1])
                add_obs("Talla", vals[1], units[1] if len(units) > 1 else "m", "vitals", "Vitals & Anthropometrics", all_lines[idx + 1])
                add_obs("Presión Arterial", vals[2], units[2] if len(units) > 2 else "mm/Hg", "vitals", "Vitals & Anthropometrics", all_lines[idx + 1])
            continue

        # 2. Perímetro Abdominal (single-line or stacked)
        m_waist = re.search(r"Per[ií]metro\s+Abdominal\s+(\d+(?:\.\d+)?)\s*(cm\.?)?", t, re.IGNORECASE)
        if m_waist:
            add_obs("Medición de Perímetro Abdominal", m_waist.group(1), m_waist.group(2) or "cm.", "vitals", "Vitals & Anthropometrics", l)
            continue
        if "Perímetro Abdominal" in t and not re.search(r"\d", t) and idx + 2 < len(all_lines):
            add_obs("Medición de Perímetro Abdominal", all_lines[idx + 1]["text"].strip(), all_lines[idx + 2]["text"].strip(), "vitals", "Vitals & Anthropometrics", all_lines[idx + 1])
            continue

        # 3. Glucosa (single-line or stacked)
        m_glu = re.match(r"^Glucosa\s+(\d+(?:\.\d+)?)\s*(mg/dL)?$", t, re.IGNORECASE)
        if m_glu:
            add_obs("Glucosa", m_glu.group(1), m_glu.group(2) or "mg/dL", "serum", "Glucose & Metabolic", l)
            continue
        if t == "Glucosa" and idx + 2 < len(all_lines):
            add_obs("Glucosa", all_lines[idx + 1]["text"].strip(), all_lines[idx + 2]["text"].strip(), "serum", "Glucose & Metabolic", all_lines[idx + 1])
            continue

        # 4. Triglicéridos & H.D.L. (single-line or stacked)
        m_trig = re.match(r"^Triglic[eé]ridos\s+(\d+(?:\.\d+)?)\s*(mg/dL)?$", t, re.IGNORECASE)
        if m_trig:
            add_obs("Triglicéridos", m_trig.group(1), m_trig.group(2) or "mg/dL", "serum", "Lipids", l)
            continue
        m_hdl = re.match(r"^H\.?D\.?L\.?\s+(\d+(?:\.\d+)?)\s*(mg/dL)?$", t, re.IGNORECASE)
        if m_hdl:
            add_obs("H.D.L.", m_hdl.group(1), m_hdl.group(2) or "mg/dL", "serum", "Lipids", l)
            continue
        if t.startswith("Triglic") and not re.search(r"\d", t) and idx + 5 < len(all_lines) and "H.D.L" in all_lines[idx + 1]["text"]:
            add_obs("Triglicéridos", all_lines[idx + 2]["text"].strip(), all_lines[idx + 4]["text"].strip(), "serum", "Lipids", all_lines[idx + 2])
            add_obs("H.D.L.", all_lines[idx + 3]["text"].strip(), all_lines[idx + 5]["text"].strip(), "serum", "Lipids", all_lines[idx + 3])
            continue

        # 5. Metabolic Syndrome Risk Finding (single-line "- RIESGO DE SINDROME METABOLICO - NEGATIVO" OR two-line)
        m_met = re.search(r"-\s*RIESGO DE SINDROME METABOLICO\s*-\s*(NEGATIVO|POSITIVO)?", t, re.IGNORECASE)
        if m_met:
            result_label = (m_met.group(1) or "").strip()
            ref_line = l
            if not result_label and idx + 1 < len(all_lines):
                cand = all_lines[idx + 1]["text"].strip()
                if re.match(r"^(NEGATIVO|POSITIVO)$", cand, re.IGNORECASE):
                    result_label = cand
                    ref_line = all_lines[idx + 1]
            if result_label:
                criteria = ""
                for k in range(idx + 1, len(all_lines)):
                    if all_lines[k]["text"].strip().lower().startswith(result_label.lower()[:4] + ":"):
                        criteria = all_lines[k]["text"].strip()
                        break
                summary = f"Metabolic Syndrome Risk: {result_label.upper()}" + (f" ({criteria})" if criteria else "")
                findings.append({
                    "findingType": "metabolic_syndrome_risk",
                    "title": "Metabolic Syndrome Risk Assessment (LAPI)",
                    "summary": summary,
                    "followupPlan": None,
                    "collectedAt": collected_at,
                    "page": ref_line["page"],
                    "bbox": ref_line["box"],
                    "excerpt": f"{t} {result_label}".strip() if result_label not in t else t,
                })

    return {
        "provider": provider,
        "orderNumber": order_number,
        "reportStatus": "FINAL",
        "docType": "lab_summary",
        "isSyntheticDemo": False,
        "patient": {
            "nameRaw": patient_name,
            "dobRaw": patient_dob,
            "sexRaw": patient_sex,
        },
        "collectedAt": collected_at,
        "reportedAt": collected_at,
        "receivedAt": None,
        "observations": observations,
        "findings": findings,
        "reviewItems": [],
        "meta": {"parser": "lapi_summary"},
    }


def parse_generic(pages: list[dict[str, Any]], provider: str) -> dict[str, Any]:
    all_lines = [l for p in pages for l in p["lines"]]
    full_text = "\n".join(l["text"] for l in all_lines)
    m_pat = re.search(r"(?:Patient|Paciente|Name)\s*:\s*([^\n]+)", full_text, re.IGNORECASE)
    m_date = re.search(r"(?:Collection\s*Date|Date\s*Collected|Fecha\s*Toma|Date)\s*:\s*([^\n]+)", full_text, re.IGNORECASE)
    collected_at = parse_date_mx_or_iso(m_date.group(1)) if m_date else None

    observations = []
    pat = re.compile(
        rf"^(?P<name>[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9()/\s.-]{{2,45}}?)\s*[:|]?\s+"
        rf"(?P<val>(?:<=|>=|<|>)?\s*\d+(?:\.\d+)?)\s+(?P<unit>{LMS_UNITS_PATTERN})\b\s*(?P<ref>.*)$",
        re.IGNORECASE,
    )
    for l in all_lines:
        m = pat.match(l["text"].strip())
        if not m:
            continue
        observations.append({
            "rawName": m.group("name").strip(),
            "specimen": "serum",
            "panel": "General Labs",
            "valueNum": parse_num(m.group("val")),
            "valueText": m.group("val").strip(),
            "unitRaw": m.group("unit").strip(),
            "refText": m.group("ref").strip() or None,
            "method": None,
            "collectedAt": collected_at,
            "page": l["page"],
            "lineIndex": l["line"],
            "bbox": l["box"],
            "excerpt": l["text"],
            "meta": {},
        })

    return {
        "provider": provider,
        "orderNumber": None,
        "reportStatus": "UNKNOWN",
        "docType": "lab_report",
        "isSyntheticDemo": False,
        "patient": {
            "nameRaw": m_pat.group(1).strip() if m_pat else None,
            "dobRaw": None,
            "sexRaw": None,
        },
        "collectedAt": collected_at,
        "reportedAt": None,
        "receivedAt": None,
        "observations": observations,
        "findings": [],
        "reviewItems": [],
        "meta": {"parser": "generic"},
    }


def extract_pdf(pdf_path: Path, pages_dir: Path | None = None, doc_prefix: str = "") -> dict[str, Any]:
    digest = sha256_file(pdf_path)
    doc_id = doc_prefix or digest[:12]

    # Priority chain: pdfplumber -> pdftotext -> macOS PDFKit -> pypdf
    raw_doc = extract_with_pdfplumber(pdf_path)
    if raw_doc is None:
        raw_doc = extract_with_pdftotext(pdf_path)
    if raw_doc is None:
        raw_doc = extract_with_macos_pdfkit(pdf_path, pages_dir, doc_id)
    if raw_doc is None:
        raw_doc = extract_with_pypdf(pdf_path)

    if raw_doc is None:
        return {
            "status": "error",
            "error": "No PDF extraction backend available (install poppler-utils, pdfplumber, or pypdf)",
            "filename": pdf_path.name,
            "sha256": digest,
        }

    pages_rendered = raw_doc.get("pagesRendered") or []
    if pages_dir is not None and not pages_rendered:
        pages_rendered = render_pages_pdftoppm(pdf_path, pages_dir, doc_id)
        if not pages_rendered and sys.platform == "darwin" and shutil.which("swift"):
            # Use PDFKit just for PNG rendering when text came from pdfplumber/pdftotext
            kit = extract_with_macos_pdfkit(pdf_path, pages_dir, doc_id)
            if kit:
                pages_rendered = kit.get("pagesRendered") or []

    pages = raw_doc.get("pages") or []
    all_lines = [l for p in pages for l in p.get("lines", [])]
    all_text = "\n".join(p.get("text", "") for p in pages)
    non_ws_chars = len(re.sub(r"\s+", "", all_text))

    if non_ws_chars < 40:
        return {
            "status": "needs_vlm_extraction",
            "filename": pdf_path.name,
            "sourcePath": str(pdf_path.resolve()),
            "sha256": digest,
            "pageCount": raw_doc.get("pageCount", len(pages)),
            "pagesRendered": pages_rendered,
            "backend": raw_doc.get("backend"),
            "reason": "Scanned or image-only PDF with insufficient embedded text",
        }

    provider, family, _ = detect_provider(all_text, all_lines)
    if family == "synthetic":
        parsed = parse_synthetic(all_lines, provider)
    elif family == "lms":
        parsed = parse_lms(pages, provider)
    elif family == "lapi_main":
        parsed = parse_lapi_main(pages, provider)
    elif family == "lapi_summary":
        parsed = parse_lapi_summary(pages, provider)
    else:
        parsed = parse_generic(pages, provider)

    # Final defensive filter across all parsers: strip any address/footer/signature/legal noise
    if not parsed.get("isSyntheticDemo"):
        parsed["observations"] = [
            obs for obs in (parsed.get("observations") or [])
            if not is_noise_analyte(obs.get("rawName"), obs.get("valueText"), obs.get("excerpt"))
        ]

    parsed["status"] = "extracted"
    parsed["filename"] = pdf_path.name
    parsed["sourcePath"] = str(pdf_path.resolve())
    parsed["sha256"] = digest
    parsed["pageCount"] = raw_doc.get("pageCount", len(pages))
    parsed["pagesRendered"] = pages_rendered
    parsed["meta"] = {**(parsed.get("meta") or {}), "backend": raw_doc.get("backend")}
    return parsed


def main():
    parser = argparse.ArgumentParser(description="Extract structured lab data from a PDF.")
    parser.add_argument("pdf", help="Path to PDF file")
    parser.add_argument("--pages-dir", default=None, help="Directory to write rendered page PNGs")
    parser.add_argument("--doc-id", default="", help="Prefix for rendered page PNGs")
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.is_file():
        print(json.dumps({"status": "error", "error": f"File not found: {pdf_path}"}))
        sys.exit(1)

    pages_dir = Path(args.pages_dir) if args.pages_dir else None
    result = extract_pdf(pdf_path, pages_dir=pages_dir, doc_prefix=args.doc_id)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
