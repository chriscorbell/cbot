/**
 * A model id as people say it: "deepseek-flash" → "DeepSeek Flash", "claude-sonnet-4-5-20250929" →
 * "Claude Sonnet 4.5", "gpt-5-mini" → "GPT-5 mini". Ids we don't recognise still read cleanly.
 */
const BRANDS: Record<string, string> = {
  deepseek: 'DeepSeek', claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', llama: 'Llama', mistral: 'Mistral', qwen: 'Qwen',
  grok: 'Grok', kimi: 'Kimi', glm: 'GLM', codex: 'Codex', copilot: 'Copilot', chatgpt: 'ChatGPT', openai: 'OpenAI',
};
const LOWER = new Set(['mini', 'nano']);
const UPPER = new Set(['r1', 'v3', 'v4', 'v5', 'ai', 'it', 'xl']);

export function modelName(id: string | null | undefined): string {
  if (!id) return '';
  // "anthropic/claude-…" and "models/gemini-…": the part after the last slash is the model.
  const bare = id.split('/').pop()!.replace(/:.*$/, '');
  const parts = bare.split(/[-_\s]+/).filter(Boolean)
    // Release dates (20250929) and "latest" don't help anyone choose.
    .filter((p) => !/^\d{6,8}$/.test(p) && p.toLowerCase() !== 'latest');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const low = p.toLowerCase();
    // Versions written as separate numbers join with dots: 4-5 → 4.5.
    if (/^\d+$/.test(p) && out.length && /^\d+(\.\d+)*$/.test(out[out.length - 1])) { out[out.length - 1] += `.${p}`; continue; }
    if (BRANDS[low]) {
      // GPT and its version read as one word: GPT-5, GPT-4.1, GPT-4o.
      if (low === 'gpt' && parts[i + 1] && /^\d/.test(parts[i + 1])) { out.push(`GPT-${parts[++i]}`); continue; }
      out.push(BRANDS[low]); continue;
    }
    if (LOWER.has(low)) { if (out.length && /^o\d/.test(out[out.length - 1])) out[out.length - 1] += `-${low}`; else out.push(low); continue; }
    if (UPPER.has(low)) { out.push(low.toUpperCase()); continue; }
    if (/^o\d/.test(low)) { out.push(low); continue; } // OpenAI's o3, o4-mini
    out.push(/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(' ') || id;
}

/**
 * The model to show after picking a provider. The current one stays if the provider lists it. Going
 * back to the saved provider brings back the saved model. Otherwise it is the provider's first model,
 * or none (the provider's own default) when it lists none, as one that isn't connected yet doesn't:
 * another provider's model saved with it would make every run fail.
 */
export function modelForProvider(next: { id: string; models: string[] } | undefined, current: string, saved: { provider: string | null; model: string | null }): string {
  if (next?.models.includes(current)) return current;
  if (next && next.id === (saved.provider ?? '')) return saved.model ?? '';
  return next?.models[0] ?? '';
}
