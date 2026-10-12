import Anthropic from '@anthropic-ai/sdk';

// Models that accept adaptive thinking and server-side refusal fallbacks.
const ADAPTIVE = /^claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])/;
const FALLBACK_OK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export function anthropicProvider({ apiKey, model }) {
  const client = new Anthropic({ apiKey });

  async function* stream(messages, signal) {
    const system = messages.find((m) => m.role === 'system')?.content;
    const params = {
      model,
      max_tokens: 64000,
      system,
      messages: messages.filter((m) => m.role !== 'system'),
      ...(ADAPTIVE.test(model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      // On a policy decline, let the API retry on a suitable model inside the same call.
      ...(FALLBACK_OK.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };
    let s;
    try {
      s = client.beta.messages.stream(params, { signal });
      for await (const event of s) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text };
          else if (event.delta.type === 'thinking_delta') yield { type: 'thinking', text: event.delta.thinking };
        } else if (event.type === 'message_delta' && event.delta.stop_reason === 'refusal') {
          yield { type: 'text', text: '\n\n_(the model declined this request)_' };
        }
      }
    } catch (err) {
      throw describe(err);
    }
  }

  async function listModels() {
    const ids = [];
    try {
      for await (const m of client.models.list()) ids.push(m.id);
    } catch (err) {
      throw describe(err);
    }
    return ids;
  }

  return { stream, listModels };
}

function describe(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('Claude API: invalid API key');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('Claude API: this key has no access to that model');
  if (err instanceof Anthropic.NotFoundError) return new Error('Claude API: model not found — pick one in Settings → AI');
  if (err instanceof Anthropic.RateLimitError) return new Error('Claude API: rate limited — try again shortly');
  if (err instanceof Anthropic.APIConnectionError) return new Error('Claude API: network error — are you online?');
  if (err instanceof Anthropic.APIError) return new Error(`Claude API ${err.status}: ${err.message}`);
  return err;
}
