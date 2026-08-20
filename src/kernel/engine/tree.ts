function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return map(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, map));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = mapStrings(nested, map);
    }
    return out;
  }
  return value;
}

export { mapStrings };
