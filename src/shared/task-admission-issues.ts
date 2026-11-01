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
  FACEBOOK_TASK_DOCUMENT_READ_FAILED: {
    disposition: 'wait',
    category: 'page',
    summary: '正在读取任务页面，等待自动重试',
    next: '页面正在加载或同步，软件将自动重试；无需重复点击。',
  },
  FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED: {
    disposition: 'pause',
    category: 'page',
    summary: 'Facebook 页面已跳转到非任务页，任务已暂停',
    next: '请检查此浏览器的登录状态或验证提示，处理完成后点击继续；软件不会自动反复跳转。',
  },
  FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED: {
    disposition: 'pause',
    category: 'identity',
    summary: '当前 Facebook 账号需要人工验证，任务已暂停',
    next: '请在此浏览器中完成 Facebook 人工验证并回到正常首页后，点击继续。',
  },
  FACEBOOK_ACCOUNT_RESTRICTED: {
    disposition: 'pause',
    category: 'identity',
    summary: '当前 Facebook 账号受限或已封停，任务已暂停',
    next: '该浏览器内的 Facebook 账号已受限或停用，请更换或申诉恢复后再执行任务。',
  },
  FACEBOOK_ACCOUNT_LOGGED_OUT: {
    disposition: 'pause',
    category: 'identity',
    summary: '当前浏览器未登录 Facebook，任务已暂停',
    next: '请在此浏览器中登录 Facebook 账号后，点击继续。',
  },
  FACEBOOK_NATIVE_ACCOUNT_CHANGED: identityIssue,
  FACEBOOK_NATIVE_ACCOUNT_MISMATCH: identityIssue,
  WINDOW_LAYOUT_MAIN_CHANGED: {
    disposition: 'wait',
    category: 'page',
    summary: '主标签页发生切换，等待自动重试',
    next: '窗口主标签页正在更新，软件将自动同步并重试。',
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
  if (Object.hasOwn(issues, reason)) return issues[reason];
  if (reason.startsWith('WINDOW_LAYOUT_'))
    return {
      ...documentIssue,
      summary: '任务窗口需要处理，任务尚未开始',
      next: '检查插件连接和任务窗口布局设置，处理后点击继续；不会反复排队重试。',
    };
  return undefined;
}
