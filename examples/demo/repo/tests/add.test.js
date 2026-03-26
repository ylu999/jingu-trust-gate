import { test } from "node:test";
import { strict as assert } from "node:assert";
import { add, multiply } from "../src/add.js";

test("add(1, 2) should be 3", () => {
  assert.strictEqual(add(1, 2), 3);
});

test("multiply(2, 3) should be 6", () => {
  assert.strictEqual(multiply(2, 3), 6);
});
