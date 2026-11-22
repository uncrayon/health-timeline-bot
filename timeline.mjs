import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const snapshot = fileURLToPath(new URL("./build/timeline.sqlite", import.meta.url));

export function readTimeline() {
  const db = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const entries = db.prepare(
      "SELECT d.id, d.provider, d.page_count AS pageCount, o.payload " +
      "FROM documents d JOIN observations o ON o.document_id = d.id " +
      "ORDER BY o.collected IS NULL, o.collected, d.id"
    ).all();
    const deliveries = db.prepare(
      "SELECT document_id AS documentId, received, channel FROM deliveries ORDER BY received, id"
    ).all();
    const records = entries.map(({payload, ...document}) => ({
      ...document,
      ...JSON.parse(payload),
      deliveries: deliveries.filter(row => row.documentId === document.id),
    }));
    const results = records.filter(row => row.normalized !== null);
    const review = records.filter(row => row.reasons.length > 0);
    const change = results.length >= 2
      ? Number((results.at(-1).normalized - results[0].normalized).toFixed(4))
      : null;
    return { results, review, change, deliveries };
  } finally {
    db.close();
  }
}
