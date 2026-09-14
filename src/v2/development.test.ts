import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {serve} from "./runtime";

test("macOS development startup reaches account validation without connecting", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mibot-development-"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previous = process.env.NODE_ENV;
  t.after(async () => {
    Object.defineProperty(process, "platform", descriptor);
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    await fs.rm(root, {recursive: true, force: true});
  });
  Object.defineProperty(process, "platform", {...descriptor, value: "darwin"});
  process.env.NODE_ENV = "development";
  await assert.rejects(serve({root}), /CONFIG/);
});

test("non-Linux production startup rejects before reading account data", async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previous = process.env.NODE_ENV;
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  });
  for (const platform of ["darwin", "win32"]) {
    Object.defineProperty(process, "platform", {...descriptor, value: platform});
    for (const environment of [undefined, "production", "test"]) {
      if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
      await assert.rejects(serve({root: "/missing-private-account"}), /PLATFORM/);
    }
  }
});
