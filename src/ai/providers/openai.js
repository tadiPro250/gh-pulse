// Any OpenAI-compatible chat API: OpenAI, Gemini (OpenAI endpoint), OpenRouter,
// Groq, Mistral, Ollama, LM Studio, llama.cpp, vLLM, …
export function openaiProvider({ baseUrl, apiKey, model, label = baseUrl }) {
  const root = baseUrl.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };

  const request = async (path, init) => {
    const res = await fetch(`${root}${path}`, { ...init, headers }).catch((err) => {
      if (init?.signal?.aborted) throw err;
      throw new Error(`can't reach ${label} — ${err.cause?.code === 'ECONNREFUSED' ? 'is the server running?' : (err.cause?.code ?? err.message)}`);
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new Error(`${label}: API key rejected (${res.status})`);
      throw new Error(`${label} ${res.status}: ${body}`);
    }
    return res;
  };

  async function* stream(messages, signal) {
    const res = await request('/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages, stream: true }), signal });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        const delta = JSON.parse(payload).choices?.[0]?.delta;
        // Reasoning models stream their thinking separately; surface it as such.
        const thinking = delta?.reasoning_content ?? delta?.reasoning;
        if (thinking) yield { type: 'thinking', text: thinking };
        if (delta?.content) yield { type: 'text', text: delta.content };
      }
    }
  }

  async function listModels() {
    const res = await request('/models', { method: 'GET' });
    const body = await res.json();
    return (body.data ?? body.models ?? []).map((m) => (m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean).sort();
  }

  return { stream, listModels };
}
