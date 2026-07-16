export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'openrouter';

export type LogicalModel =
  | 'qimo.fast-text'
  | 'qimo.reasoning'
  | 'qimo.vision'
  | 'qimo.structured-extraction'
  | 'qimo.finance-readonly';

export type AICapability =
  | 'text'
  | 'reasoning'
  | 'vision'
  | 'structured-extraction'
  | 'finance-readonly';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ToolSafetyLevel = 'READ_ONLY' | 'DRAFT' | 'WRITE_REQUIRES_APPROVAL' | 'FORBIDDEN';

export interface UsageMetadata {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface RuntimeMetadata {
  provider: ProviderName;
  model: string;
  logicalModel: LogicalModel;
  latencyMs: number;
  requestId?: string;
  traceId: string;
  usage: UsageMetadata;
  fallbackUsed: boolean;
  primaryProvider: ProviderName;
  requestedProvider: ProviderName;
  fallbackReason?: string;
  attempts: ProviderAttempt[];
}

export interface ProviderAttempt {
  provider: ProviderName;
  model?: string;
  status: 'unavailable' | 'failed' | 'success';
  errorCode?: string;
  latencyMs: number;
}

export interface RuntimeResult<T> {
  data: T;
  metadata: RuntimeMetadata;
}

export interface JSONSchema {
  [key: string]: unknown;
}

export interface SchemaValidator<T> {
  name: string;
  jsonSchema: JSONSchema;
  /** Runtime V1 requires strict structured output schemas for OpenAI. */
  strict?: true;
  parse(value: unknown): T;
}

export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64: string;
  detail?: 'low' | 'high' | 'auto';
}

export interface FileInput {
  filename: string;
  mediaType: 'application/pdf';
  base64: string;
}

export interface RuntimeRequestBase {
  scene: string;
  logicalModel?: LogicalModel;
  capability: AICapability;
  riskLevel?: RiskLevel;
  system?: string;
  prompt: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  traceId?: string;
  fallback?: 'allowed' | 'disabled';
}

export interface GenerateTextRequest extends RuntimeRequestBase {
  capability: 'text' | 'reasoning' | 'finance-readonly';
}

export interface GenerateObjectRequest<T> extends RuntimeRequestBase {
  capability: 'structured-extraction' | 'finance-readonly';
  schema: SchemaValidator<T>;
  image?: ImageInput;
  file?: FileInput;
}

export interface VisionRequest<T = string> extends RuntimeRequestBase {
  capability: 'vision' | 'structured-extraction';
  image: ImageInput;
  schema?: SchemaValidator<T>;
}

export interface ProviderAvailability {
  available: boolean;
  reason?: string;
}

export interface ProviderResponse<T> {
  data: T;
  provider: ProviderName;
  model: string;
  latencyMs: number;
  requestId?: string;
  usage: UsageMetadata;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  available(model: string): ProviderAvailability | Promise<ProviderAvailability>;
  generateText(request: GenerateTextRequest, model: string): Promise<ProviderResponse<string>>;
  generateObject<T>(request: GenerateObjectRequest<T>, model: string): Promise<ProviderResponse<T>>;
  vision<T = string>(request: VisionRequest<T>, model: string): Promise<ProviderResponse<T>>;
}

export interface StreamTextReservation {
  readonly status: 'reserved-v1';
}
export interface ToolLoopReservation {
  readonly status: 'reserved-v1';
  readonly safetyLevel: ToolSafetyLevel;
}
export interface BatchReservation {
  readonly status: 'reserved-v1';
}
