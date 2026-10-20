// A signed software authenticator for server-policy tests. Not a browser/provider PRF test.
import crypto from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
const hash = (x) => crypto.createHash("sha256").update(x).digest();
const encode = (x) => Buffer.from(isoCBOR.encode(x));
const json = (x) => Buffer.from(JSON.stringify(x));
export function authenticator(origin) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }), id = crypto.randomBytes(32), rp = new URL(origin).hostname;
  const cose = encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  let counter = 0, userHandle;
  const common = () => ({ id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key", clientExtensionResults: {} });
  return {
    id: id.toString("base64url"),
    register(options) {
      userHandle = options.user.id;
      const client = json({ type: "webauthn.create", challenge: options.challenge, origin });
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const data = Buffer.concat([hash(rp), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, cose]);
      const attestation = encode(new Map([["fmt", "none"], ["authData", data], ["attStmt", new Map()]]));
      return { ...common(), response: { clientDataJSON: client.toString("base64url"), attestationObject: attestation.toString("base64url"), transports: ["internal"] } };
    },
    assert(options, { uv = true, atOrigin = origin } = {}) {
      const client = json({ type: "webauthn.get", challenge: options.challenge, origin: atOrigin });
      const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
      const data = Buffer.concat([hash(rp), Buffer.from([uv ? 5 : 1]), count]);
      const signature = crypto.sign("sha256", Buffer.concat([data, hash(client)]), privateKey);
      return { ...common(), response: { clientDataJSON: client.toString("base64url"), authenticatorData: data.toString("base64url"), signature: signature.toString("base64url"), userHandle } };
    },
  };
}
export async function enroll(browser, device) {
  const r = await browser.call("/api/account/passkeys/options", { method: "POST", body: {} });
  if (r.status !== 200) throw new Error(`Enrollment options: ${r.status} ${JSON.stringify(r.data)}`);
  return browser.call("/api/account/passkeys/verify", { method: "POST", body: { flow: r.data.flow, response: device.register(r.data.options) } });
}
export async function approve(browser, device, assertionOptions = {}) {
  const r = await browser.call("/api/account/device/options", { method: "POST", body: {} });
  if (r.status !== 200) throw new Error(`Device options: ${r.status} ${JSON.stringify(r.data)}`);
  return browser.call("/api/account/device/verify", { method: "POST", body: { flow: r.data.flow, response: device.assert(r.data.options, assertionOptions) } });
}
