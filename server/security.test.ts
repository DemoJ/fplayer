import assert from "node:assert/strict";
import test from "node:test";
import { decrypt, encrypt, hashPassword, hashToken, verifyPassword } from "./security.js";

test("password hashes verify without storing the password", () => {
  const password = "correct horse battery staple";
  const hash = hashPassword(password);
  assert.equal(verifyPassword(password, hash), true);
  assert.equal(verifyPassword("wrong password", hash), false);
  assert.equal(hash.includes(password), false);
});

test("source secrets encrypt and decrypt", () => {
  const encrypted = encrypt("webdav-token");
  assert.notEqual(encrypted, "webdav-token");
  assert.equal(decrypt(encrypted), "webdav-token");
});

test("session tokens are stored as deterministic hashes", () => {
  assert.equal(hashToken("token"), hashToken("token"));
  assert.notEqual(hashToken("token"), hashToken("other"));
});
