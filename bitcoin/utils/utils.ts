export function idToHash(txid: string): Buffer {
  return Buffer.from(txid, "hex").reverse();
}
export function parseFeeFromError(error: string): number {
  return Number(error.slice(error.indexOf("<") + 2).split('"')[0]);
}
