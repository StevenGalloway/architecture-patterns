import { EventSource } from 'eventsource';
import { Flag, EvalContext, EvalResult, evaluateFlag } from './targeting-engine.js';

export class FlagClient {
  private cache = new Map<string, Flag>();
  private apiUrl: string;
  private sse: EventSource | null = null;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  /**
   * Seed the local cache from the management API and open an SSE connection.
   * Must be called before evaluate(). Resolves once the cache is seeded.
   */
  async initialize(): Promise<void> {
    await this.seedCache();
    this.openSseConnection();
    console.log(`[FlagSDK] Initialized with ${this.cache.size} flags`);
  }

  /**
   * Evaluate a flag for a given user context.
   * Always evaluates locally — no network call.
   * Returns safeDefault if the flag is not in cache.
   */
  evaluate(key: string, context: EvalContext = {}): EvalResult {
    const flag = this.cache.get(key);
    const result = evaluateFlag(flag, context);
    // Structured evaluation event (in production, sample to 1% for high-volume flags)
    console.log(`[EVAL] ${JSON.stringify({
      flagKey: key,
      variant: result.variant,
      ruleMatched: result.ruleMatched,
      userId: context.userId ?? 'anonymous',
      tenantId: context.tenantId,
    })}`);
    return result;
  }

  private async seedCache(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/flags`);
    if (!response.ok) {
      console.warn('[FlagSDK] Failed to seed cache — using safe defaults for all flags');
      return;
    }
    const flags: Flag[] = await response.json();
    for (const flag of flags) {
      this.cache.set(flag.key, flag);
    }
  }

  private openSseConnection(): void {
    const url = `${this.apiUrl}/flags/stream`;
    this.sse = new EventSource(url);

    this.sse.addEventListener('flag:updated', (event: MessageEvent) => {
      try {
        const flag: Flag = JSON.parse(event.data);
        this.cache.set(flag.key, flag);
        console.log(`[FlagSDK] Cache updated for key: ${flag.key}`);
      } catch (err) {
        console.error('[FlagSDK] Failed to parse SSE event:', err);
      }
    });

    this.sse.addEventListener('error', () => {
      console.warn('[FlagSDK] SSE connection lost — will reconnect automatically');
      // EventSource reconnects automatically with built-in exponential backoff
    });

    this.sse.addEventListener('open', () => {
      console.log('[FlagSDK] SSE connection established');
    });
  }

  close(): void {
    this.sse?.close();
  }
}
