import type { BrowserWindow } from 'electron';
import { writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

export async function windowLayoutSmoke(window: BrowserWindow, dataDir: string, report: string) {
  if (process.env.WORKBENCH_SMOKE_WINDOW_LAYOUT !== '1') return {};
  const directory = await realpath(dataDir),
    temp = await realpath(tmpdir());
  if (
    path.dirname(path.dirname(directory)).toLowerCase() !== temp.toLowerCase() ||
    !path.basename(path.dirname(directory)).startsWith('workbench-desktop-') ||
    path.basename(directory) !== 'data'
  )
    throw Error('WINDOW_LAYOUT_SMOKE_REQUIRES_TEMP_DIRECTORY');
  const facts: unknown = await window.webContents.executeJavaScript(`(async()=>{
    const wait=async find=>{const end=Date.now()+10000;while(Date.now()<end){const v=find();if(v)return v;await new Promise(r=>setTimeout(r,40));}throw Error('WINDOW_LAYOUT_UI_NOT_READY')};
    document.querySelector('button[aria-label="打开菜单"]').click();
    (await wait(()=>[...document.querySelectorAll('aside button')].find(b=>b.textContent==='任务窗口布局主屏／副屏自动露边'))).click();
    const panel=await wait(()=>document.querySelector('.window-layout-panel'));
    await wait(()=>panel.querySelector('select')?.options.length>1);
    const initial=await (await fetch('/api/workspace/window-layout')).json();
    const select=panel.querySelector('select');
    const chosen=initial.displays.find(d=>d.id===select.value)??initial.displays.find(d=>d.primary)??initial.displays[0];
    select.value=chosen.id;select.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>[...panel.querySelectorAll('label')].find(l=>l.textContent.includes('自定义区域')));
    const checkbox=[...panel.querySelectorAll('label')].find(l=>l.textContent.includes('自动整理与遮挡恢复')).querySelector('input');if(!checkbox.checked)checkbox.click();
    const region=[...panel.querySelectorAll('label')].find(l=>l.textContent.includes('自定义区域')).querySelector('input');if(!region.checked)region.click();
    await new Promise(r=>setTimeout(r,0)); // Let React commit the checkbox before the next synthetic click.
    const prior=await (await fetch('/api/workspace/window-layout')).json();
    const selected=panel.querySelector('select').value;
    const screen=prior.displays.find(d=>d.id===selected).workArea;
    const dimensions=[12,12,screen.width-24,screen.height-24];
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    [...panel.querySelectorAll('input[type="number"]')].forEach((input,i)=>{setter.call(input,String(dimensions[i]));input.dispatchEvent(new Event('input',{bubbles:true}));});
    await new Promise(r=>setTimeout(r,0));
    [...panel.querySelectorAll('button')].find(b=>b.textContent==='保存设置').click();
    await wait(()=>panel.querySelector('[role="status"]')?.textContent.includes('已保存'));
    const persisted=await (await fetch('/api/workspace/window-layout')).json();
    const result={windowLayoutUi:true,screenOptions:panel.querySelector('select').options.length-1,primaryListed:panel.querySelector('select').textContent.includes('主屏'),overflow:panel.scrollWidth>panel.clientWidth,automaticEnabled:checkbox.checked,persistedLayoutEnabled:persisted.settings.enabled,reservedArea:persisted.settings.reservedArea,regionPreview:!!panel.querySelector('svg[aria-label="保留区域预览"]')};
    if(result.overflow||!result.automaticEnabled||!result.persistedLayoutEnabled||!result.regionPreview||JSON.stringify(result.reservedArea)!==JSON.stringify({x:screen.x+12,y:screen.y+12,width:screen.width-24,height:screen.height-24}))throw Error('WINDOW_LAYOUT_UI_INVALID');
    return result;
  })()`);
  // Let React and the compositor present the final saved region before capture.
  await window.webContents.executeJavaScript(
    `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,200))))`,
  );
  await writeFile(report + '.window-layout.png', (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="关闭菜单"]').click();true`,
  );
  return facts;
}
