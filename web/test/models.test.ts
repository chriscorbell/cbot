import { expect, test } from 'vitest';
import { modelForProvider } from '../src/lib/models';

const saved = { provider: 'custom', model: 'qwen38' };

test('a provider that lists no models gets its own default, not the old provider’s model', () => {
  expect(modelForProvider({ id: 'gemini', models: [] }, 'qwen38', saved)).toBe('');
});

test('a provider that lists models starts from its first, unless it lists the current one', () => {
  expect(modelForProvider({ id: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }, 'qwen38', saved)).toBe('claude-opus-5-5');
  expect(modelForProvider({ id: 'openrouter', models: ['qwen38', 'gpt-5'] }, 'qwen38', saved)).toBe('qwen38');
});

test('going back to the saved provider brings back the saved model', () => {
  expect(modelForProvider({ id: 'custom', models: [] }, '', saved)).toBe('qwen38');
  expect(modelForProvider({ id: 'custom', models: ['llama-4'] }, 'gemini-3-pro', saved)).toBe('qwen38');
});

test('an unknown provider gets the default', () => {
  expect(modelForProvider(undefined, 'qwen38', saved)).toBe('');
});
