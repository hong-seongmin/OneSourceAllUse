import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { issue } from './errors.js';

const blockedV4Addresses = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) blockedV4Addresses.addSubnet(network, prefix, 'ipv4');
const blockedV6Addresses = new net.BlockList();
for (const [network, prefix] of [
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
]) blockedV6Addresses.addSubnet(network, prefix, 'ipv6');
blockedV6Addresses.addAddress('::', 'ipv6');
blockedV6Addresses.addAddress('::1', 'ipv6');

function unbracketedHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

const privateOrReserved = (address) => {
  const family = net.isIP(address);
  return family === 4
    ? blockedV4Addresses.check(address, 'ipv4')
    : family === 6 && blockedV6Addresses.check(address, 'ipv6');
};

async function resolveExternalTarget(input, { allowPrivateNetworks = false, resolver = lookup } = {}) {
  let url;
  try { url = new URL(input); } catch { throw issue('INVALID_URL', '유효한 HTTP 또는 HTTPS 주소를 입력하세요.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw issue('UNSAFE_URL', '인증정보를 포함하지 않는 HTTP 또는 HTTPS 주소만 사용할 수 있습니다.');
  if (!allowPrivateNetworks && url.port && !['80', '443'].includes(url.port)) throw issue('UNSAFE_URL', '표준 HTTP/HTTPS 포트만 사용할 수 있습니다.');
  const hostname = unbracketedHostname(url.hostname);
  if (!allowPrivateNetworks && (hostname === 'localhost' || hostname.endsWith('.local'))) throw issue('SSRF_BLOCKED', '내부 네트워크 주소에는 연결할 수 없습니다.');
  const resolved = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await resolver(hostname, { all: true, verbatim: true });
  const normalized = resolved.map(({ address, family }) => ({
    address,
    family: Number(family) || net.isIP(address)
  }));
  if (!normalized.length || normalized.some(({ address, family }) => !family || (family !== 4 && family !== 6) || (!allowPrivateNetworks && privateOrReserved(address)))) {
    throw issue('SSRF_BLOCKED', '내부 또는 예약된 네트워크 주소에는 연결할 수 없습니다.');
  }
  return { url, hostname, addresses: normalized };
}

export async function assertSafeExternalUrl(input, config = {}) {
  return (await resolveExternalTarget(input, config)).url;
}

export function assertCredentialedHttps(input, {
  environment = 'production',
  testMode = false,
  allowInsecureCredentialTransport = false
} = {}) {
  let url;
  try { url = new URL(input); } catch { throw issue('INVALID_URL', '유효한 HTTPS 주소를 입력하세요.'); }
  if (url.protocol === 'https:' && !url.username && !url.password) return url;
  if (url.protocol === 'http:'
    && !url.username
    && !url.password
    && environment === 'test'
    && testMode === true
    && allowInsecureCredentialTransport === true) {
    return url;
  }
  throw issue('CREDENTIAL_TRANSPORT_HTTPS_REQUIRED', '인증정보를 보내는 외부 endpoint는 HTTPS를 사용해야 합니다.', 422);
}

function remoteTimeout() {
  return issue('REMOTE_TIMEOUT', '원격 서비스 응답 시간이 초과되었습니다.', 504);
}

function beforeDeadline(promise, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(remoteTimeout());
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(remoteTimeout()), remaining);
    })
  ]).finally(() => clearTimeout(timer));
}

function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options?.all;
    if (all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

function responseHeaders(rawHeaders) {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headers.append(rawHeaders[index], rawHeaders[index + 1]);
  }
  return headers;
}

