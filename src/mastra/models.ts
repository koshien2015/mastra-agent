import { ollama } from 'ollama-ai-provider-v2';

export const defaultModel = ollama(process.env.OLLAMA_MODEL ?? 'llama3.1');
