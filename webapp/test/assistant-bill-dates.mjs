import assert from "node:assert/strict";
import { allDueDates, nextDue } from "../public/js/features/transactions.js";
import { today } from "../public/js/features/profile.js";

const historical = {
  schedule: { freq: "daily", interval: 1, start: "2020-01-01" },
  last_posted_on: null,
  skipped_dates: [],
};
assert.deepEqual(
  allDueDates(historical, "2026-10-05", { from: "2026-10-01" }),
  ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"],
);
assert.deepEqual(allDueDates({
  ...historical,
  last_posted_on: "2026-10-01",
  skipped_dates: ["2026-10-03"],
  schedule: { ...historical.schedule, end: "2026-10-04" },
}, "2026-10-05", { from: "2026-10-01" }), ["2026-10-02", "2026-10-04"]);

const start = today();
const tomorrow = new Date(Date.parse(`${start}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
const next = {
  schedule: { freq: "daily", interval: 1, start },
  last_posted_on: null,
  skipped_dates: [start],
};
assert.equal(nextDue(next), tomorrow);
assert.equal(nextDue({ ...next, schedule: { ...next.schedule, end: "0001-01-01" } }), null);
