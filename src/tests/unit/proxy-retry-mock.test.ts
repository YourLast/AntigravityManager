import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ProxyService } from '../../server/modules/proxy/proxy.service';
import { Observable } from 'rxjs';

// Mock dependencies
const mockTokenManager = { getNextToken: vi.fn(), markAsRateLimited: vi.fn() };
const mockGeminiClient = { streamGenerateInternal: vi.fn(), generateInternal: vi.fn() };

// Subclass to access private method
class TestableProxyService extends ProxyService {
  constructor() {
    super(mockTokenManager as any, mockGeminiClient as any);
  }

  public testProcessStream(stream: any, model: string = 'model'): Observable<string> {
    // Access private method using type assertion
    return (this as any).processAnthropicInternalStream(stream, model);
  }
}

describe('ProxyService Empty Stream Retry Logic', () => {
  it('should emit error when stream ends without data', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    const resultObservable = service.testProcessStream(stream);

    let errorReceived: Error | undefined;

    const promise = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: () => {},
        error: (err) => {
          errorReceived = err;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    // Simulate empty stream: straight to end
    setTimeout(() => stream.emit('end'), 10);

    await promise;

    expect(errorReceived).toBeDefined();
    expect(errorReceived?.message).toBe('Empty response stream');
  });

  it('should NOT emit error when stream has data', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    const resultObservable = service.testProcessStream(stream);

    let errorReceived: Error | undefined;
    const receivedChunks: string[] = [];

    const promise = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: (c) => receivedChunks.push(c),
        error: (err) => {
          errorReceived = err;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    // Simulate valid data stream
    setTimeout(() => {
      const validJson = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'hello' }] },
            finishReason: 'STOP',
          },
        ],
      });
      stream.emit('data', Buffer.from(`data: ${validJson}\n\n`));
      stream.emit('end');
    }, 10);

    await promise;

    expect(errorReceived).toBeUndefined();
    // It should produce chunks (though exact number depends on mapper logic, at least it shouldn't error)
    // Actually our mapper might produce "message_start", "content_block_start" etc.
    // We just care that it didn't error with "Empty response stream"
  });
});
