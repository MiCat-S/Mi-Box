import test from "node:test";
import assert from "node:assert/strict";
import {Api} from "teleproto";
import {getIpPrivacy, installIpPrivacy, maskIpText, redactMessage, setIpPrivacy} from "./ip-privacy";
const defaults = {mode: "mask" as const, ipv4Segments: 2, ipv6Segments: 4};
test.afterEach(() => setIpPrivacy(defaults));
test("IPv4, IPv6, mapped IPv6, endpoints and punctuation are masked", () => {
  assert.equal(maskIpText("38.59.246.201 / eth0"), "38.59.*.* / eth0");
  assert.equal(maskIpText("IP 38.59.246.201."), "IP 38.59.*.*.");
  assert.equal(maskIpText("http://38.59.246.201:8080/"), "http://38.59.*.*:8080/");
  assert.equal(maskIpText("[2001:db8::1234]:443"), "[2001:db8:0:0:*:*:*:*]:443");
  assert.equal(maskIpText("::ffff:192.0.2.1"), "0:0:0:0:*:*:*:*");
  assert.equal(maskIpText("fe80::abcd%eth0"), "fe80:0:0:0:*:*:*:*");
  assert.equal(maskIpText("v1.2.3 / 999.1.2.3 / 12:34:56"), "v1.2.3 / 999.1.2.3 / 12:34:56");
});
test("configurable segment counts and hiding preserve no full address", () => {
  setIpPrivacy({...defaults, ipv4Segments: 1, ipv6Segments: 8});
  assert.equal(maskIpText("38.59.246.201"), "38.59.246.*");
  assert.equal(maskIpText("::1"), "*:*:*:*:*:*:*:*");
  setIpPrivacy({...defaults, mode: "hide"});
  assert.equal(maskIpText("38.59.246.201 ::1"), "[IP已隐藏] [IP已隐藏]");
  assert.throws(() => setIpPrivacy({...defaults, ipv4Segments: 0}));
  assert.equal(getIpPrivacy().mode, "hide");
});
test("redaction maps UTF16 entities and strips secret hyperlink targets without mutating originals", () => {
  const message = "😀 38.59.246.201 tail";
  const request = new Api.messages.SendMessage({peer: new Api.InputPeerSelf(), message,
    entities: [new Api.MessageEntityBold({offset: 3, length: 13}), new Api.MessageEntityItalic({offset: 17, length: 4}),
      new Api.MessageEntityTextUrl({offset: 17, length: 4, url: "https://38.59.246.201"})]});
  const output = redactMessage(request);
  assert.equal(output.message, "😀 38.59.*.* tail");
  assert.deepEqual(output.entities!.map(e => [e.offset, e.length]), [[3, 9], [13, 4]]);
  assert.equal(request.message, message);
  assert.equal(request.entities!.length, 3);
  assert.ok(output instanceof Api.messages.SendMessage);
});
test("final RPC boundary protects text, captions, albums and edit calls and restores client", async () => {
  const requests: unknown[] = [];
  const client = {async invoke(request: unknown) {requests.push(request); return true;}};
  const original = client.invoke;
  const cleanup = installIpPrivacy(client);
  const caption = "address 38.59.246.201";
  for (const Type of [Api.messages.SendMessage, Api.messages.SendMedia, Api.messages.EditMessage, Api.messages.EditInlineBotMessage]) {
    await client.invoke(new Type({message: caption} as never));
    assert.equal((requests.at(-1) as {message: string}).message, "address 38.59.*.*");
  }
  const album = new Api.messages.SendMultiMedia({multiMedia: [new Api.InputSingleMedia({message: caption} as never)]} as never);
  await client.invoke(album);
  assert.equal((requests.at(-1) as typeof album).multiMedia[0].message, "address 38.59.*.*");
  const lookup = new Api.help.GetConfig();
  await client.invoke(lookup); assert.equal(requests.at(-1), lookup);
  cleanup(); assert.equal(client.invoke, original);
});

test("encoded IP hyperlinks and integer IPv4 URL hosts cannot bypass hiding", () => {
  const source = {message: "link", entities: [{offset: 0, length: 4, url: "http://%33%38.59.246.201"}, {offset: 0, length: 4, url: "http://127001"}]};
  assert.deepEqual(redactMessage(source).entities, []);
});

test("wire serialization, attachment names and button links carry only redacted values", async () => {
  let sent: any;
  const client = {async invoke(request: unknown) {sent = request;}};
  const cleanup = installIpPrivacy(client);
  try {
    const request = new Api.messages.SendMessage({peer: new Api.InputPeerSelf(), randomId: 1 as never, message: "38.59.246.201"});
    await client.invoke(request);
    assert.doesNotMatch(sent.getBytes().toString("utf8"), /38\.59\.246\.201/);
    assert.match(sent.getBytes().toString("utf8"), /38\.59\.\*\.\*/);
    await client.invoke({className: "messages.SendMedia", message: "38.59.246.201", media: {
      file: {name: "38.59.246.201.txt"}, attributes: [{className: "DocumentAttributeFilename", fileName: "38.59.246.201.txt"}],
    }, replyMarkup: {rows: [{buttons: [{text: "38.59.246.201"}, {text: "open", type: {url: "https://38.59.246.201"}}]}]}});
    assert.equal(sent.media.file.name, "38.59.*.*.txt");
    assert.equal(sent.media.attributes[0].fileName, "38.59.*.*.txt");
    assert.equal(sent.replyMarkup.rows[0].buttons.length, 1);
    assert.equal(sent.replyMarkup.rows[0].buttons[0].text, "38.59.*.*");
    assert.throws(() => installIpPrivacy(client), /ALREADY_INSTALLED/);
  } finally {cleanup();}
});
