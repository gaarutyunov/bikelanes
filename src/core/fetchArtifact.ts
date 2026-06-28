// Browser-only artifact fetch with optional gzip inflation via DecompressionStream
// (SPEC §8: graph.bin / coords.bin may ship as .gz and be inflated client-side).

export async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  if (url.endsWith('.gz') && typeof DecompressionStream !== 'undefined' && res.body) {
    const ds = new DecompressionStream('gzip');
    const stream = res.body.pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }
  return await res.arrayBuffer();
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return (await res.json()) as T;
}
