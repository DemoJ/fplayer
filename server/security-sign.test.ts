import assert from "node:assert/strict";
import test from "node:test";
import { signTranscode, verifyTranscodeSig } from "./security.js";

const SESSION = "12345678-1234-1234-1234-123456789012";

test("transcode signature verifies for the right session/file", () => {
  const sig = signTranscode(SESSION, "segment-00001.ts");
  assert.equal(verifyTranscodeSig(SESSION, "segment-00001.ts", sig), true);
});

test("transcode signature rejects mismatched file", () => {
  const sig = signTranscode(SESSION, "segment-00001.ts");
  assert.equal(verifyTranscodeSig(SESSION, "segment-00002.ts", sig), false);
});

test("transcode signature rejects mismatched session", () => {
  const sig = signTranscode(SESSION, "segment-00001.ts");
  assert.equal(verifyTranscodeSig("99999999-9999-9999-9999-999999999999", "segment-00001.ts", sig), false);
});

test("transcode signature rejects garbage token", () => {
  assert.equal(verifyTranscodeSig(SESSION, "segment-00001.ts", "garbage"), false);
  assert.equal(verifyTranscodeSig(SESSION, "segment-00001.ts", ""), false);
});

test("transcode signature contains expiry that the verifier honors", () => {
  const sig = signTranscode(SESSION, "segment-00001.ts");
  const exp = Number(sig.slice(0, sig.indexOf(".")));
  assert.ok(Number.isFinite(exp) && exp > Date.now());
  // A tampered expiry in the past must be rejected.
  const parts = sig.split(".");
  const tampered = `${Date.now() - 1}.${parts.slice(1).join(".")}`;
  assert.equal(verifyTranscodeSig(SESSION, "segment-00001.ts", tampered), false);
});
