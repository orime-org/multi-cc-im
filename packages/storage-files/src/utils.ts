/** True iff `err` is a Node fs error indicating the target does not exist. */
export function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
