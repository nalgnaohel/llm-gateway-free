#!/usr/bin/env node
/**
 * Minimal deterministic "coding CLI" used by the test suite.
 * Reads a prompt on stdin, streams a reply on stdout in small chunks.
 */
const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", async () => {
  const prompt = Buffer.concat(chunks).toString("utf8").trim();
  const words = `echo-cli reply to: ${prompt.replace(/\s+/g, " ").slice(0, 200)}`.split(" ");
  for (const w of words) {
    process.stdout.write(`${w} `);
    await new Promise((r) => setTimeout(r, 5));
  }
  process.stdout.write("\n");
  process.exit(0);
});
