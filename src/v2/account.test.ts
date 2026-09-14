import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {parseAccount, readAccount, readEnvironment, lockAccount, findFlock, assertRuntimePlatform} from "./account";

test("account mapping retains existing session, app name and SOCKS settings", () => {
  const config = parseAccount({api_id: 123, api_hash: "private", session: "existing", app_name: "TeleBox",
    unknown: {future: true}, proxy: {socksType: 5, ip: "localhost", port: 1080, username: "name", password: "private"}});
  assert.equal(config.apiId, 123);
  assert.equal(config.deviceModel, "TeleBox");
  assert.equal(config.session, "existing");
  assert.equal(config.proxy?.timeout, 10);
});

test("invalid account inputs fail with fixed diagnostics", () => {
  for (const value of [null, [], {}, {api_id: 1, api_hash: "secret", session: ""},
    {api_id: 1, api_hash: "secret", session: "secret", proxy: {ip: "secret"}}]) {
    assert.throws(() => parseAccount(value), /^Error: Account startup failed: CONFIG$/);
  }
});

test("default app name is Mi Box while explicit names remain unchanged", () => {
  assert.equal(parseAccount({api_id: 123, api_hash: "private", session: "existing"}).deviceModel, "Mi Box");
});

test("reading configuration and dotenv does not rewrite private data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-account-"));
  try {
    const content = '{"api_id":1,"api_hash":"private","session":"existing","unknown":9007199254740993}\n';
    await fs.writeFile(path.join(root, "config.json"), content);
    await fs.writeFile(path.join(root, ".env"), 'TB_PREFIX="!"\nNODE_ENV=production\n');
    assert.equal((await readAccount(root)).session, "existing");
    assert.deepEqual(await readEnvironment(root, {TB_PREFIX: ".", UNSET: undefined}), {TB_PREFIX: ".", NODE_ENV: "production"});
    assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), content);
    await fs.unlink(path.join(root, "config.json"));
    await fs.symlink(path.join(root, ".env"), path.join(root, "config.json"));
    await assert.rejects(readAccount(root), /CONFIG/);
  } finally {await fs.rm(root, {recursive: true, force: true});}
});

test("kernel lock excludes competing open descriptions and releases on close", {skip: !["linux", "darwin"].includes(process.platform)}, async t => {
  if (process.platform === "darwin") {
    const previous = process.env.NODE_ENV;
    t.after(() => {if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;});
    process.env.NODE_ENV = "development";
    try {await findFlock();} catch (error) {
      if (error instanceof Error && "code" in error && error.code === "FLOCK_NOT_FOUND") return t.skip("Install flock to verify macOS kernel locking");
      throw error;
    }
  }
  const key = randomBytes(256);
  const close = await lockAccount(key);
  try {await assert.rejects(lockAccount(key), /BUSY/);} finally {await close();}
  const closeAgain = await lockAccount(key);
  await closeAgain();
  await closeAgain();
});

test("kernel account lock remains exclusive across processes and releases after SIGKILL", {
  skip: !["linux", "darwin"].includes(process.platform), timeout: 10_000,
}, async t => {
  const previous = process.env.NODE_ENV;
  t.after(() => {if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;});
  if (process.platform === "darwin") {
    process.env.NODE_ENV = "development";
    try {await findFlock();} catch (error) {
      if (error instanceof Error && "code" in error && error.code === "FLOCK_NOT_FOUND") return t.skip("Install flock to verify macOS kernel locking");
      throw error;
    }
  }
  const key = randomBytes(256);
  const child = spawn(process.execPath, ["-e", `
    const {lockAccount} = require(${JSON.stringify(path.join(__dirname, "account.js"))});
    lockAccount(Buffer.from(${JSON.stringify(key.toString("hex"))}, "hex")).then(() => {
      process.send("locked");
      setInterval(() => {}, 1000);
    }).catch(() => process.exit(1));
  `], {env: {...process.env}, stdio: ["ignore", "ignore", "ignore", "ipc"]});
  const exit = once(child, "exit");
  t.after(async () => {if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit;});
  await Promise.race([once(child, "message"), exit.then(() => {throw new Error("Lock holder exited before readiness");})]);
  await assert.rejects(lockAccount(key), /BUSY/);
  child.kill("SIGKILL");
  await exit;
  const release = await lockAccount(key);
  await release();
});

test("flock lookup finds an executable in an absolute PATH entry without a shell", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "flock path $()-"));
  const previous = process.env.PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    await fs.rm(directory, {recursive: true, force: true});
  });
  const file = path.join(directory, "flock");
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", {mode: 0o700});
  process.env.PATH = directory;
  const nativeFs = require("node:fs/promises") as typeof fs;
  const access = nativeFs.access;
  t.mock.method(nativeFs, "access", async (candidate: string, mode: number) => {
    if (candidate === "/usr/bin/flock" || candidate === "/bin/flock") throw Object.assign(new Error("missing"), {code: "ENOENT"});
    return access(candidate, mode);
  });
  assert.equal(await findFlock(), file);
  const child = require("node:child_process");
  let invocation: {command: string; args: string[]; options: {shell: boolean; stdio: unknown[]}} | undefined;
  t.mock.method(child, "spawnSync", (command: string, args: string[], options: {shell: boolean; stdio: unknown[]}) => {
    invocation = {command, args, options};
    return {status: 0};
  });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  t.after(() => Object.defineProperty(process, "platform", platform));
  Object.defineProperty(process, "platform", {...platform, value: "linux"});
  const release = await lockAccount(randomBytes(256));
  await release();
  assert.equal(invocation?.command, file);
  assert.deepEqual(invocation?.args, ["--nonblock", "3"]);
  assert.equal(invocation?.options.shell, false);
  assert.equal(typeof invocation?.options.stdio[3], "number");
});

test("missing flock rejects explicitly and relative PATH entries are never executable candidates", async t => {
  const previous = process.env.PATH;
  t.after(() => {if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;});
  process.env.PATH = `.:relative:${path.delimiter}`;
  const checked: string[] = [];
  t.mock.method(require("node:fs/promises"), "access", async (candidate: string) => {
    checked.push(candidate);
    throw Object.assign(new Error("private-path"), {code: "ENOENT"});
  });
  await assert.rejects(findFlock(), /FLOCK_NOT_FOUND.*install util-linux/);
  assert.ok(checked.length > 0 && checked.every(candidate => path.isAbsolute(candidate)));
  assert.equal(checked.some(candidate => candidate.includes("relative")), false);
});

test("platform policy accepts Linux and explicit macOS development only", t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previous = process.env.NODE_ENV;
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  });
  for (const platform of ["linux", "darwin", "win32"]) {
    Object.defineProperty(process, "platform", {...descriptor, value: platform});
    for (const environment of ["production", "development", "test"]) {
      process.env.NODE_ENV = environment;
      if (platform === "linux" || (platform === "darwin" && environment === "development")) {
        assert.doesNotThrow(assertRuntimePlatform);
      } else assert.throws(assertRuntimePlatform, /PLATFORM/);
    }
  }
});
