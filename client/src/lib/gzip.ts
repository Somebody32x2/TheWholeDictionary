/**
 * gzip via the platform's DecompressionStream/CompressionStream.
 *
 * Everything on the wire and everything in Cache Storage stays compressed: the
 * corpus is served as opaque `.gz` bytes with no `Content-Encoding`, so the
 * browser never inflates it behind our back and a cached shard occupies its
 * compressed size. That is the difference between a ~4.5 MB and a ~15 MB
 * ceiling for 128 cached shards.
 */

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
