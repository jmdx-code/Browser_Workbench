import type { SoftwareUpdatePort } from '../domain/software-update.js';
import { UpdateConfig, type UpdateStatus } from '../shared/software-update.js';
import { ProductError } from '../domain/workspace.js';
export class SoftwareUpdateService {
  private checking: Promise<UpdateStatus> | undefined;
  private initialized: Promise<void> | undefined;
  private state: UpdateStatus;
  constructor(
    private readonly port: SoftwareUpdatePort,
    versions: { software: string; extension: string; directory: string },
  ) {
    this.state = {
      currentSoftwareVersion: versions.software,
      currentExtensionVersion: versions.extension,
      extensionDirectory: versions.directory,
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
    this.initialized ??= this.port.readConfig().then((config) => {
      Object.assign(this.state, config);
    });
    await this.initialized;
  }
  assertIdle() {
    if (this.state.applying)
      throw new ProductError('UPDATE_APPLYING', '正在更新软件，请稍后再启动任务', 409);
  }
  async status() {
    await this.init();
    if (
      this.state.githubRepo &&
      this.state.autoCheck &&
      !this.state.checking &&
      !this.state.applying &&
      (!this.state.lastCheckedAt || Date.now() - Date.parse(this.state.lastCheckedAt) > 1_800_000)
    )
      await this.check();
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
    if (this.checking) return this.checking;
    if (!this.state.githubRepo) {
      this.state.error = null;
      this.state.availableUpdate = null;
      return structuredClone(this.state);
    }
    this.state.checking = true;
    this.state.error = null;
    this.checking = (async () => {
      try {
        this.state.availableUpdate = await this.port.check(this.state.githubRepo);
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
  async apply() {
    await this.init();
    this.assertIdle();
    if (this.state.checking) throw new ProductError('UPDATE_CHECKING', '请等待更新检查完成', 409);
    const release = this.state.availableUpdate;
    if (!release) throw new ProductError('UPDATE_NOT_AVAILABLE', '暂无可更新版本', 409);
    if (release.requiresInstaller)
      throw new ProductError(
        'UPDATE_INSTALLER_REQUIRED',
        '底层引擎或依赖已变化，请下载完整安装包更新',
        409,
      );
    await this.port.assertCanApply();
    this.state.applying = true;
    this.state.error = null;
    try {
      await this.port.install(release, () => this.port.assertCanApply());
      await this.port.reloadExtensions();
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
}
