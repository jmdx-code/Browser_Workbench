import type { SoftwareUpdatePort } from '../domain/system-ports.js';
import { UpdateConfig, type UpdateStatus } from '../shared/software-update.js';
import { ProductError, failError } from '../domain/workspace.js';
export class SoftwareUpdateService {
  private checking: Promise<UpdateStatus> | undefined;
  private initialized: Promise<void> | undefined;
  private state: UpdateStatus;
  constructor(
    private readonly port: SoftwareUpdatePort,
    versions: {
      software: string;
      extension: string;
      directory: string;
      aiWorkspaceDirectory?: string;
    },
  ) {
    this.state = {
      currentSoftwareVersion: versions.software,
      currentExtensionVersion: versions.extension,
      extensionDirectory: versions.directory,
      ...(versions.aiWorkspaceDirectory
        ? { aiWorkspaceDirectory: versions.aiWorkspaceDirectory }
        : {}),
      githubRepo: '',
      autoCheck: true,
      checking: false,
      applying: false,
      lastCheckedAt: null,
      availableUpdate: null,
      error: null,
    };
  }
  private async init() {
    if (!this.initialized) {
      const work = this.port
        .readConfig()
        .then((config) => {
          Object.assign(this.state, config);
        })
        .catch((error: unknown) => {
          if (this.initialized === work) this.initialized = undefined;
          throw error;
        });
      this.initialized = work;
    }
    await this.initialized;
  }
  assertIdle() {
    if (this.state.applying)
      throw new ProductError('UPDATE_APPLYING', '正在更新软件，请稍后再启动任务', 409);
  }
  private startCheck(): Promise<UpdateStatus> {
    if (this.checking) return this.checking;
    if (!this.state.githubRepo) {
      this.state.error = null;
      this.state.availableUpdate = null;
      return Promise.resolve(structuredClone(this.state));
    }
    this.state.checking = true;
    this.state.error = null;
    const repo = this.state.githubRepo;
    this.checking = (async () => {
      try {
        this.state.availableUpdate = await this.port.check(repo);
      } catch (error) {
        this.state.error = error instanceof Error ? error.message : '更新检查失败';
      } finally {
        this.state.checking = false;
        this.state.lastCheckedAt = new Date().toISOString();
        this.checking = undefined;
      }
      return structuredClone(this.state);
    })();
    return this.checking;
  }
  async status() {
    await this.init();
    if (
      this.state.githubRepo &&
      this.state.autoCheck &&
      !this.state.checking &&
      !this.state.applying &&
      (!this.state.lastCheckedAt || Date.now() - Date.parse(this.state.lastCheckedAt) > 1_800_000)
    ) {
      void this.startCheck().catch(() => {});
    }
    return structuredClone(this.state);
  }
  async configure(input: unknown) {
    await this.init();
    this.assertIdle();
    if (this.checking) await this.checking;
    const config = UpdateConfig.parse(input);
    await this.port.saveConfig(config);
    Object.assign(this.state, config, { availableUpdate: null, lastCheckedAt: null, error: null });
    return this.check();
  }
  async check() {
    await this.init();
    this.assertIdle();
    return this.startCheck();
  }
  async apply() {
    await this.init();
    this.assertIdle();
    if (this.state.checking) throw new ProductError('UPDATE_CHECKING', '请等待更新检查完成', 409);
    const release = this.state.availableUpdate;
    if (!release) throw new ProductError('UPDATE_NOT_AVAILABLE', '暂无可更新版本', 409);
    if (release.requiresInstaller)
      failError('UPDATE_INSTALLER_REQUIRED', '底层引擎或依赖已变化，请下载完整安装包更新', 409);
    await this.port.assertCanApply();
    this.state.applying = true;
    this.state.error = null;
    try {
      await this.port.install(release, () => this.port.assertCanApply());
      try {
        await this.port.reloadExtensions();
      } catch {
        // Runtime files are already swapped on disk; proceed to restart cleanly.
      }
      this.port.restart();
      return { requested: true };
    } catch (error) {
      this.state.applying = false;
      this.state.error = error instanceof Error ? error.message : '更新失败';
      throw error;
    }
  }
  reload(ids?: string[]) {
    this.assertIdle();
    return this.port.reloadExtensions(ids);
  }
  async openDirectory() {
    await this.port.openExtensionDirectory();
    return { opened: true };
  }
  async openAiWorkspace() {
    if (!this.port.openAiWorkspaceDirectory)
      throw new ProductError('UPDATE_DESKTOP_REQUIRED', '请在桌面工作台中打开 AI 专属工作夹', 409);
    const { directory } = await this.port.openAiWorkspaceDirectory();
    return { opened: true, directory };
  }
}
