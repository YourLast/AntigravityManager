import { Injectable, Logger } from '@nestjs/common';
import { TokenManagerService } from './token-manager.service';
import { GeminiClient } from './clients/gemini.client';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  GeminiContent,
  GeminiPart,
  AnthropicSystemBlock,
  OpenAIContentPart,
  GeminiResponse,
  GeminiRequest,
  AnthropicChatResponse,
  OpenAIChatResponse,
  GeminiCandidate,
} from './interfaces/request-interfaces';
import { serverConfig } from '../../server-config';
import {
  calculateBackoffDelay,
  isRetryableError,
  sleep,
  DEFAULT_RETRY_CONFIG,
} from '../../../utils/retry';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  constructor(
    private readonly tokenManager: TokenManagerService,
    private readonly geminiClient: GeminiClient,
  ) {}

  // --- Anthropic Handlers ---

  async handleAnthropicMessages(
    request: AnthropicChatRequest,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    const targetModel = this.mapModel(request.model);
    this.logger.log(
      `Received Anthropic request for model: ${request.model} (Mapped: ${targetModel}, Stream: ${request.stream})`,
    );

    // Retry loop with exponential backoff
    let lastError: unknown = null;
    const retryConfig = serverConfig?.retry ?? DEFAULT_RETRY_CONFIG;
    const maxRetries = retryConfig.maxRetries;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const token = await this.tokenManager.getNextToken();
      if (!token) {
        throw new Error('No available accounts');
      }

      try {
        // Convert Anthropic -> Gemini
        const geminiRequest = this.convertAnthropicToGemini(request);

        if (request.stream) {
          const stream = await this.geminiClient.streamGenerate(
            targetModel,
            geminiRequest,
            token.token.access_token,
          );
          return this.processAnthropicStreamResponse(stream, request.model);
        } else {
          const response = await this.geminiClient.generate(
            targetModel,
            geminiRequest,
            token.token.access_token,
          );
          return this.convertGeminiToAnthropicResponse(response, request.model);
        }
      } catch (error) {
        lastError = error;
        if (error instanceof Error) {
          this.logger.warn(`Anthropic Request failed: ${error.message}`);
          if (isRetryableError(error)) {
            this.tokenManager.markAsRateLimited(token.email);

            // Wait before retry with exponential backoff
            if (attempt < maxRetries - 1) {
              const delay = calculateBackoffDelay(attempt, retryConfig);
              this.logger.log(`Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
              await sleep(delay);
            }
          } else {
            // Non-retryable error, throw immediately
            throw error;
          }
        }
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private convertAnthropicToGemini(request: AnthropicChatRequest): GeminiRequest {
    const contents: GeminiContent[] = [];
    let systemInstruction: { parts: GeminiPart[] } | undefined = undefined;

    if (request.system) {
      let systemText = '';
      if (typeof request.system === 'string') {
        systemText = request.system;
      } else if (Array.isArray(request.system)) {
        systemText = request.system
          .filter((b: AnthropicSystemBlock) => b.type === 'text')
          .map((b: AnthropicSystemBlock) => b.text)
          .join('\n');
      }

      systemInstruction = {
        parts: [{ text: systemText }],
      };
    }

    // Anthropic 'messages' -> Gemini 'contents'
    for (const msg of request.messages) {
      const role = msg.role === 'user' ? 'user' : 'model';
      // Handle content arrays or strings
      let textPart = '';
      if (Array.isArray(msg.content)) {
        textPart = msg.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { type: 'text'; text: string }).text)
          .join('\n');
      } else {
        textPart = msg.content;
      }

      contents.push({
        role,
        parts: [{ text: textPart }],
      });
    }

    return {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.max_tokens,
        topP: request.top_p,
        topK: request.top_k,
      },
      // Note: Rust version handles 'pending_images' logic here, but for now we assume simple text/image structure.
      // If we need to support image injection from history to user msg, that logic needs to be ported too.
      // Current port matches previous 'any' style logic but with types.
    };
  }

  private convertGeminiToAnthropicResponse(
    geminiResponse: GeminiResponse,
    model: string,
  ): AnthropicChatResponse {
    const candidate = geminiResponse.candidates?.[0];
    const processed = this.processInlineData(candidate);
    const parts = processed?.content?.parts || [];
    const contentText = parts.map((p) => p.text || '').join('');

    return {
      id: `msg_${uuidv4()}`,
      type: 'message',
      role: 'assistant',
      model: model,
      content: [{ type: 'text', text: contentText }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
        output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
      },
    };
  }

  private processAnthropicStreamResponse(upstreamStream: any, model: string): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      const msgId = `msg_${uuidv4()}`;

      // Send Message Start
      subscriber.next(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`,
      );

      subscriber.next(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })}\n\n`,
      );

      upstreamStream.on('data', (chunk: Buffer) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const json = JSON.parse(dataStr);
            const candidate = json.candidates?.[0];
            const contentPart = candidate?.content?.parts?.[0];
            const text = contentPart?.text || '';

            if (text) {
              subscriber.next(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: text },
                })}\n\n`,
              );
            }
          } catch (e) {}
        }
      });

      upstreamStream.on('end', () => {
        subscriber.next(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0,
          })}\n\n`,
        );

        subscriber.next(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 0 },
          })}\n\n`,
        );

        subscriber.next(
          `event: message_stop\ndata: ${JSON.stringify({
            type: 'message_stop',
          })}\n\n`,
        );

        subscriber.complete();
      });

      upstreamStream.on('error', (err: any) => subscriber.error(err));
    });
  }

  // --- OpenAI / Universal Handlers ---

  async handleChatCompletions(
    request: OpenAIChatRequest,
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const targetModel = this.mapModel(request.model);
    this.logger.log(
      `Received request for model: ${request.model} (Mapped: ${targetModel}, Stream: ${request.stream})`,
    );

    // Retry loop with exponential backoff
    let lastError: unknown = null;
    const retryConfig = serverConfig?.retry ?? DEFAULT_RETRY_CONFIG;
    const maxRetries = retryConfig.maxRetries;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // 1. Get Token
      const token = await this.tokenManager.getNextToken();
      if (!token) {
        throw new Error('No available accounts (all exhausted or rate limited)');
      }

      try {
        // 2. Convert Request
        const geminiRequest = this.convertOpenAIToGemini(request);

        // 3. Handle Stream vs Non-Stream
        if (request.stream) {
          const stream = await this.geminiClient.streamGenerate(
            targetModel,
            geminiRequest,
            token.token.access_token,
          );
          // Record successful request for RPM tracking
          this.tokenManager.recordRequest(token.id);
          return this.processStreamResponse(stream, request.model);
        } else {
          const response = await this.geminiClient.generate(
            targetModel,
            geminiRequest,
            token.token.access_token,
          );
          // Record successful request for RPM tracking
          this.tokenManager.recordRequest(token.id);
          return this.convertGeminiToOpenAIResponse(response, request.model);
        }
      } catch (error) {
        lastError = error;
        if (error instanceof Error) {
          this.logger.warn(`Request failed with account ${token.email}: ${error.message}`);

          // Check for rate limit / auth errors
          if (isRetryableError(error)) {
            this.tokenManager.markAsRateLimited(token.email);

            // Wait before retry with exponential backoff
            if (attempt < maxRetries - 1) {
              const delay = calculateBackoffDelay(attempt, retryConfig);
              this.logger.log(`Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
              await sleep(delay);
            }
          } else {
            // Non-retryable error, throw immediately
            throw error;
          }
        }
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  // Handle SSE Stream conversion
  private processStreamResponse(upstreamStream: any, model: string): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      upstreamStream.on('data', (chunk: Buffer) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const json = JSON.parse(dataStr);
            const candidate = json.candidates?.[0];
            const contentPart = candidate?.content?.parts?.[0];
            const text = contentPart?.text || '';

            const openAICheck = {
              id: `chatcmpl-${uuidv4()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [
                {
                  index: 0,
                  delta: { content: text },
                  finish_reason: candidate?.finishReason ? 'stop' : null,
                },
              ],
            };

            subscriber.next(`data: ${JSON.stringify(openAICheck)}\n\n`);

            if (candidate?.finishReason) {
              subscriber.next('data: [DONE]\n\n');
              subscriber.complete();
            }
          } catch (e) {
            // ignore parse errors
          }
        }
      });

      upstreamStream.on('end', () => {
        subscriber.complete();
      });

      upstreamStream.on('error', (err: any) => {
        subscriber.error(err);
      });
    });
  }

  private convertOpenAIToGemini(request: OpenAIChatRequest): GeminiRequest {
    const contents: GeminiContent[] = [];
    let systemInstruction: { parts: GeminiPart[] } | undefined = undefined;

    // Extract system message
    const messages = request.messages || [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemInstruction = {
            parts: [{ text: msg.content }],
          };
        }
      } else {
        let textPart = '';
        if (Array.isArray(msg.content)) {
          // OpenAI multimodal array
          textPart = msg.content
            .filter((p: OpenAIContentPart) => p.type === 'text')
            .map((p: OpenAIContentPart) => p.text || '')
            .join('\n');
        } else {
          textPart = msg.content;
        }

        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: textPart }],
        });
      }
    }

    return {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.max_tokens,
        topP: request.top_p,
      },
    };
  }

  private convertGeminiToOpenAIResponse(
    geminiResponse: GeminiResponse,
    model: string,
  ): OpenAIChatResponse {
    const candidate = geminiResponse.candidates?.[0];
    if (!candidate) throw new Error('No candidates in response');

    // Process response for images
    const processedCandidate = this.processInlineData(candidate);

    const parts = processedCandidate?.content?.parts || [];
    const content = parts.map((p) => p.text || '').join('');

    const finishReason =
      candidate?.finishReason === 'STOP'
        ? 'stop'
        : candidate?.finishReason?.toLowerCase() || 'stop';

    return {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content,
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
        completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0,
      },
    };
  }

  // Convert Gemini inlineData (images) to Markdown
  private processInlineData(candidate: GeminiCandidate | undefined): GeminiCandidate | undefined {
    if (!candidate?.content?.parts) return candidate;

    const newParts = candidate.content.parts.map((part) => {
      if (part.inlineData) {
        const mimeType = part.inlineData.mimeType || 'image/jpeg';
        const data = part.inlineData.data || '';
        return {
          text: `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`,
        };
      }
      return part;
    });

    return {
      ...candidate,
      content: {
        ...candidate.content,
        parts: newParts,
      },
    };
  }

  private mapModel(model: string): string {
    const lower = model.toLowerCase();
    if (lower.includes('sonnet') || lower.includes('thinking')) return 'gemini-3-pro-preview';
    if (lower.includes('haiku')) return 'gemini-2.0-flash-exp';
    if (lower.includes('opus')) return 'gemini-3-pro-preview';
    if (lower.includes('claude')) return 'gemini-2.5-flash-thinking';
    if (lower === 'gemini-3-pro-high' || lower === 'gemini-3-pro-low')
      return 'gemini-3-pro-preview';
    if (lower === 'gemini-3-flash') return 'gemini-3-flash-preview';

    // Default to original if no mapping found
    return model;
  }

  private shouldRetry(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase();
    if (
      msg.includes('404') ||
      msg.includes('not_found') ||
      msg.includes('403') ||
      msg.includes('permission_denied')
    )
      return true;
    if (
      msg.includes('429') ||
      msg.includes('resource_exhausted') ||
      msg.includes('quota') ||
      msg.includes('rate_limit')
    )
      return true;
    return false;
  }
}
