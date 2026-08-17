const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const cfg = window.APP_CONFIG || {};
const configReady = Boolean(
  cfg.SUPABASE_URL &&
  cfg.SUPABASE_PUBLISHABLE_KEY &&
  !cfg.SUPABASE_URL.includes('DEIN-PROJEKT') &&
  !cfg.SUPABASE_PUBLISHABLE_KEY.includes('DEIN-')
);

let sb = null;
let session = null;
let currentProfile = null;
let profiles = [];
let services = [];
let appointments = [];
let chatThreads = [];
let chatMessages = [];
let forms = [];
let formSubmissions = [];
let notifications = [];
let currentPage = 'dashboard';
let calendarView = 'week';
let calendarCursor = new Date();
let activeChatThreadId = null;
let realtimeChannel = null;
let backgroundTimer = null;
let realtimeDebounce = null;
let chatReloadTimer = null;
let lastChatError = '';
let swRegistration = null;

const today = new Date();
const iso = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return iso(d);
};
const roleName = (role) => ({ admin: 'Administrator', employee: 'Mitarbeiter', customer: 'Kunde' }[role] || role);
const statusName = (status) => ({
  requested: 'Angefragt',
  confirmed: 'Bestätigt',
  rejected: 'Abgelehnt',
  completed: 'Erledigt',
  cancelled: 'Abgesagt',
  no_show: 'Nicht erschienen'
}[status] || status);
const formatDate = (value) => new Intl.DateTimeFormat('de-DE', {
  weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric'
}).format(new Date(`${value}T12:00:00`));
const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const INTERNAL_ACCOUNT_DOMAIN = 'konto.s-y-terminplaner.de';
function normalizeUsername(value = '') {
  return String(value).trim().toLowerCase()
    .replaceAll('ä', 'ae').replaceAll('ö', 'oe').replaceAll('ü', 'ue').replaceAll('ß', 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '');
}
function internalEmailForUsername(username) {
  return `${normalizeUsername(username)}@${INTERNAL_ACCOUNT_DOMAIN}`;
}
function loginIdentifierToEmail(value) {
  const input = String(value || '').trim().toLowerCase();
  return input.includes('@') ? input : internalEmailForUsername(input);
}
function isInternalEmail(value = '') {
  return String(value).toLowerCase().endsWith(`@${INTERNAL_ACCOUNT_DOMAIN}`);
}
function visibleEmail(value = '') {
  return !value || isInternalEmail(value) ? 'Nicht angegeben' : value;
}
function profileContactEmail(item = {}) {
  const value = String(item.contact_email || '').trim();
  if (value) return value;
  return !item.email || isInternalEmail(item.email) ? '' : item.email;
}
function profileLoginName(item = {}) {
  return item.username || (isInternalEmail(item.email) ? String(item.email).split('@')[0] : '');
}
function profileDisplayEmail(item = {}) {
  return profileContactEmail(item) || 'Nicht angegeben';
}
function desiredPageFromLocation() {
  const value = String(location.hash || '').replace(/^#/, '');
  return ['dashboard','calendar','requests','chats','forms','notifications','users','services','customers','profile','request'].includes(value) ? value : 'dashboard';
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove('show'), 2800);
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"], button:not([type])');
  if (button) {
    button.disabled = busy;
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.textContent = busy ? 'Bitte warten …' : button.dataset.originalText;
  }
}

function withTimeout(promise, milliseconds = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Die Verbindung dauert zu lange. Bitte prüfe dein Internet und versuche es erneut.')), milliseconds))
  ]);
}

function profileById(id) {
  return profiles.find((item) => item.id === id) || { full_name: 'Unbekannt', email: '' };
}

function serviceById(id) {
  return services.find((item) => item.id === id) || { name: 'Unbekannt', duration_minutes: 0, price_cents: 0 };
}

function euro(cents = 0) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(cents || 0) / 100);
}

function localDateTime(item) {
  return new Date(`${item.appointment_date}T${String(item.appointment_time || '00:00').slice(0, 8)}`);
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(12,0,0,0);
  const weekday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - weekday);
  return d;
}

function monthKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`; }
function sameDay(a,b) { return iso(a) === iso(b); }
function addMonths(date, n) { const d=new Date(date); d.setDate(1); d.setMonth(d.getMonth()+n); return d; }
function addYears(date, n) { const d=new Date(date); d.setFullYear(d.getFullYear()+n); return d; }
function addCalendarDays(date,n){ const d=new Date(date); d.setDate(d.getDate()+n); return d; }

function setTitle(eyebrow, title) {
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
}

function showAuthTab(tab) {
  const login = tab === 'login';
  $('#loginForm').classList.toggle('hidden', !login);
  $('#registerForm').classList.toggle('hidden', login);
  $('#showLogin').classList.toggle('active', login);
  $('#showRegister').classList.toggle('active', !login);
}

async function init() {
  $('#setupWarning').classList.toggle('hidden', configReady);
  bindStaticEvents();

  if (!configReady) return;

  await registerServiceWorker();

  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const { data } = await sb.auth.getSession();
  session = data.session;

  sb.auth.onAuthStateChange(async (_event, nextSession) => {
    session = nextSession;
    if (session) await openApp();
    else closeApp();
  });

  if (session) await openApp();
}

function bindStaticEvents() {
  $('#showLogin').onclick = () => showAuthTab('login');
  $('#showRegister').onclick = () => showAuthTab('register');
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#logoutBtn').onclick = async () => {
    if (sb) await sb.auth.signOut();
  };
  $$('[data-close]').forEach((button) => {
    button.onclick = () => $(`#${button.dataset.close}`).close();
  });

  $('#loginForm').addEventListener('submit', loginWithPassword);
  $('#registerForm').addEventListener('submit', registerWithPassword);
  $('#googleLogin').onclick = () => socialLogin('google');
  $('#appointmentForm').addEventListener('submit', saveAppointment);
  $('#userForm').addEventListener('submit', saveAdminUser);
  $('#serviceForm').addEventListener('submit', saveService);
  $('#profileForm').addEventListener('submit', saveOwnProfile);
  $('#formBuilderForm').addEventListener('submit', saveOnlineForm);
  $('#fillFormForm').addEventListener('submit', submitOnlineForm);
  $('#reminderForm').addEventListener('submit', sendManualReminder);
  $('#appointmentService').addEventListener('change', () => {
    const svc = serviceById($('#appointmentService').value);
    if (!$('#appointmentId').value || currentProfile?.role === 'customer') $('#appointmentPrice').value = (Number(svc.price_cents || 0) / 100).toFixed(2);
  });
}

async function loginWithPassword(event) {
  event.preventDefault();
  if (!configReady) return toast('Supabase ist noch nicht verbunden.');
  const identifier = $('#loginEmail').value.trim();
  setBusy(event.currentTarget, true);
  try {
    const { error } = await withTimeout(sb.auth.signInWithPassword({
      email: loginIdentifierToEmail(identifier),
      password: $('#loginPassword').value
    }), 15000);
    if (error) throw error;
    toast('Erfolgreich angemeldet.');
  } catch (error) {
    const hint = identifier.includes('@')
      ? 'E-Mail oder Passwort stimmt nicht.'
      : 'Benutzername oder Passwort stimmt nicht. Wenn dieses Konto vom Admin erstellt wurde, kann der Admin unter „Konten verwalten“ → „Zugänge reparieren“ alte Konten bestätigen.';
    toast(`Anmeldung fehlgeschlagen. ${hint}`);
    console.warn(error);
  } finally {
    setBusy(event.currentTarget, false);
  }
}

async function registerWithPassword(event) {
  event.preventDefault();
  if (!configReady) return toast('Supabase ist noch nicht verbunden.');
  setBusy(event.currentTarget, true);
  const { data, error } = await sb.auth.signUp({
    email: $('#registerEmail').value.trim(),
    password: $('#registerPassword').value,
    options: {
      data: {
        full_name: $('#registerName').value.trim(),
        phone: $('#registerPhone').value.trim()
      }
    }
  });
  setBusy(event.currentTarget, false);
  if (error) {
    const message = error.message === 'User already registered'
      ? 'Diese E-Mail ist schon vorhanden. Lösche das alte Konto in Supabase unter Authentication → Users und registriere dich danach neu.'
      : error.message;
    return toast(message);
  }
  event.currentTarget.reset();
  if (data.session) {
    toast('Kundenkonto erstellt und angemeldet.');
  } else {
    toast('Das Konto wurde nicht angemeldet. Prüfe, ob Confirm email wirklich ausgeschaltet ist oder ob die E-Mail schon existiert.');
  }
}

