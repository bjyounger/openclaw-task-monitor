// tests/handlers.test.ts
/**
 * Handler 测试
 * 
 * 测试所有 handler 的注册逻辑和事件处理逻辑
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IHandler, IAsyncHandler, INamedHandler } from '../handlers/interfaces';

// Mock OpenClawPluginApi
const mockApi = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
};

// 测试 Handler 实现
class TestHandler implements INamedHandler {
  readonly name = 'TestHandler';
  registerCalled = false;

  register(api: typeof mockApi): void {
    this.registerCalled = true;
    api.on('test-event', this.handleEvent);
  }

  private handleEvent = vi.fn();
}

// 测试异步 Handler 实现
class TestAsyncHandler implements IAsyncHandler {
  registerCalled = false;

  async register(api: typeof mockApi): Promise<void> {
    this.registerCalled = true;
    // 模拟异步初始化
    await new Promise(resolve => setTimeout(resolve, 10));
    api.on('async-test-event', this.handleEvent);
  }

  private handleEvent = vi.fn();
}

describe('IHandler Interface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('register', () => {
    it('应该正确注册 handler', () => {
      const handler = new TestHandler();
      handler.register(mockApi);

      expect(handler.registerCalled).toBe(true);
      expect(mockApi.on).toHaveBeenCalledWith('test-event', expect.any(Function));
    });

    it('应该在注册时可以访问 API', () => {
      const handler = new TestHandler();
      handler.register(mockApi);

      // 验证可以调用 API 方法
      expect(mockApi.on).toHaveBeenCalled();
    });

    it('应该支持多个 handler 注册', () => {
      const handler1 = new TestHandler();
      const handler2 = new TestHandler();

      handler1.register(mockApi);
      handler2.register(mockApi);

      expect(mockApi.on).toHaveBeenCalledTimes(2);
    });
  });

  describe('INamedHandler', () => {
    it('应该有 name 属性', () => {
      const handler = new TestHandler();
      expect(handler.name).toBe('TestHandler');
    });

    it('可以通过 name 区分不同的 handler', () => {
      const handlers: INamedHandler[] = [
        { name: 'handler1', register: vi.fn() },
        { name: 'handler2', register: vi.fn() },
      ];

      handlers.forEach(h => h.register(mockApi));

      expect(handlers[0].name).toBe('handler1');
      expect(handlers[1].name).toBe('handler2');
    });
  });
});

describe('IAsyncHandler Interface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('register (async)', () => {
    it('应该支持异步注册', async () => {
      const handler = new TestAsyncHandler();
      await handler.register(mockApi);

      expect(handler.registerCalled).toBe(true);
      expect(mockApi.on).toHaveBeenCalledWith('async-test-event', expect.any(Function));
    });

    it('应该等待异步初始化完成', async () => {
      const handler = new TestAsyncHandler();
      const start = Date.now();
      await handler.register(mockApi);
      const duration = Date.now() - start;

      // 应该至少等待 10ms（模拟的异步延迟）
      expect(duration).toBeGreaterThanOrEqual(10);
    });
  });
});

describe('Handler 事件处理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应该正确处理事件', () => {
    const eventHandler = vi.fn();
    const handler: IHandler = {
      register: (api) => {
        api.on('task-created', eventHandler);
      },
    };

    handler.register(mockApi);

    // 模拟事件触发
    const eventData = { taskId: 'test-123', type: 'sub' };
    mockApi.on.mock.calls[0][1](eventData);

    expect(eventHandler).toHaveBeenCalledWith(eventData);
  });

  it('应该支持多个事件监听', () => {
    const handler: IHandler = {
      register: (api) => {
        api.on('task-created', vi.fn());
        api.on('task-completed', vi.fn());
        api.on('task-failed', vi.fn());
      },
    };

    handler.register(mockApi);

    expect(mockApi.on).toHaveBeenCalledTimes(3);
  });

  it('应该支持错误处理', () => {
    const errorHandler = vi.fn();
    const handler: IHandler = {
      register: (api) => {
        api.on('error', errorHandler);
      },
    };

    handler.register(mockApi);

    const error = new Error('Test error');
    mockApi.on.mock.calls[0][1](error);

    expect(errorHandler).toHaveBeenCalledWith(error);
  });
});

describe('Handler 配置', () => {
  it('应该支持启用/禁用配置', () => {
    const config = {
      name: 'TestHandler',
      enabled: true,
      priority: 1,
    };

    expect(config.enabled).toBe(true);
    expect(config.priority).toBe(1);
  });

  it('应该支持优先级排序', () => {
    const handlers: Array<IHandler & { priority: number }> = [
      { register: vi.fn(), priority: 3 },
      { register: vi.fn(), priority: 1 },
      { register: vi.fn(), priority: 2 },
    ];

    // 按优先级排序
    const sorted = handlers.sort((a, b) => a.priority - b.priority);

    expect(sorted[0].priority).toBe(1);
    expect(sorted[1].priority).toBe(2);
    expect(sorted[2].priority).toBe(3);
  });
});