function requestPinned(target, options, { deadlineAt, maxBytes }) {
  return new Promise((resolve, reject) => {
    const address = target.addresses[0];
    const transport = target.url.protocol === 'https:' ? https : http;
    const suppliedHeaders = new Headers(options.headers || {});
    if (!suppliedHeaders.has('accept-encoding')) suppliedHeaders.set('accept-encoding', 'identity');
    let response;
    let timer;
    let settled = false;
    const signal = options.signal;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request.destroy();
      reject(error);
    };
    const abort = () => fail(signal?.reason instanceof Error
      ? signal.reason
      : issue('REMOTE_ABORTED', '원격 서비스 요청이 중단되었습니다.', 499));
    const request = transport.request(target.url, {
      method: options.method || 'GET',
      headers: Object.fromEntries(suppliedHeaders.entries()),
      agent: false,
      lookup: pinnedLookup(address.address, address.family),
      servername: net.isIP(target.hostname) ? undefined : target.hostname
    }, (incoming) => {
      response = incoming;
      const declaredLength = Number(incoming.headers['content-length'] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        fail(issue('RESPONSE_TOO_LARGE', '응답 크기가 허용 범위를 넘었습니다.'));
        return;
      }
      const chunks = [];
      let size = 0;
      incoming.on('data', (chunk) => {
        if (settled) return;
        const value = Buffer.from(chunk);
        size += value.byteLength;
        if (size > maxBytes) {
          fail(issue('RESPONSE_TOO_LARGE', '응답 크기가 허용 범위를 넘었습니다.'));
          return;
        }
        chunks.push(value);
      });
      incoming.on('aborted', () => fail(issue('REMOTE_RESPONSE_INCOMPLETE', '원격 서비스 응답이 완료되기 전에 중단되었습니다.', 502)));
      incoming.on('error', fail);
      incoming.on('end', () => {
        if (settled) return;
        const status = Number(incoming.statusCode);
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          fail(issue('REMOTE_RESPONSE_INVALID', '원격 서비스가 유효하지 않은 HTTP 응답을 반환했습니다.', 502));
          return;
        }
        settled = true;
        cleanup();
        const bodyAllowed = options.method !== 'HEAD' && ![204, 205, 304].includes(status);
        resolve(new Response(bodyAllowed ? Buffer.concat(chunks) : null, {
          status,
          statusText: incoming.statusMessage || '',
          headers: responseHeaders(incoming.rawHeaders)
        }));
      });
    });

    request.on('error', fail);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      fail(remoteTimeout());
      return;
    }
    timer = setTimeout(() => fail(remoteTimeout()), remaining);
    request.end(options.body);
  });
}

export async function safeFetch(input, options = {}, config = {}) {
  const configuredTimeout = Number(config.timeoutMs);
  const timeoutMs = Math.min(300_000, Math.max(1, Number.isFinite(configuredTimeout) ? configuredTimeout : 12_000));
  const configuredMaxBytes = Number(config.maxBytes);
  const maxBytes = Math.max(1, Number.isFinite(configuredMaxBytes) ? configuredMaxBytes : 2_000_000);
  const deadlineAt = Date.now() + timeoutMs;
  try {
    const target = await beforeDeadline(resolveExternalTarget(input, config), deadlineAt);
    return await requestPinned(target, options, { deadlineAt, maxBytes });
  } catch (error) {
    if (error.name === 'AbortError') throw issue('REMOTE_TIMEOUT', '원격 서비스 응답 시간이 초과되었습니다.', 504);
    throw error;
  }
}

export async function boundedText(response, maxBytes = 2_000_000, timeoutMs = 12_000) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let size = 0;
  let timer;
  const deadline = timeoutMs > 0 ? new Promise((_, reject) => {
    timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(issue('REMOTE_TIMEOUT', '원격 서비스 응답 시간이 초과되었습니다.', 504));
    }, timeoutMs);
  }) : null;
  try {
    while (true) {
      const { done, value } = await (deadline ? Promise.race([reader.read(), deadline]) : reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw issue('RESPONSE_TOO_LARGE', '응답 크기가 허용 범위를 넘었습니다.');
      chunks.push(value);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function redact(value) {
  return String(value ?? '')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key|token|password|secret)=([^&\s]+)/gi, '$1=[REDACTED]');
}

export function assertSameOrigin(request) {
  const origin = request.get('origin');
  const host = request.get('host');
  if (origin && host) {
    const parsed = new URL(origin);
    if (parsed.host !== host) throw issue('CSRF_ORIGIN_REJECTED', '다른 출처의 요청은 허용되지 않습니다.', 403);
  }
}
