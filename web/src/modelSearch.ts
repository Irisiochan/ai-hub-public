export interface SearchableModel {
  id: string;
  label: string;
  description?: string;
}

export function filterModelOptions<T extends SearchableModel>(options: T[], query: string): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return options;
  return options.filter((option) => {
    const haystack = `${option.id} ${option.label} ${option.description ?? ''}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export function visibleModelOptions<T extends SearchableModel>(
  options: T[],
  query: string,
  limits: { preview?: number; match?: number } = {},
): { items: T[]; hidden: number; total: number } {
  const filtered = filterModelOptions(options, query);
  const cap = query.trim() ? (limits.match ?? 200) : (limits.preview ?? 80);
  return {
    items: filtered.slice(0, cap),
    hidden: Math.max(filtered.length - cap, 0),
    total: filtered.length,
  };
}
