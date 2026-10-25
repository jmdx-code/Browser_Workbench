import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [import.meta.filename],
    { windowsHide: true, stdio: 'inherit', env },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('exit', resolve);
    child.on('error', reject);
  });
} else {
  void (async () => {
    const { app, BrowserWindow } = await import('electron');
    const out = path.resolve('audit/inviter-graphql-20261025');
    await mkdir(out, { recursive: true });
    app.setPath('userData', path.join(out, 'projection-user-' + randomUUID()));
    let win;
    const checks = [];
    const timer = setTimeout(() => app.exit(1), 25000);
    try {
      await app.whenReady();
      const { projectGroupInvitationState, inviteDialogSelector } =
        await import('../dist/src/infrastructure/group-inviter-effects.js');
      win = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true },
      });
      await win.webContents.session.protocol.handle(
        'https',
        () =>
          new Response(
            '<!doctype html><style>div,button{min-height:20px;min-width:20px}</style><body></body>',
            { headers: { 'content-type': 'text/html' } },
          ),
      );
      await win.webContents.session.cookies.set({
        url: 'https://www.facebook.com/',
        name: 'c_user',
        value: '123456789',
      });
      await win.loadURL('https://www.facebook.com/groups/1234567890/');
      const setup = async (mode) =>
        win.webContents.executeJavaScript(
          '(' +
            function (mode) {
              document.body.innerHTML =
                '<div role="dialog" aria-label="Messenger"><div role="checkbox">Unrelated</div></div><div role="dialog" id="invite" aria-label="' +
                mode +
                '"><div role="checkbox" aria-checked="false"><span>Pure Name</span><span>99 shared contacts</span></div><div role="button" id="cancel">Random secondary label</div><div role="button" id="send" aria-disabled="true">Random primary label</div><div role="button" id="close">X</div></div>';
              const type = (name) => Object.assign(function () {}, { displayName: name });
              const fiber = (el, frames) => {
                let next = null;
                for (const f of frames.toReversed())
                  next = { type: type(f.name), memoizedProps: f.props, return: next };
                el.__reactFiber$fixture = next;
              };
              const records = {
                1234567890: { __typename: 'Group', invite_member_search: { __ref: 'connection' } },
                connection: { edges: { __refs: ['edge', 'member-edge'] } },
                edge: {
                  __typename: 'GroupInviteMemberSearchEdge',
                  is_invited: true,
                  is_member: false,
                  node: { __ref: '987654322' },
                },
                'member-edge': {
                  __typename: 'GroupSuggestedMembersEdge',
                  is_invited: false,
                  is_member: true,
                  node: { __ref: '987654323' },
                },
                foreign: {
                  __typename: 'GroupInviteMemberSearchEdge',
                  is_invited: true,
                  node: { __ref: '111111111' },
                },
                987654321: { __typename: 'User', name: 'Relay Pure Name' },
                987654322: { __typename: 'User', name: 'Offscreen Invited' },
                987654323: { __typename: 'User', name: 'Offscreen Member' },
              };
              const env = {
                getStore: () => ({ getSource: () => ({ get: (id) => records[id] ?? null }) }),
              };
              const d = document.querySelector('#invite');
              fiber(d, [
                {
                  name: 'GroupsCometInviteFriendsDialog',
                  props: {
                    queries: {
                      dialogQueryReference: {
                        name: 'GroupsCometInviteFriendsDialogQuery',
                        variables: { groupID: '1234567890' },
                        environment: env,
                      },
                    },
                  },
                },
              ]);
              fiber(d.querySelector('[role=checkbox]'), [
                { name: 'CometListCellStrict_DEPRECATED', props: { headline: 'Pure Name' } },
                {
                  name: 'GroupsCometInviteFriendsSearchFriendItem',
                  props: { user$key: { id: '987654321' }, isInvited: false, isMember: false },
                },
              ]);
              fiber(document.querySelector('#send'), [
                { name: 'FDSButton.react', props: { type: 'primary', disabled: true } },
              ]);
              fiber(document.querySelector('#cancel'), [
                { name: 'FDSButton.react', props: { type: 'secondary' } },
              ]);
              fiber(document.querySelector('#close'), [
                { name: 'FDSCircleButton.react', props: {} },
              ]);
              if (mode === 'empty') d.querySelector('[role=checkbox]').remove();
              if (mode === 'relay-name')
                fiber(d.querySelector('[role=checkbox]'), [
                  {
                    name: 'GroupsCometInviteFriendsSearchFriendItem',
                    props: { user$key: { id: '987654321' } },
                  },
                ]);
              if (mode === 'restriction') {
                d.innerHTML = '<h2>ข้อความใดก็ได้</h2>';
                fiber(d, [{ name: 'GroupsCometFeatureInterventionDialog.react', props: {} }]);
              }
              if (mode === 'footer-restriction') {
                d.innerHTML = '<h2>任意语种</h2>';
                fiber(d, [
                  {
                    name: 'FDSDialogPage.react',
                    props: {
                      footer: { props: { primary: { testid: 'feature-intervention-ok-button' } } },
                    },
                  },
                ]);
              }
            }.toString() +
            ')(' +
            JSON.stringify(mode) +
            ')',
        );
      const read = () =>
        win.webContents.executeJavaScript(
          '(' +
            projectGroupInvitationState.toString() +
            ')(' +
            JSON.stringify(inviteDialogSelector) +
            ')',
        );
      for (const label of ['Invite friends', '邀请粉丝加入小组', 'เชิญ', 'Invitar']) {
        await setup(label);
        const s = await read();
        assert.equal(s.dialog, true);
        assert.equal(s.dialogIndex, 1);
        assert.equal(s.items[0].name, 'Pure Name');
        assert.equal(s.sendButton.index, 1);
        assert.equal(s.sendButton.disabled, true);
        assert.equal(s.closeButton.index, 2);
        assert.deepEqual(s.recipients.map((r) => r.id).sort(), ['987654322', '987654323']);
        checks.push('structural-dialog-' + label);
      }
      await setup('empty');
      assert.equal((await read()).dialog, true);
      checks.push('empty-dialog-recognized-by-query');
      await setup('relay-name');
      assert.equal((await read()).items[0].name, 'Relay Pure Name');
      checks.push('pure-name-relay-fallback');
      for (const mode of ['restriction', 'footer-restriction', 'root-only-restriction']) {
        await setup(mode);
        if (mode === 'root-only-restriction')
          await win.webContents.executeJavaScript(`(() => {
            const d = document.querySelector('#invite');
            d.innerHTML = '<h2>Any language, no title match</h2>';
            delete d.__reactFiber$fixture;
            const component = Object.assign(function(){}, {displayName:'GroupsCometFeatureInterventionDialog.react'});
            const parent = {type:component,memoizedProps:{},return:null};
            const host = {type:'div',stateNode:d,memoizedProps:{},return:parent};
            document.body.__reactContainer$fixture = {stateNode:{current:{child:host}}};
          })()`);
        const s = await read();
        assert.equal(s.verificationRequired, true);
        assert.equal(s.dialog, false);
        checks.push(mode);
      }
      await writeFile(
        path.join(out, 'projection-tests.json'),
        JSON.stringify(
          {
            passed: true,
            checks,
            scope:
              'Isolated Electron DOM/Fiber/Relay fixtures matching observed fields; no Facebook network or invitations.',
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ passed: true, checks }));
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      win?.destroy();
      app.exit(process.exitCode ?? 0);
    }
  })();
}
