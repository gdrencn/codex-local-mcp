import { StringDecoder } from 'node:string_decoder';

export const clip = (text: string, limit = 2048): string =>
  text.length > limit ? text.slice(0, limit) + '…[truncated]' : text;

/** Decode split UTF-8 safely and bound a malformed or newline-free event. */
export class JsonLineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private dropping = false;
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOversize: () => void,
    private readonly maxLength = 262144,
  ) {}

  push(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }
  end(): void {
    this.consume(this.decoder.end());
    if (this.pending && !this.dropping) this.onLine(this.pending);
    this.pending = '';
  }
  private consume(text: string): void {
    for (const [index, part] of text.split('\n').entries()) {
      if (index > 0) {
        if (!this.dropping && this.pending) this.onLine(this.pending);
        this.pending = '';
        this.dropping = false;
      }
      if (this.dropping) continue;
      if (this.pending.length + part.length > this.maxLength) {
        this.pending = '';
        this.dropping = true;
        this.onOversize();
      } else this.pending += part;
    }
  }
}

export function summarizeEvent(event: Record<string, unknown>): unknown {
  // A bounded serialized summary preserves unfamiliar event shapes without flooding MCP.
  const serialized = JSON.stringify(event);
  return serialized.length <= 4096 ? event : { preview: clip(serialized, 4096), truncated: true };
}
