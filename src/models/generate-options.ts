import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

/** Optional output hint understood by runtime adapters; callers must still validate the response. */
export type RuntimeGenerateOptions = GenerateOptions & { responseFormat?: 'json-object' };
