const CANONICAL_ORIGIN = 'https://positioncrew.dolepee.com';
const GATEWAY_PREFIX = 'x-positioncrew-gateway-';
const GATEWAY_HEADERS = [
  'x-positioncrew-gateway-timestamp',
  'x-positioncrew-gateway-client-ip',
  'x-positioncrew-gateway-body-sha256',
  'x-positioncrew-gateway-signature',
] as const;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 32_768;

export class TrustedGatewayRequestError extends Error {
  constructor(message = 'Invalid trusted gateway request.') {
    super(message);
    this.name = 'TrustedGatewayRequestError';
  }
}

function isIpv4(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => (
    /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255
  ));
}

function isIpLiteral(value: string): boolean {
  if (!value.includes(':')) return isIpv4(value);
  if (value.length > 45) return false;
  let address = value;
  if (address.includes('.')) {
    const boundary = address.lastIndexOf(':');
    if (!isIpv4(address.slice(boundary + 1))) return false;
    address = `${address.slice(0, boundary + 1)}0:0`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => half === '' ? [] : half.split(':'));
  if (groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function boundedBodySha256(request: Request): Promise<string> {
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const body = request.clone().body;
    if (body) {
      reader = body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value.byteLength > MAX_BODY_BYTES - size) {
          throw new TrustedGatewayRequestError('Trusted gateway request body exceeds the allowed size.');
        }
        bytes.set(next.value, size);
        size += next.value.byteLength;
      }
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes.subarray(0, size));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    // A cloned stream is a tee. Awaiting cancellation can wait for its unread
    // original branch indefinitely; observe rejection without blocking refusal.
    if (reader) void reader.cancel().catch(() => undefined);
    if (error instanceof TrustedGatewayRequestError) throw error;
    throw new TrustedGatewayRequestError('Trusted gateway request body could not be verified.');
  } finally {
    reader?.releaseLock();
  }
}

/** Authenticate the gateway envelope before trusting its original client IP. */
export async function verifyTrustedGatewayRequest(
  request: Request,
  secret: string | undefined,
  nowMs = Date.now(),
): Promise<Request> {
  const gatewayNames: string[] = [];
  request.headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith(GATEWAY_PREFIX)) gatewayNames.push(name.toLowerCase());
  });
  if (gatewayNames.length === 0) return request;

  try {
    if (!secret || !LOWERCASE_SHA256.test(secret)) {
      throw new TrustedGatewayRequestError('Trusted gateway authentication is unavailable.');
    }
    if (gatewayNames.length !== GATEWAY_HEADERS.length
      || gatewayNames.some((name) => !GATEWAY_HEADERS.some((allowed) => name === allowed))) {
      throw new TrustedGatewayRequestError('Invalid trusted gateway envelope.');
    }
    const timestamp = request.headers.get(GATEWAY_HEADERS[0]);
    const clientIp = request.headers.get(GATEWAY_HEADERS[1]);
    const bodySha256 = request.headers.get(GATEWAY_HEADERS[2]);
    const signature = request.headers.get(GATEWAY_HEADERS[3]);
    // Headers joins duplicate values with a comma; each strict field grammar
    // rejects that representation rather than silently choosing a value.
    if (timestamp === null || !/^(?:0|[1-9][0-9]{0,15})$/.test(timestamp)
      || clientIp === null || !isIpLiteral(clientIp)
      || bodySha256 === null || !LOWERCASE_SHA256.test(bodySha256)
      || signature === null || !LOWERCASE_SHA256.test(signature)) {
      throw new TrustedGatewayRequestError('Invalid trusted gateway envelope.');
    }
    const timestampMs = Number(timestamp) * 1_000;
    if (!Number.isSafeInteger(timestampMs) || !Number.isFinite(nowMs)
      || nowMs - timestampMs > 60_000 || timestampMs - nowMs > 5_000) {
      throw new TrustedGatewayRequestError('Trusted gateway request timestamp is outside the allowed window.');
    }
    const url = new URL(request.url);
    const pathAndQuery = url.pathname + url.search;
    const payload = JSON.stringify([
      'positioncrew.gateway.v1',
      CANONICAL_ORIGIN,
      timestamp,
      clientIp,
      request.method.toUpperCase(),
      pathAndQuery,
      bodySha256,
      request.headers.get('Origin') ?? '',
      request.headers.get('Authorization') ?? '',
      request.headers.get('Idempotency-Key') ?? '',
    ]);
    // The configured 64-character hex string is the UTF-8 HMAC key. It is not
    // decoded into the 32 bytes whose hexadecimal representation it contains.
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const validMac = await crypto.subtle.verify(
      'HMAC', key, hexBytes(signature), encoder.encode(payload),
    );
    if (!validMac) throw new TrustedGatewayRequestError('Trusted gateway authentication failed.');

    // Do not clone or consume the untrusted body until the envelope MAC passes.
    if (await boundedBodySha256(request) !== bodySha256) {
      throw new TrustedGatewayRequestError('Trusted gateway request body does not match its commitment.');
    }

    const sanitized = new Request(`${CANONICAL_ORIGIN}${pathAndQuery}`, request);
    const remove: string[] = [];
    sanitized.headers.forEach((_value, name) => {
      const lower = name.toLowerCase();
      if (lower.startsWith(GATEWAY_PREFIX) || lower === 'forwarded'
        || lower.startsWith('x-forwarded-') || lower === 'x-real-ip'
        || lower === 'true-client-ip' || lower === 'cf-connecting-ipv6') remove.push(name);
    });
    for (const name of remove) sanitized.headers.delete(name);
    sanitized.headers.set('CF-Connecting-IP', clientIp);
    sanitized.headers.set('Host', 'positioncrew.dolepee.com');
    return sanitized;
  } catch (error) {
    if (error instanceof TrustedGatewayRequestError) throw error;
    throw new TrustedGatewayRequestError();
  }
}
