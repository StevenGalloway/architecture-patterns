# AI Integration — Anti-Corruption Layer Pattern

## The ACL as the Natural Boundary for AI Vendor Volatility

The Anti-Corruption Layer was born from a specific class of problem: an external vendor changes their API schema without coordinating with you, and your internal domain breaks. AI model vendor APIs exhibit exactly this behavior — and often worse. Model providers add, remove, and rename response fields between model versions. They add new optional fields that consuming code does not expect. They change the shape of structured outputs without deprecation notices.

The ACL is the right architectural response to AI vendor schema volatility for the same reason it is the right response to CRM vendor schema volatility: it absorbs external changes at a single point, protects the core domain from the details of any particular vendor's API shape, and enables vendor substitution without domain changes.

---

## 1. ACL as AI Output Adapter

LLM vendor response schemas are not stable. OpenAI has changed the shape of completion responses between API versions. Anthropic has iterated on the Messages API response format. Model providers add fields, change nesting, and alter how tool calls and structured outputs are represented — often without a formal deprecation cycle.

This is structurally identical to the CRM vendor problem: external schema drift breaking internal code.

The ACL's response: define a `CanonicalAIResponse` type that represents what your domain needs from any AI model, and write a translation function that converts each vendor's response format into that canonical type.

```typescript
// Canonical AI response type — internal, stable
type CanonicalAIResponse = {
  responseId:      string;
  modelId:         string;
  generatedText:   string;
  finishReason:    'complete' | 'max_tokens' | 'stop_sequence' | 'content_filter' | 'error';
  inputTokens:     number;
  outputTokens:    number;
  latencyMs:       number;
  structuredOutput: Record<string, unknown> | null;
};

// Anthropic Messages API v3 → CanonicalAIResponse
function fromAnthropicResponse(
  raw: AnthropicMessagesResponse,
  latencyMs: number
): CanonicalAIResponse {
  const textBlock = raw.content.find(b => b.type === 'text');
  return {
    responseId:      raw.id,
    modelId:         raw.model,
    generatedText:   textBlock?.text ?? '',
    finishReason:    toCanonicalFinishReason(raw.stop_reason),
    inputTokens:     raw.usage.input_tokens,
    outputTokens:    raw.usage.output_tokens,
    latencyMs,
    structuredOutput: null,
  };
}

// OpenAI Chat Completions → CanonicalAIResponse
function fromOpenAIResponse(
  raw: OpenAIChatCompletionResponse,
  latencyMs: number
): CanonicalAIResponse {
  const choice = raw.choices[0];
  return {
    responseId:      raw.id,
    modelId:         raw.model,
    generatedText:   choice?.message.content ?? '',
    finishReason:    toCanonicalFinishReason(choice?.finish_reason),
    inputTokens:     raw.usage.prompt_tokens,
    outputTokens:    raw.usage.completion_tokens,
    latencyMs,
    structuredOutput: choice?.message.tool_calls?.[0]?.function?.arguments
                       ? JSON.parse(choice.message.tool_calls[0].function.arguments)
                       : null,
  };
}
```

The domain service that uses AI-generated content only ever sees `CanonicalAIResponse`. When a model provider changes their API shape, only the translation function changes — not the domain.

---

## 2. Schema Versioning for AI Model Outputs

AI model providers do not deprecate model versions on a predictable schedule. When `gpt-4` is replaced by `gpt-4o`, the response format may change. When Anthropic introduces new content block types in the Messages API, code that assumes only text blocks in `content` can fail silently by dropping the new block type.

The ACL's versioned mapping strategy — which already handles `VendorCustomerV2 | VendorCustomerV3` transitions — applies directly to model version transitions.

```typescript
// Type union covers multiple model response shapes
type AnthropicMessagesResponse =
  | AnthropicMessagesResponseV1  // claude-2 era
  | AnthropicMessagesResponseV2  // claude-3 era (added content block types)
  | AnthropicMessagesResponseV3; // claude-3-5 era (added thinking blocks)

function fromAnthropicResponseVersioned(
  raw: unknown,
  apiVersion: string,
  latencyMs: number
): CanonicalAIResponse {
  if (apiVersion === '2023-01-01') return fromAnthropicV1(raw as AnthropicMessagesResponseV1, latencyMs);
  if (apiVersion === '2023-06-01') return fromAnthropicV2(raw as AnthropicMessagesResponseV2, latencyMs);
  return fromAnthropicV3(raw as AnthropicMessagesResponseV3, latencyMs);  // default to latest
}
```

The same contract testing strategy that validates vendor CRM payloads also validates AI vendor payloads: record real API responses against specific model versions, store them as contract test fixtures, and assert that the translation function produces the expected `CanonicalAIResponse` for each fixture. When a new model version is onboarded, add new fixtures before writing new translation code.

**Model version routing:** The ACL can route requests to different model versions based on canonical parameters, exactly as it routes requests to different vendor API endpoints:

```typescript
type AIModelTier = 'fast' | 'balanced' | 'capable';

// Domain service requests a capability tier, not a specific model
// ACL resolves to vendor + model based on current configuration
const modelMap: Record<AIModelTier, { vendor: string; model: string }> = {
  fast:     { vendor: 'anthropic', model: 'claude-haiku-4-5' },
  balanced: { vendor: 'anthropic', model: 'claude-sonnet-4-5' },
  capable:  { vendor: 'anthropic', model: 'claude-opus-4-5' },
};
```

