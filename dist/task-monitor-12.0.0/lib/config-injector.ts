import * as fs from 'fs';
import * as path from 'path';

export interface InjectableConfig {
  id: string;
  source: string;
  target: string;
  mode: 'merge' | 'replace' | 'append';
  section?: string;
  required: boolean;
  description: string;
}

export interface InjectConfig {
  version: string;
  injectables: InjectableConfig[];
  onInstall: 'auto' | 'prompt' | 'manual';
  onUpdate: 'auto' | 'prompt' | 'manual';
  backupEnabled: boolean;
  backupDir: string;
  timestampFormat: string;
}

export class ConfigInjector {
  private config: InjectConfig;
  private pluginDir: string;
  private workspaceDir: string;

  constructor(pluginDir: string, workspaceDir: string) {
    this.pluginDir = pluginDir;
    this.workspaceDir = workspaceDir;
    this.config = this.loadConfig();
  }

  private loadConfig(): InjectConfig {
    const configPath = path.join(this.pluginDir, 'workspace-templates', 'inject-config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * 检查目标文件是否存在
   */
  checkTargetExists(injectable: InjectableConfig): boolean {
    const targetPath = path.join(this.workspaceDir, injectable.target);
    return fs.existsSync(targetPath);
  }

  /**
   * 检查目标文件是否已包含指定内容
   */
  checkAlreadyInjected(injectable: InjectableConfig): boolean {
    const targetPath = path.join(this.workspaceDir, injectable.target);
    if (!fs.existsSync(targetPath)) {
      return false;
    }

    const targetContent = fs.readFileSync(targetPath, 'utf-8');
    const sourcePath = path.join(this.pluginDir, injectable.source);
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

    // 检查是否包含关键标识
    if (injectable.section) {
      return targetContent.includes(injectable.section);
    }

    // 检查是否包含模板内容的前几行
    const sourceLines = sourceContent.split('\n').slice(0, 10);
    const sourcePreview = sourceLines.join('\n');
    return targetContent.includes(sourcePreview);
  }

  /**
   * 备份目标文件
   */
  private backupTarget(targetPath: string): string {
    if (!this.config.backupEnabled) {
      return '';
    }

    const backupDir = path.join(this.workspaceDir, this.config.backupDir);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${path.basename(targetPath)}.${timestamp}.bak`;
    const backupPath = path.join(backupDir, backupName);

    fs.copyFileSync(targetPath, backupPath);
    return backupPath;
  }

  /**
   * 合并内容到目标文件
   */
  private mergeContent(targetContent: string, sourceContent: string, section?: string): string {
    if (!section) {
      // 如果没有指定 section，直接追加到文件末尾
      return `${targetContent}\n\n${sourceContent}`;
    }

    // 查找 section 位置
    const sectionIndex = targetContent.indexOf(section);
    if (sectionIndex === -1) {
      // section 不存在，追加到文件末尾
      return `${targetContent}\n\n${sourceContent}`;
    }

    // section 已存在，检查是否已包含内容
    const sectionEnd = targetContent.indexOf('\n## ', sectionIndex + 1);
    const sectionContent = sectionEnd === -1 
      ? targetContent.substring(sectionIndex)
      : targetContent.substring(sectionIndex, sectionEnd);

    if (sectionContent.includes(sourceContent.substring(0, 100))) {
      // 已包含类似内容，不重复注入
      return targetContent;
    }

    // 在 section 后插入内容
    const beforeSection = targetContent.substring(0, sectionEnd);
    const afterSection = targetContent.substring(sectionEnd);
    return `${beforeSection}\n\n${sourceContent}\n${afterSection}`;
  }

  /**
   * 执行注入
   */
  inject(injectable: InjectableConfig): { success: boolean; message: string; backupPath?: string } {
    try {
      const targetPath = path.join(this.workspaceDir, injectable.target);
      const sourcePath = path.join(this.pluginDir, injectable.source);

      // 检查源文件是否存在
      if (!fs.existsSync(sourcePath)) {
        return { success: false, message: `Source file not found: ${sourcePath}` };
      }

      // 读取源内容
      const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

      // 处理目标文件
      let targetContent = '';
      let backupPath = '';

      if (fs.existsSync(targetPath)) {
        // 备份原文件
        backupPath = this.backupTarget(targetPath);
        targetContent = fs.readFileSync(targetPath, 'utf-8');
      }

      // 根据模式处理内容
      let newContent = '';
      switch (injectable.mode) {
        case 'replace':
          newContent = sourceContent;
          break;
        case 'append':
          newContent = targetContent ? `${targetContent}\n\n${sourceContent}` : sourceContent;
          break;
        case 'merge':
        default:
          newContent = this.mergeContent(targetContent, sourceContent, injectable.section);
          break;
      }

      // 写入新内容
      fs.writeFileSync(targetPath, newContent, 'utf-8');

      return {
        success: true,
        message: `Successfully injected ${injectable.id} to ${injectable.target}`,
        backupPath
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to inject ${injectable.id}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * 批量注入
   */
  injectAll(): Array<{ id: string; success: boolean; message: string; backupPath?: string }> {
    const results = [];
    for (const injectable of this.config.injectables) {
      // 检查是否已注入
      if (this.checkAlreadyInjected(injectable)) {
        results.push({
          id: injectable.id,
          success: true,
          message: `Already injected: ${injectable.id}`
        });
        continue;
      }

      // 检查目标文件是否存在（对于 required 的配置项）
      if (injectable.required && !this.checkTargetExists(injectable)) {
        results.push({
          id: injectable.id,
          success: false,
          message: `Target file not found: ${injectable.target}`
        });
        continue;
      }

      // 执行注入
      const result = this.inject(injectable);
      results.push({
        id: injectable.id,
        ...result
      });
    }
    return results;
  }

  /**
   * 检查所有可注入项的状态
   */
  checkAll(): Array<{ id: string; targetExists: boolean; alreadyInjected: boolean; description: string }> {
    const results = [];
    for (const injectable of this.config.injectables) {
      results.push({
        id: injectable.id,
        targetExists: this.checkTargetExists(injectable),
        alreadyInjected: this.checkAlreadyInjected(injectable),
        description: injectable.description
      });
    }
    return results;
  }
}