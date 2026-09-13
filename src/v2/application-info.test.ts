import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, realpath, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {PluginHost, type HostOptions} from "./host";
import {readApplicationInfo} from "./runtime";
import {definePlugin, type PluginContext} from "./sdk";

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "telebox-application-info-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

const telegram: HostOptions["telegram"] = {
  async edit() {},
  async reply() {},
  async invoke() {},
  async getReply() { return undefined; },
  async withClient() { throw new Error("unexpected client operation"); },
};

test("runtime reads the fixed LICENSE mtime in milliseconds", async t => {
  const root = await temporaryRoot(t);
  const license = path.join(root, "LICENSE");
  const licenseModifiedAt = Date.parse("2025-06-07T08:09:10.000Z");
  await writeFile(license, "fixture");
  await utimes(license, new Date(licenseModifiedAt), new Date(licenseModifiedAt));

  assert.deepEqual(await readApplicationInfo(root), {licenseModifiedAt});
});

test("runtime omits LICENSE metadata when the fixed path is absent or cannot be statted", async t => {
  const root = await temporaryRoot(t);
  assert.deepEqual(await readApplicationInfo(root), {});

  const notDirectory = path.join(root, "not-a-directory");
  await writeFile(notDirectory, "fixture");
  assert.deepEqual(await readApplicationInfo(notDirectory), {});
});

test("host exposes an immutable application metadata snapshot to every plugin", async t => {
  const root = await temporaryRoot(t);
  const supplied = {licenseModifiedAt: 1_700_000_000_123};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram, application: supplied});
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); });
  supplied.licenseModifiedAt = 9;
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "fixture", description: "fixture", commands: {},
    setup(value) { context = value; }}));

  assert.deepEqual(context.application, {licenseModifiedAt: 1_700_000_000_123});
  assert.equal(Object.isFrozen(context.application), true);
  assert.throws(() => { (context.application as {licenseModifiedAt: number}).licenseModifiedAt = 10; }, TypeError);
});

test("host supplies a frozen empty application snapshot by default", async t => {
  const root = await temporaryRoot(t);
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram});
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); });
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "fixture", description: "fixture", commands: {},
    setup(value) { context = value; }}));

  assert.deepEqual(context.application, {});
  assert.equal(Object.isFrozen(context.application), true);
});
