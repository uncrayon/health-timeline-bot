import { readLegacyTimeline } from "./core/query.mjs";

export function readTimeline(opts = {}) {
  return readLegacyTimeline(opts);
}

export { readLegacyTimeline };
export * from "./core/query.mjs";
