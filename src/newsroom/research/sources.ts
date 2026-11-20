import type { Evidence, Source } from "./types";

export function groupSources(sources: Source[]) {
  const parents = sources.map((_, index) => index);
  const seen = new Map<string, number>();

  function root(index: number): number {
    while (parents[index] !== index) index = parents[index];
    return index;
  }

  for (const [index, source] of sources.entries()) {
    const keys = ["fingerprint:" + source.fingerprint];
    if (source.canonicalUrl) keys.push("url:" + source.canonicalUrl);
    if (source.origin) keys.push("origin:" + source.origin);
    for (const key of keys) {
      const previous = seen.get(key);
      if (previous === undefined) seen.set(key, index);
      else parents[root(index)] = root(previous);
    }
  }

  const groups = new Map<number, Source[]>();
  const byDocument = new Map<string, number>();
  for (const [index, source] of sources.entries()) {
    const group = root(index);
    const members = groups.get(group) ?? [];
    members.push(source);
    groups.set(group, members);
    byDocument.set(source.documentId, group);
  }
  const independent = new Set([...groups].filter(([, members]) => members.some(({ origin }) => origin)).map(([group]) => group));
  return {
    independentSourceCount: independent.size,
    duplicates: [...groups.values()].filter((members) => members.length > 1)
      .map((members) => ({ documentIds: members.map(({ documentId }) => documentId) })),
    count(records: Evidence[]) {
      const roots = records.map(({ documentId }) => byDocument.get(documentId));
      return new Set(roots.filter((group) => group !== undefined && independent.has(group))).size;
    },
  };
}

export function register(records: Evidence[]): string[] {
  return [...new Set(records.map(({ documentId }) => documentId))];
}
