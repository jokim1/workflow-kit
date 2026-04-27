export interface SurfaceBuckets {
  surfaces: Record<string, string[]>;
  other: string[];
}

interface NormalizedSurface {
  surface: string;
  exactFiles: Set<string>;
  dirPrefixes: string[];
}

// Map a surface map to a pre-normalized list used by matchSurfaceFast.
// Keys are pre-sorted alphabetically so iteration order is deterministic
// across Node versions. Each pattern is classified once, avoiding repeated
// string work for every changed file.
function buildNormalizedSurfaceMap(map: Record<string, string[]>): NormalizedSurface[] {
  const surfaces = Object.keys(map).sort();
  const seenExact = new Map<string, string>();
  const seenDir = new Map<string, string>();
  return surfaces.map((surface) => {
    const exactFiles = new Set<string>();
    const dirPrefixes: string[] = [];
    for (const rawPattern of map[surface] ?? []) {
      if (!rawPattern) continue;
      const pattern = toPosixPath(rawPattern);
      if (pattern.endsWith('/')) {
        assertUnambiguousPattern(seenDir, pattern, surface);
        dirPrefixes.push(pattern);
      } else {
        assertUnambiguousPattern(seenExact, pattern, surface);
        assertUnambiguousPattern(seenDir, `${pattern}/`, surface);
        exactFiles.add(pattern);
        dirPrefixes.push(`${pattern}/`);
      }
    }
    return { surface, exactFiles, dirPrefixes };
  });
}

function assertUnambiguousPattern(seen: Map<string, string>, pattern: string, surface: string): void {
  const existing = seen.get(pattern);
  if (existing && existing !== surface) {
    throw new Error(`Ambiguous surfacePathMap: ${pattern} is assigned to both ${existing} and ${surface}.`);
  }
  seen.set(pattern, surface);
}

export function bucketPathsBySurface(paths: string[], map: Record<string, string[]> = {}): SurfaceBuckets {
  const normalizedMap = buildNormalizedSurfaceMap(map);
  const surfaces: Record<string, string[]> = {};
  const other: string[] = [];

  for (const file of paths) {
    const normalizedFile = toPosixPath(file);
    const matched = matchSurfaceFast(normalizedFile, normalizedMap);
    if (matched) {
      if (!surfaces[matched]) surfaces[matched] = [];
      surfaces[matched].push(file);
    } else {
      other.push(file);
    }
  }

  for (const list of Object.values(surfaces)) list.sort();
  other.sort();
  return { surfaces, other };
}

function matchSurfaceFast(file: string, surfaces: NormalizedSurface[]): string | null {
  let best: { surface: string; specificity: number; exact: boolean } | null = null;
  for (const { surface, exactFiles, dirPrefixes } of surfaces) {
    if (exactFiles.has(file)) {
      best = chooseMoreSpecific(best, { surface, specificity: file.length, exact: true });
    }
    for (const prefix of dirPrefixes) {
      if (file.startsWith(prefix)) {
        best = chooseMoreSpecific(best, { surface, specificity: prefix.length, exact: false });
      }
    }
  }
  return best?.surface ?? null;
}

function chooseMoreSpecific(
  current: { surface: string; specificity: number; exact: boolean } | null,
  candidate: { surface: string; specificity: number; exact: boolean },
): { surface: string; specificity: number; exact: boolean } {
  if (!current) return candidate;
  if (candidate.specificity !== current.specificity) {
    return candidate.specificity > current.specificity ? candidate : current;
  }
  if (candidate.exact !== current.exact) {
    return candidate.exact ? candidate : current;
  }
  return candidate.surface < current.surface ? candidate : current;
}

function toPosixPath(file: string): string {
  return file.replace(/\\/g, '/');
}
