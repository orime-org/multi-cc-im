/**
 * Mask a secret value for inline default-display per
 * [DD §9.D4](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#9d4).
 *
 * Formula: 16 asterisks + last 4 characters of the input. Mirrors AWS
 * CLI's [`aws-cli/customizations/configure/__init__.py:38`](https://github.com/aws/aws-cli/blob/main/awscli/customizations/configure/__init__.py)
 * so users coming from `aws configure` recognize the convention.
 *
 * Edge cases:
 * - Empty / `< 4` characters → 16 asterisks only. Last_4 of a 3-char
 *   secret is the whole secret, defeating the mask.
 * - JS string `.length` counts UTF-16 code units; surrogate pairs may
 *   leave a half-character before the suffix. Real Feishu tokens are
 *   ASCII so this is non-issue in practice.
 *
 * @param value Secret string to mask.
 * @returns Masked representation suitable for showing as a wizard
 *          placeholder / default-display.
 */
export function maskSecret(value: string): string {
  const ASTERISKS = '*'.repeat(16);
  if (value.length < 4) return ASTERISKS;
  return ASTERISKS + value.slice(-4);
}