When the model provider releases a better model for the `fast` tier, the mapping in the ACL changes. No domain service changes required.

---

## 3. ACL as Prompt Injection Defense Boundary

When AI-generated content flows back into core business logic, it represents exactly the same threat model as vendor payload injection. The content was produced by an external system (the model) responding to external input (user-supplied prompts). It must be treated as untrusted until validated at the boundary.

The ACL is the right place to apply this validation — for the same reason it validates CRM vendor payloads: once the content enters the domain as a canonical type, domain code trusts it. The validation window before that trust is established is the ACL boundary.

**Validation at the ACL boundary for AI-generated content:**

```typescript
function validateAIContentForDomain(
  response: CanonicalAIResponse,
  expectedSchema: OutputSchema
): ValidationResult {
  const issues: string[] = [];

  // 1. Structural validation: does the output match the expected shape?
  if (response.structuredOutput !== null) {
    const schemaResult = validateAgainstJsonSchema(response.structuredOutput, expectedSchema);
    if (!schemaResult.valid) issues.push(...schemaResult.errors);
  }

  // 2. Content checks: reject known injection patterns
  const injectionPatterns = [
    /ignore previous instructions/i,
    /you are now/i,
    /system prompt/i,
    /<script/i,
  ];
  for (const pattern of injectionPatterns) {
    if (pattern.test(response.generatedText)) {
      issues.push(`Potential injection content detected: ${pattern.source}`);
    }
  }

  // 3. Finish reason check: content_filter means the model self-refused
  // Do not forward content_filter responses into domain logic
  if (response.finishReason === 'content_filter') {
    issues.push('Model content filter triggered; response rejected at ACL boundary');
  }

  return { valid: issues.length === 0, issues };
}
```

The domain service does not implement this check. It consumes `CanonicalAIResponse` objects that have already passed boundary validation. This is the same principle as the domain service consuming `CanonicalCustomer` objects that have already passed schema validation and translation.

**The key insight:** AI-generated text is untrusted external input. The model does not have access to your domain's invariants, security requirements, or business rules. The ACL is the point where domain knowledge is applied to external content — regardless of whether that content came from a CRM or a language model.

---

## 4. Evaluating AI Outputs Against Domain Invariants

Before AI-generated data enters the core domain, it must satisfy the domain's invariants. The ACL is the correct place to apply these checks because it is the only point where the content can be intercepted before the domain trusts it.

**Example: AI-generated product descriptions entering the Product Catalog domain**

```typescript
type ProductDescriptionInvariant = {
  minLength: number;          // Must be at least 50 characters
  maxLength: number;          // Must not exceed 2,000 characters
  prohibitedTerms: string[];  // Legal or brand-prohibited words
  requiredElements: string[]; // Must include at minimum the product name
};

function validateProductDescriptionInvariant(
  description: string,
  product: CanonicalProduct,
  invariant: ProductDescriptionInvariant
): ValidationResult {
  const issues: string[] = [];

  if (description.length < invariant.minLength) {
    issues.push(`Description too short: ${description.length} chars, minimum ${invariant.minLength}`);
  }
  if (description.length > invariant.maxLength) {
    issues.push(`Description too long: ${description.length} chars, maximum ${invariant.maxLength}`);
  }

  const lowerDesc = description.toLowerCase();
  for (const term of invariant.prohibitedTerms) {
    if (lowerDesc.includes(term.toLowerCase())) {
      issues.push(`Prohibited term found: "${term}"`);
    }
  }

  if (!lowerDesc.includes(product.name.toLowerCase())) {
    issues.push(`Description does not mention product name: "${product.name}"`);
  }

  return { valid: issues.length === 0, issues };
}
```

This validation runs in the ACL before the domain catalog service receives the description. If validation fails, the ACL returns an error to the orchestrating service and the description is not persisted. The catalog service's write path does not need to implement these checks — they are enforced at the entry boundary.

**Why this matters architecturally:** If domain invariant validation is scattered across services, invariant enforcement becomes inconsistent. AI-generated content that satisfies the invariants for service A may violate them for service B. The ACL, as the single entry point for AI-generated content entering a domain, is the correct centralization point for invariant enforcement — exactly as it is the correct centralization point for vendor schema validation.

---

## Mapping ACL ADRs to AI Workloads

| Existing ACL ADR | AI workload implication |
|---|---|
| **ADR-001 (Adopt ACL)**: Protect core domain from vendor schema volatility | AI model vendor APIs change output format without notice. The same rationale applies: absorb AI vendor changes at one boundary. |
| **ADR-002 (Canonical Model)**: Define stable internal types | `CanonicalAIResponse` is the same pattern as `CanonicalCustomer`. Define what your domain needs; translate from whatever the vendor provides. |
| **ADR-003 (Resilience and Timeouts)**: Circuit breakers and retries for vendor APIs | AI model APIs fail, return 529s, and time out under load. The ACL's circuit breaker protects the domain from model provider outages in the same way it protects from CRM outages. Model calls are significantly more expensive than CRM API calls, making retry budgets more consequential. |
| **ADR-004 (Contract Testing)**: Test translation against recorded vendor payloads | Record real AI model responses as contract test fixtures. Assert canonical output for each. When the model provider changes their API, the contract test fails before your translation code breaks in production. |
| **ADR-005 (Versioning and Migration)**: Handle v2 → v3 vendor transitions | Handle model version transitions (claude-3 → claude-3-5 → claude-4) through the same versioned mapping strategy. The ACL holds the mapping logic; domain services do not change when the model changes. |
