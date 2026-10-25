import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [import.meta.filename],
    { stdio: 'inherit', windowsHide: true, env },
  );
  process.exitCode = await new Promise((r, j) => {
    child.once('exit', r);
    child.once('error', j);
  });
} else {
  void (async () => {
    const { app, BrowserWindow } = await import('electron');
    const out = path.resolve('audit/publish-locale-20261025');
    app.setPath('userData', path.join(out, 'fixture-user'));
    await app.whenReady();
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true },
    });
    const timer = setTimeout(() => app.exit(1), 45000),
      checks = [];
    try {
      const { projectFacebookStoryPage, projectFacebookStoryMediaBytes, FacebookStoryPage } =
        await import('../dist/src/infrastructure/facebook-story-page-reader.js');
      const { projectFacebookBackground } =
        await import('../dist/src/infrastructure/facebook-background-reader.js');
      const {
        nativeSolidBackgrounds,
        FACEBOOK_BACKGROUND_OPTIONS,
        FACEBOOK_NO_BACKGROUND,
        facebookBackgroundScope,
      } = await import('../dist/src/shared/facebook-background.js');
      const { projectFacebookComposerAudience } =
        await import('../dist/src/infrastructure/facebook-composer-audience.js');
      const { facebookComposerProjection } =
        await import('../dist/src/infrastructure/facebook-read-adapter.js');
      const { projectPage } = await import('../dist/src/shared/page-projection.js');
      const { observeFacebookComposerSurface } =
        await import('../dist/src/domain/facebook-composer-analysis.js');
      await win.webContents.session.protocol.handle(
        'https',
        () =>
          new Response(
            '<!doctype html><style>body{margin:0;display:flex}main{width:600px;height:700px}nav{width:300px;height:700px}button,[role=button],input,[role=textbox]{display:inline-block;min-width:50px;min-height:30px}h2{height:30px}</style><body></body>',
            { headers: { 'content-type': 'text/html' } },
          ),
      );
      const value = (s) => win.webContents.executeJavaScript(s),
        run = (s) => value(s + ';void 0');
      const attach = `window.attach=(el,frames)=>{let f=null;for(const row of frames.toReversed())f={type:Object.assign(function(){},{displayName:row.name}),memoizedProps:row.props??{},return:f};el.__reactFiber$fixture=f;};`;
      const load = async (route, locale) => {
        await win.loadURL('https://www.facebook.com' + route);
        await run(attach + 'document.documentElement.lang=' + JSON.stringify(locale));
      };
      const story = async () =>
        FacebookStoryPage.parse(await value('(' + projectFacebookStoryPage.toString() + ')()'));
      for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'th']) {
        await load('/stories/create/', locale);
        await run(
          `document.body.innerHTML='<nav role="navigation"><button id="privacy"><svg></svg></button></nav><main role="main"><input type="file" accept="image/*,video/*"><button id="entry"><svg></svg>Native entry</button></main>';attach(document.querySelector('main'),[{name:'StoriesCreate.react'}]);attach(document.querySelector('nav'),[{name:'StoriesCreate.react'}]);attach(document.querySelector('#entry svg'),[{name:'FBNucleusTextFilled20Icon.react'}]);attach(document.querySelector('#privacy svg'),[{name:'FBNucleusSettingsFilled20Icon.react'}]);`,
        );
        let s = await story();
        assert.equal(s.phase, 'entry');
        assert.equal(s.textEntry?.enabled, true);
        assert.equal(s.privacy?.phase, 'CLOSED');
        checks.push(locale + '-entry-fiber-no-label-dictionary');
        await run(
          `document.querySelector('main').innerHTML='<h2>Native preview</h2><div contenteditable="true" role="textbox">Draft only</div>';document.querySelector('nav').insertAdjacentHTML('beforeend','<select role="combobox"><option>Native font</option></select><input role="switch" aria-checked="false" type="checkbox"><button id="discard">Cancel</button><button id="submit">Native submit</button>');attach(document.querySelector('[role=textbox]'),[{name:'StoriesCreateSATPPreview.react'}]);attach(document.querySelector('#discard'),[{name:'FDSButton.react',props:{variant:'secondary'}}]);attach(document.querySelector('#submit'),[{name:'FDSButton.react',props:{disabled:false}}]);`,
        );
        s = await story();
        assert.equal(s.phase, 'text-editor');
        assert.equal(s.submit?.enabled, true);
        assert.ok(s.fontCSS);
        assert.equal(s.ai?.checked, false);
        assert.equal(s.text, 'Draft only');
        checks.push(locale + '-editor-submit-font-switch-native-scopes');
        await run(`document.querySelector('#submit').setAttribute('aria-disabled','true')`);
        assert.equal((await story()).submit?.enabled, false);
        checks.push(locale + '-disabled-submit-stays-disabled');
        await run(
          `document.body.insertAdjacentHTML('beforeend','<div role="dialog" aria-modal="true" id="privacyMenu" style="position:fixed;left:350px;top:50px;background:white"><label><input type="radio" aria-checked="false">A</label><label><input type="radio" aria-checked="true" checked>B</label><label><input type="radio" aria-checked="false">C</label><button id="cancel">Native cancel</button><button id="save">Native save</button></div>');const radios=[...document.querySelectorAll('input[type=radio]')];const store={get:id=>id==='custom'?{unified_stories_audience_mode:'CUSTOM'}:null};attach(document.querySelector('#privacyMenu'),[{name:'StoriesCometPrivacySelectorDialog.react',props:{queries:{myQueryReference:{name:'StoriesCometPrivacySelectorDialogQuery',environment:{getStore:()=>({getSource:()=>store})}}}}}]);for(let i=0;i<3;i++)attach(radios[i],[{name:'StoriesCometPrivacySelectorFixedDescriptionRow.react',props:{formatData:i===2?{__id:'custom'}:{unified_stories_audience_mode:['PUBLIC','FRIENDS'][i]}}}]);attach(document.querySelector('#cancel'),[{name:'FDSButton.react',props:{type:'secondary'}}]);attach(document.querySelector('#save'),[{name:'FDSButton.react',props:{disabled:false}}]);`,
        );
        s = await story();
        assert.equal(s.privacy?.phase, 'MENU');
        assert.equal(s.privacy?.draftSelection, 'FRIENDS');
        assert.equal(s.privacy?.friendsEnabled, true);
        checks.push(locale + '-privacy-native-mode-enum');
        await run(
          `for(const r of document.querySelectorAll('input[type=radio]')){r.checked=false;r.setAttribute('aria-checked','false')}const r=document.querySelectorAll('input[type=radio]')[2];r.checked=true;r.setAttribute('aria-checked','true')`,
        );
        assert.equal((await story()).privacy?.draftSelection, 'CUSTOM');
        checks.push(locale + '-custom-mode-local-relay-not-caption');
      }
      await load('/stories/create/', 'zh-Hant');
      await run(
        `document.body.innerHTML='<nav role="navigation"></nav><main role="main"><img></main>';attach(document.querySelector('main'),[{name:'StoriesCreate.react'}]);attach(document.querySelector('nav'),[{name:'StoriesCreate.react'}]);`,
      );
      await value(
        `(async()=>{const c=document.createElement('canvas');c.width=20;c.height=20;c.getContext('2d').fillRect(0,0,20,20);const b=await new Promise(r=>c.toBlob(r));const img=document.querySelector('img');img.src=URL.createObjectURL(b);await img.decode();})()`,
      );
      let s = await story();
      assert.equal(s.phase, 'media-editor');
      const proof = await value('(' + projectFacebookStoryMediaBytes.toString() + ')("image")');
      assert.ok(proof?.bytes > 0);
      assert.match(proof.sha256, /^[a-f0-9]{64}$/);
      checks.push('traditional-preview-marker-hashes-actual-local-blob');
      for (const [locale, label, advance] of [
        ['zh-Hans', '发帖', '下一页'],
        ['zh-Hant', '發佈', '下一步'],
        ['en', 'Post', 'Next'],
      ]) {
        await load('/', locale);
        await run(
          `document.body.innerHTML='<div role="dialog"><form><div role="textbox" contenteditable="true"></div><input type="file" multiple accept="image/*,video/*"><button role="button" aria-label="${label}"></button></form></div>'`,
        );
        let p = await value(
          '(' + projectPage.toString() + ')(' + JSON.stringify(facebookComposerProjection) + ')',
        );
        assert.equal(observeFacebookComposerSurface(p, locale)?.phase, 'direct-submit');
        checks.push(locale + '-composer-direct-submit');
        await run(
          `document.querySelector('button').setAttribute('aria-label',${JSON.stringify(advance)})`,
        );
        p = await value(
          '(' + projectPage.toString() + ')(' + JSON.stringify(facebookComposerProjection) + ')',
        );
        const surface = observeFacebookComposerSurface(p, locale);
        assert.equal(surface?.phase, 'edit-before-review');
        assert.equal(surface?.submit, null);
        checks.push(locale + '-advance-never-submit');
      }
      for (const [locale, settings, edit, reelSettings, post, next] of [
        ['zh-Hans', '帖子设置', '编辑 Reels', 'Reels 设置', '发帖', '下一步'],
        ['zh-Hant', '貼文設定', '編輯 Reels', 'Reels 設定', '發佈', '下一步'],
        ['en', 'Post settings', 'Edit reel', 'Reel settings', 'Post', 'Next'],
      ]) {
        await load('/profile.php?id=10000000000001', locale);
        await run(
          `document.body.innerHTML='<div role="dialog"><form><div role="textbox" contenteditable="true"></div><input type="file" multiple accept="image/*,video/*"></form><div role="dialog" aria-label="${settings}"><h2>${settings}</h2><button role="button" aria-label="${post}">Native submit</button></div></div>'`,
        );
        let p = await value(
          '(' + projectPage.toString() + ')(' + JSON.stringify(facebookComposerProjection) + ')',
        );
        assert.equal(observeFacebookComposerSurface(p, locale)?.phase, 'review-before-submit');
        checks.push(locale + '-profile-review');
        await run(
          `const d=document.querySelector('[role=dialog] [role=dialog]');d.removeAttribute('aria-label');d.insertAdjacentHTML('afterbegin','<section role="form" aria-label="Native video edit"></section>');d.querySelector('h2').textContent=${JSON.stringify(edit)};d.querySelector('button').setAttribute('aria-label',${JSON.stringify(next)});`,
        );
        p = await value(
          '(' + projectPage.toString() + ')(' + JSON.stringify(facebookComposerProjection) + ')',
        );
        assert.equal(observeFacebookComposerSurface(p, locale)?.phase, 'reel-edit-before-review');
        assert.equal(observeFacebookComposerSurface(p, locale)?.submit, null);
        checks.push(locale + '-video-edit-not-final-submit');
        await run(
          `document.querySelector('h2').textContent=${JSON.stringify(reelSettings)};document.querySelector('button').setAttribute('aria-label',${JSON.stringify(post)});`,
        );
        p = await value(
          '(' + projectPage.toString() + ')(' + JSON.stringify(facebookComposerProjection) + ')',
        );
        assert.equal(observeFacebookComposerSurface(p, locale)?.phase, 'reel-review-before-submit');
        checks.push(locale + '-video-review-submit');
      }
      await load('/', 'zh-Hant');
      await run(
        `document.body.innerHTML='<div role="dialog"><form><section id="paint" style="width:500px;height:250px"><div role="textbox" contenteditable="true"></div></section><button role="button" id="bg" aria-label="顯示背景選項"></button><button role="button" id="clear" aria-label="無背景"></button><button role="button" id="red"><i style="display:block;width:24px;height:24px;background:rgb(226,1,59)"></i></button></form></div>';for(const el of document.querySelectorAll('button'))attach(el,[{name:'FeedComposerCometStatusAreaClickHandlerForLexical.react'}]);`,
      );
      const bgArgs = {
        scope: facebookBackgroundScope,
        openCSS: FACEBOOK_BACKGROUND_OPTIONS,
        clearCSS: FACEBOOK_NO_BACKGROUND,
        solids: nativeSolidBackgrounds,
      };
      const background = () =>
        value('(' + projectFacebookBackground.toString() + ')(' + JSON.stringify(bgArgs) + ')');
      let bg = await background();
      assert.equal(bg.openCSS, FACEBOOK_BACKGROUND_OPTIONS);
      assert.equal(bg.options[0]?.id, 'red');
      assert.equal(bg.phase, 'plain');
      await run(`document.querySelector('#paint').style.backgroundColor='rgb(226,1,59)'`);
      assert.equal((await background()).phase, 'solid');
      checks.push('traditional-background-native-swatch-and-painted-effect');
      await load('/', 'zh-Hant');
      await run(
        `document.body.innerHTML='<div role="dialog"><form><div role="textbox" contenteditable="true"></div></form><div role="radiogroup"><label><input type="radio" checked aria-checked="true">Arbitrary native self label</label></div><input type="checkbox" value="default_privacy_checkbox"><button role="button" id="done">Native done</button></div>';const radio=document.querySelector('input[type=radio]');attach(radio,[{name:'CometPrivacySelectorOptionBasic.react'},{name:'CometPrivacySelectorOption.react',props:{option:{post_param:'286958161406148'}}}]);attach(document.querySelector('#done'),[{name:'FDSButton.react',props:{type:'primary'}}]);`,
      );
      const audience = await value('(' + projectFacebookComposerAudience.toString() + ')()');
      assert.equal(audience.phase, 'MENU');
      assert.equal(audience.selfSelected, true);
      assert.equal(audience.defaultChecked, false);
      checks.push('traditional-audience-native-basic-option-not-translated-text');
      await fs.writeFile(
        path.join(out, 'structure-tests.json'),
        JSON.stringify(
          {
            passed: true,
            checks,
            actualChromium: true,
            actualFacebook: false,
            finalSubmissions: 0,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ passed: true, cases: checks.length }));
    } catch (e) {
      console.error(e);
      await fs.writeFile(path.join(out, 'structure-failure.txt'), String(e));
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      win.destroy();
      app.exit(process.exitCode ?? 0);
    }
  })();
}
