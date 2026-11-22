from decimal import Decimal
import json
import sqlite3
import subprocess
import unittest

from ingest import BUILD, FIXTURES, extract_pages, ingest, observe


class IngestTest(unittest.TestCase):
    def test_actual_pdfs_survive_reimport_with_evidence(self):
        ingest()
        ingest()
        with sqlite3.connect(BUILD / "timeline.sqlite") as db:
            documents = db.execute("""
                SELECT d.id, d.filename, o.payload FROM documents d
                JOIN observations o ON o.document_id = d.id ORDER BY o.collected
            """).fetchall()
            receipts = db.execute("""
                SELECT document_id, received, channel FROM deliveries ORDER BY received
            """).fetchall()
        self.assertEqual([row[0] for row in documents], ["cedar", "meridian"])
        self.assertEqual(receipts, [
            ("meridian", "2026-10-10", "Simulated lab delivery"),
            ("cedar", "2026-10-18", "Simulated email copy"),
        ])
        expected = [
            ("2026-02-14", "2026-02-15", "112", "mg/dL", "<100", 1, 8,
             "LDL Cholesterol (Direct) | 112 mg/dL | <100", 112, 1),
            ("2026-10-08", "2026-10-09", "3.60", "mmol/L", "<3.00", 2, 6,
             "LDL-C, measured | 3.60 mmol/L | <3.00", 139.212, 38.67),
        ]
        values = []
        for (doc, filename, payload), expectation in zip(documents, expected, strict=True):
            row = json.loads(payload)
            result, source = row["result"], row["source"]
            self.assertEqual((
                row["collected"], row["reported"], result["value"], result["unit"],
                result["range"], source["page"], source["line"], source["text"],
                row["normalized"], row["factor"],
            ), expectation)
            self.assertEqual(row["reasons"], [])
            self.assertEqual((BUILD / filename).read_bytes(), (FIXTURES / filename).read_bytes())
            for location in (source, row["collectionSource"], row["reportSource"]):
                page = str(location["page"])
                plain = subprocess.check_output([
                    "pdftotext", "-f", page, "-l", page, str(FIXTURES / filename), "-",
                ], text=True)
                self.assertIn(location["text"], [" ".join(line.split()) for line in plain.splitlines()])
                self.assertTrue((BUILD / f"{doc}-{page}.png").is_file())
                x, y, width, height = location["box"]
                self.assertTrue(0 < x < x + width <= 1 and 0 < y < y + height <= 1)
            values.append(Decimal(str(row["normalized"])))
        self.assertEqual(values[1] - values[0], Decimal("27.212"))

    def test_invalid_date_and_incomparable_result_stay_out_of_trend(self):
        _, lines = extract_pages(FIXTURES / "meridian-diagnostics.pdf")
        collection = next(line for line in lines if line["text"].startswith("Collection date: "))
        result = next(line for line in lines if line["text"].startswith("LDL-C, measured"))
        variants = [
            ([line for line in lines if line != collection], "Collection date"),
            (lines + [dict(collection, text="Collection date: 2026-09-08")], "Collection date"),
            ([dict(line, text="Collection date: 2026-02-30") if line == collection else line
              for line in lines], "Collection date"),
            ([dict(line, text="Method: Calculated") if line["text"] == "Method: Direct" else line
              for line in lines], "method"),
            ([dict(line, text=result["text"].replace("mmol/L", "mg/L")) if line == result else line
              for line in lines], "unit"),
        ]
        for page_lines, reason in variants:
            with self.subTest(reason=reason):
                observed = observe(page_lines)
                self.assertIsNone(observed["normalized"])
                self.assertIn(reason, " ".join(observed["reasons"]))
                if reason == "Collection date":
                    self.assertIsNone(observed["collected"])
                    self.assertEqual(observed["reported"], "2026-10-09")


if __name__ == "__main__":
    unittest.main()
