import type { ITaskTemplate, ITaskTemplateManager, ITaskFactory, ITaskConfig, ITaskDependencies, ITask } from '../core/interfaces';

/**
 * 任务模板管理器
 * 
 * 职责：
 * - 管理任务模板
 * - 从模板创建任务
 */
export class TaskTemplateManager implements ITaskTemplateManager {
  private templates: Map<string, ITaskTemplate> = new Map();
  private logger: any;
  
  constructor(logger?: any) {
    this.logger = logger;
  }
  
  /**
   * 注册模板
   */
  public registerTemplate(template: ITaskTemplate): void {
    if (this.templates.has(template.name)) {
      this.logger?.warn?.(
        `[TemplateManager] Template already exists: ${template.name}, overwriting`
      );
    }
    
    this.templates.set(template.name, template);
    this.logger?.info?.(`[TemplateManager] Template registered: ${template.name}`);
  }
  
  /**
   * 获取模板
   */
  public getTemplate(name: string): ITaskTemplate | undefined {
    return this.templates.get(name);
  }
  
  /**
   * 从模板创建任务
   */
  public createFromTemplate(
    templateName: string,
    factory: ITaskFactory,
    dependencies: ITaskDependencies,
    overrides?: Partial<ITaskConfig>
  ): ITask {
    const template = this.templates.get(templateName);
    
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }
    
    const config = template.createConfig(overrides);
    
    this.logger?.debug?.(
      `[TemplateManager] Creating task from template: ${templateName} -> ${config.id}`
    );
    
    return factory.createTask(config, dependencies);
  }
  
  /**
   * 检查模板是否存在
   */
  public hasTemplate(name: string): boolean {
    return this.templates.has(name);
  }
  
  /**
   * 注销模板
   */
  public unregisterTemplate(name: string): boolean {
    const deleted = this.templates.delete(name);
    if (deleted) {
      this.logger?.info?.(`[TemplateManager] Template unregistered: ${name}`);
    }
    return deleted;
  }
  
  /**
   * 获取所有模板名称
   */
  public getTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }
}

// ==================== 预定义模板 ====================

/**
 * 代码审查任务模板
 */
export const CodeReviewTemplate: ITaskTemplate = {
  name: 'code-review',
  description: '代码审查任务',
  
  createConfig(overrides?: Partial<ITaskConfig>): ITaskConfig {
    return {
      id: `review-${Date.now()}`,
      type: 'sub',
      timeoutMs: 15 * 60 * 1000, // 15 分钟
      maxRetries: 1,
      label: '代码审查',
      metadata: {
        category: 'code-review',
        priority: 'high',
      },
      ...overrides,
    };
  },
};

/**
 * 文档生成任务模板
 */
export const DocGenTemplate: ITaskTemplate = {
  name: 'doc-gen',
  description: '文档生成任务',
  
  createConfig(overrides?: Partial<ITaskConfig>): ITaskConfig {
    return {
      id: `doc-${Date.now()}`,
      type: 'sub',
      timeoutMs: 10 * 60 * 1000, // 10 分钟
      maxRetries: 2,
      label: '文档生成',
      metadata: {
        category: 'doc-gen',
        priority: 'normal',
      },
      ...overrides,
    };
  },
};

/**
 * 数据处理任务模板
 */
export const DataProcessingTemplate: ITaskTemplate = {
  name: 'data-processing',
  description: '数据处理任务',
  
  createConfig(overrides?: Partial<ITaskConfig>): ITaskConfig {
    return {
      id: `data-${Date.now()}`,
      type: 'sub',
      timeoutMs: 30 * 60 * 1000, // 30 分钟
      maxRetries: 2,
      label: '数据处理',
      metadata: {
        category: 'data-processing',
        priority: 'normal',
      },
      ...overrides,
    };
  },
};

export default TaskTemplateManager;
