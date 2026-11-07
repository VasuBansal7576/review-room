(function () {
  'use strict';

  const roomId = location.pathname.match(/^\/rooms\/([^/]+)/)?.[1] || new URLSearchParams(location.search).get('room');
  const fragment = new URLSearchParams(location.hash.slice(1));
  const inviteToken = fragment.get('invite');
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  document.documentElement.classList.add('access-pending');

  const modal = document.createElement('div');
  modal.className = 'access-modal hidden';
  modal.innerHTML = '<section class="access-card" role="dialog" aria-modal="true" aria-labelledby="accessTitle"><button class="access-close" type="button" aria-label="Close">×</button><h2 id="accessTitle"></h2><p class="access-description"></p><form class="access-form"><label class="access-label" for="accessInput"></label><input id="accessInput" class="access-input"><p class="access-error" role="alert"></p><button class="access-submit" type="submit"></button></form><div class="access-extra"></div></section>';
  document.body.append(modal);
  const title = modal.querySelector('#accessTitle');
  const description = modal.querySelector('.access-description');
  const form = modal.querySelector('.access-form');
  const label = modal.querySelector('.access-label');
  const input = modal.querySelector('.access-input');
  const error = modal.querySelector('.access-error');
  const submit = modal.querySelector('.access-submit');
  const extra = modal.querySelector('.access-extra');
  const close = modal.querySelector('.access-close');
  let access = { secure: false, owner: false };
  let returnFocus = null;
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !close.hidden) { event.preventDefault(); hide(); return; }
    if (event.key !== 'Tab') return;
    const items = [...modal.querySelectorAll('button, input, a[href]')].filter(node => !node.disabled && node.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });

  async function request(path, method = 'GET', data) {
    const options = { method, credentials: 'same-origin', cache: 'no-store' };
    if (data !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(data); }
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
    return body;
  }
  function hide() { modal.classList.add('hidden'); input.value = ''; error.textContent = ''; extra.replaceChildren(); if (returnFocus?.isConnected) returnFocus.focus(); }
  function show({ heading, detail, labelText, buttonText, type = 'text', dismissible = true }) {
    if (modal.classList.contains('hidden')) returnFocus = document.activeElement;
    title.textContent = heading; description.textContent = detail; label.textContent = labelText;
    submit.textContent = buttonText; input.type = type; input.value = ''; input.readOnly = false;
    input.autocomplete = type === 'password' ? 'current-password' : 'off';
    error.textContent = ''; extra.replaceChildren(); close.hidden = !dismissible;
    modal.classList.remove('hidden'); input.focus();
  }
  close.addEventListener('click', hide);
  function requireSignIn(event) { event.preventDefault(); ownerLogin(); }
  function loadApp() {
    document.getElementById('createForm').removeEventListener('submit', requireSignIn);
    document.getElementById('landingSignIn')?.remove();
    document.getElementById('profileButton').onclick = null;
    document.documentElement.classList.remove('access-pending');
    const script = document.createElement('script'); script.src = '/app.js'; document.body.append(script);
    if (!roomId) showRooms();
  }
  async function showRooms() {
    try {
      const { rooms } = await request('/api/rooms');
      if (!rooms?.length) return;
      const section = document.createElement('section'); section.className = 'access-rooms';
      const heading = document.createElement('h2'); heading.textContent = 'Your review rooms'; section.append(heading);
      for (const room of rooms) {
        const link = document.createElement('a'); link.href = `/?room=${encodeURIComponent(room.id)}`;
        link.textContent = room.name; section.append(link);
      }
      document.querySelector('.create-card')?.after(section);
    } catch { }
  }
  function showError(message) {
    document.documentElement.classList.remove('access-pending');
    show({ heading: 'Unable to open this review', detail: message, labelText: '', buttonText: 'Back to start', dismissible: false });
    input.hidden = true; label.hidden = true;
    form.onsubmit = event => { event.preventDefault(); location.href = '/'; };
    if (roomId) { const signIn = document.createElement('button'); signIn.type = 'button'; signIn.className = 'access-secondary'; signIn.textContent = 'Sign in as owner'; signIn.addEventListener('click', ownerLogin); extra.append(signIn); }
  }
  function ownerLogin() {
    show({ heading: 'Sign in to your workspace', detail: 'Enter the owner password to create and manage review rooms.', labelText: 'Owner password', buttonText: 'Sign in', type: 'password', dismissible: !!(!roomId) });
    input.hidden = false; label.hidden = false;
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; error.textContent = '';
      try { await request('/api/owner/session', 'POST', { password: input.value }); input.value = ''; access.owner = true; document.documentElement.dataset.reviewOwner = 'true'; hide(); loadApp(); installOwnerControls(); }
      catch (failure) { error.textContent = failure.message; }
      finally { submit.disabled = false; }
    };
  }
  function installOwnerControls() {
    const control = document.createElement('button');
    control.type = 'button'; control.className = 'access-account'; control.textContent = 'Sign out';
    control.addEventListener('click', async () => {
      try { await request('/api/owner/logout', 'POST'); location.href = '/'; }
      catch { control.textContent = 'Could not sign out'; }
    });
    document.querySelector('.top-actions')?.prepend(control);
    if (!roomId) return;
    const manage = document.createElement('button');
    manage.type = 'button'; manage.className = 'access-account'; manage.textContent = 'Manage access';
    manage.addEventListener('click', manageInvites);
    document.querySelector('.heading-actions')?.prepend(manage);
    for (const id of ['copyLink', 'inviteSmall']) {
      document.getElementById(id)?.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); createInvite(); }, true);
    }
    const label = document.querySelector('#copyLink span'); if (label) label.textContent = 'Invite client';
    document.getElementById('shareScreen')?.classList.replace('dark', 'subtle');
    if (sessionStorage.getItem('review-created') === roomId) { sessionStorage.removeItem('review-created'); inviteCta(); }
  }
  function manageInvites() {
    show({ heading: 'Manage room access', detail: 'Create an invite for your client, or revoke all active invitations and guest sessions.', labelText: '', buttonText: 'Create invite' });
    input.hidden = true; label.hidden = true;
    form.onsubmit = event => { event.preventDefault(); createInvite(); };
    const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'access-secondary'; revoke.textContent = 'Revoke guest access';
    revoke.addEventListener('click', async () => {
      if (!confirm('Revoke all guest access to this room? Guests will need a new invitation.')) return;
      revoke.disabled = true;
      try { await request(`/api/rooms/${encodeURIComponent(roomId)}/invitations`, 'DELETE'); description.textContent = 'Guest access has been revoked.'; }
      catch (failure) { error.textContent = failure.message; }
      finally { revoke.disabled = false; }
    });
    extra.append(revoke);
  }
  function inviteBanner(href) {
    let bar = document.getElementById('inviteBanner');
    if (bar?.classList.contains('cta')) { bar.remove(); bar = null; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'inviteBanner'; bar.className = 'invite-banner'; bar.innerHTML = '<strong>Send this link to your client</strong><input readonly aria-label="Invitation link"><button type="button" class="invite-copy">Copy again</button><button type="button" class="invite-dismiss" aria-label="Dismiss">×</button>'; document.querySelector('.room-heading')?.after(bar); bar.querySelector('.invite-dismiss').onclick = () => bar.remove(); bar.querySelector('input').onfocus = e => e.target.select(); }
    const field = bar.querySelector('input'); field.value = href;
    bar.querySelector('.invite-copy').onclick = async () => { try { await navigator.clipboard.writeText(field.value); window.toast?.('Invite link copied'); } catch { field.focus(); } };
  }
  function inviteCta() {
    let bar = document.getElementById('inviteBanner'); if (bar) return;
    bar = document.createElement('div'); bar.id = 'inviteBanner'; bar.className = 'invite-banner cta'; bar.innerHTML = '<strong>Room ready. First, invite your client.</strong><button type="button" class="button dark invite-now">Invite client ↗</button><button type="button" class="invite-dismiss" aria-label="Dismiss">×</button>';
    document.querySelector('.room-heading')?.after(bar); bar.querySelector('.invite-dismiss').onclick = () => bar.remove();
    bar.querySelector('.invite-now').onclick = () => { bar.remove(); createInvite(); }; bar.querySelector('.invite-now').focus();
  }
  async function createInvite() {
    try {
      const result = await request(`/api/rooms/${encodeURIComponent(roomId)}/invitations`, 'POST');
      const url = new URL(result.url, location.origin);
      if (url.origin !== location.origin || !url.hash.startsWith('#invite=')) throw new Error('The invitation could not be created.');
      inviteBanner(url.href);
      try { await navigator.clipboard.writeText(url.href); window.toast?.(`Invite copied${result.expiresAt ? ` · expires ${new Date(result.expiresAt).toLocaleString()}` : ''}`); }
      catch { window.toast?.('Invite ready. Copy it from the banner.'); document.querySelector('#inviteBanner input')?.focus(); }
    } catch (failure) { window.toast?.(`Could not create an invitation: ${failure.message}`); }
  }
  async function start() {
    try {
      try { access = await request('/api/auth/status'); }
      catch (failure) {
        if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) { loadApp(); return; }
        throw failure;
      }
      document.documentElement.dataset.reviewOwner = access.owner ? 'true' : 'false';
      if (!access.secure) { loadApp(); return; }
      if (inviteToken && !access.owner) {
        if (!roomId || !/^[a-f0-9]{64}$/.test(inviteToken)) throw new Error('This invitation is invalid. Ask the room owner for another.');
        try { await request(`/api/rooms/${encodeURIComponent(roomId)}/join`, 'POST', { token: inviteToken }); }
        catch { throw new Error('This invitation has expired or is no longer valid. Ask the room owner for another.'); }
      }
      if (!roomId && !access.owner) {
        document.documentElement.classList.remove('access-pending');
        document.getElementById('connectionText').textContent = 'Owner sign-in required';
        const signIn = document.createElement('button'); signIn.id = 'landingSignIn'; signIn.type = 'button'; signIn.className = 'access-account'; signIn.textContent = 'Sign in'; signIn.onclick = ownerLogin;
        document.querySelector('.top-actions').prepend(signIn);
        document.getElementById('createForm').addEventListener('submit', requireSignIn);
        document.getElementById('profileButton').onclick = ownerLogin;
        return;
      }
      if (roomId && !access.owner) {
        try { await request(`/api/rooms/${encodeURIComponent(roomId)}`); }
        catch { throw new Error('You do not have access to this room. Ask the room owner for an invitation.'); }
      }
      loadApp();
      if (access.owner) installOwnerControls();
      else {
        for (const id of ['copyLink', 'inviteSmall', 'sendHandoff']) { const button = document.getElementById(id); if (button) button.hidden = true; }
      }
    } catch (failure) { showError(failure.message); }
  }
  start();
})();
