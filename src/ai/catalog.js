// Every AI pulse knows how to talk to. Three kinds:
//
//   cli  — a coding agent installed on this machine (uses its own login).
//          Can chat headlessly AND be handed a task to edit code in a clone.
//   api  — a hosted or local model behind an API key / URL. Chat only.
//   ide  — an editor with a built-in agent. pulse opens the repo there and
//          puts the task on your clipboard.
//
// CLI arg templates: strings may contain {model} {prompt} {promptFile}
// {systemFile}. A nested array is an optional group, dropped when any
// placeholder in it is empty (e.g. ['--model', '{model}']).
// Any of these can be overridden per provider in config.ai.providers.<id>.

const TASK_FILE_PROMPT = 'Read the task in the file {promptFile} and carry it out.';
const CHAT_FILE_PROMPT = 'Read the file {promptFile} and reply to the last user message in it. Do not modify any files.';

export const CATALOG = [
  // ── coding agents ───────────────────────────────────────────────────────
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic · uses your Claude login',
    kind: 'cli',
    bin: 'claude',
    install: 'https://claude.com/claude-code',
    models: ['opus', 'sonnet', 'haiku'],
    verified: true,
    chat: {
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--no-session-persistence', '--system-prompt-file', '{systemFile}', ['--model', '{model}']],
      input: 'stdin-transcript',
      parse: 'claude-stream-json',
    },
    agent: { args: [['--model', '{model}'], '{prompt}'], inlinePrompt: true },
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI · sign in with ChatGPT',
    kind: 'cli',
    bin: 'codex',
    install: 'npm i -g @openai/codex',
    chat: { args: ['exec', '--skip-git-repo-check', ['-m', '{model}'], '-'], input: 'stdin-full', parse: 'text' },
    agent: { args: [['-m', '{model}'], '{prompt}'] },
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google · sign in with Google',
    kind: 'cli',
    bin: 'gemini',
    install: 'npm i -g @google/gemini-cli',
    chat: { args: ['-p', 'Follow the instructions and context given on stdin.', ['-m', '{model}']], input: 'stdin-full', parse: 'text' },
    agent: { args: [['-m', '{model}'], '-i', '{prompt}'] },
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    vendor: 'Cursor · uses your Cursor login',
    kind: 'cli',
    bin: 'cursor-agent',
    install: 'https://cursor.com/cli',
    chat: { args: ['-p', '--output-format', 'text', ['--model', '{model}'], CHAT_FILE_PROMPT], input: 'file', parse: 'text' },
    agent: { args: [['--model', '{model}'], '{prompt}'] },
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    vendor: 'GitHub · uses your Copilot plan',
    kind: 'cli',
    bin: 'copilot',
    install: 'npm i -g @github/copilot',
    chat: { args: ['-p', CHAT_FILE_PROMPT], input: 'file', parse: 'text' },
    agent: { args: ['-i', '{prompt}'] },
  },

  // ── APIs ────────────────────────────────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Claude API',
    vendor: 'Anthropic · API key',
    kind: 'api',
    protocol: 'anthropic',
    env: 'ANTHROPIC_API_KEY',
    keyUrl: 'platform.claude.com → API keys',
    defaultModel: 'claude-opus-5-5',
  },
  {
    id: 'openai',
    name: 'OpenAI API (ChatGPT models)',
    vendor: 'OpenAI · API key',
    kind: 'api',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    env: 'OPENAI_API_KEY',
    keyUrl: 'platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    name: 'Gemini API',
    vendor: 'Google · API key',
    kind: 'api',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: 'GEMINI_API_KEY',
    keyUrl: 'aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: 'hundreds of models · API key',
    kind: 'api',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
    keyUrl: 'openrouter.ai/keys',
  },
  { id: 'ollama', name: 'Ollama', vendor: 'local models', kind: 'api', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', local: true },
  { id: 'lmstudio', name: 'LM Studio', vendor: 'local models', kind: 'api', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', local: true },
  {
    id: 'custom-api',
    name: 'Custom OpenAI-compatible API',
    vendor: 'Groq, Mistral, Together, vLLM, …',
    kind: 'api',
    protocol: 'openai',
    baseUrl: '',
    custom: true,
  },

  // ── editors with built-in agents ────────────────────────────────────────
  { id: 'antigravity', name: 'Antigravity', vendor: 'Google · agent IDE', kind: 'ide', bin: 'antigravity', install: 'antigravity.google' },
  { id: 'cursor', name: 'Cursor', vendor: 'agent IDE', kind: 'ide', bin: 'cursor', install: 'cursor.com' },
  { id: 'vscode', name: 'VS Code', vendor: 'with Copilot agent mode', kind: 'ide', bin: 'code', install: 'code.visualstudio.com' },

  // ── anything else ───────────────────────────────────────────────────────
  {
    id: 'custom-cli',
    name: 'Custom CLI',
    vendor: 'any command-line AI',
    kind: 'cli',
    bin: '',
    custom: true,
    chat: { args: ['{promptFile}'], input: 'file', parse: 'text' },
    agent: { args: [TASK_FILE_PROMPT] },
  },
];

export const TASK_PROMPT_TEMPLATE = TASK_FILE_PROMPT;

export const byId = (id) => CATALOG.find((p) => p.id === id);

export const KIND_LABELS = { cli: 'agent', api: 'API', ide: 'IDE' };
