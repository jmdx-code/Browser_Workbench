type AdmissionIssue = {
  disposition: 'pause' | 'wait';
  category: 'page' | 'identity' | 'extension' | 'capacity';
  summary: string;
  next: string;
};
const identityIssue: AdmissionIssue = {
  disposition: 'pause',
  category: 'identity',
  summary: '无法确认当前 Facebook 账号，任务未开始',
  next: '检查此浏览器的登录及页面提示，处理后点击继续；软件不会反复打开检查页。',
};
const documentIssue: AdmissionIssue = {
  disposition: 'pause',
  category: 'page',
  summary: '无法读取任务页面，任务未开始',
  next: '确认页面和插件连接正常后点击继续；软件不会自动反复打开检查页。',
};
const extensionIssue: AdmissionIssue = {
  disposition: 'pause',
  category: 'extension',
  summary: '当前插件不支持本次任务',
  next: '更新这份浏览器中的正式插件，连接恢复后点击继续。',
};
const issues: Record<string, AdmissionIssue> = {
  FACEBOOK_TASK_DOCUMENT_TIMEOUT: {
    ...documentIssue,
    summary: 'Facebook 页面加载超时，任务未开始',
  },
  FACEBOOK_TASK_DOCUMENT_READ_FAILED: documentIssue,
  FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED: {
    ...documentIssue,
    summary: '任务页面发生跳转，任务未开始',
  },
  FACEBOOK_CURRENT_NATIVE_IDENTITY_UNCONFIRMED: identityIssue,
  FACEBOOK_CURRENT_CREATOR_UNCONFIRMED: identityIssue,
  FACEBOOK_CURRENT_NATIVE_BOOTSTRAP_REQUIRED: identityIssue,
  FACEBOOK_TASK_EXTENSION_UPDATE_REQUIRED: extensionIssue,
  MARKETPLACE_BRIDGE_UPDATE_REQUIRED: extensionIssue,
  CONCURRENCY_LIMIT: {
    disposition: 'wait',
    category: 'capacity',
    summary: '等待执行名额',
    next: '将按设置的同时执行数排队；无需重复点击启动。',
  },
};
export function taskAdmissionIssue(reason: string): AdmissionIssue | undefined {
  if (reason === 'WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED') return extensionIssue;
  if (reason.startsWith('WINDOW_LAYOUT_'))
    return {
      ...documentIssue,
      summary: '任务窗口需要处理，任务尚未开始',
      next: '检查插件连接和任务窗口布局设置，处理后点击继续；不会反复排队重试。',
    };
  return Object.hasOwn(issues, reason) ? issues[reason] : undefined;
}
