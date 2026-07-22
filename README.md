# S-Y Terminplaner – Originalversion

Diese Version nutzt Supabase. Dadurch funktionieren Konten und Termine auf verschiedenen Geräten.

## Enthalten
- Kunden können selbst ein Kundenkonto erstellen.
- Nur der Admin kann Mitarbeiterkonten erstellen.
- Admin kann alle Konten bearbeiten, sperren und löschen.
- Admin verwaltet Leistungen und alle Termine.
- Mitarbeiter sehen ihren Kalender und bearbeiten eigene Termine.
- Kunden sehen nur eigene Termine und können Termine beantragen.

## Einrichtung
1. Kostenloses Projekt auf Supabase erstellen.
2. `supabase.sql` im Supabase SQL Editor vollständig ausführen.
3. In `config.js` die Project URL und den Publishable/Anon Key eintragen.
4. Den Ordner `supabase/functions/admin-users` als Edge Function `admin-users` bereitstellen.
5. Website-Dateien auf GitHub hochladen.
6. Zuerst ein normales Kundenkonto registrieren.
7. Im Supabase SQL Editor ausführen:

```sql
select public.make_admin_by_email('DEINE-EMAIL@BEISPIEL.DE');
```

8. Abmelden und wieder anmelden. Das Konto ist nun Administrator.

Wichtig: Niemals den Supabase Service-Role-Key in `config.js` oder GitHub eintragen. Dieser Schlüssel gehört nur in die Supabase Edge Function.
