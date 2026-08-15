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
  setBusy(event.currentTarget, true);
  const { error } = await sb.auth.signInWithPassword({
    email: loginIdentifierToEmail($('#loginEmail').value),
    password: $('#loginPassword').value
  });
  setBusy(event.currentTarget, false);
  if (error) return toast(`Anmeldung fehlgeschlagen: ${error.message}`);
  toast('Erfolgreich angemeldet.');
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
  $('#userName').textContent = currentProfile.full_name || currentProfile.email;
  $('#userRole').textContent = roleName(currentProfile.role);
  $('#userAvatar').textContent = (currentProfile.full_name || currentProfile.email || 'A')[0].toUpperCase();
  currentPage = 'dashboard';
  renderNav();
  renderPage();
  startRealtimeSync();
  startBackgroundTasks();
  checkAppointmentReminders();
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
  const queries = [
    sb.from('profiles').select('*').order('full_name'),
    sb.from('services').select('*').order('name'),
    sb.from('appointments').select('*').order('appointment_date').order('appointment_time'),
    sb.from('chat_threads').select('*').order('updated_at', { ascending: false }),
    sb.from('chat_messages').select('*').order('created_at'),
    sb.from('online_forms').select('*').order('created_at', { ascending: false }),
    sb.from('form_submissions').select('*').order('submitted_at', { ascending: false }),
    sb.from('app_notifications').select('*').order('created_at', { ascending: false }).limit(100)
  ];
  const [profileResult, serviceResult, appointmentResult, threadResult, messageResult, formResult, submissionResult, notificationResult] = await Promise.all(queries);

  [profileResult, serviceResult, appointmentResult, threadResult, messageResult, formResult, submissionResult, notificationResult]
    .filter((result) => result.error)
    .forEach((result) => console.warn(result.error.message));

  profiles = profileResult.data || [currentProfile];
  if (!profiles.some((item) => item.id === currentProfile.id)) profiles.push(currentProfile);
  services = serviceResult.data || [];
  appointments = appointmentResult.data || [];
  chatThreads = threadResult.data || [];
  chatMessages = messageResult.data || [];
  forms = formResult.data || [];
  formSubmissions = submissionResult.data || [];
  notifications = notificationResult.data || [];
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
    <span class="person-main"><b>${escapeHtml(item.full_name || 'Ohne Name')}</b><small>${escapeHtml(visibleEmail(item.email))}</small></span>
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
    const result = source.filter((item) => `${item.full_name || ''} ${item.email || ''}`.toLowerCase().includes(query));
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
  $('#personDialogContent').innerHTML = `<div class="profile-summary"><div class="person-avatar large">${escapeHtml((item.full_name || item.email)[0].toUpperCase())}</div><div><h4>${escapeHtml(item.full_name || 'Ohne Name')}</h4><p>${escapeHtml(visibleEmail(item.email))}</p></div></div>
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
  content.innerHTML = `<div class="hero"><div><h3>Alle Konten</h3><p>Suche nach Name oder E-Mail und öffne das vollständige Profil.</p></div><button id="newUser" class="btn primary">+ Konto erstellen</button></div>
    <div class="card">${personSearchBlock()}<div id="peopleResults" class="people-results"></div></div>`;
  $('#newUser').onclick = () => openUserDialog();
  bindPersonSearch(list, 'peopleResults', true);
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
  content.innerHTML = `<div class="two-col"><div class="card profile-card"><div class="user-big">${escapeHtml((currentProfile.full_name || currentProfile.email)[0].toUpperCase())}</div><h3>${escapeHtml(currentProfile.full_name)}</h3><p class="muted">${escapeHtml(visibleEmail(currentProfile.email))}</p><span class="badge ${currentProfile.role}">${roleName(currentProfile.role)}</span><div style="margin-top:18px"><button id="editOwnProfile" class="btn primary">Daten bearbeiten</button></div></div><div class="card"><h3>Kontoinformationen</h3><div class="info-list"><div class="info-row"><span>Telefon</span><b>${escapeHtml(currentProfile.phone || 'Nicht angegeben')}</b></div><div class="info-row"><span>Status</span><b>${currentProfile.active ? 'Aktiv' : 'Gesperrt'}</b></div><div class="info-row"><span>Erstellt</span><b>${new Intl.DateTimeFormat('de-DE').format(new Date(currentProfile.created_at))}</b></div></div></div></div>`;
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
    checkAppointmentReminders();
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
  $('#newUsername').value = item && isInternalEmail(item.email) ? item.email.split('@')[0] : '';
  $('#newUsername').required = !item;
  $('#newUsername').disabled = Boolean(item);
  $('#usernameLabel').classList.toggle('hidden', Boolean(item));
  $('#usernameHint').classList.toggle('hidden', Boolean(item));
  $('#newUserPhone').value = item?.phone || '';
  $('#newUserEmail').value = item ? (isInternalEmail(item.email) ? '' : item.email || '') : '';
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
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error || 'Unbekannter Fehler');
  return data;
}

async function createAdminManagedAccount(body) {
  const username = normalizeUsername(body.username);
  if (username.length < 3) throw new Error('Der Benutzername muss mindestens 3 Zeichen lang sein.');
  const authEmail = internalEmailForUsername(username);
  const isolated = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const { data, error } = await withTimeout(isolated.auth.signUp({
    email: authEmail,
    password: body.password,
    options: { data: { full_name: body.full_name, phone: body.phone, username, admin_created: true } }
  }), 15000);
  if (error) throw error;
  if (!data?.user || data.user.identities?.length === 0) {
    throw new Error('Dieser Benutzername ist bereits vergeben.');
  }
  const { error: profileError } = await sb.rpc('admin_configure_account', {
    p_user_id: data.user.id,
    p_full_name: body.full_name,
    p_phone: body.phone || '',
    p_contact_email: body.email || '',
    p_role: body.role,
    p_active: true
  });
  if (profileError) throw new Error(`${profileError.message} – führe zuerst die Datei supabase-update.sql im SQL Editor aus.`);
}

async function updateAdminManagedAccount(body) {
  const { error } = await sb.rpc('admin_configure_account', {
    p_user_id: body.id,
    p_full_name: body.full_name,
    p_phone: body.phone || '',
    p_contact_email: body.email || '',
    p_role: body.role,
    p_active: body.active
  });
  if (error) throw new Error(`${error.message} – führe zuerst die Datei supabase-update.sql im SQL Editor aus.`);
  if (body.password) {
    try {
      await invokeAdminUsers({ action: 'update', id: body.id, password: body.password });
    } catch (_) {
      toast('Profildaten gespeichert. Das Passwort konnte ohne die optionale Admin-Funktion nicht geändert werden.');
    }
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
  const { error } = await sb.rpc('admin_configure_account', {
    p_user_id: id,
    p_full_name: item?.full_name || '',
    p_phone: item?.phone || '',
    p_contact_email: isInternalEmail(item?.email) ? '' : item?.email || '',
    p_role: item?.role || 'customer',
    p_active: false
  });
  if (error) return toast(`${error.message} – führe zuerst supabase-update.sql aus.`);
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
    .on('postgres_changes',{event:'*',schema:'public',table:'chat_messages'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'chat_threads'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'online_forms'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'form_submissions'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'app_notifications'},handleNotificationRealtime)
    .subscribe();
}


function handleNotificationRealtime(payload) {
  const item=payload?.new;
  if(payload?.eventType==='INSERT' && item?.user_id===currentProfile?.id) {
    toast(`${item.title}: ${item.body}`);
    if ('Notification' in window && Notification.permission==='granted') {
      new Notification(item.title,{body:item.body});
    }
  }
  scheduleRealtimeReload();
}

function scheduleRealtimeReload() {
  clearTimeout(realtimeDebounce);
  realtimeDebounce=setTimeout(async()=>{ if (!currentProfile) return; await loadData(); renderPage(); checkAppointmentReminders(); },450);
}

function startBackgroundTasks() {
  if (backgroundTimer) clearInterval(backgroundTimer);
  backgroundTimer=setInterval(async()=>{
    if (!currentProfile) return;
    await loadData();
    if (currentPage==='calendar' || currentPage==='chats' || currentPage==='notifications') renderPage();
    checkAppointmentReminders();
  },60000);
}

async function checkAppointmentReminders() {
  if (!currentProfile || !sb) return;
  const now=Date.now();
  const relevant=appointments.filter((a)=>a.status==='confirmed' && (a.customer_id===currentProfile.id || a.employee_id===currentProfile.id));
  for (const item of relevant) {
    const diff=(localDateTime(item).getTime()-now)/60000;
    const mins=Number(item.reminder_minutes || 30);
    if (diff>mins || diff<0) continue;
    const dedupe=`appointment:${item.id}:soon`;
    if (notifications.some((n)=>n.dedupe_key===dedupe)) continue;
    const title='Termin steht bald an';
    const body=`${formatDate(item.appointment_date)} um ${item.appointment_time.slice(0,5)} · ${serviceById(item.service_id).name}`;
    const {data,error}=await sb.from('app_notifications').insert({user_id:currentProfile.id,appointment_id:item.id,type:'appointment_reminder',title,body,dedupe_key:dedupe}).select('*').single();
    if (!error && data) {
      notifications.unshift(data); toast(body);
      if ('Notification' in window && Notification.permission==='granted') new Notification(title,{body});
    }
  }
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
  content.innerHTML=`<div class="hero"><div><h3>Erinnerungen</h3><p>Automatische und manuell verschickte Erinnerungen erscheinen hier sofort.</p></div><div class="hero-actions"><button id="enableNotifications" class="btn primary">Browser-Erinnerungen aktivieren</button>${unread?`<button id="markNotifications" class="btn ghost">Alle als gelesen</button>`:''}</div></div><div class="card notification-list">${notifications.length?notifications.map(n=>`<button class="notification-item ${n.read?'':'unread'}" data-read-notification="${n.id}"><div><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body)}</p></div><small>${new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short'}).format(new Date(n.created_at))}</small></button>`).join(''):'<div class="empty">Noch keine Erinnerungen.</div>'}</div>`;
  $('#enableNotifications').onclick=async()=>{ if (!('Notification' in window)) return toast('Dieser Browser unterstützt keine Benachrichtigungen.'); const perm=await Notification.requestPermission(); toast(perm==='granted'?'Browser-Erinnerungen sind aktiv.':'Benachrichtigungen wurden nicht erlaubt.'); };
  const mark=$('#markNotifications'); if(mark) mark.onclick=async()=>{await sb.from('app_notifications').update({read:true}).eq('user_id',currentProfile.id); notifications=notifications.map(n=>({...n,read:true}));renderNotifications(content);};
  $$('[data-read-notification]').forEach(btn=>btn.onclick=async()=>{await sb.from('app_notifications').update({read:true}).eq('id',btn.dataset.readNotification);const n=notifications.find(x=>x.id===btn.dataset.readNotification);if(n)n.read=true;renderNotifications(content);});
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
  content.innerHTML=`<div class="chat-layout"><aside class="chat-list"><div class="chat-list-head"><div><h3>${currentProfile.role==='admin'?'Alle Unterhaltungen':'Nachrichten'}</h3><small>${chatThreads.length} Chats</small></div><button id="newChatBtn" class="mini">+ Kunde anschreiben</button></div><div class="chat-thread-list">${chatThreads.length?chatThreads.map(t=>{const ppl=threadPeople(t);const msgs=chatMessages.filter(m=>m.thread_id===t.id);const last=msgs.at(-1);return `<button class="chat-thread ${t.id===activeChatThreadId?'active':''}" data-thread="${t.id}"><b>${escapeHtml(ppl.customer.full_name)} ↔ ${escapeHtml(ppl.employee.full_name)}</b><small>${escapeHtml(last?.body||'Noch keine Nachricht')}</small></button>`}).join(''):'<div class="empty">Noch keine Chats.</div>'}</div></aside><section class="chat-window">${active?chatWindowHtml(active):'<div class="empty">Wähle einen Chat aus oder schreibe einen Kunden an.</div>'}</section></div>`;
  $$('[data-thread]').forEach(btn=>btn.onclick=()=>{activeChatThreadId=btn.dataset.thread;renderChats(content);});
  $('#newChatBtn').onclick=()=>openDirectChatPicker();
  const form=$('#chatSendForm'); if(form) form.onsubmit=sendChatMessage;
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
  const person=customers.find(p=>`${p.full_name||''} ${p.email||''}`.toLowerCase().includes(query));
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

init().catch((error) => {
  console.error(error);
  toast(`Fehler: ${error.message}`);
});
