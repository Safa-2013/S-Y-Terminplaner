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
let currentPage = 'dashboard';

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

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove('show'), 2800);
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"], button:not([type])');
  if (button) button.disabled = busy;
}

function profileById(id) {
  return profiles.find((item) => item.id === id) || { full_name: 'Unbekannt', email: '' };
}

function serviceById(id) {
  return services.find((item) => item.id === id) || { name: 'Unbekannt', duration_minutes: 0 };
}

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
}

async function loginWithPassword(event) {
  event.preventDefault();
  if (!configReady) return toast('Supabase ist noch nicht verbunden.');
  setBusy(event.currentTarget, true);
  const { error } = await sb.auth.signInWithPassword({
    email: $('#loginEmail').value.trim(),
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
  const [profileResult, serviceResult, appointmentResult] = await Promise.all([
    sb.from('profiles').select('*').order('full_name'),
    sb.from('services').select('*').order('name'),
    sb.from('appointments').select('*').order('appointment_date').order('appointment_time')
  ]);

  if (profileResult.error) toast(profileResult.error.message);
  if (serviceResult.error) toast(serviceResult.error.message);
  if (appointmentResult.error) toast(appointmentResult.error.message);

  profiles = profileResult.data || [currentProfile];
  if (!profiles.some((item) => item.id === currentProfile.id)) profiles.push(currentProfile);
  services = serviceResult.data || [];
  appointments = appointmentResult.data || [];
}

function closeApp() {
  session = null;
  currentProfile = null;
  profiles = [];
  services = [];
  appointments = [];
  $('#appView').classList.add('hidden');
  $('#authView').classList.remove('hidden');
  showAuthTab('login');
}

function navItems() {
  if (currentProfile.role === 'admin') {
    return [
      ['dashboard', 'Übersicht'], ['calendar', 'Kalender'], ['requests', 'Terminanfragen'],
      ['users', 'Konten verwalten'], ['services', 'Leistungen'], ['profile', 'Mein Profil']
    ];
  }
  if (currentProfile.role === 'employee') {
    return [
      ['dashboard', 'Übersicht'], ['calendar', 'Mein Kalender'], ['requests', 'Anfragen'],
      ['customers', 'Kunden'], ['profile', 'Mein Profil']
    ];
  }
  return [['dashboard', 'Meine Termine'], ['request', 'Termin beantragen'], ['profile', 'Mein Profil']];
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
    <th>Datum</th><th>Uhrzeit</th><th>Kunde</th><th>Mitarbeiter</th><th>Leistung</th><th>Status</th><th>Aktion</th>
  </tr></thead><tbody>${list.map((item) => {
    const canEdit = currentProfile.role === 'admin' || currentProfile.role === 'employee';
    const canCancel = currentProfile.role === 'customer' && ['requested', 'confirmed'].includes(item.status);
    return `<tr>
      <td>${formatDate(item.appointment_date)}</td><td><b>${escapeHtml(item.appointment_time.slice(0, 5))}</b></td>
      <td>${escapeHtml(profileById(item.customer_id).full_name)}</td>
      <td>${escapeHtml(profileById(item.employee_id).full_name)}</td>
      <td>${escapeHtml(serviceById(item.service_id).name)}</td>
      <td><span class="badge ${item.status}">${statusName(item.status)}</span></td>
      <td><div class="row-actions">
        ${canEdit ? `<button class="mini" data-edit-appointment="${item.id}">Bearbeiten</button>` : ''}
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
}

function renderCalendar(content) {
  setTitle('KALENDER', currentProfile.role === 'admin' ? 'Gesamter Kalender' : 'Mein Kalender');
  const start = new Date();
  const weekday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - weekday);
  const days = Array.from({ length: 5 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });

  content.innerHTML = `<div class="hero"><div><h3>Wochenplan</h3><p>Montag bis Freitag, alle Termine nach Uhrzeit.</p></div><button id="calendarNew" class="btn primary">+ Termin</button></div>
    <div class="calendar">${days.map((date) => {
      const value = iso(date);
      const dayAppointments = appointments
        .filter((item) => item.appointment_date === value && !['rejected', 'cancelled'].includes(item.status))
        .sort((a, b) => a.appointment_time.localeCompare(b.appointment_time));
      return `<section class="day"><div class="day-head"><strong>${new Intl.DateTimeFormat('de-DE', { weekday: 'long' }).format(date)}</strong><span>${new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(date)}</span></div>
        ${dayAppointments.length ? dayAppointments.map((item) => `<div class="event ${item.status === 'requested' ? 'pending' : item.status === 'completed' ? 'done' : ''}" ${currentProfile.role !== 'customer' ? `data-edit-appointment="${item.id}"` : ''}>
          <b>${item.appointment_time.slice(0, 5)} · ${escapeHtml(serviceById(item.service_id).name)}</b>
          <small>${currentProfile.role === 'customer' ? escapeHtml(profileById(item.employee_id).full_name) : escapeHtml(profileById(item.customer_id).full_name)}</small>
          <small>${statusName(item.status)}</small>
        </div>`).join('') : '<div class="empty">Frei</div>'}</section>`;
    }).join('')}</div>`;

  $('#calendarNew').onclick = () => openAppointment();
  $$('[data-edit-appointment]').forEach((button) => button.onclick = () => openAppointment(button.dataset.editAppointment));
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
    <span class="person-main"><b>${escapeHtml(item.full_name || 'Ohne Name')}</b><small>${escapeHtml(item.email)}</small></span>
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
  $('#personDialogContent').innerHTML = `<div class="profile-summary"><div class="person-avatar large">${escapeHtml((item.full_name || item.email)[0].toUpperCase())}</div><div><h4>${escapeHtml(item.full_name || 'Ohne Name')}</h4><p>${escapeHtml(item.email)}</p></div></div>
    <div class="info-list"><div class="info-row"><span>Telefon</span><b>${escapeHtml(item.phone || 'Nicht angegeben')}</b></div><div class="info-row"><span>Rolle</span><b>${roleName(item.role)}</b></div><div class="info-row"><span>Status</span><b>${item.active ? 'Aktiv' : 'Gesperrt'}</b></div><div class="info-row"><span>Erstellt</span><b>${item.created_at ? new Intl.DateTimeFormat('de-DE').format(new Date(item.created_at)) : '–'}</b></div></div>
    <div class="profile-appointments"><h4>Termine (${personAppointments.length})</h4>${personAppointments.length ? personAppointments.slice(0, 8).map((appointment) => `<div class="profile-appointment"><b>${formatDate(appointment.appointment_date)} · ${appointment.appointment_time.slice(0,5)}</b><span>${escapeHtml(serviceById(appointment.service_id).name)} · ${statusName(appointment.status)}</span></div>`).join('') : '<p class="muted">Keine Termine vorhanden.</p>'}</div>
    ${currentProfile.role === 'admin' ? `<div class="actions person-admin-actions"><button id="editPersonFromProfile" class="btn primary" type="button">Konto bearbeiten</button>${item.id !== currentProfile.id ? '<button id="deletePersonFromProfile" class="btn danger" type="button">Konto löschen</button>' : ''}</div>` : ''}`;
  $('#personDialog').showModal();
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
  setTitle('EINSTELLUNGEN', 'Leistungen');
  content.innerHTML = `<div class="hero"><div><h3>Leistungen verwalten</h3><p>Diese Leistungen können bei Terminen ausgewählt werden.</p></div><button id="newService" class="btn primary">+ Leistung</button></div><div class="card"><div class="service-list">${services.map((item) => `<div class="service"><div><b>${escapeHtml(item.name)}</b><span>${item.duration_minutes} Minuten · ${item.active ? 'Aktiv' : 'Deaktiviert'}</span></div><div class="row-actions"><button class="mini" data-edit-service="${item.id}">Bearbeiten</button><button class="mini bad" data-delete-service="${item.id}">Löschen</button></div></div>`).join('') || '<div class="empty">Keine Leistungen vorhanden.</div>'}</div></div>`;
  $('#newService').onclick = () => openServiceDialog();
  $$('[data-edit-service]').forEach((button) => button.onclick = () => openServiceDialog(button.dataset.editService));
  $$('[data-delete-service]').forEach((button) => button.onclick = () => deleteService(button.dataset.deleteService));
}

function renderProfile(content) {
  setTitle('KONTO', 'Mein Profil');
  content.innerHTML = `<div class="two-col"><div class="card profile-card"><div class="user-big">${escapeHtml((currentProfile.full_name || currentProfile.email)[0].toUpperCase())}</div><h3>${escapeHtml(currentProfile.full_name)}</h3><p class="muted">${escapeHtml(currentProfile.email)}</p><span class="badge ${currentProfile.role}">${roleName(currentProfile.role)}</span><div style="margin-top:18px"><button id="editOwnProfile" class="btn primary">Daten bearbeiten</button></div></div><div class="card"><h3>Kontoinformationen</h3><div class="info-list"><div class="info-row"><span>Telefon</span><b>${escapeHtml(currentProfile.phone || 'Nicht angegeben')}</b></div><div class="info-row"><span>Status</span><b>${currentProfile.active ? 'Aktiv' : 'Gesperrt'}</b></div><div class="info-row"><span>Erstellt</span><b>${new Intl.DateTimeFormat('de-DE').format(new Date(currentProfile.created_at))}</b></div></div></div></div>`;
  $('#editOwnProfile').onclick = () => {
    $('#profileName').value = currentProfile.full_name || '';
    $('#profilePhone').value = currentProfile.phone || '';
    $('#profileDialog').showModal();
  };
}

function fillAppointmentForm(item = null) {
  const customers = profiles.filter((profile) => profile.role === 'customer' && profile.active);
  const employees = profiles.filter((profile) => profile.role === 'employee' && profile.active);
  const activeServices = services.filter((service) => service.active || service.id === item?.service_id);

  $('#appointmentCustomer').innerHTML = customers.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.full_name)}</option>`).join('');
  $('#appointmentEmployee').innerHTML = employees.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.full_name)}</option>`).join('');
  $('#appointmentService').innerHTML = activeServices.map((service) => `<option value="${service.id}">${escapeHtml(service.name)} (${service.duration_minutes} Min.)</option>`).join('');

  $('#appointmentId').value = item?.id || '';
  $('#appointmentCustomer').value = item?.customer_id || (currentProfile.role === 'customer' ? currentProfile.id : customers[0]?.id || '');
  $('#appointmentEmployee').value = item?.employee_id || (currentProfile.role === 'employee' ? currentProfile.id : employees[0]?.id || '');
  $('#appointmentService').value = item?.service_id || activeServices[0]?.id || '';
  $('#appointmentDate').value = item?.appointment_date || addDays(1);
  $('#appointmentTime').value = item?.appointment_time?.slice(0, 5) || '10:00';
  $('#appointmentStatus').value = item?.status || (currentProfile.role === 'customer' ? 'requested' : 'confirmed');
  $('#appointmentNote').value = item?.note || '';

  $('#appointmentCustomer').disabled = currentProfile.role === 'customer';
  $('#appointmentEmployee').disabled = currentProfile.role === 'employee';
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
  setBusy(event.currentTarget, true);
  const id = $('#appointmentId').value;
  const payload = {
    customer_id: currentProfile.role === 'customer' ? currentProfile.id : $('#appointmentCustomer').value,
    employee_id: currentProfile.role === 'employee' ? currentProfile.id : $('#appointmentEmployee').value,
    service_id: $('#appointmentService').value,
    appointment_date: $('#appointmentDate').value,
    appointment_time: $('#appointmentTime').value,
    status: currentProfile.role === 'customer' ? 'requested' : $('#appointmentStatus').value,
    note: $('#appointmentNote').value.trim()
  };

  const conflictQuery = sb.from('appointments').select('id').eq('employee_id', payload.employee_id).eq('appointment_date', payload.appointment_date).eq('appointment_time', payload.appointment_time).not('status', 'in', '(rejected,cancelled)');
  const { data: conflicts } = id ? await conflictQuery.neq('id', id) : await conflictQuery;
  if (conflicts?.length) {
    setBusy(event.currentTarget, false);
    return toast('Diese Uhrzeit ist bei diesem Mitarbeiter bereits belegt.');
  }

  const result = id
    ? await sb.from('appointments').update(payload).eq('id', id)
    : await sb.from('appointments').insert(payload);
  setBusy(event.currentTarget, false);
  if (result.error) return toast(result.error.message);

  $('#appointmentDialog').close();
  await reloadAndRender(currentProfile.role === 'customer' ? 'Anfrage wurde gesendet.' : 'Termin wurde gespeichert.');
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
  $('#newUserPhone').value = item?.phone || '';
  $('#newUserEmail').value = item?.email || '';
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

async function saveAdminUser(event) {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  const id = $('#editUserId').value;
  const body = {
    action: id ? 'update' : 'create',
    id: id || undefined,
    full_name: $('#newUserName').value.trim(),
    phone: $('#newUserPhone').value.trim(),
    email: $('#newUserEmail').value.trim(),
    password: $('#newUserPassword').value || undefined,
    role: $('#newUserRole').value,
    active: id ? $('#newUserActive').checked : true
  };

  try {
    await invokeAdminUsers(body);
    $('#userDialog').close();
    await reloadAndRender(id ? 'Konto wurde aktualisiert.' : 'Konto wurde erstellt.');
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(event.currentTarget, false);
  }
}

async function deleteAdminUser(id) {
  const item = profiles.find((profile) => profile.id === id);
  if (!confirm(`Konto von ${item?.full_name || 'diesem Benutzer'} endgültig löschen?`)) return;
  try {
    await invokeAdminUsers({ action: 'delete', id });
    await reloadAndRender('Konto wurde gelöscht.');
  } catch (error) {
    toast(error.message);
  }
}

function openServiceDialog(id = null) {
  const item = id ? services.find((service) => service.id === id) : null;
  $('#serviceDialogTitle').textContent = item ? 'Leistung bearbeiten' : 'Leistung erstellen';
  $('#serviceId').value = item?.id || '';
  $('#serviceName').value = item?.name || '';
  $('#serviceDuration').value = item?.duration_minutes || 30;
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
