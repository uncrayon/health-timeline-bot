import { readTimeline } from "./timeline.mjs";

const string = { type: "string" };
const number = { type: "number" };
const integer = { type: "integer", minimum: 1 };
const nullableNumber = { anyOf: [number, { type: "null" }] };
const rows = items => ({ type: "array", maxItems: 2, items });
const record = properties => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const trendTool = {
  name: "health_ldl_trend",
  label: "Read synthetic LDL trend",
  description: "Compare direct serum LDL in the staged synthetic Health Timeline reports, with collection dates and evidence. Report the observed change only.",
  parameters: record({ measurement: { type: "string", enum: ["ldl_direct_serum"] } }),
  outputSchema: record({
    normalizedUnit: { type: "string", enum: ["mg/dL"] },
    change: nullableNumber,
    results: rows(record({
      provider: string, collected: string, value: string, unit: string,
      labRange: string, normalized: number, conversionFactor: number,
      source: record({ page: integer, line: integer, excerpt: string, evidencePath: string }),
    })),
    review: rows(record({
      provider: string, reasons: { type: "array", items: string }, evidencePath: string,
    })),
  }),
  async execute(_toolCallId, args) {
    if (!args || Object.keys(args).length !== 1 || args.measurement !== "ldl_direct_serum") {
      throw new Error("Use only measurement = ldl_direct_serum.");
    }
    const { results, review, change } = readTimeline();
    const details = {
      normalizedUnit: "mg/dL",
      change,
      results: results.map(row => ({
        provider: row.provider,
        collected: row.collected,
        value: row.result.value,
        unit: row.result.unit,
        labRange: row.result.range,
        normalized: row.normalized,
        conversionFactor: row.factor,
        source: {
          page: row.source.page,
          line: row.source.line,
          excerpt: row.source.text,
          evidencePath: "/?result=" + row.id + "#evidence",
        },
      })),
      review: review.map(row => ({
        provider: row.provider, reasons: row.reasons,
        evidencePath: "/?result=" + row.id + "#evidence",
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(details) }], details };
  },
};

export default {
  id: "health-timeline",
  name: "Health Timeline",
  register(api) {
    api.registerTool(trendTool, { optional: true });
  },
};
