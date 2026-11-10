import http from 'node:http';
import https from 'node:https';
import type { Reachability } from './domain.js';

/** Direct Node HTTP intentionally does not use environment proxy settings. */
export function checkService(baseUrl: string, timeoutMs: number): Promise<Reachability> {
  return new Promise((resolve) => {
    const checked_at = new Date().toISOString();
    const url = new URL(`${baseUrl}/models`);
    let settled = false;
    const finish = (value: Reachability) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      }
    };
    const request = (url.protocol === 'https:' ? https : http).get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1048576) request.destroy(new Error('Model list exceeds 1 MiB'));
      });
      response.on('error', (error) =>
        finish({ available: false, checked_at, error: error.message }),
      );
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { data?: { id?: unknown }[] };
          if (
            response.statusCode !== 200 ||
            !Array.isArray(parsed.data) ||
            !parsed.data.some(
              (model) => model && typeof model.id === 'string' && model.id.length > 0,
            )
          )
            throw new Error(`No models available (HTTP ${response.statusCode})`);
          finish({ available: true, checked_at });
        } catch (error) {
          finish({ available: false, checked_at, error: String(error) });
        }
      });
    });
    const deadline = setTimeout(
      () => request.destroy(new Error('Service health request timed out')),
      timeoutMs,
    );
    request.on('error', (error) => finish({ available: false, checked_at, error: error.message }));
  });
}
