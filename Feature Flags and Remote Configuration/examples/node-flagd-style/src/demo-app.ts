import express, { Request, Response } from 'express';
import { FlagClient } from './flag-client.js';

const app = express();
const flagClient = new FlagClient(process.env.FLAG_API_URL ?? 'http://localhost:3001');

// Initialize SDK — seed cache and open SSE connection before accepting requests
await flagClient.initialize();

// GET /checkout?userId=<id> — evaluates checkout-v2 flag
app.get('/checkout', (req: Request, res: Response) => {
  const userId = (req.query.userId as string) ?? 'anonymous';
  const result = flagClient.evaluate('checkout-v2', { userId });
  res.json({
    userId,
    feature: 'checkout-v2',
    variant: result.variant,
    ruleMatched: result.ruleMatched,
    description: result.variant
      ? 'User sees the new checkout flow (v2)'
      : 'User sees the original checkout flow',
  });
});

// GET /search?userId=<id> — evaluates new-search-algorithm kill switch
app.get('/search', (req: Request, res: Response) => {
  const userId = (req.query.userId as string) ?? 'anonymous';
  const result = flagClient.evaluate('new-search-algorithm', { userId });
  res.json({
    userId,
    feature: 'new-search-algorithm',
    variant: result.variant,
    ruleMatched: result.ruleMatched,
    description: result.variant
      ? 'New search algorithm is active'
      : 'Kill switch active — falling back to original search',
  });
});

// GET /config/max-upload-size — evaluates remote config value
app.get('/config/max-upload-size', (_req: Request, res: Response) => {
  const result = flagClient.evaluate('max-upload-size-mb', {});
  res.json({
    configKey: 'max-upload-size-mb',
    value: result.variant,
    ruleMatched: result.ruleMatched,
    unit: 'MB',
  });
});

const port = parseInt(process.env.PORT ?? '3000');
app.listen(port, () => {
  console.log(`[APP] Demo app listening on port ${port}`);
  console.log(`[APP] Try: curl "http://localhost:${port}/checkout?userId=user-123"`);
  console.log(`[APP] Try: curl "http://localhost:${port}/search?userId=user-123"`);
  console.log(`[APP] Try: curl "http://localhost:${port}/config/max-upload-size"`);
});
