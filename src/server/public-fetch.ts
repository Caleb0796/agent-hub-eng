import { lookup } from 'node:dns';
import { Agent, fetch as httpFetch } from 'undici';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function metadataUrl(input: string | URL | Request): URL {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !(
      url.hostname === 'chatgpt.com' ||
      url.hostname === 'muse.ai' ||
      url.hostname.endsWith('.muse.ai')
    )
  )
    throw new Error('OAuth metadata host is not approved');
  return url;
}

// Validate the addresses used by the actual socket lookup, not an earlier DNS check.
// Reject mixed public/private answers, IPv4-mapped private IPv6, and redirect hops.
const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, '', 4);
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
          return callback(new Error('OAuth metadata resolved to a non-public address'), '', 4);
        const eligible = options.family
          ? addresses.filter((x) => x.family === options.family)
          : addresses;
        if (!eligible.length) return callback(new Error('No address for requested family'), '', 4);
        if (options.all) callback(null, eligible);
        else callback(null, eligible[0].address, eligible[0].family);
      });
    },
  },
});

// This is a lexical adapter for the pinned library's runtime capability probe,
// paired with the fetch export below by both bundlers. It does not set a global
// or claim that Node is Workers: the Node socket/DNS policy supplies the guarantee.
export const Cloudflare = Object.freeze({
  compatibilityFlags: Object.freeze({ global_fetch_strictly_public: true }),
});

/** Lexically injected only into the server bundle; database requests use their own SDK. */
export async function fetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const url = metadataUrl(input);
  if (init.method && init.method !== 'GET') throw new Error('OAuth metadata requires GET');
  const response = await httpFetch(url, {
    method: 'GET',
    headers: Object.fromEntries(new globalThis.Headers(init.headers)),
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(4000)])
      : AbortSignal.timeout(4000),
    redirect: 'error',
    dispatcher,
  });
  return new Response(response.body as unknown as ReadableStream, {
    status: response.status,
    headers: Object.fromEntries(response.headers),
  });
}
