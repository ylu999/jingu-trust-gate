import assert from "node:assert";
import { sum } from "../src/math.js";

assert.strictEqual(sum(2, 3), 5, "sum(2, 3) should equal 5");
console.log("PASS: sum(2, 3) === 5");
