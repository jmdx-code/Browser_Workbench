import type { BrowserWindow } from 'electron';
import { readFile, writeFile, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Opt-in integration fixture; never permitted on a product data directory.
export async function cleanupDesktopSmoke(
  window: BrowserWindow,
  origin: string,
  cookie: string,
  dataDir: string,
  report: string,
) {
  if (
    process.env.WORKBENCH_SMOKE_CLEANUP_UI !== '1' &&
    process.env.WORKBENCH_SMOKE_RESET !== '1' &&
    process.env.WORKBENCH_SMOKE_RELEASE_POLISH !== '1'
  )
    return {};
  const directory = await realpath(dataDir),
    temp = await realpath(tmpdir());
  const parent = path.dirname(directory);
  if (
    path.dirname(parent).toLowerCase() !== temp.toLowerCase() ||
    !path.basename(parent).startsWith('workbench-desktop-') ||
    path.basename(directory) !== 'data'
  )
    throw Error('CLEANUP_SMOKE_REQUIRES_GENERATED_TEMP_DIRECTORY');
  let cleanupUi = false;
  let releasePolish: unknown;
  if (process.env.WORKBENCH_SMOKE_RELEASE_POLISH === '1') {
    releasePolish = await window.webContents.executeJavaScript(`(async () => {
      const wait = async (find) => { const deadline=Date.now()+10000; while(Date.now()<deadline){const found=find();if(found)return found;await new Promise(r=>setTimeout(r,40));}throw Error('POLISH_UI_NOT_READY'); };
      await new Promise(r=>setTimeout(r,1200));
      const all=[...document.querySelectorAll('.filters button, .profile-filters button, .profile-list-filter button, .sidebar button')].find(b=>b.textContent.trim()==='全部');
      if(all)all.click();
      await new Promise(r=>setTimeout(r,300));
      const statuses=[...document.querySelectorAll('.profile-list .task-line-text')].map(e=>e.textContent.trim());
      document.querySelector('button[aria-label="打开菜单"]').click();
      (await wait(()=>[...document.querySelectorAll('aside[aria-label="软件菜单"] button')].find(b=>b.textContent.includes('可选组件')))).click();
      const panel=await wait(()=>document.querySelector('section[aria-label="可选组件"]'));
      await wait(()=>panel.querySelector('button')||panel.textContent.includes('尚未提供'));
      if(!panel.textContent.includes('浏览任务、普通视频帖子、无文案视频快拍均不需要安装'))throw Error('OPTIONAL_SCOPE_NOT_CLEAR');
      const icon=await fetch('/app-icon.svg'); if(!icon.ok||!icon.headers.get('content-type').includes('image/svg'))throw Error('ICON_NOT_SERVED');
      return {optionalPanel:true,iconServed:true,sidebarStatuses:statuses,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    // Hidden-window capture can reuse the previous compositor surface on
    // Windows. Show this isolated fixture without activating it before QA.
    window.showInactive();
    await window.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,250))))',
    );
    await writeFile(
      report + '.media-component.png',
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="关闭菜单"]\').click();true',
    );
    window.hide();
  }
  if (process.env.WORKBENCH_SMOKE_CLEANUP_UI === '1') {
    await window.webContents.executeJavaScript(`(async () => {
      const wait = async (find) => { const deadline=Date.now()+10000; while(Date.now()<deadline) {const found=find(); if(found)return found; await new Promise(r=>setTimeout(r,40));}throw Error('CLEANUP_UI_NOT_READY'); };
      document.querySelector('button[aria-label="打开菜单"]').click();
      const button=await wait(()=>[...document.querySelectorAll('aside[aria-label="软件菜单"] button')].find(b=>b.textContent.includes('日志与数据清理'))); button.click();
      await wait(()=>document.querySelector('section[aria-label="数据清理"]'));
      await wait(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='保存自动清理设置'&&!b.disabled));
      if(document.querySelector('section[aria-label="数据清理"]').textContent.includes('自动清理')===false)throw Error('CLEANUP_CONTROLS_MISSING');
      [...document.querySelectorAll('button')].find(b=>b.textContent==='预览清空运行与诊断日志').click();
      const preview=await wait(()=>document.querySelector('dialog[open][aria-label="确认清理数据"]'));
      await wait(()=>preview.textContent.includes('可清理')); [...preview.querySelectorAll('button')].find(b=>b.textContent==='取消').click();
      const reset=[...document.querySelectorAll('button')].find(b=>b.textContent==='彻底重置工作台…');
      if(reset&&!reset.disabled){reset.click();const dialog=await wait(()=>document.querySelector('dialog[open][aria-label="彻底重置工作台"]'));const submit=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='删除全部工作台数据并重启');if(!submit?.disabled)throw Error('RESET_CONFIRMATION_NOT_REQUIRED');[...dialog.querySelectorAll('button')].find(b=>b.textContent==='取消').click();}
      return true;
    })()`);
    await writeFile(report + '.cleanup.png', (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="关闭菜单"]\')?.click();true',
    );
    cleanupUi = true;
  }
  if (process.env.WORKBENCH_SMOKE_RESET !== '1') return { cleanupUi, releasePolish };
  const phaseFile = report + '.reset-phase.json';
  let phase: { dataDir: string } | undefined;
  try {
    phase = JSON.parse(await readFile(phaseFile, 'utf8')) as { dataDir: string };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const request = async (route: string, input?: unknown) => {
    const response = await fetch(origin + '/api/workspace' + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-workbench-workspace-contract': '6',
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const value = (await response.json()) as { groups?: unknown[] };
    if (!response.ok)
      throw Error('RESET_SMOKE_HTTP_' + response.status + ':' + JSON.stringify(value));
    return value;
  };
  if (!phase) {
    const before = await request('');
    if (before.groups?.length) throw Error('RESET_SMOKE_REQUIRES_EMPTY_DATABASE');
    await request('/groups/create', { name: 'reset-lifecycle-fixture', color: 'gray' });
    await window.webContents.executeJavaScript(
      "localStorage.setItem('reset-smoke','discard');true",
    );
    await writeFile(phaseFile, JSON.stringify({ dataDir: directory }), { flag: 'wx' });
    await request('/data-cleanup/reset', {
      confirmation: '确认重置',
      acknowledgeUnknownResults: true,
    });
    return { restarting: true };
  }
  if (phase.dataDir !== directory) throw Error('RESET_SMOKE_PHASE_DIRECTORY_CHANGED');
  if ((await request('')).groups?.length) throw Error('RESET_DID_NOT_CLEAR_DATABASE');
  if ((await window.webContents.executeJavaScript("localStorage.getItem('reset-smoke')")) !== null)
    throw Error('RESET_DID_NOT_CLEAR_DESKTOP_STORAGE');
  let pending = false;
  try {
    await access(directory + '.reset-request.json');
    pending = true;
  } catch {}
  if (pending) throw Error('RESET_REQUEST_NOT_CONSUMED');
  return { cleanupUi, resetVerified: true };
}
