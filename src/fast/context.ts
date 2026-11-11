/** Factor repeated, runtime-owned context versions; stored tasks and artifacts stay unchanged. */
export class ContextVersionTable {
  private definitions: Record<string, string> = {};
  constructor(records: readonly object[], resolve: (name: string) => string | undefined) {
    const counts = new Map<string, number>(), versions = new Map<string, string | undefined>();
    for (const record of records) {
      const inputs = (record as { input_versions?: Record<string, unknown> }).input_versions;
      for (const [name, value] of Object.entries(inputs ?? {})) {
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) continue;
        if (!versions.has(name)) versions.set(name, resolve(name));
        if (versions.get(name) === value) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    this.definitions = Object.fromEntries([...counts].filter(([, count]) => count >= 3).map(([name]) => [name, versions.get(name)!]));
    if (Object.keys(this.definitions).length) {
      const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
      const before = records.reduce((total, record) => total + size(record), 0);
      const after = records.reduce((total, record) => total + size(this.compact(record)), 0) + Buffer.byteLength(this.instructions());
      if (after >= before) this.definitions = {};
    }
  }
  compact(record: object): Record<string, unknown> {
    const copy = structuredClone(record) as Record<string, unknown>;
    const inputs = copy.input_versions;
    if (inputs && typeof inputs === "object" && !Array.isArray(inputs)) {
      copy.input_versions = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name,
        typeof value === "string" && Object.hasOwn(this.definitions, name) && this.definitions[name] === value
          ? { context: name } : value]));
    }
    return copy;
  }
  values(): Record<string, string> { return { ...this.definitions }; }
  instructions(): string {
    return Object.keys(this.definitions).length
      ? `Shared context versions (in input_versions, {"context":"key"} denotes this exact version): ${JSON.stringify(this.definitions)}\n`
      : "";
  }
}

/** Exact expansion for auditing the wire representation; never interprets user prose or tool arguments. */
export function expandContextVersions(record: object, definitions: Record<string, string>): Record<string, unknown> {
  const copy = structuredClone(record) as Record<string, unknown>;
  const inputs = copy.input_versions;
  if (inputs && typeof inputs === "object" && !Array.isArray(inputs)) {
    copy.input_versions = Object.fromEntries(Object.entries(inputs).map(([name, value]) => {
      if (value && typeof value === "object" && Object.keys(value).length === 1 &&
          "context" in value && value.context === name && Object.hasOwn(definitions, name)) return [name, definitions[name]];
      return [name, value];
    }));
  }
  return copy;
}
