import { describe, it, expect } from 'vitest';
import {
  AskUserQuestionToolInputSchema,
  AskUserQuestionAnswerSchema,
} from '../ask-user-question.js';

describe('AskUserQuestionToolInputSchema', () => {
  it('accepts a single-question single-select input', () => {
    const input = {
      questions: [
        {
          question: 'How should I format the output?',
          header: 'Format',
          options: [
            { label: 'Summary', description: 'Brief overview' },
            { label: 'Detailed', description: 'Full explanation' },
          ],
          multiSelect: false,
        },
      ],
    };
    const parsed = AskUserQuestionToolInputSchema.parse(input);
    expect(parsed.questions[0]!.options).toHaveLength(2);
  });

  it('accepts multiple questions per call', () => {
    const input = {
      questions: [
        {
          question: 'A?',
          header: 'A',
          options: [
            { label: 'a1', description: 'd1' },
            { label: 'a2', description: 'd2' },
          ],
          multiSelect: false,
        },
        {
          question: 'B?',
          header: 'B',
          options: [
            { label: 'b1', description: 'd1' },
            { label: 'b2', description: 'd2' },
            { label: 'b3', description: 'd3' },
          ],
          multiSelect: true,
        },
      ],
    };
    expect(AskUserQuestionToolInputSchema.parse(input).questions).toHaveLength(2);
  });

  it('accepts an optional preview field on each option (TypeScript SDK preview)', () => {
    const input = {
      questions: [
        {
          question: 'Layout?',
          header: 'Layout',
          options: [
            { label: 'A', description: 'd', preview: '<div>html</div>' },
            { label: 'B', description: 'd' },
          ],
          multiSelect: false,
        },
      ],
    };
    expect(() => AskUserQuestionToolInputSchema.parse(input)).not.toThrow();
  });

  it('rejects empty questions array (cc spec: 1-4 questions per call)', () => {
    const input = { questions: [] };
    expect(AskUserQuestionToolInputSchema.safeParse(input).success).toBe(false);
  });

  it('rejects an option without a label', () => {
    const input = {
      questions: [
        {
          question: 'X?',
          header: 'X',
          options: [{ description: 'no label here' }],
          multiSelect: false,
        },
      ],
    };
    expect(AskUserQuestionToolInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('AskUserQuestionAnswerSchema', () => {
  it('accepts a single-question option answer (1-based optionIndex)', () => {
    const ans = {
      answers: [{ questionIndex: 0, kind: 'option', optionIndex: 1 }],
    };
    const parsed = AskUserQuestionAnswerSchema.parse(ans);
    expect(parsed.answers[0]).toEqual({
      questionIndex: 0,
      kind: 'option',
      optionIndex: 1,
    });
  });

  it('accepts multi-select option (optionIndex as array)', () => {
    const ans = {
      answers: [{ questionIndex: 0, kind: 'option', optionIndex: [1, 3] }],
    };
    expect(AskUserQuestionAnswerSchema.parse(ans).answers[0]).toEqual({
      questionIndex: 0,
      kind: 'option',
      optionIndex: [1, 3],
    });
  });

  it('accepts free-text answer for a question', () => {
    const ans = {
      answers: [
        { questionIndex: 1, kind: 'text', text: 'use TypeScript with strict mode' },
      ],
    };
    const parsed = AskUserQuestionAnswerSchema.parse(ans);
    expect(parsed.answers[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('TypeScript') });
  });

  it('rejects negative questionIndex', () => {
    const ans = {
      answers: [{ questionIndex: -1, kind: 'option', optionIndex: 1 }],
    };
    expect(AskUserQuestionAnswerSchema.safeParse(ans).success).toBe(false);
  });

  it('rejects optionIndex of 0 (must be 1-based)', () => {
    const ans = {
      answers: [{ questionIndex: 0, kind: 'option', optionIndex: 0 }],
    };
    expect(AskUserQuestionAnswerSchema.safeParse(ans).success).toBe(false);
  });

  it('rejects empty answers array', () => {
    expect(AskUserQuestionAnswerSchema.safeParse({ answers: [] }).success).toBe(
      false,
    );
  });

  it('rejects an answer entry that omits both optionIndex and text', () => {
    const ans = {
      answers: [{ questionIndex: 0, kind: 'option' }],
    };
    expect(AskUserQuestionAnswerSchema.safeParse(ans).success).toBe(false);
  });
});
