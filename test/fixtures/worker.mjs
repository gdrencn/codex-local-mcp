#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (process.argv.includes('--version')) {
  console.log('fixture-codex 1.0');
  process.exit(0);
}
let text = '';
for await (const chunk of process.stdin) text += chunk;
let options;
try {
  options = JSON.parse(text);
} catch {
  options = { answer: text };
}
if (options.startup_error) {
  console.error('Error loading worker configuration: fixture startup failure');
  process.exit(2);
}
if (options.capture)
  writeFileSync(
    options.capture,
    JSON.stringify({
      args: process.argv.slice(2),
      prompt: text,
      cwd: process.cwd(),
      inherited_thread: process.env.CODEX_THREAD_ID ?? null,
      service_url: process.env.CODEX_LOCAL_BASE_URL ?? null,
      backup_url: process.env.CODEX_LOCAL_BACKUP_BASE_URL ?? null,
    }),
  );
const send = (value) => console.log(JSON.stringify(value));
const session = process.argv.includes('resume') ? process.argv.at(-2) : randomUUID();
send({ type: 'thread.started', thread_id: session });
send({ type: 'turn.started' });
if (options.detached_child) {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { detached: true, stdio: 'ignore' },
  );
  writeFileSync(options.detached_child, String(child.pid));
  child.unref();
}
if (options.ignore_term) process.on('SIGTERM', () => {});
if (options.hold) {
  setInterval(() => {}, 1000);
} else {
  await new Promise((resolve) => setTimeout(resolve, options.delay ?? 25));
  if (options.malformed) console.log('plain worker diagnostic');
  if (options.oversize) console.log('X'.repeat(300000));
  if (options.failure) {
    send({ type: 'error', message: 'fixture failure' });
    send({ type: 'turn.failed', error: { message: 'fixture failure' } });
  } else if (!options.incomplete) {
    const line = Buffer.from(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: options.answer ?? 'OK' },
      }) + '\n',
    );
    if (options.fragmented) {
      for (let i = 0; i < line.length; i += 2) process.stdout.write(line.subarray(i, i + 2));
    } else process.stdout.write(line);
    send({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
  }
  process.exitCode = options.exit_code ?? 0;
}
