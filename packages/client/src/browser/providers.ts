/**
 * Selector registry for browser-driven web LLMs.
 *
 * Selectors are the only provider-specific knowledge the agent needs: everything
 * else (send, settle detection, extraction) is generic. Adding a provider = adding
 * a row here. Values follow the layout used by ai-browser-bridge's PROVIDER_CONFIG.
 */

export type ProviderSelectors = {
  /** required: the prompt box */
  composer: string;
  /** required: assistant message nodes; the last one is the current answer */
  assistant: string;
  /** visible only while the model is generating — the primary settle signal */
  stop?: string;
  /** explicit send button; falls back to pressing Enter */
  send?: string;
  /** shown when logged out */
  signedOut?: string;
  newChat?: string;
};

export type WebProvider = {
  id: string;
  displayName: string;
  /** hostname match used to find an already-open tab */
  origin: string;
  defaultUrl: string;
  selectors: ProviderSelectors;
  /** contenteditable composers need an input event dispatched for React/Slate */
  contentEditable: boolean;
  models?: string[];
};

export const WEB_PROVIDERS: Record<string, WebProvider> = {
  chatgpt: {
    id: "chatgpt",
    displayName: "ChatGPT (web)",
    origin: "chatgpt.com",
    defaultUrl: "https://chatgpt.com/",
    contentEditable: true,
    models: ["auto", "gpt-5", "gpt-5-thinking"],
    selectors: {
      composer: '#prompt-textarea, div[contenteditable="true"]',
      assistant: '[data-message-author-role="assistant"]',
      stop: 'button[data-testid="stop-button"], button[aria-label*="Stop" i]',
      send: 'button[data-testid="send-button"], button[aria-label*="Send" i]',
      signedOut: '[data-testid="login-button"]',
      newChat: 'a[href="/"], button[data-testid="create-new-chat-button"]',
    },
  },
  claude: {
    id: "claude",
    displayName: "Claude (web)",
    origin: "claude.ai",
    defaultUrl: "https://claude.ai/new",
    contentEditable: true,
    models: ["default"],
    selectors: {
      composer: '[data-testid="chat-input"], div[contenteditable="true"]',
      assistant: ".standard-markdown, [data-testid='assistant-message']",
      stop: 'button[aria-label="Stop response"], button[aria-label*="Stop" i]',
      send: 'button[aria-label="Send message"], button[aria-label*="Send" i]',
      signedOut: 'a[href*="/login"]',
    },
  },
  gemini: {
    id: "gemini",
    displayName: "Gemini (web)",
    origin: "gemini.google.com",
    defaultUrl: "https://gemini.google.com/app",
    contentEditable: true,
    selectors: {
      composer: 'div.ql-editor, div[contenteditable="true"]',
      assistant: "model-response .model-response-text, message-content, .model-response-text",
      stop: 'button[aria-label*="Stop" i]',
      send: 'button[aria-label*="Send" i], button.send-button',
    },
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek (web)",
    origin: "chat.deepseek.com",
    defaultUrl: "https://chat.deepseek.com/",
    contentEditable: false,
    selectors: {
      composer: "textarea#chat-input, textarea",
      assistant: ".ds-markdown",
      stop: 'div[role="button"][aria-label*="Stop" i]',
    },
  },
  grok: {
    id: "grok",
    displayName: "Grok (web)",
    origin: "grok.com",
    defaultUrl: "https://grok.com/",
    contentEditable: true,
    selectors: {
      composer: '[aria-label="Ask Grok anything"], div.tiptap.ProseMirror, textarea',
      assistant: '[class*="message-bubble"]',
      stop: 'button[aria-label*="Stop" i]',
    },
  },
  perplexity: {
    id: "perplexity",
    displayName: "Perplexity (web)",
    origin: "perplexity.ai",
    defaultUrl: "https://www.perplexity.ai/",
    contentEditable: true,
    selectors: {
      composer: "#ask-input, textarea, div[contenteditable]",
      assistant: ".prose",
      stop: 'button[aria-label*="Stop" i]',
    },
  },
  duck: {
    id: "duck",
    displayName: "Duck.ai (web)",
    origin: "duck.ai",
    defaultUrl: "https://duck.ai/chat",
    contentEditable: false,
    selectors: {
      composer: 'textarea[name="user-prompt"], [data-testid="duckai-chat-input"] textarea',
      assistant: 'div[id*="-assistant-message-"]:not([id^="heading-"])',
      stop: 'button[aria-label="Stop generating"]',
    },
  },
  /**
   * Local harness used by the E2E suite. It mimics the DOM contract every real
   * provider exposes (composer / assistant nodes / stop button), so the whole
   * browser pipeline is exercised without a logged-in account.
   */
  mockweb: {
    id: "mockweb",
    displayName: "Mock Web LLM (test)",
    origin: "127.0.0.1",
    defaultUrl: process.env.AIGW_MOCKWEB_URL ?? "http://127.0.0.1:8899/",
    contentEditable: false,
    models: ["fast", "slow"],
    selectors: {
      composer: "#prompt-textarea",
      assistant: '[data-message-author-role="assistant"]',
      stop: "#stop-button",
      send: "#send-button",
    },
  },
};

export function knownProviderIds(): string[] {
  return Object.keys(WEB_PROVIDERS);
}

export function providerFor(id: string): WebProvider | undefined {
  return WEB_PROVIDERS[id];
}
