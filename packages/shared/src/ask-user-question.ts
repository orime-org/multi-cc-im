import { z } from 'zod';

/**
 * Schemas for cc's built-in `AskUserQuestion` tool.
 *
 * Two schemas live here:
 *
 * 1. `AskUserQuestionToolInputSchema` — the shape cc puts in `tool_input`
 *    when it fires the `PreToolUse` hook. Sourced from the official
 *    [Agent SDK user-input docs](https://code.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions).
 *    `questions[].options[].preview` is the optional TS-SDK preview field;
 *    we accept it but do not consume it (multi-cc-im IM rendering uses
 *    label + description only).
 *
 * 2. `AskUserQuestionAnswerSchema` — the structured output the AI router
 *    produces when triaging an IM reply to a pending AUQ prompt. The
 *    daemon then looks up
 *    `toolInput.questions[questionIndex].options[optionIndex - 1].label`
 *    to assemble the `answers` map that gets written into
 *    `updatedInput.answers` per [DD §9](../../../../docs/superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md#9-revision-d5-retracted--allow--updatedinputanswers-is-the-correct-channel).
 *    `optionIndex` is **1-based** to match the numbered IM rendering
 *    users see (`1. Summary`, `2. Detailed`, ...) — daemon converts to
 *    0-based when indexing `options[]`.
 */

const AskUserQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
  /**
   * Optional preview field set by the TypeScript Agent SDK when
   * `toolConfig.askUserQuestion.previewFormat` is configured. Carries
   * markdown or HTML for visual comparison. multi-cc-im does not render
   * previews in IM; we accept the field so zod parsing doesn't fail when
   * cc forwards an SDK-generated tool_input with previews attached.
   */
  preview: z.string().optional(),
});

const AskUserQuestionItemSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  options: z.array(AskUserQuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean(),
});

export const AskUserQuestionToolInputSchema = z.object({
  questions: z.array(AskUserQuestionItemSchema).min(1).max(4),
});

export type AskUserQuestionToolInput = z.infer<
  typeof AskUserQuestionToolInputSchema
>;
export type AskUserQuestionItem = z.infer<typeof AskUserQuestionItemSchema>;
export type AskUserQuestionOption = z.infer<typeof AskUserQuestionOptionSchema>;

const AskUserQuestionOptionAnswerSchema = z.object({
  questionIndex: z.number().int().nonnegative(),
  kind: z.literal('option'),
  /**
   * 1-based option index OR array of 1-based indices for multi-select.
   * Daemon decrements before indexing `options[]`.
   */
  optionIndex: z.union([
    z.number().int().min(1),
    z.array(z.number().int().min(1)).min(1),
  ]),
});

const AskUserQuestionTextAnswerSchema = z.object({
  questionIndex: z.number().int().nonnegative(),
  kind: z.literal('text'),
  /**
   * Free-text answer. The daemon writes this verbatim into
   * `updatedInput.answers[question.question]`. Empty string is reserved
   * for the hook-side timeout fallback (no IM reply within 110s).
   */
  text: z.string(),
});

export const AskUserQuestionAnswerSchema = z.object({
  answers: z
    .array(
      z.discriminatedUnion('kind', [
        AskUserQuestionOptionAnswerSchema,
        AskUserQuestionTextAnswerSchema,
      ]),
    )
    .min(1),
});

export type AskUserQuestionAnswer = z.infer<typeof AskUserQuestionAnswerSchema>;
export type AskUserQuestionAnswerEntry = AskUserQuestionAnswer['answers'][number];

/**
 * AI envelope output schema for the AskUserQuestion-mode triage call.
 * Carries the matched `target` tab + the per-question `answers` array
 * (from `AskUserQuestionAnswerSchema`) + an optional `reason` trace.
 * Defined here (not in bridge) so the bridge package can stay zod-free
 * at the dependency level.
 */
export const AskUserQuestionAIOutputSchema = z.object({
  target: z.string().min(1),
  reason: z.string().nullable().optional(),
  answers: AskUserQuestionAnswerSchema.shape.answers,
});

export type AskUserQuestionAIOutput = z.infer<
  typeof AskUserQuestionAIOutputSchema
>;
