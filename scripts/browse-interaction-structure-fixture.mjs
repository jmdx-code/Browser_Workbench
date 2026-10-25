import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const c = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [import.meta.filename], {
    stdio: 'inherit',
    windowsHide: true,
    env,
  });
  process.exitCode = await new Promise((r, j) => {
    c.once('exit', r);
    c.once('error', j);
  });
} else {
  void (async () => {
    const { app, BrowserWindow } = await import('electron');
    const out = path.resolve('audit/browse-interaction-20261025');
    app.setPath('userData', path.join(out, 'fixture-user'));
    await app.whenReady();
    const { projectFacebookBrowsePage, projectFacebookFeedInputFence, FacebookBrowsePage } =
      await import('../dist/src/infrastructure/facebook-browse-reader.js');
    const { FACEBOOK_REEL_NEXT_CSS } = await import('../dist/src/shared/facebook-browse-route.js');
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true },
    });
    const checks = [];
    const timeout = setTimeout(() => app.exit(1), 40000);
    try {
      await win.webContents.session.protocol.handle(
        'https',
        () =>
          new Response(
            '<!doctype html><style>body{margin:0}main{position:relative;width:800px;height:820px}button,[role=button]{display:inline-block;min-width:48px;min-height:48px}</style><main role="main"></main>',
            { headers: { 'content-type': 'text/html' } },
          ),
      );
      const value = (source) => win.webContents.executeJavaScript(source);
      const js = (source) => value(source + ';void 0');
      const load = async (route) => {
        await win.loadURL('https://www.facebook.com' + route);
        await js(
          `window.attach=(el,frames)=>{let n=null;for(const f of frames.toReversed()){const type=Object.assign(function(){},{displayName:f.name});n={type,memoizedProps:f.props??{},return:n};}el.__reactFiber$fixture=n;};`,
        );
      };
      const read = async () =>
        FacebookBrowsePage.parse(await value('(' + projectFacebookBrowsePage.toString() + ')()'));
      const fence = () => value('(' + projectFacebookFeedInputFence.toString() + ')()');
      await load('/');
      await js(
        `document.querySelector('main').innerHTML='<article role="article"><a href="/posts/123">Body</a></article>';document.body.insertAdjacentHTML('beforeend','<div id="popup" role="dialog" aria-modal="false" style="position:fixed;right:0;bottom:0;width:240px;height:280px;background:white">Edge chat</div>');`,
      );
      assert.equal((await read()).blocked, false);
      assert.equal((await fence()).blocked, false);
      checks.push('edge-nonmodal-does-not-block-both-readers');
      await js(`document.querySelector('#popup').setAttribute('aria-modal','true')`);
      assert.equal((await read()).blocked, true);
      assert.equal((await fence()).blocked, true);
      checks.push('explicit-modal-blocks');
      await js(
        `const p=document.querySelector('#popup');p.removeAttribute('aria-modal');p.style.cssText='position:fixed;left:0;top:0;width:800px;height:820px;background:white;z-index:10'`,
      );
      assert.equal((await read()).blocked, true);
      assert.equal((await fence()).blocked, true);
      checks.push('central-topmost-dialog-blocks-without-modal-attribute');
      await js(
        `attach(document.querySelector('#popup'),[{name:'CometTopNavListDropdown.react'}]);`,
      );
      assert.equal((await read()).blocked, false);
      assert.equal((await fence()).blocked, false);
      checks.push('observed-top-nav-popover-does-not-block-even-in-narrow-window');
      await js(`attach(document.querySelector('#popup'),[{name:'MWV2ChatTabsLayout.react'}]);`);
      assert.equal((await read()).blocked, false);
      assert.equal((await fence()).blocked, false);
      checks.push('observed-messenger-chat-layout-is-nonmodal');
      await js(
        `document.querySelector('#popup').style.cssText='position:fixed;right:0;bottom:0;width:240px;height:200px';attach(document.querySelector('#popup'),[{name:'GroupsCometFeatureInterventionDialog.react'}]);`,
      );
      assert.equal((await read()).blocked, true);
      assert.equal((await fence()).blocked, true);
      checks.push('structural-restriction-blocks-at-edge');
      await js(`document.querySelector('#popup').style.display='none'`);
      assert.equal((await read()).blocked, false);
      checks.push('hidden-modal-does-not-block');
      await load('/friends/requests/');
      await js(`document.querySelector('main').innerHTML='<nav role="navigation"><div id="card"><a href="/profile.php?id=123456789">Pure name</a><button id="confirm">ยืนยัน</button><button id="delete">ลบ</button></div><button id="other">ยืนยัน</button></nav>';
 const row={name:'FriendingCometListItemWithButtons.react',props:{user:{id:'123456789',friendship_status:'INCOMING_REQUEST'}}};const group={name:'FDSButtonGroup.react',props:{primary:{type:'primary',testid:'confirm_button'},secondary:{type:'secondary',testid:'ignore_button'}}};
 attach(document.querySelector('#confirm'),[{name:'FDSButton.react',props:{type:'primary'}},group,row]);attach(document.querySelector('#delete'),[{name:'FDSButton.react',props:{type:'secondary'}},group,row]);attach(document.querySelector('#other'),[{name:'FDSButton.react',props:{type:'primary'}}]);`);
      let v = await read();
      assert.equal(v.friendPendingCount, 1);
      assert.equal(await value(`document.querySelector('[data-wb-friend-confirm]').id`), 'confirm');
      assert.match(v.contentKey, /123456789/);
      checks.push('language-independent-confirm-only-incoming-request-not-delete-or-other-primary');
      await js(`document.querySelector('#confirm').setAttribute('aria-disabled','true')`);
      assert.equal((await read()).friendPendingCount, 0);
      checks.push('disabled-confirm-not-selected');
      await load('/reel/123456789/');
      await js(`document.querySelector('main').innerHTML='<video width="320" height="240" muted></video><button id="prev">ก่อนหน้า</button><button id="next">ถัดไป</button><button id="like"><svg width="24" height="24"></svg>1.2K</button><button id="picker">menu</button><button id="comment">comment</button>';
 attach(document.querySelector('#prev'),[{name:'FBUnifiedVideoNavigationButton.react',props:{direction:'prev-card'}}]);attach(document.querySelector('#next'),[{name:'FBUnifiedVideoNavigationButton.react',props:{direction:'next-card',disabled:false}}]);
 const records={fb:{'viewer_feedback_reaction_info(use_default_actor:false)':null,reactors:{__ref:'count'}},count:{count:1234}};window.feedback=records.fb;
 const env={getStore:()=>({getSource:()=>({get:id=>records[id]})})};const base={name:'CometUFIReactButtonBase.react',props:{feedback:{__id:'fb'},feedbackSource:'short_form_video_viewer_activity'}};
 const context={name:'RelayEnvironmentProvider',props:{value:{environment:env}}};attach(document.querySelector('#like'),[base,context]);attach(document.querySelector('#picker'),[base,context]);attach(document.querySelector('#like svg'),[{name:'FBNucleusLikeOutline24Icon.react'}]);attach(document.querySelector('#comment'),[{name:'FBUnifiedVideoFeedbackCommentButton.react'}]);
 const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;const video=document.querySelector('video');video.srcObject=canvas.captureStream(15);window.drawing=setInterval(()=>{canvas.getContext('2d').fillRect(0,0,320,240)},50);video.play();`);
      await new Promise((r) => setTimeout(r, 300));
      v = await read();
      assert.equal(v.nextReelCSS, FACEBOOK_REEL_NEXT_CSS);
      assert.equal(await value(`document.querySelector('[data-wb-reel-next]').id`), 'next');
      checks.push('next-card-fiber-selects-thai-label-and-excludes-previous');
      assert.equal(v.likeTarget?.liked, false);
      assert.equal(v.likeTarget?.likeCount, 1234);
      assert.equal(await value(`document.querySelector('[data-wb-browse-like]').id`), 'like');
      checks.push('reaction-icon-excludes-picker-comment-and-reads-exact-local-count');
      await js(
        `feedback['viewer_feedback_reaction_info(use_default_actor:false)']={__ref:'reaction'};document.querySelector('#like').setAttribute('aria-pressed','false')`,
      );
      assert.equal((await read()).likeTarget.liked, true);
      checks.push('native-reacted-state-overrides-stale-dom-label');
      await js(`document.querySelector('#next').setAttribute('aria-disabled','true')`);
      assert.equal((await read()).nextReelCSS, null);
      checks.push('disabled-next-not-authorized');
      await load('/marketplace/');
      await js(
        `document.querySelector('main').innerHTML='<div id="empty"><span>ภาษาใดก็ได้</span></div>';const host={type:'div',stateNode:document.querySelector('#empty'),memoizedProps:{},return:{type:Object.assign(function(){},{displayName:'CometMarketplaceNoAccessContent.react'}),memoizedProps:{}}};document.body.__reactContainer$fixture={stateNode:{current:{child:host}}};`,
      );
      assert.equal((await read()).marketplaceUnavailable, true);
      checks.push('root-only-native-no-access-with-non-English-text');
      await js(
        `document.querySelector('main').insertAdjacentHTML('beforeend','<a href="/marketplace/item/123456789/" style="display:block;width:100px;height:100px">Product</a>')`,
      );
      assert.equal((await read()).marketplaceUnavailable, false);
      checks.push('visible-product-prevents-false-unavailable');
      await js(
        `document.querySelector('main a').remove();document.body.__reactContainer$fixture.stateNode.current.child.return.type.displayName='CometEmptyState.react'`,
      );
      assert.equal((await read()).marketplaceUnavailable, false);
      checks.push('generic-empty-search-is-not-account-restriction');
      await fs.writeFile(
        path.join(out, 'structure-tests.json'),
        JSON.stringify(
          { passed: true, actualChromium: true, actualFacebook: false, checks },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ passed: true, checks }));
    } catch (e) {
      console.error(e);
      await fs.writeFile(path.join(out, 'structure-failure.txt'), String(e));
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
      win.destroy();
      app.exit(process.exitCode ?? 0);
    }
  })();
}
