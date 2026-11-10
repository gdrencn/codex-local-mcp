import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { TaskError, type Reachability } from './domain.js';
import { checkService } from './health.js';

export interface ServiceEndpoints {
  primary: string;
  backup: string | null;
}
export interface EndpointUpdate {
  primary: string;
  backup?: string | null | undefined;
}
export const SERVICE_PROMPT =
  '本地模型服务无法访问，请提供可用的 IP 和端口（例如 http://HOST:PORT/v1）。';

export function normalizeEndpoint(value: string): string {
  let input = value.trim();
  const bare = !input.includes('://');
  if (bare) input = `http://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TaskError('invalid_endpoint', 'Provide an IP:port or HTTP(S) service URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (bare && !/^https?:\/\/(?:\[[^\]]+\]|[^/:?#]+):\d+(?:\/|$)/i.test(input))
  )
    throw new TaskError(
      'invalid_endpoint',
      'Use IP:port or an HTTP(S) URL without credentials, query, or fragment',
    );
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
}

function normalize(endpoints: EndpointUpdate): ServiceEndpoints {
  const primary = normalizeEndpoint(endpoints.primary);
  const backup = endpoints.backup ? normalizeEndpoint(endpoints.backup) : null;
  return { primary, backup: backup === primary ? null : backup };
}

export function recoveryDetails(service: Reachability): Record<string, unknown> {
  return {
    requires_user_input: true,
    user_prompt: SERVICE_PROMPT,
    next_action: 'ask_user_for_service_address',
    recovery_tool: 'local_set_service',
    attempts: service.attempts ?? [],
  };
}

export class EndpointRegistry {
  private updates: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: Config) {}

  current(): ServiceEndpoints {
    if (!existsSync(this.config.endpointsFile))
      return normalize({ primary: this.config.baseUrl, backup: this.config.backupUrl });
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.config.endpointsFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const value = parsed as { primary?: unknown; backup?: unknown };
      if (
        typeof value.primary !== 'string' ||
        !(value.backup === undefined || value.backup === null || typeof value.backup === 'string')
      )
        throw new Error();
      return normalize({ primary: value.primary, backup: value.backup ?? null });
    } catch (error) {
      throw new TaskError(
        'invalid_endpoint_config',
        `Invalid endpoint file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  revision(): string {
    try {
      return createHash('sha256').update(JSON.stringify(this.current())).digest('hex');
    } catch {
      return 'invalid-configuration';
    }
  }

  async check(): Promise<Reachability> {
    let endpoints: ServiceEndpoints;
    try {
      endpoints = this.current();
    } catch (error) {
      const service: Reachability = {
        available: false,
        checked_at: new Date().toISOString(),
        error: String(error),
        active_base_url: null,
      };
      return { ...service, ...recoveryDetails(service) };
    }
    const attempts: NonNullable<Reachability['attempts']> = [];
    const candidates = [endpoints.primary, ...(endpoints.backup ? [endpoints.backup] : [])];
    for (const [index, base_url] of candidates.entries()) {
      const result = await checkService(base_url, this.config.healthTimeoutMs);
      attempts.push({
        base_url,
        available: result.available,
        ...(result.error ? { error: result.error } : {}),
      });
      if (result.available)
        return { ...result, active_base_url: base_url, using_backup: index > 0, attempts };
    }
    const service: Reachability = {
      available: false,
      checked_at: new Date().toISOString(),
      active_base_url: null,
      using_backup: false,
      attempts,
      error: 'No configured model service returned a valid model list',
    };
    return { ...service, ...recoveryDetails(service) };
  }

  set(input: EndpointUpdate): Promise<{ endpoints: ServiceEndpoints; service: Reachability }> {
    const operation = this.updates
      .catch(() => undefined)
      .then(async () => {
        let previous: ServiceEndpoints;
        try {
          previous = this.current();
        } catch {
          previous = { primary: this.config.baseUrl, backup: this.config.backupUrl };
        }
        const endpoints = normalize({
          primary: input.primary,
          backup: input.backup === undefined ? previous.backup : input.backup,
        });
        // Verify the new primary itself: a healthy old backup must not disguise an
        // invalid user-supplied replacement. Failed checks leave the file intact.
        const checked = await checkService(endpoints.primary, this.config.healthTimeoutMs);
        if (!checked.available) {
          const service = {
            ...checked,
            attempts: [
              {
                base_url: endpoints.primary,
                available: false,
                error: checked.error ?? 'Unavailable',
              },
            ],
          };
          throw new TaskError(
            'service_unavailable',
            'The supplied primary address could not be verified',
            recoveryDetails(service),
          );
        }
        mkdirSync(dirname(this.config.endpointsFile), { recursive: true, mode: 0o700 });
        const temporary = `${this.config.endpointsFile}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(endpoints, null, 2) + '\n', { mode: 0o600 });
        renameSync(temporary, this.config.endpointsFile);
        return {
          endpoints,
          service: { ...checked, active_base_url: endpoints.primary, using_backup: false },
        };
      });
    this.updates = operation;
    return operation;
  }
}
