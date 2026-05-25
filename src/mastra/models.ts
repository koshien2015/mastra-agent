import { ollama } from 'ollama-ai-provider';

export const defaultModel = ollama(process.env.OLLAMA_MODEL ?? 'llama3.1');