async function socialLogin(provider) {
  if (!configReady) return toast('Supabase ist noch nicht verbunden.');
  const { error } = await sb.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${location.origin}${location.pathname}` }
  });
  if (error) {
    const label = provider === 'google' ? 'Google' : 'Apple';
    toast(`${label}-Anmeldung ist in Supabase noch nicht eingerichtet: ${error.message}`);
  }
}

async function openApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#pageContent').innerHTML = '<div class="loading">Daten werden geladen …</div>';

  const loaded = await loadProfileWithRetry();
  if (!loaded) {
    toast('Profil konnte nicht geladen werden. Prüfe die Supabase-Einrichtung.');
    await sb.auth.signOut();
    return;
  }

  if (!currentProfile.active) {
    toast('Dieses Konto wurde vom Administrator gesperrt.');
    await sb.auth.signOut();
    return;
  }

  await loadData();
  $('#userName').textContent = currentProfile.full_name || profileDisplayEmail(currentProfile);
  $('#userRole').textContent = roleName(currentProfile.role);
  $('#userAvatar').textContent = (currentProfile.full_name || profileDisplayEmail(currentProfile) || 'A')[0].toUpperCase();
  currentPage = desiredPageFromLocation();
  renderNav();
  renderPage();
  startRealtimeSync();
  startBackgroundTasks();
  await syncPushSubscriptionIfGranted();
}

async function loadProfileWithRetry() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (!error && data) {
      currentProfile = data;
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  return false;
}

async function loadData() {
  const coreQueries = [
    sb.from('profiles').select('*').order('full_name'),
    sb.from('services').select('*').order('name'),
    sb.from('appointments').select('*').order('appointment_date').order('appointment_time'),
    sb.from('online_forms').select('*').order('created_at', { ascending: false }),
    sb.from('form_submissions').select('*').order('submitted_at', { ascending: false }),
    sb.from('app_notifications').select('*').order('created_at', { ascending: false }).limit(100),
    sb.from('chat_threads').select('*').order('updated_at', { ascending: false })
  ];
  const [profileResult, serviceResult, appointmentResult, formResult, submissionResult, notificationResult, threadResult] = await Promise.all(coreQueries);

  [profileResult, serviceResult, appointmentResult, formResult, submissionResult, notificationResult, threadResult]
    .filter((result) => result.error)
    .forEach((result) => console.warn(result.error.message));

  profiles = profileResult.data || [currentProfile];
  if (!profiles.some((item) => item.id === currentProfile.id)) profiles.push(currentProfile);
  services = serviceResult.data || [];
  appointments = appointmentResult.data || [];
  forms = formResult.data || [];
  formSubmissions = submissionResult.data || [];
  notifications = notificationResult.data || [];
  chatThreads = threadResult.data || [];
  lastChatError = threadResult.error?.message || '';

  if (chatThreads.length) {
    const ids = chatThreads.map((thread) => thread.id);
    const messageResult = await sb.from('chat_messages').select('*').in('thread_id', ids).order('created_at');
    if (messageResult.error) {
      lastChatError = messageResult.error.message;
      console.warn(messageResult.error.message);
      chatMessages = [];
    } else {
      chatMessages = messageResult.data || [];
    }
  } else {
    chatMessages = [];
  }
}

async function reloadChatData() {
  if (!sb || !currentProfile) return;
  const threadResult = await sb.from('chat_threads').select('*').order('updated_at', { ascending: false });
  if (threadResult.error) {
    lastChatError = threadResult.error.message;
    if (currentPage === 'chats') renderPage();
    return;
  }
  chatThreads = threadResult.data || [];
  if (!chatThreads.some((thread) => thread.id === activeChatThreadId)) activeChatThreadId = chatThreads[0]?.id || null;
  if (!chatThreads.length) {
    chatMessages = [];
    lastChatError = '';
    if (currentPage === 'chats') renderPage();
    return;
  }
  const messageResult = await sb.from('chat_messages').select('*').in('thread_id', chatThreads.map((t) => t.id)).order('created_at');
  if (messageResult.error) lastChatError = messageResult.error.message;
  else { chatMessages = messageResult.data || []; lastChatError = ''; }
  if (currentPage === 'chats') {
    renderPage();
    requestAnimationFrame(() => { const box = $('#chatMessages'); if (box) box.scrollTop = box.scrollHeight; });
  }
}

function scheduleChatReload() {
  clearTimeout(chatReloadTimer);
  chatReloadTimer = setTimeout(reloadChatData, 160);
}

function closeApp() {
  session = null;
  currentProfile = null;
  profiles = [];
  services = [];
  appointments = [];
  chatThreads = [];
  chatMessages = [];
  forms = [];
  formSubmissions = [];
  notifications = [];
  activeChatThreadId = null;
  if (backgroundTimer) clearInterval(backgroundTimer);
  backgroundTimer = null;
  if (realtimeChannel && sb) sb.removeChannel(realtimeChannel);
  realtimeChannel = null;
  $('#appView').classList.add('hidden');
  $('#authView').classList.remove('hidden');
  showAuthTab('login');
}

function navItems() {
  if (currentProfile.role === 'admin') {
    return [
      ['dashboard', 'Übersicht'], ['calendar', 'Kalender'], ['requests', 'Terminanfragen'],
      ['chats', 'Alle Chats'], ['forms', 'Formulare'], ['notifications', 'Erinnerungen'],
      ['users', 'Konten verwalten'], ['services', 'Leistungen & Preise'], ['profile', 'Mein Profil']
    ];
  }
  if (currentProfile.role === 'employee') {
    return [
      ['dashboard', 'Übersicht'], ['calendar', 'Mein Kalender'], ['requests', 'Anfragen'],
      ['chats', 'Chats'], ['forms', 'Formulare'], ['notifications', 'Erinnerungen'],
      ['customers', 'Kunden'], ['profile', 'Mein Profil']
    ];
  }
  return [
    ['dashboard', 'Meine Termine'], ['request', 'Termin beantragen'], ['calendar', 'Kalender'],
    ['chats', 'Nachrichten'], ['forms', 'Formulare'], ['notifications', 'Erinnerungen'], ['profile', 'Mein Profil']
  ];
}

function renderNav() {
  const nav = $('#navMenu');
  nav.innerHTML = navItems().map(([id, label]) => (
    `<button data-page="${id}" class="${id === currentPage ? 'active' : ''}">${label}</button>`
  )).join('');
  nav.querySelectorAll('button').forEach((button) => {
    button.onclick = () => {
      currentPage = button.dataset.page;
      renderNav();
      renderPage();
      $('#sidebar').classList.remove('open');
    };
  });
}

function renderPage() {
  const content = $('#pageContent');
  if (currentPage === 'dashboard') return renderDashboard(content);
  if (currentPage === 'calendar') return renderCalendar(content);
  if (currentPage === 'requests') return renderRequests(content);
  if (currentPage === 'users') return renderUsers(content);
  if (currentPage === 'services') return renderServices(content);
  if (currentPage === 'customers') return renderCustomers(content);
  if (currentPage === 'profile') return renderProfile(content);
  if (currentPage === 'request') return renderRequestPage(content);
  if (currentPage === 'chats') return renderChats(content);
  if (currentPage === 'forms') return renderForms(content);
  if (currentPage === 'notifications') return renderNotifications(content);
}

function renderDashboard(content) {
  setTitle(currentProfile.role === 'customer' ? 'KUNDENBEREICH' : 'ÜBERSICHT', currentProfile.role === 'customer' ? 'Meine Termine' : 'Dashboard');
  const list = [...appointments].sort((a, b) => `${a.appointment_date}${a.appointment_time}`.localeCompare(`${b.appointment_date}${b.appointment_time}`));
  const requested = list.filter((item) => item.status === 'requested').length;
  const confirmed = list.filter((item) => item.status === 'confirmed').length;
  const upcoming = list.filter((item) => item.appointment_date >= iso(today) && !['rejected', 'cancelled'].includes(item.status)).length;

  content.innerHTML = `
    <div class="hero">
      <div><h3>Hallo, ${escapeHtml((currentProfile.full_name || 'Benutzer').split(' ')[0])}!</h3><p>Hier siehst du alle wichtigen Termine auf einen Blick.</p></div>
      <div class="hero-actions"><button id="newAppointment" class="btn primary">+ ${currentProfile.role === 'customer' ? 'Termin beantragen' : 'Termin eintragen'}</button></div>
    </div>
    <div class="stats">
      <div class="stat"><span>Alle Termine</span><strong>${list.length}</strong></div>
      <div class="stat"><span>Kommende Termine</span><strong>${upcoming}</strong></div>
      <div class="stat"><span>Anfragen</span><strong>${requested}</strong></div>
      <div class="stat"><span>Bestätigt</span><strong>${confirmed}</strong></div>
    </div>
    <div class="card"><div class="card-head"><h3>Termine</h3><span class="muted">${list.length} Einträge</span></div>${appointmentTable(list)}</div>`;

  $('#newAppointment').onclick = () => openAppointment();
  bindAppointmentActions();
}

function appointmentTable(list) {
  if (!list.length) return '<div class="empty">Noch keine Termine vorhanden.</div>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr>
    <th>Datum</th><th>Uhrzeit</th><th>Kunde</th><th>Mitarbeiter</th><th>Leistung</th><th>Preis</th><th>Status</th><th>Aktion</th>
  </tr></thead><tbody>${list.map((item) => {
    const canEdit = currentProfile.role === 'admin' || currentProfile.role === 'employee';
    const canCancel = currentProfile.role === 'customer' && ['requested', 'confirmed'].includes(item.status);
    return `<tr>
      <td>${formatDate(item.appointment_date)}</td><td><b>${escapeHtml(item.appointment_time.slice(0, 5))}</b></td>
      <td>${escapeHtml(profileById(item.customer_id).full_name)}</td>
      <td>${escapeHtml(profileById(item.employee_id).full_name)}</td>
      <td>${escapeHtml(serviceById(item.service_id).name)}</td>
      <td><b>${euro(item.price_cents ?? serviceById(item.service_id).price_cents)}</b></td>
      <td><span class="badge ${item.status}">${statusName(item.status)}</span></td>
      <td><div class="row-actions">
        <button class="mini" data-chat-appointment="${item.id}">Nachricht</button>
        ${canEdit ? `<button class="mini" data-remind-appointment="${item.id}">Erinnerung</button><button class="mini" data-edit-appointment="${item.id}">Bearbeiten</button>` : ''}
        ${canCancel ? `<button class="mini bad" data-cancel-appointment="${item.id}">Absagen</button>` : ''}
        ${currentProfile.role === 'admin' ? `<button class="mini bad" data-delete-appointment="${item.id}">Löschen</button>` : ''}
      </div></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

function bindAppointmentActions() {
  $$('[data-edit-appointment]').forEach((button) => button.onclick = () => openAppointment(button.dataset.editAppointment));
  $$('[data-cancel-appointment]').forEach((button) => button.onclick = () => cancelAppointment(button.dataset.cancelAppointment));
  $$('[data-delete-appointment]').forEach((button) => button.onclick = () => deleteAppointment(button.dataset.deleteAppointment));
  $$('[data-chat-appointment]').forEach((button) => button.onclick = () => openChatForAppointment(button.dataset.chatAppointment));
  $$('[data-remind-appointment]').forEach((button) => button.onclick = () => openReminderDialog(button.dataset.remindAppointment));
}

function renderCalendar(content) {
  setTitle('KALENDER', currentProfile.role === 'admin' ? 'Gesamter Kalender' : 'Mein Kalender');
  const title = calendarPeriodLabel();
  content.innerHTML = `<div class="calendar-toolbar-wrap">
    <div><h3>Termin-Kalender</h3><p class="muted">Automatisch aktuell · ${new Intl.DateTimeFormat('de-DE',{hour:'2-digit',minute:'2-digit'}).format(new Date())}</p></div>
    <div class="calendar-toolbar">
      <button id="calPrev" class="btn ghost">‹</button><button id="calToday" class="btn ghost">Heute</button><button id="calNext" class="btn ghost">›</button>
      <strong class="calendar-period">${escapeHtml(title)}</strong>
      <div class="view-switch">
        ${[['day','Tag'],['week','Woche'],['month','Monat'],['year','Jahr']].map(([id,label])=>`<button class="mini ${calendarView===id?'selected':''}" data-calendar-view="${id}">${label}</button>`).join('')}
      </div>
      <button id="calendarRefresh" class="btn ghost">↻ Aktualisieren</button>
      <button id="calendarNew" class="btn primary">+ Termin</button>
    </div>
  </div><div id="calendarBody">${calendarViewHtml()}</div>`;

  $('#calPrev').onclick = () => moveCalendar(-1);
  $('#calNext').onclick = () => moveCalendar(1);
  $('#calToday').onclick = () => { calendarCursor = new Date(); renderCalendar(content); };
  $('#calendarRefresh').onclick = () => reloadAndRender('Kalender wurde aktualisiert.');
  $('#calendarNew').onclick = () => openAppointment();
  $$('[data-calendar-view]').forEach((button) => button.onclick = () => { calendarView = button.dataset.calendarView; calendarCursor = new Date(); renderCalendar(content); });
  $$('[data-calendar-appointment]').forEach((button) => button.onclick = () => currentProfile.role === 'customer' ? openChatForAppointment(button.dataset.calendarAppointment) : openAppointment(button.dataset.calendarAppointment));
}

function renderRequests(content) {
  setTitle('ANFRAGEN', 'Terminanfragen');
  const list = appointments.filter((item) => item.status === 'requested');
  content.innerHTML = `<div class="hero"><div><h3>Offene Anfragen</h3><p>Bestätige oder lehne gewünschte Termine ab.</p></div></div><div class="card">${appointmentTable(list)}</div>`;
  const rows = $$('.data-table tbody tr');
  rows.forEach((row, index) => {
    const item = list[index];
    row.lastElementChild.innerHTML = `<div class="row-actions"><button class="mini ok" data-accept="${item.id}">Bestätigen</button><button class="mini bad" data-reject="${item.id}">Ablehnen</button><button class="mini" data-edit-appointment="${item.id}">Bearbeiten</button></div>`;
  });
  $$('[data-accept]').forEach((button) => button.onclick = () => setAppointmentStatus(button.dataset.accept, 'confirmed'));
  $$('[data-reject]').forEach((button) => button.onclick = () => setAppointmentStatus(button.dataset.reject, 'rejected'));
  $$('[data-edit-appointment]').forEach((button) => button.onclick = () => openAppointment(button.dataset.editAppointment));
}

function renderRequestPage(content) {
  setTitle('TERMIN', 'Termin beantragen');
  content.innerHTML = `<div class="hero"><div><h3>Neuen Termin wünschen</h3><p>Wähle Mitarbeiter, Leistung, Datum und Uhrzeit.</p></div><button id="requestAppointment" class="btn primary">Termin beantragen</button></div><div class="card"><div class="empty">Deine Anfrage wird anschließend von einem Mitarbeiter oder Administrator bestätigt.</div></div>`;
  $('#requestAppointment').onclick = () => openAppointment();
}

function personSearchBlock(placeholder = 'Nach Name oder E-Mail suchen') {
  return `<div class="people-search"><span aria-hidden="true">⌕</span><input id="peopleSearch" type="search" placeholder="${placeholder}" autocomplete="off"></div>`;
}

function personCard(item, adminMode = false) {
  return `<button class="person-result" type="button" data-view-person="${item.id}">
    <span class="person-avatar">${escapeHtml((item.full_name || item.email || '?')[0].toUpperCase())}</span>
    <span class="person-main"><b>${escapeHtml(item.full_name || 'Ohne Name')}</b><small>${escapeHtml(profileDisplayEmail(item))}</small></span>
    <span class="badge ${item.role}">${roleName(item.role)}</span>
    <span class="badge ${item.active ? 'active' : 'inactive'}">${item.active ? 'Aktiv' : 'Gesperrt'}</span>
    ${adminMode ? '<span class="person-arrow">›</span>' : ''}
  </button>`;
}

function bindPersonSearch(source, targetId, adminMode = false) {
  const input = $('#peopleSearch');
  const target = $(`#${targetId}`);
  const draw = () => {
    const query = input.value.trim().toLowerCase();
    const result = source.filter((item) => `${item.full_name || ''} ${profileContactEmail(item)} ${profileLoginName(item)}`.toLowerCase().includes(query));
    target.innerHTML = result.length ? result.map((item) => personCard(item, adminMode)).join('') : '<div class="empty">Keine Person gefunden.</div>';
    $$('[data-view-person]').forEach((button) => button.onclick = () => openPersonProfile(button.dataset.viewPerson));
  };
  input.addEventListener('input', draw);
  draw();
}

function openPersonProfile(id) {
  const item = profiles.find((profile) => profile.id === id);
  if (!item) return toast('Profil wurde nicht gefunden.');
  const personAppointments = appointments
    .filter((appointment) => appointment.customer_id === id || appointment.employee_id === id)
    .sort((a, b) => `${a.appointment_date}${a.appointment_time}`.localeCompare(`${b.appointment_date}${b.appointment_time}`));
  $('#personDialogTitle').textContent = item.full_name || item.email;
  $('#personDialogContent').innerHTML = `<div class="profile-summary"><div class="person-avatar large">${escapeHtml((item.full_name || item.email)[0].toUpperCase())}</div><div><h4>${escapeHtml(item.full_name || 'Ohne Name')}</h4><p>${escapeHtml(profileDisplayEmail(item))}${profileLoginName(item) ? ` · Benutzername: ${escapeHtml(profileLoginName(item))}` : ''}</p></div></div>
    <div class="info-list"><div class="info-row"><span>Telefon</span><b>${escapeHtml(item.phone || 'Nicht angegeben')}</b></div><div class="info-row"><span>Rolle</span><b>${roleName(item.role)}</b></div><div class="info-row"><span>Status</span><b>${item.active ? 'Aktiv' : 'Gesperrt'}</b></div><div class="info-row"><span>Erstellt</span><b>${item.created_at ? new Intl.DateTimeFormat('de-DE').format(new Date(item.created_at)) : '–'}</b></div></div>
    <div class="profile-appointments"><h4>Termine (${personAppointments.length})</h4>${personAppointments.length ? personAppointments.slice(0, 8).map((appointment) => `<div class="profile-appointment"><b>${formatDate(appointment.appointment_date)} · ${appointment.appointment_time.slice(0,5)}</b><span>${escapeHtml(serviceById(appointment.service_id).name)} · ${statusName(appointment.status)}</span></div>`).join('') : '<p class="muted">Keine Termine vorhanden.</p>'}</div>
    ${(['admin','employee'].includes(currentProfile.role) && item.role === 'customer') ? `<div class="actions person-admin-actions"><button id="chatPersonFromProfile" class="btn primary" type="button">Mit Kunde schreiben</button>${currentProfile.role==='admin'?'<button id="remindPersonFromProfile" class="btn ghost" type="button">Erinnerung senden</button>':''}</div>` : ''}
    ${currentProfile.role === 'admin' ? `<div class="actions person-admin-actions"><button id="editPersonFromProfile" class="btn ghost" type="button">Konto bearbeiten</button>${item.id !== currentProfile.id ? '<button id="deletePersonFromProfile" class="btn danger" type="button">Konto löschen</button>' : ''}</div>` : ''}`;
  $('#personDialog').showModal();
  const chatBtn = $('#chatPersonFromProfile');
  if (chatBtn) chatBtn.onclick = async () => { $('#personDialog').close(); await startDirectCustomerChat(item.id); };
  const remindBtn = $('#remindPersonFromProfile');
  if (remindBtn) remindBtn.onclick = () => { $('#personDialog').close(); openGeneralReminderDialog(item.id); };
  if (currentProfile.role === 'admin') {
    $('#editPersonFromProfile').onclick = () => { $('#personDialog').close(); openUserDialog(item.id); };
    const deleteButton = $('#deletePersonFromProfile');
    if (deleteButton) deleteButton.onclick = async () => { $('#personDialog').close(); await deleteAdminUser(item.id); };
  }
}

function renderUsers(content) {
  setTitle('VERWALTUNG', 'Konten verwalten');
  const list = [...profiles].sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  content.innerHTML = `<div class="hero"><div><h3>Alle Konten</h3><p>Suche nach Name, E-Mail oder Benutzername. Vom Admin erstellte Konten brauchen keine E-Mail zum Anmelden.</p></div><div class="hero-actions"><button id="repairAccounts" class="btn ghost">Zugänge reparieren</button><button id="newUser" class="btn primary">+ Konto erstellen</button></div></div>
    <div class="card">${personSearchBlock('Nach Name, E-Mail oder Benutzername suchen')}<div id="peopleResults" class="people-results"></div></div>`;
  $('#newUser').onclick = () => openUserDialog();
  $('#repairAccounts').onclick = repairAdminManagedAccounts;
  bindPersonSearch(list, 'peopleResults', true);
}

async function repairAdminManagedAccounts() {
  const button = $('#repairAccounts');
  if (button) { button.disabled = true; button.textContent = 'Wird repariert …'; }
  try {
    const data = await invokeAdminUsers({ action: 'repair' });
    await loadData();
    renderPage();
    toast(`${data.repaired || 0} vom Admin erstellte Zugänge wurden geprüft/repariert.`);
  } catch (error) {
    toast(`Reparatur nicht möglich: ${error.message}. Prüfe, ob die Edge Function „admin-users“ eingerichtet ist.`);
  } finally {
    const next = $('#repairAccounts');
    if (next) { next.disabled = false; next.textContent = 'Zugänge reparieren'; }
  }
}

function renderCustomers(content) {
  setTitle('KUNDEN', 'Kundenübersicht');
  const customers = profiles.filter((item) => item.role === 'customer').sort((a,b)=>(a.full_name||'').localeCompare(b.full_name||''));
  content.innerHTML = `<div class="hero"><div><h3>Kunden suchen</h3><p>Nach Name oder E-Mail suchen und das Kundenprofil öffnen.</p></div></div><div class="card">${personSearchBlock('Kunden nach Name oder E-Mail suchen')}<div id="peopleResults" class="people-results"></div></div>`;
  bindPersonSearch(customers, 'peopleResults');
}

function renderServices(content) {
  setTitle('EINSTELLUNGEN', 'Leistungen & Preise');
  content.innerHTML = `<div class="hero"><div><h3>Leistungen und Preise</h3><p>Preis und Dauer werden bei neuen Terminen automatisch übernommen.</p></div><button id="newService" class="btn primary">+ Leistung</button></div><div class="card"><div class="service-list">${services.map((item) => `<div class="service"><div><b>${escapeHtml(item.name)}</b><span>${item.duration_minutes} Minuten · ${euro(item.price_cents)} · ${item.active ? 'Aktiv' : 'Deaktiviert'}</span></div><div class="row-actions"><button class="mini" data-edit-service="${item.id}">Bearbeiten</button><button class="mini bad" data-delete-service="${item.id}">Löschen</button></div></div>`).join('') || '<div class="empty">Keine Leistungen vorhanden.</div>'}</div></div>`;
  $('#newService').onclick = () => openServiceDialog();
  $$('[data-edit-service]').forEach((button) => button.onclick = () => openServiceDialog(button.dataset.editService));
  $$('[data-delete-service]').forEach((button) => button.onclick = () => deleteService(button.dataset.deleteService));
}

function renderProfile(content) {
  setTitle('KONTO', 'Mein Profil');
  content.innerHTML = `<div class="two-col"><div class="card profile-card"><div class="user-big">${escapeHtml((currentProfile.full_name || profileDisplayEmail(currentProfile))[0].toUpperCase())}</div><h3>${escapeHtml(currentProfile.full_name)}</h3><p class="muted">${escapeHtml(profileDisplayEmail(currentProfile))}${profileLoginName(currentProfile) ? ` · ${escapeHtml(profileLoginName(currentProfile))}` : ''}</p><span class="badge ${currentProfile.role}">${roleName(currentProfile.role)}</span><div style="margin-top:18px"><button id="editOwnProfile" class="btn primary">Daten bearbeiten</button></div></div><div class="card"><h3>Kontoinformationen</h3><div class="info-list"><div class="info-row"><span>Telefon</span><b>${escapeHtml(currentProfile.phone || 'Nicht angegeben')}</b></div><div class="info-row"><span>Status</span><b>${currentProfile.active ? 'Aktiv' : 'Gesperrt'}</b></div><div class="info-row"><span>Erstellt</span><b>${new Intl.DateTimeFormat('de-DE').format(new Date(currentProfile.created_at))}</b></div></div></div></div>`;
  $('#editOwnProfile').onclick = () => {
    $('#profileName').value = currentProfile.full_name || '';
    $('#profilePhone').value = currentProfile.phone || '';
    $('#profileDialog').showModal();
  };
}

function fillAppointmentForm(item = null) {
  const customers = profiles.filter((profile) => profile.role === 'customer' && profile.active);
  const employees = profiles.filter((profile) => ['employee', 'admin'].includes(profile.role) && profile.active);
  const activeServices = services.filter((service) => service.active || service.id === item?.service_id);

  $('#appointmentCustomer').innerHTML = customers.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.full_name)}</option>`).join('');
  $('#appointmentEmployee').innerHTML = employees.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.full_name)} · ${roleName(profile.role)}</option>`).join('');
  $('#appointmentService').innerHTML = activeServices.map((service) => `<option value="${service.id}">${escapeHtml(service.name)} (${service.duration_minutes} Min. · ${euro(service.price_cents)})</option>`).join('');

  $('#appointmentId').value = item?.id || '';
  $('#appointmentCustomer').value = item?.customer_id || (currentProfile.role === 'customer' ? currentProfile.id : customers[0]?.id || '');
  $('#appointmentEmployee').value = item?.employee_id || (['employee', 'admin'].includes(currentProfile.role) ? currentProfile.id : employees[0]?.id || '');
  $('#appointmentService').value = item?.service_id || activeServices[0]?.id || '';
  $('#appointmentDate').value = item?.appointment_date || addDays(1);
  $('#appointmentTime').value = item?.appointment_time?.slice(0, 5) || '10:00';
  $('#appointmentStatus').value = item?.status || (currentProfile.role === 'customer' ? 'requested' : 'confirmed');
  $('#appointmentNote').value = item?.note || '';
  $('#appointmentReminder').value = String(item?.reminder_minutes || 30);
  const price = item?.price_cents ?? serviceById($('#appointmentService').value).price_cents ?? 0;
  $('#appointmentPrice').value = (Number(price) / 100).toFixed(2);

  $('#appointmentCustomer').disabled = currentProfile.role === 'customer';
  $('#appointmentEmployee').disabled = currentProfile.role === 'employee';
  $('#appointmentPrice').readOnly = currentProfile.role === 'customer';
  $('#statusWrap').classList.toggle('hidden', currentProfile.role === 'customer');
}

