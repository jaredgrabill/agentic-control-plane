/** Type surface for the protocol breaking-change gate (scripts/schema-diff.mjs). */
export interface SchemaBundle {
  schemas: Record<string, unknown>;
  subjects: unknown;
}
export interface DiffFinding {
  path: string;
  msg: string;
}
export interface DiffResult {
  breaking: DiffFinding[];
  additive: DiffFinding[];
}
export function readCurrentBundle(schemasDir?: string): SchemaBundle;
export function diffBundles(baseBundle: SchemaBundle, curBundle: SchemaBundle): DiffResult;
