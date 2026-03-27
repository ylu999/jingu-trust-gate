import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileAuditWriter } from "../../../src/audit/audit-log.js";

function makeEntry(overrides?: Partial<Record<string, unknown>>) {
  return {
    auditId: randomUUID(),
    timestamp: new Date().toISOString(),
    proposalId: "p-1",
    proposalKind: "response",
    totalUnits: 2,
    approvedCount: 1,
    downgradeCount: 0,
    rejectedCount: 1,
    conflictCount: 0,
    unitSupportMap: { "u-1": ["s-1"], "u-2": [] },
    gateResults: [],
    ...overrides,
  };
}

test("append() writes a single JSONL entry to file", async () => {
  const filePath = join(tmpdir(), randomUUID(), "audit.jsonl");
  const writer = new FileAuditWriter(filePath);
  const entry = makeEntry() as Parameters<typeof writer.append>[0];

  await writer.append(entry);

  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 1);

  await rm(join(tmpdir(), filePath.split("/").slice(-2)[0]), { recursive: true });
});

test("consecutive appends produce multiple lines, each valid JSON", async () => {
  const dir = randomUUID();
  const filePath = join(tmpdir(), dir, "audit.jsonl");
  const writer = new FileAuditWriter(filePath);

  const entry1 = makeEntry({ auditId: randomUUID() }) as Parameters<typeof writer.append>[0];
  const entry2 = makeEntry({ auditId: randomUUID() }) as Parameters<typeof writer.append>[0];

  await writer.append(entry1);
  await writer.append(entry2);

  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 2);

  // Each line is valid JSON
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }

  await rm(join(tmpdir(), dir), { recursive: true });
});

test("auto-creates directory if it does not exist", async () => {
  const dir = randomUUID();
  const filePath = join(tmpdir(), dir, "nested", "deep", "audit.jsonl");
  const writer = new FileAuditWriter(filePath);
  const entry = makeEntry() as Parameters<typeof writer.append>[0];

  // Must not throw even though nested dirs don't exist yet
  await assert.doesNotReject(() => writer.append(entry));

  await rm(join(tmpdir(), dir), { recursive: true });
});

test("round-trip: JSON.parse of written line equals original entry", async () => {
  const dir = randomUUID();
  const filePath = join(tmpdir(), dir, "audit.jsonl");
  const writer = new FileAuditWriter(filePath);
  const entry = makeEntry() as Parameters<typeof writer.append>[0];

  await writer.append(entry);

  const content = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(content.trim());
  assert.deepEqual(parsed, entry);

  await rm(join(tmpdir(), dir), { recursive: true });
});

test("multiple entries have distinct auditIds (append-only, no overwrite)", async () => {
  const dir = randomUUID();
  const filePath = join(tmpdir(), dir, "audit.jsonl");
  const writer = new FileAuditWriter(filePath);

  const id1 = randomUUID();
  const id2 = randomUUID();

  const entry1 = makeEntry({ auditId: id1 }) as Parameters<typeof writer.append>[0];
  const entry2 = makeEntry({ auditId: id2 }) as Parameters<typeof writer.append>[0];

  await writer.append(entry1);
  await writer.append(entry2);

  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  const parsedIds = lines.map((l) => JSON.parse(l).auditId);

  assert.equal(parsedIds.length, 2);
  assert.notEqual(parsedIds[0], parsedIds[1]);
  assert.equal(parsedIds[0], id1);
  assert.equal(parsedIds[1], id2);

  await rm(join(tmpdir(), dir), { recursive: true });
});
