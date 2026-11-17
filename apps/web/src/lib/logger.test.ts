// Unit tests for the redaction logger (P1 MEDIUM #5).
//
// The logger writes one JSON line to stdout; the tests capture `console.log` and
// parse that line, so they assert on exactly what a collector would receive.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { log, redact, REDACTED } from "./logger.ts";

function captureLog(run: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];

  console.log = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = original;
  }

  return lines;
}

describe("logger redaction", () => {
  it("meredaksi field password", () => {
    const safe = redact({ password: "hunter2", email: "owner@example.com" });

    assert.equal(safe.password, REDACTED);
    assert.equal(safe.email, "owner@example.com");
  });

  it("meredaksi token di dalam objek bersarang", () => {
    const safe = redact({
      request: { headers: { authorization: "Bearer abc.def.ghi" }, token: "raw-token" },
      outcome: "denied",
    }) as {
      request: { headers: { authorization: unknown }; token: unknown };
      outcome: string;
    };

    assert.equal(safe.request.headers.authorization, REDACTED);
    assert.equal(safe.request.token, REDACTED);
    assert.equal(safe.outcome, "denied");
  });

  it("meredaksi secret di dalam array", () => {
    const safe = redact({ attempts: [{ secret: "s3cr3t" }, { api_key: "key-123" }, "plain"] });

    assert.deepEqual(safe.attempts, [{ secret: REDACTED }, { api_key: REDACTED }, "plain"]);
  });

  it("menulis JSON satu baris dengan field aman tetap utuh", () => {
    const lines = captureLog(() => {
      log("warn", "test.event", { userId: "u-1", nested: { count: 2 }, cookie: "sid=abc" });
    });

    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

    assert.equal(record.level, "warn");
    assert.equal(record.event, "test.event");
    assert.equal(record.userId, "u-1");
    assert.deepEqual(record.nested, { count: 2 });
    assert.equal(record.cookie, REDACTED);
    assert.equal(typeof record.ts, "string");
    assert.ok(!String(record.ts).includes("sid=abc"));
  });

  it("meredaksi secret yang tertulis di dalam teks bebas (pesan error)", () => {
    const safe = redact({
      message: "login failed password=hunter2 token=abc123 Bearer eyJhbGciOi.payload",
    });

    const message = String(safe.message);
    assert.ok(!message.includes("hunter2"), message);
    assert.ok(!message.includes("abc123"), message);
    assert.ok(!message.includes("eyJhbGciOi.payload"), message);
    assert.ok(message.includes(REDACTED), message);
  });
});