function openAppointment(id = null) {
  const item = id ? appointments.find((appointment) => appointment.id === id) : null;
  $('#appointmentDialogTitle').textContent = item ? 'Termin bearbeiten' : currentProfile.role === 'customer' ? 'Termin beantragen' : 'Termin eintragen';
  fillAppointmentForm(item);
  $('#appointmentDialog').showModal();
}

async function saveAppointment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  const id = $('#appointmentId').value;
  const payload = {
    customer_id: currentProfile.role === 'customer' ? currentProfile.id : $('#appointmentCustomer').value,
    employee_id: currentProfile.role === 'employee' ? currentProfile.id : $('#appointmentEmployee').value,
    service_id: $('#appointmentService').value,
    appointment_date: $('#appointmentDate').value,
    appointment_time: $('#appointmentTime').value,
    status: currentProfile.role === 'customer' ? 'requested' : $('#appointmentStatus').value,
    note: $('#appointmentNote').value.trim(),
    reminder_minutes: Number($('#appointmentReminder').value || 30),
    price_cents: Math.max(0, Math.round(Number($('#appointmentPrice').value || 0) * 100))
  };

  if (!payload.customer_id) { setBusy(form, false); return toast('Bitte zuerst ein Kundenkonto auswählen oder erstellen.'); }
  if (!payload.employee_id) { setBusy(form, false); return toast('Bitte einen Mitarbeiter oder Administrator auswählen.'); }
  if (!payload.service_id) { setBusy(form, false); return toast('Bitte zuerst eine Leistung anlegen.'); }

  const conflict = appointments.some((item) =>
    item.id !== id && item.employee_id === payload.employee_id && item.appointment_date === payload.appointment_date &&
    item.appointment_time.slice(0, 5) === payload.appointment_time.slice(0, 5) && !['rejected', 'cancelled'].includes(item.status)
  );
  if (conflict) { setBusy(form, false); return toast('Diese Uhrzeit ist bei diesem Mitarbeiter bereits belegt.'); }

  try {
    const query = id ? sb.from('appointments').update(payload).eq('id', id).select('*').single() : sb.from('appointments').insert(payload).select('*').single();
    const result = await withTimeout(query, 15000);
    if (result.error) throw result.error;
    if (id) appointments = appointments.map((item) => item.id === id ? result.data : item); else appointments.push(result.data);
    appointments.sort((a, b) => `${a.appointment_date}${a.appointment_time}`.localeCompare(`${b.appointment_date}${b.appointment_time}`));
    $('#appointmentDialog').close();
    renderPage();
    toast(currentProfile.role === 'customer' ? 'Anfrage wurde gesendet.' : 'Termin wurde gespeichert.');
  } catch (error) { toast(error.message || 'Termin konnte nicht gespeichert werden.'); }
  finally { setBusy(form, false); }
}

async function setAppointmentStatus(id, status) {
  const { error } = await sb.from('appointments').update({ status }).eq('id', id);
  if (error) return toast(error.message);
  await reloadAndRender(`Termin wurde ${statusName(status).toLowerCase()}.`);
}

async function cancelAppointment(id) {
  if (!confirm('Möchtest du diesen Termin wirklich absagen?')) return;
  const { error } = await sb.rpc('customer_cancel_appointment', { p_appointment_id: id });
  if (error) return toast(error.message);
  await reloadAndRender('Termin wurde abgesagt.');
}

async function deleteAppointment(id) {
  if (!confirm('Termin endgültig löschen?')) return;
  const { error } = await sb.from('appointments').delete().eq('id', id);
  if (error) return toast(error.message);
  await reloadAndRender('Termin wurde gelöscht.');
}

function openUserDialog(id = null) {
  const item = id ? profiles.find((profile) => profile.id === id) : null;
  $('#userDialogTitle').textContent = item ? 'Konto bearbeiten' : 'Konto erstellen';
  $('#editUserId').value = item?.id || '';
  $('#newUserName').value = item?.full_name || '';
  $('#newUsername').value = item ? profileLoginName(item) : '';
  $('#newUsername').required = !item;
  $('#newUsername').disabled = Boolean(item);
  $('#usernameLabel').classList.toggle('hidden', Boolean(item));
  $('#usernameHint').classList.toggle('hidden', Boolean(item));
  $('#newUserPhone').value = item?.phone || '';
  $('#newUserEmail').value = item ? profileContactEmail(item) : '';
  $('#newUserPassword').value = '';
  $('#newUserPassword').required = !item;
  $('#passwordLabel').firstChild.textContent = item ? 'Neues Passwort (optional)' : 'Startpasswort';
  $('#newUserRole').value = item?.role || 'employee';
  $('#newUserActive').checked = item?.active ?? true;
  $('#activeWrap').classList.toggle('hidden', !item);
  $('#userDialog').showModal();
}

async function invokeAdminUsers(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let message = error.message || 'Edge Function konnte nicht aufgerufen werden.';
    try {
      if (error.context?.json) {
        const detail = await error.context.json();
        if (detail?.error) message = detail.error;
      }
    } catch (_) {}
    throw new Error(message);
  }
  if (!data?.ok) throw new Error(data?.error || 'Unbekannter Fehler');
  return data;
}

async function createAdminManagedAccount(body) {
  const username = normalizeUsername(body.username);
  if (username.length < 3) throw new Error('Der Benutzername muss mindestens 3 Zeichen lang sein.');
  if (!body.password || body.password.length < 8) throw new Error('Das Startpasswort muss mindestens 8 Zeichen lang sein.');
  try {
    await invokeAdminUsers({ ...body, action: 'create', username });
  } catch (error) {
    // Fallback, falls die Edge Function noch nicht eingerichtet ist. Das klappt nur, wenn Confirm email in Supabase ausgeschaltet ist.
    if (!String(error.message || '').toLowerCase().includes('function') && !String(error.message || '').includes('404')) throw error;
    const authEmail = internalEmailForUsername(username);
    const isolated = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error: signupError } = await withTimeout(isolated.auth.signUp({
      email: authEmail,
      password: body.password,
      options: { data: { full_name: body.full_name, phone: body.phone, username, admin_created: true } }
    }), 15000);
    if (signupError) throw signupError;
    if (!data?.user || !data.session) throw new Error('Das Konto wurde angelegt, aber noch nicht bestätigt. Richte die Edge Function „admin-users“ ein und klicke danach auf „Zugänge reparieren“.');
    const { error: profileError } = await sb.rpc('admin_configure_account_v2', {
      p_user_id: data.user.id, p_full_name: body.full_name, p_phone: body.phone || '', p_contact_email: body.email || '', p_username: username, p_role: body.role, p_active: true
    });
    if (profileError) throw profileError;
  }
}

async function updateAdminManagedAccount(body) {
  try {
    await invokeAdminUsers({ ...body, action: 'update' });
  } catch (error) {
    const { error: profileError } = await sb.rpc('admin_configure_account_v2', {
      p_user_id: body.id, p_full_name: body.full_name, p_phone: body.phone || '', p_contact_email: body.email || '', p_username: profileLoginName(profiles.find((p) => p.id === body.id) || {}), p_role: body.role, p_active: body.active
    });
    if (profileError) throw error;
    if (body.password) toast('Profildaten gespeichert. Für ein neues Passwort muss die Edge Function „admin-users“ eingerichtet sein.');
  }
}

async function saveAdminUser(event) {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  const id = $('#editUserId').value;
  const body = {
    id: id || undefined,
    username: $('#newUsername').value.trim(),
    full_name: $('#newUserName').value.trim(),
    phone: $('#newUserPhone').value.trim(),
    email: $('#newUserEmail').value.trim(),
    password: $('#newUserPassword').value || undefined,
    role: $('#newUserRole').value,
    active: id ? $('#newUserActive').checked : true
  };

  try {
    if (id) await updateAdminManagedAccount(body);
    else await createAdminManagedAccount(body);
    $('#userDialog').close();
    await reloadAndRender(id ? 'Konto wurde aktualisiert.' : 'Konto wurde erstellt. Die Anmeldung erfolgt mit Benutzername und Startpasswort.');
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(event.currentTarget, false);
  }
}

async function deleteAdminUser(id) {
  const item = profiles.find((profile) => profile.id === id);
  if (!confirm(`Konto von ${item?.full_name || 'diesem Benutzer'} sperren? Die Person kann sich danach nicht mehr anmelden.`)) return;
  const { error } = await sb.rpc('admin_configure_account_v2', {
    p_user_id: id,
    p_full_name: item?.full_name || '',
    p_phone: item?.phone || '',
    p_contact_email: profileContactEmail(item || {}),
    p_username: profileLoginName(item || {}),
    p_role: item?.role || 'customer',
    p_active: false
  });
  if (error) return toast(`${error.message} – führe zuerst das neue Supabase-Update aus.`);
  await reloadAndRender('Konto wurde gesperrt.');
}

function openServiceDialog(id = null) {
  const item = id ? services.find((service) => service.id === id) : null;
  $('#serviceDialogTitle').textContent = item ? 'Leistung bearbeiten' : 'Leistung erstellen';
  $('#serviceId').value = item?.id || '';
  $('#serviceName').value = item?.name || '';
  $('#serviceDuration').value = item?.duration_minutes || 30;
  $('#servicePrice').value = (Number(item?.price_cents || 0) / 100).toFixed(2);
  $('#serviceActive').checked = item?.active ?? true;
  $('#serviceDialog').showModal();
}

async function saveService(event) {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  const id = $('#serviceId').value;
  const payload = {
    name: $('#serviceName').value.trim(),
    duration_minutes: Number($('#serviceDuration').value),
    price_cents: Math.max(0, Math.round(Number($('#servicePrice').value || 0) * 100)),
    active: $('#serviceActive').checked
  };
  const result = id ? await sb.from('services').update(payload).eq('id', id) : await sb.from('services').insert(payload);
  setBusy(event.currentTarget, false);
  if (result.error) return toast(result.error.message);
  $('#serviceDialog').close();
  await reloadAndRender(id ? 'Leistung wurde aktualisiert.' : 'Leistung wurde erstellt.');
}

async function deleteService(id) {
  if (!confirm('Leistung wirklich löschen? Bestehende Termine können dadurch betroffen sein.')) return;
  const { error } = await sb.from('services').delete().eq('id', id);
  if (error) return toast(error.message);
  await reloadAndRender('Leistung wurde gelöscht.');
}

async function saveOwnProfile(event) {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  const { error } = await sb.rpc('update_my_profile', {
    p_full_name: $('#profileName').value.trim(),
    p_phone: $('#profilePhone').value.trim()
  });
  setBusy(event.currentTarget, false);
  if (error) return toast(error.message);
  $('#profileDialog').close();
  await loadProfileWithRetry();
  await reloadAndRender('Profil wurde gespeichert.');
  $('#userName').textContent = currentProfile.full_name;
  $('#userAvatar').textContent = currentProfile.full_name[0].toUpperCase();
}


