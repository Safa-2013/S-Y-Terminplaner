const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const DB_KEY='safa_terminplaner_v1';
const today=new Date();
const iso=d=>{const x=new Date(d);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`};
const addDays=(n)=>{const d=new Date();d.setDate(d.getDate()+n);return iso(d)};
const seed={
 users:[
  {id:'u1',name:'Safa Yildiz',username:'admin',password:'admin123',role:'admin'},
  {id:'u2',name:'Yusuf Mitarbeiter',username:'mitarbeiter',password:'team123',role:'mitarbeiter'},
  {id:'u3',name:'Yunus Mitarbeiter',username:'yunus',password:'team123',role:'mitarbeiter'},
  {id:'u4',name:'Max Mustermann',username:'kunde',password:'kunde123',role:'kunde'},
  {id:'u5',name:'Anna Beispiel',username:'anna',password:'kunde123',role:'kunde'}
 ],
 services:[{id:'s1',name:'Beratung',duration:30},{id:'s2',name:'Besprechung',duration:60},{id:'s3',name:'Service-Termin',duration:45}],
 appointments:[
  {id:'a1',customerId:'u4',employeeId:'u2',serviceId:'s1',date:addDays(1),time:'10:00',status:'bestaetigt',note:'Erstgespräch'},
  {id:'a2',customerId:'u5',employeeId:'u3',serviceId:'s2',date:addDays(2),time:'13:30',status:'angefragt',note:''},
  {id:'a3',customerId:'u4',employeeId:'u2',serviceId:'s3',date:addDays(4),time:'09:00',status:'angefragt',note:'Bitte vormittags'}
 ]
};
let db=JSON.parse(localStorage.getItem(DB_KEY)||'null')||seed;
let currentUser=null,currentPage='dashboard';
const save=()=>localStorage.setItem(DB_KEY,JSON.stringify(db));
const uid=p=>(p||'id')+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const user=id=>db.users.find(x=>x.id===id)||{name:'Unbekannt'};
const service=id=>db.services.find(x=>x.id===id)||{name:'Unbekannt',duration:0};
const roleName=r=>({admin:'Administrator',mitarbeiter:'Mitarbeiter',kunde:'Kunde'})[r]||r;
const statusName=s=>({angefragt:'Angefragt',bestaetigt:'Bestätigt',abgelehnt:'Abgelehnt',erledigt:'Erledigt',abgesagt:'Abgesagt'})[s]||s;
const formatDate=d=>new Intl.DateTimeFormat('de-DE',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(d+'T12:00:00'));
function toast(text){const t=$('#toast');t.textContent=text;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
function visibleAppointments(){if(currentUser.role==='admin')return db.appointments;if(currentUser.role==='mitarbeiter')return db.appointments.filter(a=>a.employeeId===currentUser.id);return db.appointments.filter(a=>a.customerId===currentUser.id)}
function navItems(){if(currentUser.role==='admin')return [['dashboard','Übersicht'],['calendar','Kalender'],['requests','Terminanfragen'],['users','Benutzer'],['services','Leistungen']];if(currentUser.role==='mitarbeiter')return [['dashboard','Übersicht'],['calendar','Mein Kalender'],['requests','Anfragen']];return [['dashboard','Meine Termine'],['request','Termin beantragen'],['profile','Mein Konto']]}
function openApp(){
 $('#loginView').classList.add('hidden');$('#appView').classList.remove('hidden');
 $('#userName').textContent=currentUser.name;$('#userRole').textContent=roleName(currentUser.role);$('#userAvatar').textContent=currentUser.name[0].toUpperCase();
 currentPage='dashboard';renderNav();renderPage();
}
function renderNav(){const n=$('#navMenu');n.innerHTML=navItems().map(([id,label])=>`<button data-page="${id}" class="${id===currentPage?'active':''}">${label}</button>`).join('');n.querySelectorAll('button').forEach(b=>b.onclick=()=>{currentPage=b.dataset.page;renderNav();renderPage();$('#sidebar').classList.remove('open')})}
function setTitle(eye,title){$('#pageEyebrow').textContent=eye;$('#pageTitle').textContent=title}
function renderPage(){
 const p=$('#pageContent');
 if(currentPage==='dashboard')return renderDashboard(p);
 if(currentPage==='calendar')return renderCalendar(p);
 if(currentPage==='requests')return renderRequests(p);
 if(currentPage==='users')return renderUsers(p);
 if(currentPage==='services')return renderServices(p);
 if(currentPage==='request'){setTitle('TERMIN','Termin beantragen');p.innerHTML=`<div class="hero"><div><h3>Neuen Termin wünschen</h3><p>Wähle Mitarbeiter, Leistung, Datum und Uhrzeit.</p></div><button id="requestBtn" class="btn primary">Termin beantragen</button></div><div class="card"><div class="empty">Klicke oben auf „Termin beantragen“.</div></div>`;$('#requestBtn').onclick=()=>openAppointment();return}
 if(currentPage==='profile')return renderProfile(p)
}
function renderDashboard(p){
 if(currentUser.role==='kunde')setTitle('KUNDENBEREICH','Meine Termine');else setTitle('ÜBERSICHT','Dashboard');
 const list=visibleAppointments().sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
 const requested=list.filter(a=>a.status==='angefragt').length, confirmed=list.filter(a=>a.status==='bestaetigt').length, upcoming=list.filter(a=>a.date>=iso(today)&&!['abgelehnt','abgesagt'].includes(a.status)).length;
 p.innerHTML=`<div class="hero"><div><h3>Hallo, ${currentUser.name.split(' ')[0]}!</h3><p>Hier siehst du alle wichtigen Termine auf einen Blick.</p></div>${currentUser.role!=='kunde'?'<button id="newAppointment" class="btn primary">+ Termin eintragen</button>':'<button id="newAppointment" class="btn primary">+ Termin beantragen</button>'}</div>
 <div class="stats"><div class="stat"><span>Alle Termine</span><strong>${list.length}</strong></div><div class="stat"><span>Kommende Termine</span><strong>${upcoming}</strong></div><div class="stat"><span>Anfragen</span><strong>${requested}</strong></div><div class="stat"><span>Bestätigt</span><strong>${confirmed}</strong></div></div>
 <div class="card"><div class="card-head"><h3>Termine</h3><span class="muted">${list.length} Einträge</span></div>${appointmentTable(list)}</div>`;
 $('#newAppointment').onclick=()=>openAppointment();bindAppointmentActions();
}
function appointmentTable(list){if(!list.length)return `<div class="empty">Noch keine Termine vorhanden.</div>`;return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Datum</th><th>Uhrzeit</th><th>Kunde</th><th>Mitarbeiter</th><th>Leistung</th><th>Status</th><th>Aktion</th></tr></thead><tbody>${list.map(a=>`<tr><td>${formatDate(a.date)}</td><td><b>${a.time}</b></td><td>${user(a.customerId).name}</td><td>${user(a.employeeId).name}</td><td>${service(a.serviceId).name}</td><td><span class="badge ${a.status}">${statusName(a.status)}</span></td><td><div class="row-actions">${currentUser.role!=='kunde'?`<button class="mini" data-edit="${a.id}">Bearbeiten</button>`:a.status==='angefragt'?`<button class="mini bad" data-cancel="${a.id}">Zurückziehen</button>`:''}${currentUser.role==='admin'?`<button class="mini bad" data-delete="${a.id}">Löschen</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`}
function bindAppointmentActions(){
 $$('[data-edit]').forEach(b=>b.onclick=()=>openAppointment(b.dataset.edit));
 $$('[data-delete]').forEach(b=>b.onclick=()=>{if(confirm('Termin wirklich löschen?')){db.appointments=db.appointments.filter(a=>a.id!==b.dataset.delete);save();renderPage();toast('Termin gelöscht')}});
 $$('[data-cancel]').forEach(b=>b.onclick=()=>{const a=db.appointments.find(x=>x.id===b.dataset.cancel);a.status='abgesagt';save();renderPage();toast('Termin zurückgezogen')});
}
function renderCalendar(p){
 setTitle('KALENDER',currentUser.role==='admin'?'Gesamter Kalender':'Mein Kalender');
 const start=new Date();const day=(start.getDay()+6)%7;start.setDate(start.getDate()-day);
 const days=Array.from({length:5},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d});
 p.innerHTML=`<div class="hero"><div><h3>Wochenplan</h3><p>Montag bis Freitag, alle Termine nach Uhrzeit.</p></div><button id="calNew" class="btn primary">+ Termin</button></div><div class="calendar">${days.map(d=>{const date=iso(d);const apps=visibleAppointments().filter(a=>a.date===date&&!['abgelehnt','abgesagt'].includes(a.status)).sort((a,b)=>a.time.localeCompare(b.time));return `<section class="day"><div class="day-head"><strong>${new Intl.DateTimeFormat('de-DE',{weekday:'long'}).format(d)}</strong><span>${new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit'}).format(d)}</span></div>${apps.length?apps.map(a=>`<div class="event ${a.status==='angefragt'?'pending':a.status==='erledigt'?'done':''}" data-edit="${a.id}"><b>${a.time} · ${service(a.serviceId).name}</b><small>${currentUser.role==='kunde'?user(a.employeeId).name:user(a.customerId).name}</small><small>${statusName(a.status)}</small></div>`).join(''):'<div class="empty">Frei</div>'}</section>`}).join('')}</div>`;
 $('#calNew').onclick=()=>openAppointment();if(currentUser.role!=='kunde')$$('[data-edit]').forEach(b=>b.onclick=()=>openAppointment(b.dataset.edit));
}
function renderRequests(p){
 setTitle('ANFRAGEN','Terminanfragen');const list=visibleAppointments().filter(a=>a.status==='angefragt');
 p.innerHTML=`<div class="hero"><div><h3>Offene Anfragen</h3><p>Bestätige oder lehne gewünschte Termine ab.</p></div></div><div class="card">${appointmentTable(list)}</div>`;
 const rows=$$('.data-table tbody tr');rows.forEach((tr,i)=>{const a=list[i];tr.lastElementChild.innerHTML=`<div class="row-actions"><button class="mini ok" data-accept="${a.id}">Bestätigen</button><button class="mini bad" data-reject="${a.id}">Ablehnen</button><button class="mini" data-edit="${a.id}">Bearbeiten</button></div>`});
 $$('[data-accept]').forEach(b=>b.onclick=()=>setStatus(b.dataset.accept,'bestaetigt'));$$('[data-reject]').forEach(b=>b.onclick=()=>setStatus(b.dataset.reject,'abgelehnt'));bindAppointmentActions();
}
function setStatus(id,status){db.appointments.find(a=>a.id===id).status=status;save();renderPage();toast(`Termin ${statusName(status).toLowerCase()}`)}
function renderUsers(p){
 setTitle('VERWALTUNG','Benutzer');
 p.innerHTML=`<div class="hero"><div><h3>Konten verwalten</h3><p>Admin, Mitarbeiter und Kunden.</p></div><button id="newUser" class="btn primary">+ Benutzer</button></div><div class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Benutzername</th><th>Rolle</th><th>Aktion</th></tr></thead><tbody>${db.users.map(u=>`<tr><td><b>${u.name}</b></td><td>${u.username}</td><td>${roleName(u.role)}</td><td>${u.id==='u1'?'<span class="muted">Hauptadmin</span>':`<button class="mini bad" data-user-delete="${u.id}">Löschen</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
 $('#newUser').onclick=()=>$('#userDialog').showModal();$$('[data-user-delete]').forEach(b=>b.onclick=()=>{if(confirm('Benutzer und seine Termine löschen?')){db.users=db.users.filter(u=>u.id!==b.dataset.userDelete);db.appointments=db.appointments.filter(a=>a.customerId!==b.dataset.userDelete&&a.employeeId!==b.dataset.userDelete);save();renderPage();toast('Benutzer gelöscht')}})
}
function renderServices(p){setTitle('EINSTELLUNGEN','Leistungen');p.innerHTML=`<div class="hero"><div><h3>Leistungen</h3><p>Diese Leistungen können bei einem Termin ausgewählt werden.</p></div></div><div class="two-col"><div class="card"><div class="card-head"><h3>Aktive Leistungen</h3></div><div class="service-list">${db.services.map(s=>`<div class="service"><div><b>${s.name}</b><span>${s.duration} Minuten</span></div></div>`).join('')}</div></div><div class="card"><div class="card-head"><h3>Hinweis</h3></div><p class="muted">In dieser einfachen Version sind drei Standardleistungen enthalten.</p></div></div>`}
function renderProfile(p){setTitle('KUNDENBEREICH','Mein Konto');p.innerHTML=`<div class="two-col"><div class="card profile-card"><div class="user-big">${currentUser.name[0]}</div><h3>${currentUser.name}</h3><p class="muted">Benutzername: ${currentUser.username}</p><span class="badge bestaetigt">${roleName(currentUser.role)}</span></div><div class="card"><h3>Information</h3><p class="muted">Hier werden nur deine eigenen Termine angezeigt. Andere Kunden können deine Termine nicht sehen.</p></div></div>`}
function fillAppointmentForm(a){
 const customers=db.users.filter(u=>u.role==='kunde'),employees=db.users.filter(u=>u.role==='mitarbeiter');
 $('#appointmentCustomer').innerHTML=customers.map(u=>`<option value="${u.id}">${u.name}</option>`).join('');$('#appointmentEmployee').innerHTML=employees.map(u=>`<option value="${u.id}">${u.name}</option>`).join('');$('#appointmentService').innerHTML=db.services.map(s=>`<option value="${s.id}">${s.name} (${s.duration} Min.)</option>`).join('');
 $('#appointmentId').value=a?.id||'';$('#appointmentCustomer').value=a?.customerId||(currentUser.role==='kunde'?currentUser.id:customers[0]?.id);$('#appointmentEmployee').value=a?.employeeId||(currentUser.role==='mitarbeiter'?currentUser.id:employees[0]?.id);$('#appointmentService').value=a?.serviceId||db.services[0]?.id;$('#appointmentDate').value=a?.date||addDays(1);$('#appointmentTime').value=a?.time||'10:00';$('#appointmentStatus').value=a?.status||(currentUser.role==='kunde'?'angefragt':'bestaetigt');$('#appointmentNote').value=a?.note||'';
 $('#appointmentCustomer').disabled=currentUser.role==='kunde';$('#appointmentEmployee').disabled=currentUser.role==='mitarbeiter';$('#statusWrap').style.display=currentUser.role==='kunde'?'none':'grid';
}
function openAppointment(id){const a=id?db.appointments.find(x=>x.id===id):null;$('#appointmentDialogTitle').textContent=a?'Termin bearbeiten':currentUser.role==='kunde'?'Termin beantragen':'Termin eintragen';fillAppointmentForm(a);$('#appointmentDialog').showModal()}
$('#loginForm').addEventListener('submit',e=>{e.preventDefault();const u=db.users.find(x=>x.username===$('#loginUsername').value.trim()&&x.password===$('#loginPassword').value);if(!u)return toast('Benutzername oder Passwort falsch');currentUser=u;openApp()});
$$('[data-demo]').forEach(b=>b.onclick=()=>{const [u,p]=b.dataset.demo.split('|');$('#loginUsername').value=u;$('#loginPassword').value=p;$('#loginForm').requestSubmit()});
$('#logoutBtn').onclick=()=>{currentUser=null;$('#appView').classList.add('hidden');$('#loginView').classList.remove('hidden');$('#loginPassword').value=''};
$('#menuBtn').onclick=()=>$('#sidebar').classList.toggle('open');
$$('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).close());
$('#appointmentForm').addEventListener('submit',e=>{e.preventDefault();const id=$('#appointmentId').value;const item={id:id||uid('a'),customerId:currentUser.role==='kunde'?currentUser.id:$('#appointmentCustomer').value,employeeId:currentUser.role==='mitarbeiter'?currentUser.id:$('#appointmentEmployee').value,serviceId:$('#appointmentService').value,date:$('#appointmentDate').value,time:$('#appointmentTime').value,status:currentUser.role==='kunde'?'angefragt':$('#appointmentStatus').value,note:$('#appointmentNote').value.trim()};const conflict=db.appointments.find(a=>a.id!==id&&a.employeeId===item.employeeId&&a.date===item.date&&a.time===item.time&&!['abgelehnt','abgesagt'].includes(a.status));if(conflict)return toast('Diese Uhrzeit ist bereits belegt');if(id)db.appointments=db.appointments.map(a=>a.id===id?item:a);else db.appointments.push(item);save();$('#appointmentDialog').close();renderPage();toast(currentUser.role==='kunde'?'Anfrage gesendet':'Termin gespeichert')});
$('#userForm').addEventListener('submit',e=>{e.preventDefault();const username=$('#newUsername').value.trim();if(db.users.some(u=>u.username===username))return toast('Benutzername schon vergeben');db.users.push({id:uid('u'),name:$('#newUserName').value.trim(),username,password:$('#newUserPassword').value,role:$('#newUserRole').value});save();$('#userDialog').close();e.target.reset();renderPage();toast('Benutzer erstellt')});
save();
