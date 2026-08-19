import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local web page that reproduces the DOM contract every real web LLM exposes:
 * a composer, a stop button that is visible only while "generating", and
 * assistant nodes tagged `data-message-author-role="assistant"` whose text grows
 * token by token. It lets the E2E suite drive the full browser pipeline with a
 * real Chromium and no account.
 */
const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Mock Web LLM</title></head>
<body>
  <div id="thread"></div>
  <textarea id="prompt-textarea" rows="3" cols="60"></textarea>
  <button id="send-button">Send</button>
  <button id="stop-button" style="display:none">Stop</button>
  <script>
    const thread = document.getElementById('thread');
    const box = document.getElementById('prompt-textarea');
    const send = document.getElementById('send-button');
    const stop = document.getElementById('stop-button');
    let timer = null;

    function reply(prompt) {
      const user = document.createElement('div');
      user.setAttribute('data-message-author-role', 'user');
      user.textContent = prompt;
      thread.appendChild(user);

      const node = document.createElement('div');
      node.setAttribute('data-message-author-role', 'assistant');
      node.textContent = '';
      thread.appendChild(node);

      // A brief "Thinking…" placeholder — the settle logic must not treat it as final.
      node.textContent = 'Thinking…';
      stop.style.display = 'inline-block';

      // A real web UI renders over seconds; pad the reply so the streaming path
      // is exercised over many poll cycles rather than landing in one tick.
      const filler = Array.from({ length: 40 }, (_, k) => 'tok' + (k + 1)).join(' ');
      const words = ('MOCKWEB reply: ' + prompt.replace(/\\s+/g, ' ') + ' || ' + filler).split(' ');
      let i = 0;
      setTimeout(() => {
        node.textContent = '';
        timer = setInterval(() => {
          if (i >= words.length) {
            clearInterval(timer);
            timer = null;
            stop.style.display = 'none';
            return;
          }
          node.textContent = (node.textContent + ' ' + words[i]).trim();
          i += 1;
        }, 40);
      }, 250);
    }

    send.addEventListener('click', () => {
      const text = box.value.trim();
      if (!text || timer) return;
      box.value = '';
      reply(text);
    });
    stop.addEventListener('click', () => {
      if (timer) { clearInterval(timer); timer = null; }
      stop.style.display = 'none';
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); }
    });
  </script>
</body>
</html>`;

export type MockWebServer = { url: string; close(): Promise<void> };

export async function startMockWebLlm(port = 0): Promise<MockWebServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
