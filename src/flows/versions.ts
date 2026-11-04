// Flow packs use three numeric components; BigInt preserves authored versions
// beyond JavaScript's safe integer range.
export const isFlowVersion = (version: string) => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version);
export function compareFlowVersions(a: string, b: string) {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i]! > right[i]!) return 1;
    if (left[i]! < right[i]!) return -1;
  }
  return 0;
}
export function nextFlowPatch(version: string) {
  const parts = version.split('.');
  return `${parts[0]}.${parts[1]}.${BigInt(parts[2]!) + 1n}`;
}
