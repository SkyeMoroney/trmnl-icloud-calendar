import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../src/index.js";

test("OPTIONS preflight gets a 204 with CORS headers", async () => {
  const req = new Request("http://worker.test/calendars", { method: "OPTIONS" });
  const res = await handler.fetch(req);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("POST /calendars response carries CORS headers so the browser-side xhrSelect can read it", async () => {
  const req = new Request("http://worker.test/calendars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const res = await handler.fetch(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json();
  assert.equal(Array.isArray(body), true);
});

test("GET /trmnl with no credentials returns a graceful has_data:false", async () => {
  const req = new Request("http://worker.test/trmnl", { method: "GET" });
  const res = await handler.fetch(req);
  const body = await res.json();
  assert.equal(body.has_data, false);
});

test("unknown route 404s", async () => {
  const req = new Request("http://worker.test/nope", { method: "GET" });
  const res = await handler.fetch(req);
  assert.equal(res.status, 404);
});