function calendarPeriodLabel() {
  const d = calendarCursor;
  if (calendarView === 'day') return new Intl.DateTimeFormat('de-DE',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(d);
  if (calendarView === 'week') {
    const a=startOfWeek(d), b=addCalendarDays(a,6);
    return `${new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit'}).format(a)} – ${new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}).format(b)}`;
  }
  if (calendarView === 'month') return new Intl.DateTimeFormat('de-DE',{month:'long',year:'numeric'}).format(d);
  return String(d.getFullYear());
}

function moveCalendar(direction) {
  if (calendarView === 'day') calendarCursor = addCalendarDays(calendarCursor, direction);
  if (calendarView === 'week') calendarCursor = addCalendarDays(calendarCursor, direction * 7);
  if (calendarView === 'month') calendarCursor = addMonths(calendarCursor, direction);
  if (calendarView === 'year') calendarCursor = addYears(calendarCursor, direction);
  renderPage();
}

function calendarEventHtml(item, compact=false) {
  const customer = profileById(item.customer_id);
  const label = currentProfile.role === 'customer' ? profileById(item.employee_id).full_name : customer.full_name;
  return `<button class="cal-event ${item.status}" data-calendar-appointment="${item.id}" title="${escapeHtml(serviceById(item.service_id).name)}">
    <b>${compact ? '' : `${item.appointment_time.slice(0,5)} · `}${escapeHtml(serviceById(item.service_id).name)}</b>
    ${compact ? '' : `<small>${escapeHtml(label)} · ${euro(item.price_cents)}</small>`}
  </button>`;
}

function calendarViewHtml() {
  const active = appointments.filter((item)=>!['rejected','cancelled'].includes(item.status));
  if (calendarView === 'day') {
    const key=iso(calendarCursor); const list=active.filter((a)=>a.appointment_date===key).sort((a,b)=>a.appointment_time.localeCompare(b.appointment_time));
    return `<div class="day-agenda">${list.length?list.map((a)=>calendarEventHtml(a)).join(''):'<div class="empty">An diesem Tag gibt es keine Termine.</div>'}</div>`;
  }
  if (calendarView === 'week') {
    const start=startOfWeek(calendarCursor);
    const days=Array.from({length:7},(_,i)=>addCalendarDays(start,i));
    return `<div class="calendar week-seven">${days.map((d)=>{const key=iso(d);const list=active.filter((a)=>a.appointment_date===key).sort((a,b)=>a.appointment_time.localeCompare(b.appointment_time));return `<section class="day ${sameDay(d,new Date())?'today-cell':''}"><div class="day-head"><strong>${new Intl.DateTimeFormat('de-DE',{weekday:'short'}).format(d)}</strong><span>${new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit'}).format(d)}</span></div>${list.length?list.map((a)=>calendarEventHtml(a)).join(''):'<div class="calendar-free">Frei</div>'}</section>`}).join('')}</div>`;
  }
  if (calendarView === 'month') {
    const first=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth(),1,12); const start=startOfWeek(first);
    const days=Array.from({length:42},(_,i)=>addCalendarDays(start,i));
    return `<div class="month-grid"><div class="month-weekdays">${['Mo','Di','Mi','Do','Fr','Sa','So'].map(x=>`<b>${x}</b>`).join('')}</div><div class="month-days">${days.map((d)=>{const key=iso(d);const list=active.filter((a)=>a.appointment_date===key);const outside=d.getMonth()!==calendarCursor.getMonth();return `<div class="month-day ${outside?'outside':''} ${sameDay(d,new Date())?'today-cell':''}"><span class="date-number">${d.getDate()}</span><div class="month-events">${list.slice(0,3).map((a)=>calendarEventHtml(a,true)).join('')}${list.length>3?`<small>+${list.length-3} weitere</small>`:''}</div></div>`}).join('')}</div></div>`;
  }
  const year=calendarCursor.getFullYear();
  return `<div class="year-grid">${Array.from({length:12},(_,m)=>{const d=new Date(year,m,1,12);const count=active.filter((a)=>a.appointment_date.startsWith(`${year}-${String(m+1).padStart(2,'0')}`)).length;const daysInMonth=new Date(year,m+1,0).getDate();const firstOffset=(new Date(year,m,1).getDay()+6)%7;const cells=[...Array(firstOffset).fill(null),...Array.from({length:daysInMonth},(_,i)=>i+1)];return `<button class="year-month" data-jump-month="${m}"><div class="year-month-head"><b>${new Intl.DateTimeFormat('de-DE',{month:'long'}).format(d)}</b><span>${count} Termine</span></div><div class="mini-month"><div class="mini-weekdays">${['M','D','M','D','F','S','S'].map(x=>`<i>${x}</i>`).join('')}</div><div class="mini-days">${cells.map(day=>day===null?'<i></i>':`<i class="${active.some(a=>a.appointment_date===`${year}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`)?'has-event':''}">${day}</i>`).join('')}</div></div></button>`}).join('')}</div>`;
}

document.addEventListener('click',(event)=>{
  const jump=event.target.closest('[data-jump-month]');
  if (jump) { calendarCursor=new Date(calendarCursor.getFullYear(),Number(jump.dataset.jumpMonth),1,12); calendarView='month'; renderPage(); }
});

function startRealtimeSync() {
  if (!sb || realtimeChannel) return;
  realtimeChannel = sb.channel(`termin-live-${session.user.id}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'appointments'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'services'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'chat_messages'},handleChatRealtime)
    .on('postgres_changes',{event:'*',schema:'public',table:'chat_threads'},scheduleChatReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'online_forms'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'form_submissions'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'app_notifications'},handleNotificationRealtime)
    .subscribe((status, error) => { if (error) console.warn('Realtime:', error); });
}

function handleChatRealtime(payload) {
  const item = payload?.new;
  if (payload?.eventType === 'INSERT' && item?.id && !chatMessages.some((m) => m.id === item.id)) {
    chatMessages.push(item);
    chatMessages.sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
    if (currentPage === 'chats') {
      renderPage();
      requestAnimationFrame(()=>{const box=$('#chatMessages');if(box)box.scrollTop=box.scrollHeight;});
    }
  }
  scheduleChatReload();
}

function handleNotificationRealtime(payload) {
  const item=payload?.new;
  if(payload?.eventType==='INSERT' && item?.user_id===currentProfile?.id) {
    if (!notifications.some((n)=>n.id===item.id)) notifications.unshift(item);
    toast(`${item.title}: ${item.body}`);
    if ('Notification' in window && Notification.permission==='granted' && document.visibilityState === 'visible') {
      new Notification(item.title,{body:item.body, icon:'icon-192.png'});
    }
    if (currentPage === 'notifications') renderPage();
  }
}

function scheduleRealtimeReload() {
  clearTimeout(realtimeDebounce);
  realtimeDebounce=setTimeout(async()=>{ if (!currentProfile) return; await loadData(); renderPage(); },350);
}

function startBackgroundTasks() {
  if (backgroundTimer) clearInterval(backgroundTimer);
  backgroundTimer=setInterval(async()=>{
    if (!currentProfile) return;
    if (currentPage === 'chats') await reloadChatData();
    else {
      await loadData();
      if (currentPage==='calendar' || currentPage==='notifications') renderPage();
    }
  },60000);
}

async function checkAppointmentReminders() {
  // Erinnerungen werden jetzt serverseitig per Supabase Cron erzeugt. Dadurch funktionieren sie auch, wenn die Website geschlossen ist.
  return;
}

function openReminderDialog(appointmentId) {
  const item=appointments.find(a=>a.id===appointmentId); if(!item)return toast('Termin nicht gefunden.');
  const customer=profileById(item.customer_id);
  $('#reminderAppointmentId').value=item.id;
  $('#reminderRecipient').textContent=`Empfänger: ${customer.full_name} · ${formatDate(item.appointment_date)} um ${item.appointment_time.slice(0,5)}`;
  $('#reminderTitle').value='Terminerinnerung';
  $('#reminderBody').value=`Hallo ${customer.full_name.split(' ')[0]}, wir erinnern Sie an Ihren Termin am ${formatDate(item.appointment_date)} um ${item.appointment_time.slice(0,5)} (${serviceById(item.service_id).name}).`;
  $('#reminderDialog').showModal();
}

function openGeneralReminderDialog(customerId) {
  const customer=profileById(customerId);
  $('#reminderAppointmentId').value='';
  $('#reminderRecipient').dataset.customerId=customerId;
  $('#reminderRecipient').textContent=`Empfänger: ${customer.full_name}`;
  $('#reminderTitle').value='Erinnerung';
  $('#reminderBody').value=`Hallo ${customer.full_name.split(' ')[0]}, dies ist eine Erinnerung von Safa Yildiz.`;
  $('#reminderDialog').showModal();
}

async function sendManualReminder(event) {
  event.preventDefault();setBusy(event.currentTarget,true);
  const appointmentId=$('#reminderAppointmentId').value||null;
  const appointment=appointmentId?appointments.find(a=>a.id===appointmentId):null;
  const customerId=appointment?.customer_id||$('#reminderRecipient').dataset.customerId;
  if(!customerId){setBusy(event.currentTarget,false);return toast('Empfänger nicht gefunden.');}
  const payload={user_id:customerId,appointment_id:appointmentId,type:'manual_reminder',title:$('#reminderTitle').value.trim(),body:$('#reminderBody').value.trim(),dedupe_key:`manual:${currentProfile.id}:${Date.now()}`,sender_id:currentProfile.id};
  const {error}=await sb.from('app_notifications').insert(payload);
  setBusy(event.currentTarget,false);
  if(error)return toast(error.message);
  $('#reminderDialog').close();
  $('#reminderRecipient').dataset.customerId='';
  toast('Erinnerung wurde verschickt.');
}

function renderNotifications(content) {
  setTitle('ERINNERUNGEN','Benachrichtigungen');
  const unread=notifications.filter(n=>!n.read).length;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const pushLabel = ('Notification' in window && Notification.permission === 'granted') ? 'Handy-Benachrichtigungen aktiv' : 'Handy-Benachrichtigungen aktivieren';
  content.innerHTML=`<div class="hero"><div><h3>Erinnerungen</h3><p>Terminerinnerungen und Nachrichten können als echte Push-Benachrichtigung auf dem Handy erscheinen – auch wenn die Website geschlossen ist.</p></div><div class="hero-actions"><button id="enableNotifications" class="btn primary" ${pushSupported?'':'disabled'}>${pushLabel}</button>${unread?`<button id="markNotifications" class="btn ghost">Alle als gelesen</button>`:''}</div></div>
    <div class="note push-note"><b>Am Handy:</b> Android: Benachrichtigungen erlauben. iPhone/iPad: die Website zuerst über „Teilen → Zum Home-Bildschirm“ installieren und danach hier Push aktivieren.</div>
    <div class="card notification-list">${notifications.length?notifications.map(n=>`<button class="notification-item ${n.read?'':'unread'}" data-read-notification="${n.id}"><div><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body)}</p></div><small>${new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short'}).format(new Date(n.created_at))}</small></button>`).join(''):'<div class="empty">Noch keine Erinnerungen.</div>'}</div>`;
  const enable = $('#enableNotifications');
  enable.onclick = enablePhonePush;
  const mark=$('#markNotifications'); if(mark) mark.onclick=async()=>{await sb.from('app_notifications').update({read:true}).eq('user_id',currentProfile.id); notifications=notifications.map(n=>({...n,read:true}));renderNotifications(content);};
  $$('[data-read-notification]').forEach(btn=>btn.onclick=async()=>{await sb.from('app_notifications').update({read:true}).eq('id',btn.dataset.readNotification);const n=notifications.find(x=>x.id===btn.dataset.readNotification);if(n)n.read=true;renderNotifications(content);});
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js?v=21', { scope: './' });
    return swRegistration;
  } catch (error) {
    console.warn('Service Worker konnte nicht registriert werden:', error);
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function enablePhonePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Push-Benachrichtigungen werden auf diesem Browser nicht unterstützt.');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  if (ios && !standalone) return toast('Auf iPhone/iPad: zuerst Teilen → Zum Home-Bildschirm. Öffne danach die installierte App und aktiviere hier die Benachrichtigungen.');
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return toast('Benachrichtigungen wurden nicht erlaubt.');
    await syncPushSubscription(true);
    toast('Handy-Benachrichtigungen sind jetzt aktiv.');
    if (currentPage === 'notifications') renderPage();
  } catch (error) {
    console.warn(error);
    toast(`Push konnte nicht aktiviert werden: ${error.message}`);
  }
}

async function syncPushSubscription(force = false) {
  if (!currentProfile || !cfg.VAPID_PUBLIC_KEY || !('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = swRegistration || await registerServiceWorker();
  if (!reg) return;
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription && force) {
    subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY) });
  }
  if (!subscription) return;
  const json = subscription.toJSON();
  const payload = {
    user_id: currentProfile.id,
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh || '',
    auth: json.keys?.auth || '',
    user_agent: navigator.userAgent,
    updated_at: new Date().toISOString()
  };
  // Nicht direkt in die RLS-geschützte Tabelle schreiben. Ein Push-Endpunkt
  // gehört pro Browser/Service-Worker nur einmal und kann noch einem zuvor
  // angemeldeten Konto zugeordnet sein. Die RPC übernimmt den Endpunkt sicher
  // für das aktuell angemeldete Konto (auth.uid()).
  const { error } = await sb.rpc('save_push_subscription', {
    p_endpoint: payload.endpoint,
    p_p256dh: payload.p256dh,
    p_auth: payload.auth,
    p_user_agent: payload.user_agent
  });
  if (error) throw error;
}

async function syncPushSubscriptionIfGranted() {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { await syncPushSubscription(false); } catch (error) { console.warn('Push-Sync:', error); }
  }
}

function threadPeople(thread) {
  return { customer: profileById(thread.customer_id), employee: profileById(thread.employee_id) };
}

async function ensureChatThread(customerId, employeeId, appointmentId=null) {
  let thread=chatThreads.find(t=>t.customer_id===customerId && t.employee_id===employeeId && (appointmentId ? t.appointment_id===appointmentId : !t.appointment_id));
  if (thread) return thread;
  const {data,error}=await sb.from('chat_threads').insert({customer_id:customerId,employee_id:employeeId,appointment_id:appointmentId,created_by:currentProfile.id}).select('*').single();
  if (error) throw error;
  chatThreads.unshift(data); return data;
}

async function openChatForAppointment(id) {
  const appointment=appointments.find(a=>a.id===id); if(!appointment)return toast('Termin nicht gefunden.');
  try { const thread=await ensureChatThread(appointment.customer_id,appointment.employee_id,appointment.id); activeChatThreadId=thread.id; currentPage='chats'; renderNav(); await loadData(); renderPage(); }
  catch(error){toast(error.message);}
}

function renderChats(content) {
  setTitle('NACHRICHTEN',currentProfile.role==='admin'?'Alle Chats':'Chats');
  if (!activeChatThreadId && chatThreads[0]) activeChatThreadId=chatThreads[0].id;
  const active=chatThreads.find(t=>t.id===activeChatThreadId);
  const errorBox = lastChatError ? `<div class="note"><b>Chat konnte nicht vollständig geladen werden:</b> ${escapeHtml(lastChatError)} <button id="reloadChats" class="mini" type="button">Neu laden</button></div>` : '';
  const newLabel = currentProfile.role === 'customer' ? '+ Mitarbeiter anschreiben' : '+ Kunde anschreiben';
  content.innerHTML=`${errorBox}<div class="chat-layout"><aside class="chat-list"><div class="chat-list-head"><div><h3>${currentProfile.role==='admin'?'Alle Unterhaltungen':'Nachrichten'}</h3><small>${chatThreads.length} Chats</small></div><button id="newChatBtn" class="mini">${newLabel}</button></div><div class="chat-thread-list">${chatThreads.length?chatThreads.map(t=>{const ppl=threadPeople(t);const msgs=chatMessages.filter(m=>m.thread_id===t.id);const last=msgs.at(-1);return `<button class="chat-thread ${t.id===activeChatThreadId?'active':''}" data-thread="${t.id}"><b>${escapeHtml(ppl.customer.full_name)} ↔ ${escapeHtml(ppl.employee.full_name)}</b><small>${escapeHtml(last?.body||'Noch keine Nachricht')}</small></button>`}).join(''):'<div class="empty">Noch keine Chats.</div>'}</div></aside><section class="chat-window">${active?chatWindowHtml(active):'<div class="empty">Wähle einen Chat aus oder starte eine neue Unterhaltung.</div>'}</section></div>`;
  $$('[data-thread]').forEach(btn=>btn.onclick=()=>{activeChatThreadId=btn.dataset.thread;renderChats(content);requestAnimationFrame(()=>{const box=$('#chatMessages');if(box)box.scrollTop=box.scrollHeight;});});
  $('#newChatBtn').onclick=()=>openDirectChatPicker();
  const reload=$('#reloadChats'); if(reload) reload.onclick=reloadChatData;
  const form=$('#chatSendForm'); if(form) form.onsubmit=sendChatMessage;
  requestAnimationFrame(()=>{const box=$('#chatMessages');if(box)box.scrollTop=box.scrollHeight;});
}

async function startDirectCustomerChat(customerId) {
  const customer=profiles.find(p=>p.id===customerId && p.role==='customer');
  if(!customer) return toast('Kunde wurde nicht gefunden.');
  const employeeId=currentProfile.id;
  try {
    const thread=await ensureChatThread(customer.id,employeeId,null);
    activeChatThreadId=thread.id;
    currentPage='chats';
    renderNav();
    await loadData();
    renderPage();
  } catch(error) { toast(error.message); }
}

function openDirectChatPicker() {
  if (currentProfile.role==='customer') {
    const team=profiles.filter(p=>['employee','admin'].includes(p.role)&&p.active);
    const name=prompt(`Mitarbeitername:\n${team.map(p=>p.full_name).join(', ')}`)||'';
    const person=team.find(p=>p.full_name.toLowerCase().includes(name.toLowerCase()));
    if(!person) return toast('Mitarbeiter nicht gefunden.');
    ensureChatThread(currentProfile.id,person.id,null).then(async t=>{activeChatThreadId=t.id;await loadData();renderPage();}).catch(e=>toast(e.message));
    return;
  }
  const customers=profiles.filter(p=>p.role==='customer'&&p.active);
  const name=prompt(`Kundenname oder E-Mail:\n${customers.slice(0,20).map(p=>p.full_name).join(', ')}`)||'';
  const query=name.trim().toLowerCase();
  const person=customers.find(p=>`${p.full_name||''} ${profileContactEmail(p)} ${profileLoginName(p)}`.toLowerCase().includes(query));
  if(!person) return toast('Kunde nicht gefunden.');
  startDirectCustomerChat(person.id);
}

function chatWindowHtml(thread) {
  const ppl=threadPeople(thread); const msgs=chatMessages.filter(m=>m.thread_id===thread.id);
  return `<div class="chat-window-head"><div><h3>${escapeHtml(ppl.customer.full_name)} ↔ ${escapeHtml(ppl.employee.full_name)}</h3><small>${thread.appointment_id?'Termin-Chat':'Allgemeiner Chat'}${currentProfile.role==='admin'?' · Admin kann mitlesen':''}</small></div></div><div id="chatMessages" class="chat-messages">${msgs.length?msgs.map(m=>`<div class="message ${m.sender_id===currentProfile.id?'mine':''}"><b>${escapeHtml(profileById(m.sender_id).full_name)}</b><p>${escapeHtml(m.body)}</p><small>${new Intl.DateTimeFormat('de-DE',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}).format(new Date(m.created_at))}</small></div>`).join(''):'<div class="empty">Schreibe die erste Nachricht.</div>'}</div><form id="chatSendForm" class="chat-compose"><input id="chatText" maxlength="2000" required placeholder="Nachricht schreiben …"><button class="btn primary">Senden</button></form>`;
}

async function sendChatMessage(event) {
  event.preventDefault(); const input=$('#chatText');const body=input.value.trim();if(!body||!activeChatThreadId)return;
  setBusy(event.currentTarget,true);
  const {data,error}=await sb.from('chat_messages').insert({thread_id:activeChatThreadId,sender_id:currentProfile.id,body}).select('*').single();
  setBusy(event.currentTarget,false); if(error)return toast(error.message); chatMessages.push(data); input.value='';
  await sb.from('chat_threads').update({updated_at:new Date().toISOString()}).eq('id',activeChatThreadId); renderPage();
  requestAnimationFrame(()=>{const box=$('#chatMessages');if(box)box.scrollTop=box.scrollHeight;});
}

function renderForms(content) {
  setTitle('FORMULARE','Formulare');
  const visible=forms.filter(f=>currentProfile.role==='admin'||f.published);
  content.innerHTML=`<div class="hero"><div><h3>Formulare</h3><p>${currentProfile.role==='admin'?'Eigene PDF-/Bild-/Word-Formulare hochladen oder Online-Fragen erstellen.':'Formulare öffnen, online ausfüllen oder ausgefüllte Dateien zurücksenden.'}</p></div>${currentProfile.role==='admin'?'<button id="newOnlineForm" class="btn primary">+ Formular hochladen / erstellen</button>':''}</div><div class="forms-grid">${visible.length?visible.map(f=>{const subs=formSubmissions.filter(s=>s.form_id===f.id);const own=subs.find(s=>s.user_id===currentProfile.id);const hasFile=Boolean(f.file_path);const qCount=Array.isArray(f.questions)?f.questions.length:0;return `<div class="card form-card"><div class="form-card-head"><div><h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(f.description||'')}</p></div><span class="badge ${f.published?'active':'inactive'}">${f.published?'Online':'Entwurf'}</span></div><p class="muted">${hasFile?'📎 Eigene Datei · ':''}${qCount} Online-Fragen${currentProfile.role==='admin'?` · ${subs.length} Antworten`:own?' · Bereits gesendet':''}</p><div class="row-actions">${hasFile?`<button class="mini" data-open-form-file="${f.id}">Datei öffnen</button>`:''}<button class="btn primary" data-fill-form="${f.id}">${hasFile?'Ausfüllen / zurücksenden':'Online ausfüllen'}</button>${currentProfile.role==='admin'?`<button class="mini" data-edit-form="${f.id}">Bearbeiten</button><button class="mini" data-submissions="${f.id}">Antworten (${subs.length})</button><button class="mini bad" data-delete-form="${f.id}">Löschen</button>`:''}</div></div>`}).join(''):'<div class="card empty">Keine Formulare vorhanden.</div>'}</div>`;
  const newBtn=$('#newOnlineForm');if(newBtn)newBtn.onclick=()=>openOnlineFormDialog();
  $$('[data-open-form-file]').forEach(btn=>btn.onclick=()=>openFormTemplateFile(btn.dataset.openFormFile));
  $$('[data-fill-form]').forEach(btn=>btn.onclick=()=>openFillForm(btn.dataset.fillForm));
  $$('[data-edit-form]').forEach(btn=>btn.onclick=()=>openOnlineFormDialog(btn.dataset.editForm));
  $$('[data-submissions]').forEach(btn=>btn.onclick=()=>showFormSubmissions(btn.dataset.submissions));
  $$('[data-delete-form]').forEach(btn=>btn.onclick=()=>deleteOnlineForm(btn.dataset.deleteForm));
}

function openOnlineFormDialog(id=null) {
  const f=id?forms.find(x=>x.id===id):null;
  $('#formDialogTitle').textContent=f?'Formular bearbeiten':'Formular hochladen / erstellen';
  $('#formId').value=f?.id||'';
  $('#formTitle').value=f?.title||'';
  $('#formDescription').value=f?.description||'';
  $('#formQuestions').value=Array.isArray(f?.questions)?f.questions.join('\n'):'';
  $('#formPublished').checked=f?.published??true;
  $('#formFile').value='';
  const current=$('#formFileCurrent');
  current.classList.toggle('hidden',!f?.file_name);
  current.textContent=f?.file_name?`Aktuelle Datei: ${f.file_name}. Wähle nur eine neue Datei, wenn du sie ersetzen möchtest.`:'';
  $('#formDialog').showModal();
}

function safeFileName(name='datei') {
  return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(-120);
}

async function uploadTemplateFile(file, formId) {
  const path=`templates/${formId}/${Date.now()}-${safeFileName(file.name)}`;
  const {error}=await sb.storage.from('forms').upload(path,file,{upsert:false,contentType:file.type||undefined});
  if(error) throw error;
  return path;
}

async function openStorageFile(path) {
  const popup=window.open('about:blank','_blank');
  const {data,error}=await sb.storage.from('forms').createSignedUrl(path,300);
  if(error) { if(popup) popup.close(); return toast(error.message); }
  if(popup) { popup.opener=null; popup.location=data.signedUrl; }
  else location.href=data.signedUrl;
}

async function openFormTemplateFile(id) {
  const f=forms.find(x=>x.id===id); if(!f?.file_path)return toast('Keine Datei vorhanden.');
  await openStorageFile(f.file_path);
}

async function saveOnlineForm(event) {
  event.preventDefault();
  setBusy(event.currentTarget,true);
  const id=$('#formId').value || crypto.randomUUID();
  const questions=$('#formQuestions').value.split('\n').map(x=>x.trim()).filter(Boolean);
  const existing=forms.find(x=>x.id===id);
  const file=$('#formFile').files?.[0]||null;
  let filePath=existing?.file_path||null, fileName=existing?.file_name||null, fileMime=existing?.file_mime||null;
  try {
    if(file){
      if(file.size>10*1024*1024) throw new Error('Die Datei darf höchstens 10 MB groß sein.');
      filePath=await uploadTemplateFile(file,id); fileName=file.name; fileMime=file.type||'';
    }
    const payload={id,title:$('#formTitle').value.trim(),description:$('#formDescription').value.trim(),questions,published:$('#formPublished').checked,created_by:currentProfile.id,file_path:filePath,file_name:fileName,file_mime:fileMime};
    if(!payload.title) throw new Error('Bitte einen Titel eintragen.');
    if(!filePath && questions.length===0) throw new Error('Bitte eine Datei hochladen oder mindestens eine Online-Frage eintragen.');
    const result=existing?await sb.from('online_forms').update(payload).eq('id',id):await sb.from('online_forms').insert(payload);
    if(result.error) throw result.error;
    $('#formDialog').close(); await reloadAndRender('Formular wurde gespeichert.');
  } catch(error){ toast(error.message); }
  finally { setBusy(event.currentTarget,false); }
}

function openFillForm(id) {
  const f=forms.find(x=>x.id===id);if(!f)return;
  $('#fillFormId').value=f.id;
  $('#fillFormTitle').textContent=f.title;
  $('#fillFormDescription').textContent=f.description||'';
  $('#fillFormFile').value='';
  const template=$('#fillFormTemplate');
  template.classList.toggle('hidden',!f.file_path);
  template.innerHTML=f.file_path?`<div><b>Vorlage:</b> ${escapeHtml(f.file_name||'Formular')}</div><button id="openTemplateFromFill" type="button" class="btn ghost">Vorlage öffnen</button>`:'';
  if(f.file_path) $('#openTemplateFromFill').onclick=()=>openStorageFile(f.file_path);
  $('#fillFormFileWrap').classList.toggle('hidden',!f.file_path);
  $('#fillFormQuestions').innerHTML=(f.questions||[]).map((q,i)=>`<label>${escapeHtml(q)}<textarea data-form-answer="${i}" rows="2" required></textarea></label>`).join('');
  $('#fillFormDialog').showModal();
}

async function uploadSubmissionFile(file, formId) {
  const path=`submissions/${currentProfile.id}/${formId}/${Date.now()}-${safeFileName(file.name)}`;
  const {error}=await sb.storage.from('forms').upload(path,file,{upsert:false,contentType:file.type||undefined});
  if(error) throw error;
  return path;
}

async function submitOnlineForm(event) {
  event.preventDefault();setBusy(event.currentTarget,true);
  const id=$('#fillFormId').value;const f=forms.find(x=>x.id===id);
  const answers=(f.questions||[]).map((question,i)=>({question,answer:$(`[data-form-answer="${i}"]`).value.trim()}));
  const file=$('#fillFormFile').files?.[0]||null;
  let filePath=null,fileName=null;
  try{
    if(file){ if(file.size>10*1024*1024) throw new Error('Die Datei darf höchstens 10 MB groß sein.'); filePath=await uploadSubmissionFile(file,id);fileName=file.name; }
    if(answers.length===0 && !filePath) throw new Error('Bitte eine ausgefüllte Datei auswählen.');
    const {error}=await sb.from('form_submissions').insert({form_id:id,user_id:currentProfile.id,answers,file_path:filePath,file_name:fileName});
    if(error)throw error;
    $('#fillFormDialog').close();await reloadAndRender('Formular wurde abgesendet.');
  }catch(error){toast(error.message);}finally{setBusy(event.currentTarget,false);}
}

function showFormSubmissions(id) {
  const f=forms.find(x=>x.id===id);const subs=formSubmissions.filter(s=>s.form_id===id);
  $('#submissionDialogTitle').textContent=`${f?.title||'Formular'} – Antworten`;
  $('#submissionDialogContent').innerHTML=subs.length?subs.map(s=>`<button class="submission-card" data-show-submission="${s.id}"><b>${escapeHtml(profileById(s.user_id).full_name)}</b><span>${new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short'}).format(new Date(s.submitted_at))}${s.file_path?' · Datei':''}</span></button>`).join(''):'<div class="empty">Noch keine Antworten.</div>';
  $('#submissionDialog').showModal();
  $$('[data-show-submission]').forEach(btn=>btn.onclick=()=>{
    const sub=formSubmissions.find(x=>x.id===btn.dataset.showSubmission);
    $('#submissionDialogContent').innerHTML=`<button id="backSubs" class="mini">← Zurück</button><h4>${escapeHtml(profileById(sub.user_id).full_name)}</h4>${sub.file_path?`<button id="openSubmissionFile" class="btn primary" type="button">${escapeHtml(sub.file_name||'Ausgefüllte Datei')} öffnen</button>`:''}<div class="answer-list">${(sub.answers||[]).map(a=>`<div><b>${escapeHtml(a.question)}</b><p>${escapeHtml(a.answer||'–')}</p></div>`).join('')}</div>`;
    $('#backSubs').onclick=()=>showFormSubmissions(id);
    const openBtn=$('#openSubmissionFile'); if(openBtn) openBtn.onclick=()=>openStorageFile(sub.file_path);
  });
}

async function deleteOnlineForm(id) {
  if(!confirm('Formular wirklich löschen? Auch Antworten werden gelöscht.'))return;
  const f=forms.find(x=>x.id===id);
  const subs=formSubmissions.filter(x=>x.form_id===id);
  const paths=[f?.file_path,...subs.map(x=>x.file_path)].filter(Boolean);
  if(paths.length) await sb.storage.from('forms').remove(paths);
  const {error}=await sb.from('online_forms').delete().eq('id',id);
  if(error)return toast(error.message);
  await reloadAndRender('Formular wurde gelöscht.');
}

async function reloadAndRender(message = '') {
  $('#pageContent').innerHTML = '<div class="loading">Daten werden aktualisiert …</div>';
  await loadData();
  renderPage();
  if (message) toast(message);
}


// ===== V4: Direkt-in-der-Vorlage-Editor (Canva-/Photoshop-artig) =====
let templateDesignerState = { form: null, fields: [], selectedId: null, addMode: false };
let templateFillState = { form: null };

function visualTemplateSupported(form) {
  const mime = String(form?.file_mime || '').toLowerCase();
  const name = String(form?.file_name || '').toLowerCase();
  return mime === 'application/pdf' || mime === 'image/png' || mime === 'image/jpeg' || /\.(pdf|png|jpe?g)$/.test(name);
}

function templateFields(form) {
  const raw = form?.template_fields;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  return [];
}

async function signedTemplateUrl(form, expires = 900) {
  if (!form?.file_path) throw new Error('Für dieses Formular wurde keine Vorlage hochgeladen.');
  const { data, error } = await sb.storage.from('forms').createSignedUrl(form.file_path, expires);
  if (error) throw error;
  return data.signedUrl;
}

function setupPdfJsWorker() {
  if (!window.pdfjsLib) throw new Error('PDF-Anzeige konnte nicht geladen werden. Bitte die Seite neu laden.');
  if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
}

async function renderTemplateBackground(form, container, mode = 'fill') {
  container.innerHTML = '<div class="loading">Vorlage wird geladen …</div>';
  const url = await signedTemplateUrl(form);
  container.innerHTML = '';
  const mime = String(form.file_mime || '').toLowerCase();
  const name = String(form.file_name || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');

  if (isPdf) {
    setupPdfJsWorker();
    const pdf = await window.pdfjsLib.getDocument({ url }).promise;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.45 });
      const wrapper = document.createElement('div');
      wrapper.className = 'template-page';
      wrapper.dataset.templatePage = String(pageNumber);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.setAttribute('aria-label', `Seite ${pageNumber}`);
      const layer = document.createElement('div');
      layer.className = 'template-overlay';
      layer.dataset.templateLayer = String(pageNumber);
      const badge = document.createElement('span');
      badge.className = 'template-page-number';
      badge.textContent = `Seite ${pageNumber}`;
      wrapper.append(canvas, layer, badge);
      container.appendChild(wrapper);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (mode === 'designer') installDesignerPage(layer, pageNumber);
    }
    return;
  }

  if (mime.startsWith('image/') || /\.(png|jpe?g)$/.test(name)) {
    const wrapper = document.createElement('div');
    wrapper.className = 'template-page';
    wrapper.dataset.templatePage = '1';
    const img = document.createElement('img');
    img.src = url;
    img.alt = form.title || 'Formularvorlage';
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Bildvorlage konnte nicht geladen werden.')); });
    const layer = document.createElement('div');
    layer.className = 'template-overlay';
    layer.dataset.templateLayer = '1';
    const badge = document.createElement('span');
    badge.className = 'template-page-number';
    badge.textContent = 'Seite 1';
    wrapper.append(img, layer, badge);
    container.appendChild(wrapper);
    if (mode === 'designer') installDesignerPage(layer, 1);
    return;
  }

  throw new Error('Der Direkt-Editor unterstützt PDF, JPG und PNG. Word-Dateien können weiterhin normal geöffnet und zurückgesendet werden.');
}

function newTemplateField(page, x, y) {
  return {
    id: crypto.randomUUID(),
    page,
    label: 'Textfeld',
    type: 'text',
    required: false,
    x: Math.max(0, Math.min(0.92, x)),
    y: Math.max(0, Math.min(0.95, y)),
    w: 0.34,
    h: 0.045,
    fontSize: 16 / 820
  };
}

function installDesignerPage(layer, pageNumber) {
  layer.onclick = (event) => {
    if (!templateDesignerState.addMode || event.target !== layer) return;
    const rect = layer.getBoundingClientRect();
    const field = newTemplateField(
      pageNumber,
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height
    );
    field.x = Math.min(field.x, 1 - field.w);
    field.y = Math.min(field.y, 1 - field.h);
    templateDesignerState.fields.push(field);
    templateDesignerState.selectedId = field.id;
    templateDesignerState.addMode = false;
    updateAddFieldButton();
    renderDesignerFields();
    selectDesignerField(field.id);
  };
}

function updateAddFieldButton() {
  const button = $('#addTemplateField');
  if (!button) return;
  button.textContent = templateDesignerState.addMode ? 'Jetzt auf eine Linie klicken …' : '+ Textfeld auf Linie setzen';
  button.classList.toggle('danger', templateDesignerState.addMode);
  $$('.template-overlay').forEach(layer => layer.classList.toggle('add-mode', templateDesignerState.addMode));
}

function renderDesignerFields() {
  $$('.design-field').forEach(el => el.remove());
  for (const field of templateDesignerState.fields) {
    const layer = $(`[data-template-layer="${field.page}"]`);
    if (!layer) continue;
    const box = document.createElement('div');
    box.className = `design-field${field.id === templateDesignerState.selectedId ? ' selected' : ''}`;
    box.dataset.designField = field.id;
    box.style.left = `${field.x * 100}%`;
    box.style.top = `${field.y * 100}%`;
    box.style.width = `${field.w * 100}%`;
    box.style.height = `${field.h * 100}%`;
    const label = document.createElement('span');
    label.className = 'design-field-label';
    label.textContent = field.label || 'Textfeld';
    label.style.fontSize = `${Math.max(10, (field.fontSize || 16/820) * layer.clientWidth)}px`;
    const resize = document.createElement('span');
    resize.className = 'design-resize';
    box.append(label, resize);
    layer.appendChild(box);
    bindDesignerBox(box, resize, field, layer);
  }
}

function bindDesignerBox(box, resize, field, layer) {
  box.onclick = (event) => { event.stopPropagation(); selectDesignerField(field.id); };
  box.onpointerdown = (event) => {
    if (event.target === resize) return;
    event.preventDefault(); event.stopPropagation(); selectDesignerField(field.id);
    const rect = layer.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY, ox = field.x, oy = field.y;
    box.setPointerCapture?.(event.pointerId);
    const move = (e) => {
      field.x = Math.max(0, Math.min(1 - field.w, ox + (e.clientX - startX) / rect.width));
      field.y = Math.max(0, Math.min(1 - field.h, oy + (e.clientY - startY) / rect.height));
      box.style.left = `${field.x * 100}%`; box.style.top = `${field.y * 100}%`;
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  };
  resize.onpointerdown = (event) => {
    event.preventDefault(); event.stopPropagation(); selectDesignerField(field.id);
    const rect = layer.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY, ow = field.w, oh = field.h;
    const move = (e) => {
      field.w = Math.max(0.07, Math.min(1 - field.x, ow + (e.clientX - startX) / rect.width));
      field.h = Math.max(0.025, Math.min(1 - field.y, oh + (e.clientY - startY) / rect.height));
      box.style.width = `${field.w * 100}%`; box.style.height = `${field.h * 100}%`;
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  };
}

function selectDesignerField(id) {
  templateDesignerState.selectedId = id;
  const field = templateDesignerState.fields.find(item => item.id === id);
  $('#templateFieldInspector').classList.toggle('hidden', !field);
  $$('.design-field').forEach(el => el.classList.toggle('selected', el.dataset.designField === id));
  if (!field) return;
  $('#designerFieldLabel').value = field.label || '';
  $('#designerFieldType').value = field.type || 'text';
  $('#designerFieldRequired').checked = Boolean(field.required);
  $('#designerFieldFontSize').value = String(Math.round((field.fontSize || 16/820) * 820));
}

function syncSelectedDesignerField() {
  const field = templateDesignerState.fields.find(item => item.id === templateDesignerState.selectedId);
  if (!field) return;
  field.label = $('#designerFieldLabel').value.trim() || 'Textfeld';
  field.type = $('#designerFieldType').value;
  field.required = $('#designerFieldRequired').checked;
  field.fontSize = Math.max(8, Math.min(40, Number($('#designerFieldFontSize').value || 16))) / 820;
  renderDesignerFields();
  selectDesignerField(field.id);
}

async function openTemplateDesigner(id) {
  const form = forms.find(item => item.id === id);
  if (!form || !form.file_path) return toast('Bitte zuerst eine PDF-, JPG- oder PNG-Vorlage hochladen.');
  if (!visualTemplateSupported(form)) return toast('Der Direkt-Editor unterstützt PDF, JPG und PNG.');
  templateDesignerState = {
    form,
    fields: templateFields(form).map(field => ({ ...field })),
    selectedId: null,
    addMode: false
  };
  $('#templateDesignerTitle').textContent = `${form.title} – Felder auf Linien setzen`;
  $('#templateFieldInspector').classList.add('hidden');
  $('#templateDesignerDialog').showModal();
  $('#addTemplateField').onclick = () => {
    templateDesignerState.addMode = !templateDesignerState.addMode;
    updateAddFieldButton();
  };
  $('#designerFieldLabel').oninput = syncSelectedDesignerField;
  $('#designerFieldType').onchange = syncSelectedDesignerField;
  $('#designerFieldRequired').onchange = syncSelectedDesignerField;
  $('#designerFieldFontSize').oninput = syncSelectedDesignerField;
  $('#deleteTemplateField').onclick = () => {
    const idToDelete = templateDesignerState.selectedId;
    if (!idToDelete) return;
    templateDesignerState.fields = templateDesignerState.fields.filter(field => field.id !== idToDelete);
    templateDesignerState.selectedId = null;
    $('#templateFieldInspector').classList.add('hidden');
    renderDesignerFields();
  };
  $('#saveTemplateDesign').onclick = saveTemplateDesign;
  try {
    await renderTemplateBackground(form, $('#templateDesignerPages'), 'designer');
    renderDesignerFields();
    updateAddFieldButton();
  } catch (error) {
    $('#templateDesignerPages').innerHTML = `<div class="template-editor-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function saveTemplateDesign() {
  const button = $('#saveTemplateDesign');
  button.disabled = true; const old = button.textContent; button.textContent = 'Speichern …';
  try {
    const fields = templateDesignerState.fields.map(field => ({ ...field }));
    const { error: rpcError } = await sb.rpc('save_form_template_fields', {
      p_form_id: templateDesignerState.form.id,
      p_fields: fields
    });
    if (rpcError) throw rpcError;

    // Direkt frisch aus der Datenbank lesen. So sieht der Admin sofort,
    // dass die Felder wirklich gespeichert wurden – und Kunden bekommen
    // auf anderen Geräten ebenfalls die aktuelle Version.
    const { data: fresh, error: freshError } = await sb.from('online_forms').select('*').eq('id', templateDesignerState.form.id).single();
    if (freshError) throw freshError;
    const index = forms.findIndex(item => item.id === fresh.id);
    if (index >= 0) forms[index] = fresh; else forms.unshift(fresh);
    templateDesignerState.form = fresh;

    $('#templateDesignerDialog').close();
    renderPage();
    toast(`${templateFields(fresh).length} Feld${templateFields(fresh).length === 1 ? '' : 'er'} auf der Vorlage gespeichert.`);
  } catch (error) { toast(`Editor konnte nicht gespeichert werden: ${error.message}`); }
  finally { button.disabled = false; button.textContent = old; }
}

function createTemplateInput(field, layer) {
  const element = field.type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
  if (field.type !== 'textarea') element.type = ['date','number'].includes(field.type) ? field.type : 'text';
  element.className = `template-field-input${field.type === 'textarea' ? ' template-textarea' : ''}`;
  element.dataset.templateInput = field.id;
  element.dataset.templateLabel = field.label || 'Feld';
  element.required = Boolean(field.required);
  element.placeholder = field.label || '';
  element.title = field.label || '';
  element.style.left = `${field.x * 100}%`;
  element.style.top = `${field.y * 100}%`;
  element.style.width = `${field.w * 100}%`;
  element.style.height = `${field.h * 100}%`;
  const setFont = () => { element.style.fontSize = `${Math.max(9, (field.fontSize || 16/820) * layer.clientWidth)}px`; };
  setFont();
  if (window.ResizeObserver) new ResizeObserver(setFont).observe(layer);
  return element;
}

async function openVisualTemplateFill(form) {
  templateFillState = { form };
  $('#templateFillTitle').textContent = form.title;
  $('#templateFillDescription').textContent = form.description || '';
  $('#templateExtraQuestions').innerHTML = (form.questions || []).map((q, i) => `<label>${escapeHtml(q)}<textarea data-template-extra-answer="${i}" rows="2" required></textarea></label>`).join('');
  $('#templateFillDialog').showModal();
  $('#templateFillForm').onsubmit = submitVisualTemplateForm;
  try {
    await renderTemplateBackground(form, $('#templateFillPages'), 'fill');
    for (const field of templateFields(form)) {
      const layer = $(`#templateFillPages [data-template-layer="${field.page}"]`);
      if (!layer) continue;
      layer.appendChild(createTemplateInput(field, layer));
    }
  } catch (error) {
    $('#templateFillPages').innerHTML = `<div class="template-editor-empty">${escapeHtml(error.message)}</div>`;
  }
}

function splitPdfText(text, font, size, maxWidth) {
  const source = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const paragraph of source) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

async function buildFilledTemplatePdf(form, values) {
  if (!window.PDFLib) throw new Error('PDF-Erstellung konnte nicht geladen werden. Bitte die Seite neu laden.');
  const url = await signedTemplateUrl(form, 900);
  const response = await fetch(url);
  if (!response.ok) throw new Error('Vorlage konnte nicht geladen werden.');
  const bytes = await response.arrayBuffer();
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const mime = String(form.file_mime || '').toLowerCase();
  const name = String(form.file_name || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  let pdfDoc;
  if (isPdf) {
    pdfDoc = await PDFDocument.load(bytes);
  } else {
    pdfDoc = await PDFDocument.create();
    const embedded = (mime === 'image/png' || name.endsWith('.png')) ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const natural = embedded.scale(1);
    const maxWidth = 1200;
    const scale = natural.width > maxWidth ? maxWidth / natural.width : 1;
    const page = pdfDoc.addPage([natural.width * scale, natural.height * scale]);
    page.drawImage(embedded, { x: 0, y: 0, width: natural.width * scale, height: natural.height * scale });
  }
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  for (const field of templateFields(form)) {
    const text = String(values[field.id] ?? '').trim();
    if (!text) continue;
    const page = pages[Math.max(0, Number(field.page || 1) - 1)];
    if (!page) continue;
    const { width, height } = page.getSize();
    const fontSize = Math.max(7, Math.min(30, Number(field.fontSize || 16/820) * width));
    const x = Number(field.x || 0) * width + 2;
    const top = Number(field.y || 0) * height;
    const boxW = Math.max(20, Number(field.w || .3) * width - 4);
    const boxH = Math.max(fontSize + 2, Number(field.h || .04) * height);
    const lines = splitPdfText(text, font, fontSize, boxW);
    const lineHeight = fontSize * 1.12;
    let y = height - top - fontSize - Math.max(1, (boxH - fontSize) * .25);
    for (const line of lines) {
      if (y < height - top - boxH) break;
      page.drawText(line, { x, y, size: fontSize, font, color: rgb(0.04, 0.06, 0.1), maxWidth: boxW });
      y -= lineHeight;
    }
  }
  return pdfDoc.save();
}

async function uploadGeneratedPdf(bytes, form) {
  const name = `${safeFileName(form.title || 'Formular')}-ausgefuellt.pdf`;
  const path = `submissions/${currentProfile.id}/${form.id}/${Date.now()}-${name}`;
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const { error } = await sb.storage.from('forms').upload(path, blob, { upsert: false, contentType: 'application/pdf' });
  if (error) throw error;
  return { path, name };
}

async function submitVisualTemplateForm(event) {
  event.preventDefault();
  const formEl = event.currentTarget;
  setBusy(formEl, true);
  const form = templateFillState.form;
  try {
    const values = {};
    let firstInvalid = null;
    for (const field of templateFields(form)) {
      const input = $(`[data-template-input="${field.id}"]`);
      if (!input) continue;
      input.classList.remove('invalid');
      const value = input.value.trim();
      values[field.id] = value;
      if (field.required && !value && !firstInvalid) { firstInvalid = input; input.classList.add('invalid'); }
    }
    if (firstInvalid) { firstInvalid.focus(); throw new Error('Bitte alle Pflichtfelder direkt in der Vorlage ausfüllen.'); }
    const answers = templateFields(form).map(field => ({ question: field.label || 'Feld', answer: values[field.id] || '' }));
    (form.questions || []).forEach((question, i) => {
      const answer = $(`[data-template-extra-answer="${i}"]`)?.value.trim() || '';
      answers.push({ question, answer });
    });
    const pdfBytes = await buildFilledTemplatePdf(form, values);
    const uploaded = await uploadGeneratedPdf(pdfBytes, form);
    const { error } = await sb.from('form_submissions').insert({
      form_id: form.id,
      user_id: currentProfile.id,
      answers,
      file_path: uploaded.path,
      file_name: uploaded.name
    });
    if (error) throw error;
    $('#templateFillDialog').close();
    await reloadAndRender('Formular wurde direkt ausgefüllt und als PDF abgesendet.');
  } catch (error) { toast(error.message); }
  finally { setBusy(formEl, false); }
}

// V4 überschreibt die Formularübersicht: Direkt-Editor + direkte Eingabe auf den Linien.
function renderForms(content) {
  setTitle('FORMULARE','Formulare');
  const visible = forms.filter(f => currentProfile.role === 'admin' || f.published);
  content.innerHTML = `<div class="hero"><div><h3>Formulare & Vorlagen</h3><p>${currentProfile.role === 'admin' ? 'PDF/JPG/PNG hochladen und die Eingabefelder direkt auf die Linien setzen – wie in Canva.' : 'Direkt in die vorgesehenen Linien der Vorlage klicken, schreiben und als PDF absenden.'}</p></div>${currentProfile.role === 'admin' ? '<button id="newOnlineForm" class="btn primary">+ Formular hochladen / erstellen</button>' : ''}</div><div class="forms-grid">${visible.length ? visible.map(f => {
    const subs = formSubmissions.filter(s => s.form_id === f.id);
    const own = subs.find(s => s.user_id === currentProfile.id);
    const hasFile = Boolean(f.file_path);
    const qCount = Array.isArray(f.questions) ? f.questions.length : 0;
    const editable = visualTemplateSupported(f);
    const directFields = templateFields(f).length;
    return `<div class="card form-card"><div class="form-card-head"><div><h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(f.description || '')}</p></div><span class="badge ${f.published ? 'active' : 'inactive'}">${f.published ? 'Online' : 'Entwurf'}</span></div><p class="muted">${hasFile ? '📎 Eigene Vorlage · ' : ''}${directFields ? `<span class="form-editor-badge">✎ ${directFields} Felder direkt auf Linien</span> · ` : ''}${qCount} Zusatzfragen${currentProfile.role === 'admin' ? ` · ${subs.length} Antworten` : own ? ' · Bereits gesendet' : ''}</p><div class="row-actions">${hasFile ? `<button class="mini" data-open-form-file="${f.id}">Original öffnen</button>` : ''}${currentProfile.role === 'admin' && editable ? `<button class="btn primary" data-template-designer="${f.id}">${directFields ? 'Editor bearbeiten' : '✎ Linien-Editor einrichten'}</button>` : ''}<button class="btn primary" data-fill-form="${f.id}">${directFields ? 'Direkt in Vorlage ausfüllen' : hasFile ? 'Ausfüllen / zurücksenden' : 'Online ausfüllen'}</button>${currentProfile.role === 'admin' ? `<button class="mini" data-edit-form="${f.id}">Details</button><button class="mini" data-submissions="${f.id}">Antworten (${subs.length})</button><button class="mini bad" data-delete-form="${f.id}">Löschen</button>` : ''}</div></div>`;
  }).join('') : '<div class="card empty">Keine Formulare vorhanden.</div>'}</div>`;
  const newBtn = $('#newOnlineForm'); if (newBtn) newBtn.onclick = () => openOnlineFormDialog();
  $$('[data-open-form-file]').forEach(btn => btn.onclick = () => openFormTemplateFile(btn.dataset.openFormFile));
  $$('[data-template-designer]').forEach(btn => btn.onclick = () => openTemplateDesigner(btn.dataset.templateDesigner));
  $$('[data-fill-form]').forEach(btn => btn.onclick = () => openFillForm(btn.dataset.fillForm));
  $$('[data-edit-form]').forEach(btn => btn.onclick = () => openOnlineFormDialog(btn.dataset.editForm));
  $$('[data-submissions]').forEach(btn => btn.onclick = () => showFormSubmissions(btn.dataset.submissions));
  $$('[data-delete-form]').forEach(btn => btn.onclick = () => deleteOnlineForm(btn.dataset.deleteForm));
}

// V4: Wenn der Admin Felder auf der Vorlage gesetzt hat, öffnet sich der visuelle Editor.
async function openFillForm(id) {
  let form = forms.find(item => item.id === id);
  if (!form) return;
  // Vor dem Öffnen einmal frisch laden, damit neu gesetzte Linienfelder nicht
  // durch einen alten Browser-/Realtime-Stand verloren wirken.
  try {
    const { data: fresh, error } = await sb.from('online_forms').select('*').eq('id', id).single();
    if (!error && fresh) {
      form = fresh;
      const index = forms.findIndex(item => item.id === id);
      if (index >= 0) forms[index] = fresh;
    }
  } catch (_) {}
  if (visualTemplateSupported(form) && templateFields(form).length) {
    await openVisualTemplateFill(form);
    return;
  }
  $('#fillFormId').value = form.id;
  $('#fillFormTitle').textContent = form.title;
  $('#fillFormDescription').textContent = form.description || '';
  $('#fillFormFile').value = '';
  const template = $('#fillFormTemplate');
  template.classList.toggle('hidden', !form.file_path);
  template.innerHTML = form.file_path ? `<div><b>Vorlage:</b> ${escapeHtml(form.file_name || 'Formular')}</div><button id="openTemplateFromFill" type="button" class="btn ghost">Vorlage öffnen</button>${visualTemplateSupported(form) ? '<p class="field-hint">Der Admin hat für diese Vorlage noch keine direkten Textfelder auf den Linien eingerichtet.</p>' : ''}` : '';
  if (form.file_path) $('#openTemplateFromFill').onclick = () => openStorageFile(form.file_path);
  $('#fillFormFileWrap').classList.toggle('hidden', !form.file_path);
  $('#fillFormQuestions').innerHTML = (form.questions || []).map((q, i) => `<label>${escapeHtml(q)}<textarea data-form-answer="${i}" rows="2" required></textarea></label>`).join('');
  $('#fillFormDialog').showModal();
}

// V4: Beim Ersetzen der Vorlage werden alte Feldpositionen bewusst zurückgesetzt.
async function saveOnlineForm(event) {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  const id = $('#formId').value || crypto.randomUUID();
  const questions = $('#formQuestions').value.split('\n').map(x => x.trim()).filter(Boolean);
  const existing = forms.find(x => x.id === id);
  const file = $('#formFile').files?.[0] || null;
  let filePath = existing?.file_path || null, fileName = existing?.file_name || null, fileMime = existing?.file_mime || null;
  try {
    if (file) {
      if (file.size > 10 * 1024 * 1024) throw new Error('Die Datei darf höchstens 10 MB groß sein.');
      filePath = await uploadTemplateFile(file, id); fileName = file.name; fileMime = file.type || '';
    }
    const payload = {
      id,
      title: $('#formTitle').value.trim(),
      description: $('#formDescription').value.trim(),
      questions,
      published: $('#formPublished').checked,
      created_by: currentProfile.id,
      file_path: filePath,
      file_name: fileName,
      file_mime: fileMime,
      ...(file ? { template_fields: [] } : {})
    };
    if (!payload.title) throw new Error('Bitte einen Titel eintragen.');
    if (!filePath && questions.length === 0) throw new Error('Bitte eine Datei hochladen oder mindestens eine Online-Frage eintragen.');
    const result = existing ? await sb.from('online_forms').update(payload).eq('id', id) : await sb.from('online_forms').insert(payload);
    if (result.error) throw result.error;
    $('#formDialog').close();
    await reloadAndRender(file && existing && templateFields(existing).length ? 'Neue Vorlage gespeichert. Die alten Feldpositionen wurden zurückgesetzt.' : 'Formular wurde gespeichert.');
  } catch (error) { toast(error.message); }
  finally { setBusy(event.currentTarget, false); }
}


// ===== V5: automatische KI-Felder + feste Safa-Yildiz-Standardvorlagen =====
const V5_TEMPLATE_PRESETS = {"einfacher-vertrag.pdf":[{"label":"Partei B - Name / Firma","type":"text","required":true,"x":0.25198,"y":0.32783,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract1-01","page":1},{"label":"Partei B - Adresse","type":"text","required":true,"x":0.25198,"y":0.35872,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract1-02","page":1},{"label":"Partei B - Telefon / E-Mail","type":"text","required":false,"x":0.25198,"y":0.38841,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract1-03","page":1},{"label":"Vertragsgegenstand / Vereinbarung","type":"textarea","required":true,"x":0.10415,"y":0.45849,"w":0.79123,"h":0.05345,"fontSize":0.014634,"id":"contract1-04","page":1},{"label":"Preis / Zahlung","type":"textarea","required":false,"x":0.10415,"y":0.56064,"w":0.79123,"h":0.05345,"fontSize":0.014634,"id":"contract1-05","page":1},{"label":"Besondere Absprachen","type":"textarea","required":false,"x":0.10415,"y":0.66279,"w":0.79123,"h":0.04989,"fontSize":0.014634,"id":"contract1-06","page":1},{"label":"Betrag","type":"number","required":false,"x":0.22847,"y":0.721,"w":0.24694,"h":0.02138,"fontSize":0.014634,"id":"contract1-07","page":1},{"label":"Fällig am","type":"date","required":false,"x":0.6518,"y":0.721,"w":0.26206,"h":0.02138,"fontSize":0.014634,"id":"contract1-08","page":1},{"label":"Ort, Datum","type":"text","required":false,"x":0.19991,"y":0.75544,"w":0.29062,"h":0.02138,"fontSize":0.014634,"id":"contract1-09","page":1},{"label":"Unterschrift Safa Yildiz","type":"text","required":false,"x":0.08567,"y":0.81008,"w":0.36622,"h":0.02138,"fontSize":0.013415,"id":"contract1-10","page":1},{"label":"Unterschrift Partei B","type":"text","required":false,"x":0.54765,"y":0.81008,"w":0.36622,"h":0.02138,"fontSize":0.013415,"id":"contract1-11","page":1}],"kaufvertrag.pdf":[{"label":"Partei B - Name / Firma","type":"text","required":true,"x":0.25198,"y":0.32783,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract2-01","page":1},{"label":"Partei B - Adresse","type":"text","required":true,"x":0.25198,"y":0.35872,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract2-02","page":1},{"label":"Partei B - Telefon / E-Mail","type":"text","required":false,"x":0.25198,"y":0.38841,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract2-03","page":1},{"label":"Verkaufter Gegenstand","type":"textarea","required":true,"x":0.10415,"y":0.45849,"w":0.79123,"h":0.05345,"fontSize":0.014634,"id":"contract2-04","page":1},{"label":"Zustand / Zubehör","type":"textarea","required":false,"x":0.10415,"y":0.56064,"w":0.79123,"h":0.05345,"fontSize":0.014634,"id":"contract2-05","page":1},{"label":"Besondere Absprachen","type":"textarea","required":false,"x":0.10415,"y":0.66279,"w":0.79123,"h":0.04989,"fontSize":0.014634,"id":"contract2-06","page":1},{"label":"Betrag","type":"number","required":false,"x":0.22847,"y":0.721,"w":0.24694,"h":0.02138,"fontSize":0.014634,"id":"contract2-07","page":1},{"label":"Fällig am","type":"date","required":false,"x":0.6518,"y":0.721,"w":0.26206,"h":0.02138,"fontSize":0.014634,"id":"contract2-08","page":1},{"label":"Ort, Datum","type":"text","required":false,"x":0.19991,"y":0.75544,"w":0.29062,"h":0.02138,"fontSize":0.014634,"id":"contract2-09","page":1},{"label":"Unterschrift Safa Yildiz","type":"text","required":false,"x":0.08567,"y":0.81008,"w":0.36622,"h":0.02138,"fontSize":0.013415,"id":"contract2-10","page":1},{"label":"Unterschrift Partei B","type":"text","required":false,"x":0.54765,"y":0.81008,"w":0.36622,"h":0.02138,"fontSize":0.013415,"id":"contract2-11","page":1}],"dienstleistungsvereinbarung.pdf":[{"label":"Partei B - Name / Firma","type":"text","required":true,"x":0.25198,"y":0.32783,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract3-01","page":1},{"label":"Partei B - Adresse","type":"text","required":true,"x":0.25198,"y":0.35872,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract3-02","page":1},{"label":"Partei B - Telefon / E-Mail","type":"text","required":false,"x":0.25198,"y":0.38841,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract3-03","page":1},{"label":"Auftrag / Leistung","type":"textarea","required":true,"x":0.10415,"y":0.45849,"w":0.79123,"h":0.05345,"fontSize":0.014634,"id":"contract3-04","page":1},{"label":"Termin / Zeitraum","type":"textarea","required":false,"x":0.10415,"y":0.56064,"w":0.79123,"h":0.05345,"fontSize":0.014634,"id":"contract3-05","page":1},{"label":"Preis / Zahlungsweise","type":"textarea","required":false,"x":0.10415,"y":0.66279,"w":0.79123,"h":0.04989,"fontSize":0.014634,"id":"contract3-06","page":1},{"label":"Betrag","type":"number","required":false,"x":0.22847,"y":0.721,"w":0.24694,"h":0.02138,"fontSize":0.014634,"id":"contract3-07","page":1},{"label":"Fällig am","type":"date","required":false,"x":0.6518,"y":0.721,"w":0.26206,"h":0.02138,"fontSize":0.014634,"id":"contract3-08","page":1},{"label":"Ort, Datum","type":"text","required":false,"x":0.19991,"y":0.75544,"w":0.29062,"h":0.02138,"fontSize":0.014634,"id":"contract3-09","page":1},{"label":"Unterschrift Safa Yildiz","type":"text","required":false,"x":0.08567,"y":0.81008,"w":0.36622,"h":0.02138,"fontSize":0.013415,"id":"contract3-10","page":1},{"label":"Unterschrift Partei B","type":"text","required":false,"x":0.54765,"y":0.81008,"w":0.36622,"h":0.02138,"fontSize":0.013415,"id":"contract3-11","page":1}],"uebergabe-zahlungsbestaetigung.pdf":[{"label":"Partei B - Name / Firma","type":"text","required":true,"x":0.25198,"y":0.32783,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract4-01","page":1},{"label":"Partei B - Adresse","type":"text","required":true,"x":0.25198,"y":0.35872,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract4-02","page":1},{"label":"Partei B - Telefon / E-Mail","type":"text","required":false,"x":0.25198,"y":0.38841,"w":0.66188,"h":0.02138,"fontSize":0.015854,"id":"contract4-03","page":1},{"label":"Übergebener Gegenstand / Dokumente","type":"textarea","required":true,"x":0.10415,"y":0.45849,"w":0.79123,"h":0.05345,"fontSize":0.014634,"id":"contract4-04","page":1},{"label":"Erhaltener Betrag / Zahlungsart","type":"textarea","required":false,"x":0.10415,"y":0.56064,"w":0.79123,"h":0.05345,"fontSize":0.014634,"id":"contract4-05","page":1},{"label":"Bemerkungen","type":"textarea","required":false,"x":0.10415,"y":0.66279,"w":0.79123,"h":0.04989,"fontSize":0.014634,"id":"contract4-06","page":1},{"label":"Betrag","type":"number","required":false,"x":0.22847,"y":0.721,"w":0.24694,"h":0.02138,"fontSize":0.014634,"id":"contract4-07","page":1},{"label":"Fällig am","type":"date","required":false,"x":0.6518,"y":0.721,"w":0.26206,"h":0.02138,"fontSize":0.014634,"id":"contract4-08","page":1},{"label":"Ort, Datum","type":"text","required":false,"x":0.19991,"y":0.75544,"w":0.29062,"h":0.02138,"fontSize":0.014634,"id":"contract4-09","page":1},{"label":"Unterschrift Safa Yildiz","type":"text","required":false,"x":0.08567,"y":0.81008,"w":0.36622,"h":0.02138,"fontSize":0.013415,"id":"contract4-10","page":1},{"label":"Unterschrift Partei B","type":"text","required":false,"x":0.54765,"y":0.81008,"w":0.36622,"h":0.02138,"fontSize":0.013415,"id":"contract4-11","page":1}],"vertragsfragebogen.pdf":[{"label":"Formular-Nr.","type":"text","required":false,"x":0.87522,"y":0.02494,"w":0.0672,"h":0.01782,"fontSize":0.014634,"id":"questionnaire-01","page":1},{"label":"Datum","type":"date","required":false,"x":0.84163,"y":0.04157,"w":0.10079,"h":0.01782,"fontSize":0.014634,"id":"questionnaire-02","page":1},{"label":"Kundendaten - Name / Firma","type":"text","required":true,"x":0.18983,"y":0.14254,"w":0.36286,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-03","page":1},{"label":"Kundendaten - Telefon","type":"text","required":false,"x":0.65684,"y":0.14254,"w":0.28558,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-04","page":1},{"label":"Kundendaten - Adresse","type":"text","required":true,"x":0.15287,"y":0.1651,"w":0.39981,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-05","page":1},{"label":"Kundendaten - E-Mail","type":"text","required":false,"x":0.65684,"y":0.1651,"w":0.28558,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-06","page":1},{"label":"Einfacher Vertrag","type":"checkbox","required":false,"x":0.05712,"y":0.22782,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-07","page":1},{"label":"Kaufvertrag","type":"checkbox","required":false,"x":0.26206,"y":0.22782,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-08","page":1},{"label":"Dienstleistungsvereinbarung","type":"checkbox","required":false,"x":0.42837,"y":0.22782,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-09","page":1},{"label":"Übergabe-/Zahlungsbestätigung","type":"checkbox","required":false,"x":0.71899,"y":0.22782,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-10","page":1},{"label":"Sonstiger Vertrag","type":"checkbox","required":false,"x":0.05712,"y":0.24968,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-11","page":1},{"label":"Sonstiger Vertrag - Bezeichnung","type":"text","required":false,"x":0.23854,"y":0.23994,"w":0.70388,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-12","page":1},{"label":"Ziel / Anlass","type":"textarea","required":true,"x":0.17639,"y":0.29339,"w":0.76603,"h":0.04276,"fontSize":0.014634,"id":"questionnaire-13","page":1},{"label":"Partei A - Name / Firma","type":"text","required":true,"x":0.17639,"y":0.38604,"w":0.30742,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-14","page":1},{"label":"Partei A - Adresse","type":"text","required":false,"x":0.13775,"y":0.40504,"w":0.34606,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-15","page":1},{"label":"Partei A - Telefon / E-Mail","type":"text","required":false,"x":0.20495,"y":0.42405,"w":0.27886,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-16","page":1},{"label":"Partei B - Name / Firma","type":"text","required":true,"x":0.635,"y":0.38604,"w":0.30742,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-17","page":1},{"label":"Partei B - Adresse","type":"text","required":false,"x":0.59804,"y":0.40504,"w":0.34438,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-18","page":1},{"label":"Partei B - Telefon / E-Mail","type":"text","required":false,"x":0.66356,"y":0.42405,"w":0.27886,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-19","page":1},{"label":"Gegenstand / Leistung / Vereinbarung","type":"text","required":true,"x":0.36118,"y":0.47275,"w":0.58124,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-20","page":1},{"label":"Zustand / Zubehör / Umfang","type":"text","required":false,"x":0.36118,"y":0.49294,"w":0.58124,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-21","page":1},{"label":"Termin / Zeitraum / Übergabe","type":"text","required":false,"x":0.36118,"y":0.51313,"w":0.58124,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-22","page":1},{"label":"Preis / Betrag","type":"number","required":false,"x":0.19487,"y":0.53332,"w":0.22007,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-23","page":1},{"label":"Zahlungsweise","type":"text","required":false,"x":0.59468,"y":0.53332,"w":0.18143,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-24","page":1},{"label":"Fällig am","type":"date","required":false,"x":0.87522,"y":0.53332,"w":0.0672,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-25","page":1},{"label":"Besondere Absprachen / Bedingungen","type":"textarea","required":false,"x":0.36622,"y":0.55352,"w":0.5762,"h":0.03801,"fontSize":0.014634,"id":"questionnaire-26","page":1},{"label":"Benötigte Unterlagen / Nachweise","type":"textarea","required":false,"x":0.33766,"y":0.59271,"w":0.60476,"h":0.03801,"fontSize":0.014634,"id":"questionnaire-27","page":1},{"label":"Firmenstempel","type":"checkbox","required":false,"x":0.05712,"y":0.6723,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-28","page":1},{"label":"Zeugen","type":"checkbox","required":false,"x":0.23854,"y":0.6723,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-29","page":1},{"label":"Anlage / Fotos","type":"checkbox","required":false,"x":0.3763,"y":0.6723,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-30","page":1},{"label":"Rechnung / Quittung","type":"checkbox","required":false,"x":0.57116,"y":0.6723,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-31","page":1},{"label":"Eilige Bearbeitung","type":"checkbox","required":false,"x":0.79963,"y":0.6723,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-32","page":1},{"label":"Weitere Wünsche","type":"checkbox","required":false,"x":0.05712,"y":0.69368,"w":0.0168,"h":0.01188,"fontSize":0.014634,"id":"questionnaire-33","page":1},{"label":"Weitere Wünsche - Text","type":"text","required":false,"x":0.21839,"y":0.68418,"w":0.72403,"h":0.02613,"fontSize":0.014634,"id":"questionnaire-34","page":1},{"label":"Ort, Datum","type":"text","required":true,"x":0.17135,"y":0.76257,"w":0.2671,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-35","page":1},{"label":"Unterschrift Kunde","type":"text","required":true,"x":0.6854,"y":0.76257,"w":0.25702,"h":0.02138,"fontSize":0.014634,"id":"questionnaire-36","page":1}]};

function hasTemplateFileV5(form) {
  return Boolean(form?.file_path || form?.asset_path);
}

function visualTemplateSupported(form) {
  const mime = String(form?.file_mime || '').toLowerCase();
  const name = String(form?.file_name || form?.asset_path || '').toLowerCase();
  return mime === 'application/pdf' || mime === 'image/png' || mime === 'image/jpeg' || /\.(pdf|png|jpe?g)$/.test(name);
}

async function signedTemplateUrl(form, expires = 900) {
  if (form?.asset_path) return new URL(String(form.asset_path), document.baseURI).href;
  if (!form?.file_path) throw new Error('Für dieses Formular wurde keine Vorlage hinterlegt.');
  const { data, error } = await sb.storage.from('forms').createSignedUrl(form.file_path, expires);
  if (error) throw error;
  return data.signedUrl;
}

function v5PresetFields(form) {
  const preset = V5_TEMPLATE_PRESETS[String(form?.asset_path || '')];
  if (!preset) return [];
  return preset.map((field, index) => ({ ...field, id: crypto.randomUUID?.() || `auto-${Date.now()}-${index}` }));
}

function v5GuessFieldType(label) {
  const s = String(label || '').toLowerCase();
  if (/datum|fällig/.test(s)) return 'date';
  if (/preis|betrag|summe|kosten/.test(s)) return 'number';
  if (/bemerk|absprach|anlass|gegenstand|leistung|zustand|umfang|unterlagen|nachweise|wünsche|vereinbarung/.test(s)) return 'textarea';
  return 'text';
}

async function v5GenericPdfFieldDetection(form) {
  const url = await signedTemplateUrl(form);
  setupPdfJsWorker();
  const pdf = await window.pdfjsLib.getDocument({ url }).promise;
  const fields = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter(item => String(item.str || '').trim());
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item.str || '').trim();
      if (!text.endsWith(':')) continue;
      const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontH = Math.max(8, Math.hypot(tx[2], tx[3]));
      const left = tx[4] + Number(item.width || 0) + 5;
      const top = tx[5] - fontH - 2;
      if (left > viewport.width * .89 || top < 0) continue;
      const label = text.replace(/:$/, '').trim() || 'Feld';
      const type = v5GuessFieldType(label);
      const width = Math.max(55, viewport.width * .92 - left);
      const height = type === 'textarea' ? Math.max(30, fontH * 2.8) : Math.max(17, fontH * 1.5);
      fields.push({
        id: crypto.randomUUID(), page: pageNumber, label, type, required: false,
        x: Math.max(0, left / viewport.width), y: Math.max(0, top / viewport.height),
        w: Math.min(.8, width / viewport.width), h: Math.min(.12, height / viewport.height),
        fontSize: Math.max(10, Math.min(16, fontH)) / 820
      });
    }
  }
  // Fast gleiche Treffer zusammenfassen.
  return fields.filter((field, index, all) => !all.slice(0,index).some(old => old.page===field.page && Math.abs(old.x-field.x)<.02 && Math.abs(old.y-field.y)<.012));
}

async function v5AiDetectFields(form) {
  const exact = v5PresetFields(form);
  if (exact.length) return exact;
  const name = String(form?.file_name || '').toLowerCase();
  const mime = String(form?.file_mime || '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return v5GenericPdfFieldDetection(form);
  throw new Error('Die automatische Erkennung funktioniert derzeit für PDF-Vorlagen. Bei Bildern kannst du Felder weiterhin manuell setzen.');
}

async function openTemplateDesigner(id) {
  const form = forms.find(item => item.id === id);
  if (!form || !hasTemplateFileV5(form)) return toast('Bitte zuerst eine PDF-, JPG- oder PNG-Vorlage hinterlegen.');
  if (!visualTemplateSupported(form)) return toast('Der Direkt-Editor unterstützt PDF, JPG und PNG.');
  templateDesignerState = { form, fields: templateFields(form).map(field => ({ ...field })), selectedId: null, addMode: false };
  $('#templateDesignerTitle').textContent = `${form.title} – KI-Linien-Editor`;
  $('#templateFieldInspector').classList.add('hidden');
  $('#templateDesignerDialog').showModal();
  $('#addTemplateField').onclick = () => { templateDesignerState.addMode = !templateDesignerState.addMode; updateAddFieldButton(); };
  $('#aiDetectTemplateFields').onclick = async () => {
    const button = $('#aiDetectTemplateFields'); const old = button.textContent; button.disabled = true; button.textContent = '✨ KI analysiert …';
    try {
      if (templateDesignerState.fields.length && !confirm('Vorhandene Felder durch die automatische Erkennung ersetzen?')) return;
      const detected = await v5AiDetectFields(form);
      templateDesignerState.fields = detected;
      templateDesignerState.selectedId = null;
      $('#templateFieldInspector').classList.add('hidden');
      renderDesignerFields();
      toast(`${detected.length} Eingabefelder automatisch erkannt.`);
    } catch (error) { toast(`Automatische Erkennung: ${error.message}`); }
    finally { button.disabled = false; button.textContent = old; }
  };
  $('#designerFieldLabel').oninput = syncSelectedDesignerField;
  $('#designerFieldType').onchange = syncSelectedDesignerField;
  $('#designerFieldRequired').onchange = syncSelectedDesignerField;
  $('#designerFieldFontSize').oninput = syncSelectedDesignerField;
  $('#deleteTemplateField').onclick = () => {
    const idToDelete = templateDesignerState.selectedId; if (!idToDelete) return;
    templateDesignerState.fields = templateDesignerState.fields.filter(field => field.id !== idToDelete);
    templateDesignerState.selectedId = null; $('#templateFieldInspector').classList.add('hidden'); renderDesignerFields();
  };
  $('#saveTemplateDesign').onclick = saveTemplateDesign;
  try {
    await renderTemplateBackground(form, $('#templateDesignerPages'), 'designer');
    // Bei neuen PDFs startet die Erkennung automatisch. Die fünf Standardvorlagen
    // kommen bereits vollständig erkannt aus der Datenbank.
    if (!templateDesignerState.fields.length) {
      try { templateDesignerState.fields = await v5AiDetectFields(form); } catch (_) {}
    }
    renderDesignerFields(); updateAddFieldButton();
  } catch (error) { $('#templateDesignerPages').innerHTML = `<div class="template-editor-empty">${escapeHtml(error.message)}</div>`; }
}

function createTemplateInput(field, layer) {
  if (field.type === 'checkbox') {
    const element = document.createElement('input');
    element.type = 'checkbox';
    element.className = 'template-field-checkbox';
    element.dataset.templateInput = field.id;
    element.dataset.templateLabel = field.label || 'Auswahl';
    element.required = Boolean(field.required);
    element.title = field.label || '';
    element.style.left = `${field.x * 100}%`; element.style.top = `${field.y * 100}%`;
    element.style.width = `${field.w * 100}%`; element.style.height = `${field.h * 100}%`;
    return element;
  }
  const element = field.type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
  if (field.type !== 'textarea') element.type = ['date','number'].includes(field.type) ? field.type : 'text';
  element.className = `template-field-input${field.type === 'textarea' ? ' template-textarea' : ''}`;
  element.dataset.templateInput = field.id; element.dataset.templateLabel = field.label || 'Feld';
  element.required = Boolean(field.required); element.placeholder = field.label || ''; element.title = field.label || '';
  element.style.left = `${field.x * 100}%`; element.style.top = `${field.y * 100}%`; element.style.width = `${field.w * 100}%`; element.style.height = `${field.h * 100}%`;
  const setFont = () => { element.style.fontSize = `${Math.max(9, (field.fontSize || 16/820) * layer.clientWidth)}px`; };
  setFont(); if (window.ResizeObserver) new ResizeObserver(setFont).observe(layer); return element;
}

async function buildFilledTemplatePdf(form, values) {
  if (!window.PDFLib) throw new Error('PDF-Erstellung konnte nicht geladen werden. Bitte die Seite neu laden.');
  const url = await signedTemplateUrl(form, 900); const response = await fetch(url); if (!response.ok) throw new Error('Vorlage konnte nicht geladen werden.');
  const bytes = await response.arrayBuffer(); const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const mime = String(form.file_mime || '').toLowerCase(); const name = String(form.file_name || form.asset_path || '').toLowerCase(); const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  let pdfDoc;
  if (isPdf) pdfDoc = await PDFDocument.load(bytes);
  else {
    pdfDoc = await PDFDocument.create(); const embedded = (mime === 'image/png' || name.endsWith('.png')) ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const natural = embedded.scale(1); const maxWidth = 1200; const scale = natural.width > maxWidth ? maxWidth / natural.width : 1;
    const page = pdfDoc.addPage([natural.width * scale, natural.height * scale]); page.drawImage(embedded, { x:0,y:0,width:natural.width*scale,height:natural.height*scale });
  }
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica); const pages = pdfDoc.getPages();
  for (const field of templateFields(form)) {
    const page = pages[Math.max(0, Number(field.page || 1) - 1)]; if (!page) continue;
    const { width, height } = page.getSize(); const x0 = Number(field.x || 0) * width; const top = Number(field.y || 0) * height;
    if (field.type === 'checkbox') {
      if (!values[field.id]) continue;
      const size = Math.max(7, Math.min(14, Number(field.h || .02) * height * .95));
      page.drawText('X', { x:x0+1, y:height-top-size+1, size, font, color:rgb(0.02,0.03,0.08) }); continue;
    }
    const text = String(values[field.id] ?? '').trim(); if (!text) continue;
    const fontSize = Math.max(7, Math.min(30, Number(field.fontSize || 16/820) * width)); const x = x0 + 2;
    const boxW = Math.max(20, Number(field.w || .3) * width - 4); const boxH = Math.max(fontSize + 2, Number(field.h || .04) * height);
    const lines = splitPdfText(text, font, fontSize, boxW); const lineHeight = fontSize * 1.12; let y = height - top - fontSize - Math.max(1, (boxH - fontSize) * .25);
    for (const line of lines) { if (y < height - top - boxH) break; page.drawText(line, { x,y,size:fontSize,font,color:rgb(0.04,0.06,0.1),maxWidth:boxW }); y -= lineHeight; }
  }
  return pdfDoc.save();
}

async function submitVisualTemplateForm(event) {
  event.preventDefault(); const formEl = event.currentTarget; setBusy(formEl, true); const form = templateFillState.form;
  try {
    const values = {}; let firstInvalid = null;
    for (const field of templateFields(form)) {
      const input = $(`[data-template-input="${field.id}"]`); if (!input) continue; input.classList.remove('invalid');
      const value = field.type === 'checkbox' ? Boolean(input.checked) : input.value.trim(); values[field.id] = value;
      if (field.required && (field.type === 'checkbox' ? !input.checked : !value) && !firstInvalid) { firstInvalid=input; input.classList.add('invalid'); }
    }
    if (firstInvalid) { firstInvalid.focus(); throw new Error('Bitte alle Pflichtfelder direkt in der Vorlage ausfüllen.'); }
    const answers = templateFields(form).map(field => ({ question: field.label || 'Feld', answer: field.type === 'checkbox' ? (values[field.id] ? 'Ja' : 'Nein') : (values[field.id] || '') }));
    (form.questions || []).forEach((question,i) => { const answer=$(`[data-template-extra-answer="${i}"]`)?.value.trim() || ''; answers.push({question,answer}); });
    const pdfBytes = await buildFilledTemplatePdf(form, values); const uploaded = await uploadGeneratedPdf(pdfBytes, form);
    const { error } = await sb.from('form_submissions').insert({ form_id:form.id,user_id:currentProfile.id,answers,file_path:uploaded.path,file_name:uploaded.name }); if (error) throw error;
    $('#templateFillDialog').close(); await reloadAndRender('Formular wurde direkt ausgefüllt und als PDF abgesendet.');
  } catch (error) { toast(error.message); } finally { setBusy(formEl,false); }
}

async function openFormTemplateFile(id) {
  const form = forms.find(x => x.id === id); if (!form || !hasTemplateFileV5(form)) return toast('Keine Datei vorhanden.');
  if (form.asset_path) { const popup=window.open(new URL(form.asset_path, document.baseURI).href,'_blank'); if (popup) popup.opener=null; return; }
  await openStorageFile(form.file_path);
}

function renderForms(content) {
  setTitle('FORMULARE','Formulare'); const visible=forms.filter(f=>currentProfile.role==='admin'||f.published);
  content.innerHTML=`<div class="hero"><div><h3>Formulare & Vorlagen</h3><p>${currentProfile.role==='admin'?'Die Safa-Yildiz-Standardformulare sind schon automatisch erkannt. Neue PDFs kann die KI ebenfalls automatisch vorbereiten.':'Direkt in die vorgesehenen Linien klicken, schreiben und als PDF absenden.'}</p></div>${currentProfile.role==='admin'?'<button id="newOnlineForm" class="btn primary">+ Eigenes Formular hochladen</button>':''}</div><div class="forms-grid">${visible.length?visible.map(f=>{
    const subs=formSubmissions.filter(s=>s.form_id===f.id); const own=subs.find(s=>s.user_id===currentProfile.id); const hasFile=hasTemplateFileV5(f); const qCount=Array.isArray(f.questions)?f.questions.length:0; const directFields=templateFields(f).length; const builtIn=Boolean(f.built_in);
    return `<div class="card form-card"><div class="form-card-head"><div><h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(f.description||'')}</p></div><div class="badge-stack"><span class="badge ${f.published?'active':'inactive'}">${f.published?'Online':'Entwurf'}</span>${builtIn?'<span class="badge standard">Standardvorlage</span>':''}</div></div><p class="muted">${hasFile?'📎 PDF-Vorlage · ':''}${directFields?`<span class="form-editor-badge">✨ ${directFields} Felder automatisch erkannt</span> · `:''}${qCount} Zusatzfragen${currentProfile.role==='admin'?` · ${subs.length} Antworten`:own?' · Bereits gesendet':''}</p><div class="row-actions">${hasFile?`<button class="mini" data-open-form-file="${f.id}">Original öffnen</button>`:''}${currentProfile.role==='admin'&&visualTemplateSupported(f)?`<button class="btn primary" data-template-designer="${f.id}">✨ KI-Editor</button>`:''}<button class="btn primary" data-fill-form="${f.id}">${directFields?'Direkt ausfüllen':hasFile?'Ausfüllen':'Online ausfüllen'}</button>${currentProfile.role==='admin'?`${!builtIn?`<button class="mini" data-edit-form="${f.id}">Details</button>`:''}<button class="mini" data-submissions="${f.id}">Antworten (${subs.length})</button>${!builtIn?`<button class="mini bad" data-delete-form="${f.id}">Löschen</button>`:''}`:''}</div></div>`;
  }).join(''):'<div class="card empty">Keine Formulare vorhanden.</div>'}</div>`;
  const newBtn=$('#newOnlineForm'); if(newBtn)newBtn.onclick=()=>openOnlineFormDialog();
  $$('[data-open-form-file]').forEach(btn=>btn.onclick=()=>openFormTemplateFile(btn.dataset.openFormFile));
  $$('[data-template-designer]').forEach(btn=>btn.onclick=()=>openTemplateDesigner(btn.dataset.templateDesigner));
  $$('[data-fill-form]').forEach(btn=>btn.onclick=()=>openFillForm(btn.dataset.fillForm));
  $$('[data-edit-form]').forEach(btn=>btn.onclick=()=>openOnlineFormDialog(btn.dataset.editForm));
  $$('[data-submissions]').forEach(btn=>btn.onclick=()=>showFormSubmissions(btn.dataset.submissions));
  $$('[data-delete-form]').forEach(btn=>btn.onclick=()=>deleteOnlineForm(btn.dataset.deleteForm));
}

async function openFillForm(id) {
  let form=forms.find(item=>item.id===id); if(!form)return;
  try { const {data:fresh,error}=await sb.from('online_forms').select('*').eq('id',id).single(); if(!error&&fresh){form=fresh;const index=forms.findIndex(item=>item.id===id);if(index>=0)forms[index]=fresh;} } catch(_){}
  if (visualTemplateSupported(form) && templateFields(form).length) { await openVisualTemplateFill(form); return; }
  $('#fillFormId').value=form.id; $('#fillFormTitle').textContent=form.title; $('#fillFormDescription').textContent=form.description||''; $('#fillFormFile').value='';
  const hasFile=hasTemplateFileV5(form); const template=$('#fillFormTemplate'); template.classList.toggle('hidden',!hasFile);
  template.innerHTML=hasFile?`<div><b>Vorlage:</b> ${escapeHtml(form.file_name||'Formular')}</div><button id="openTemplateFromFill" type="button" class="btn ghost">Vorlage öffnen</button><p class="field-hint">Für diese Vorlage wurden noch keine direkten Felder gespeichert. Der Admin kann den KI-Editor öffnen.</p>`:'';
  if(hasFile) $('#openTemplateFromFill').onclick=()=>openFormTemplateFile(form.id); $('#fillFormFileWrap').classList.toggle('hidden',!form.file_path);
  $('#fillFormQuestions').innerHTML=(form.questions||[]).map((q,i)=>`<label>${escapeHtml(q)}<textarea data-form-answer="${i}" rows="2" required></textarea></label>`).join(''); $('#fillFormDialog').showModal();
}

async function deleteOnlineForm(id) {
  const form=forms.find(x=>x.id===id); if(form?.built_in) return toast('Diese Standardvorlage bleibt fest im System.');
  if(!confirm('Formular wirklich löschen? Auch Antworten werden gelöscht.'))return;
  const subs=formSubmissions.filter(x=>x.form_id===id); const paths=[form?.file_path,...subs.map(x=>x.file_path)].filter(Boolean); if(paths.length)await sb.storage.from('forms').remove(paths);
  const {error}=await sb.from('online_forms').delete().eq('id',id); if(error)return toast(error.message); await reloadAndRender('Formular wurde gelöscht.');
}

init().catch((error) => {
  console.error(error);
  toast(`Fehler: ${error.message}`);
});
