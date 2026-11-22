"""Build a SQLite snapshot from the allowlisted synthetic lab fixtures."""
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from datetime import date
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
BUILD = ROOT / "build"
NS = {"pdf": "http://www.w3.org/1999/xhtml"}
DOCUMENTS = {
    "cedar": ("cedar-lab.pdf", "Cedar Lab"),
    "meridian": ("meridian-diagnostics.pdf", "Meridian Diagnostics"),
}
RESULT = re.compile(
    r"(?P<test>[^|]+?)\s*\|\s*(?P<value>\d+(?:\.\d+)?)\s+"
    r"(?P<unit>[^|]+?)\s*\|\s*(?P<range>[^|]+)"
)
SUPPORTED = {"LDL Cholesterol (Direct)", "LDL-C, measured"}
FACTORS = {"mg/dL": Decimal("1"), "mmol/L": Decimal("38.67")}

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE documents (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, provider TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE, page_count INTEGER NOT NULL
);
CREATE TABLE deliveries (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
    received TEXT NOT NULL, channel TEXT NOT NULL
);
CREATE TABLE observations (
    document_id TEXT PRIMARY KEY REFERENCES documents(id),
    collected TEXT, normalized REAL, payload TEXT NOT NULL
);
"""


def extract_pages(pdf):
    data = subprocess.check_output(
        ["pdftotext", "-f", "1", "-l", "5", "-bbox-layout", str(pdf), "-"],
        timeout=12,
    )
    pages = ET.fromstring(data).findall(".//pdf:page", NS)
    if not 1 <= len(pages) <= 4:
        raise ValueError(f"Unexpected page count in {pdf.name}")
    lines = []
    for page_number, page in enumerate(pages, 1):
        for line_number, line in enumerate(page.findall(".//pdf:line", NS), 1):
            width, height = float(page.attrib["width"]), float(page.attrib["height"])
            x0, y0, x1, y1 = (float(line.attrib[key]) for key in ("xMin", "yMin", "xMax", "yMax"))
            lines.append({
                "page": page_number,
                "line": line_number,
                "text": " ".join(word.text or "" for word in line.findall("pdf:word", NS)),
                "box": [x0 / width, y0 / height, (x1 - x0) / width, (y1 - y0) / height],
            })
    return len(pages), lines


def field(lines, label):
    prefix = f"{label}: "
    matches = [line for line in lines if line["text"].startswith(prefix)]
    if len(matches) != 1:
        return None, None
    return matches[0]["text"][len(prefix):], matches[0]


def iso_date(value):
    try:
        return date.fromisoformat(value).isoformat() if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or "") else None
    except ValueError:
        return None


def observe(lines):
    raw_collected, collection_source = field(lines, "Collection date")
    raw_reported, report_source = field(lines, "Report date")
    specimen, _ = field(lines, "Specimen")
    method, _ = field(lines, "Method")
    candidates = [
        (line, match) for line in lines
        if (match := RESULT.fullmatch(line["text"])) and "LDL" in match["test"].upper()
    ]
    source, match = candidates[0] if len(candidates) == 1 else (None, None)
    collected, reported = iso_date(raw_collected), iso_date(raw_reported)
    result = match.groupdict() if match else None
    factor = FACTORS.get(result["unit"]) if result else None
    reasons = []
    if collected is None:
        reasons.append("Collection date missing, invalid, or ambiguous")
    if result is None:
        reasons.append("Report lacks a single readable LDL result")
    elif result["test"] not in SUPPORTED or method != "Direct" or specimen != "Serum":
        reasons.append("LDL method, specimen, or test name is outside direct serum LDL")
    elif factor is None:
        reasons.append("LDL unit is outside the supported conversion")
    normalized = float(Decimal(result["value"]) * factor) if not reasons else None
    return {
        "collected": collected, "reported": reported, "specimen": specimen, "method": method,
        "result": result, "source": source, "collectionSource": collection_source,
        "reportSource": report_source, "factor": float(factor) if normalized is not None else None,
        "normalized": normalized, "reasons": reasons,
    }


def stage_document(staging, fixture):
    document_id = fixture["id"]
    filename, provider = DOCUMENTS[document_id]
    pdf = FIXTURES / filename
    if (fixture["file"] != filename or pdf.resolve() != pdf
            or not pdf.is_file() or pdf.stat().st_size > 256_000):
        raise ValueError(f"Invalid staged fixture: {document_id}")
    raw = pdf.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != fixture["sha256"]:
        raise ValueError(f"Fixture checksum mismatch: {filename}")
    copy = staging / filename
    copy.write_bytes(raw)
    page_count, lines = extract_pages(copy)
    if not lines or lines[0]["text"] != provider:
        raise ValueError(f"Wrong report in fixture: {filename}")
    observation = observe(lines)
    subprocess.run(
        ["pdftoppm", "-png", "-r", "120", str(copy), str(staging / document_id)],
        check=True, timeout=15,
    )
    return (document_id, filename, provider, digest, page_count), observation


def ingest():
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    fixtures = manifest["documents"]
    if len(fixtures) != len(DOCUMENTS) or {f["id"] for f in fixtures} != DOCUMENTS.keys():
        raise ValueError("Unexpected staged document list")
    deliveries = manifest["deliveries"]
    if any(
        row["document"] not in DOCUMENTS or not iso_date(row["date"])
        for row in deliveries
    ):
        raise ValueError("Invalid synthetic delivery metadata")
    BUILD.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=BUILD) as directory:
        staging = Path(directory)
        with sqlite3.connect(staging / "timeline.sqlite") as db:
            db.executescript(SCHEMA)
            for fixture in fixtures:
                document, observation = stage_document(staging, fixture)
                db.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?)", document)
                db.execute("INSERT INTO observations VALUES (?, ?, ?, ?)", (
                    document[0], observation["collected"], observation["normalized"],
                    json.dumps(observation),
                ))
            db.executemany("INSERT OR IGNORE INTO deliveries VALUES (?, ?, ?, ?)", (
                (row["id"], row["document"], row["date"], row["channel"]) for row in deliveries
            ))
        db.close()
        for file in sorted(staging.iterdir(), key=lambda path: path.suffix == ".sqlite"):
            os.replace(file, BUILD / file.name)
    print("Built Health Timeline from two synthetic PDFs.")


if __name__ == "__main__":
    ingest()
