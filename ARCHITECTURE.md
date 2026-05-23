# Zeiterfassung — Architecture

Stand: Mai 2026. Living document, wird mit jeder strukturellen Änderung mitgepflegt.

Dieses Dokument hält fest, **was die App ist** und **warum sie so gebaut ist** — getrennt vom Code. Zweck ist, dass eine spätere Person (oder eine spätere Version derselben Person) in 30 Minuten verstehen kann, warum bestimmte Entscheidungen so getroffen wurden, ohne sich durch den Commit-Log arbeiten zu müssen.

Reihenfolge der Sektionen ist bewusst: erst Glossar (damit Begriffe sitzen), dann Datenmodell (das Was), dann Sync-Invarianten (die Regeln), dann Defenses (was schiefgehen kann und wie wir's auffangen), dann Dataflows (das Wie), dann Strategie (Antworten + Pfad).

---

## 0. Status & Richtung — Stand Mai 2026

Die fünf Strategie-Fragen (siehe Sektion 7) sind beantwortet. Daraus folgt:

**Entscheidung: Refactor in Phasen, kein Greenfield-Rewrite.**

Eckpfeiler:
- **Anwendungsmodell** bleibt: Single-User mit optionalem Team. Kein Multi-Tenant.
- **Semantik** ist final gesetzt (Sektion 1 — Naive / Wallclock / Präsenz / Coverage).
- **Plattform**: Desktop-first wie bisher; **PWA-Optimierung wird hinzugefügt** (Manifest, Service-Worker für Asset-Cache, Install-Prompt). Kein Mobile-Native.
- **Sync-Modell**: **Wechsel von Local-First zu Server-First** mit lokaler Backup-Option (manueller Snapshot-Export, kein laufender Mirror). Das ist der grösste Eingriff und vereinfacht den Defense-Stack drastisch.
- **Feature-Scope**: Timer, Manual-Entry, Dashboard, Team-View, Rollen, Backup/Restore, E2E-Encryption mit Team-Sharing, DE/FR. Reports nur für Admin, mit Auswahl Einzelreport-pro-Mitglied oder Teamreport.

Die Phase 2–6-Roadmap dazu steht in Sektion 8.

Was sich durch S4 (Server-First) konkret an den Sektionen ändert, ist im jeweiligen Teil mit **🔄 ändert sich** markiert.

---

## 1. Glossar — die Begriffe, die nicht mehr wackeln dürfen

Diese Begriffe haben in den letzten Sessions zweimal die Bedeutung gewechselt. Hier ist die finale Definition. Wenn ein neuer Code-Pfad einen dieser Begriffe verwendet, _muss_ er sich an diese Definition halten — oder einen neuen Begriff erfinden.

### Naive Summe / „Erfasst"
**Definition:** Σ aller Eintragsdauern in einem Zeitraum, ohne jede Bereinigung. Parallele Erfassungen zählen mehrfach voll.

**Beispiel:** Zwei gleichzeitige 30min-Calls (SRF + Bloomberg) → Naive = 1h, obwohl nur 30min Wanduhr-Zeit vergangen ist.

**Wofür sinnvoll:** Attribution pro Dimension. „Wie viel Zeit wurde Stakeholder X zugeordnet" — Multitasking soll dort voll zählen, weil X tatsächlich Aufmerksamkeit bekam.

**Wofür _nicht_ sinnvoll:** Per-Person-Tagestotal. „Wie viel hat gnac am 4.5. gearbeitet" — Naive überzählt parallele Arbeit.

**Wo verwendet:**
- Dashboard-Headline „Erfasst Heute / Erfasst im Zeitraum" (`KpiCards`)
- Stakeholder × Person Cell-Werte (`TeamMatrix`)
- Projekt × Person Cell-Werte
- Tätigkeit/Format-Breakdowns
- Heatmap-Werte
- Report-Kennzahlen (`reportData.ts`)

### Wallclock-Union / „Getrackt"
**Definition:** Vereinigung aller Tracker-aktiven Zeitintervalle pro Tag (überlappende Intervalle werden mergedmit), in Stunden. Gibt an: während wie vieler Stunden des Tages lief tatsächlich ein Timer.

**Beispiel:** 09:00–10:00 und 09:30–10:30 parallel → Wallclock-Union = 1.5h (09:00–10:30, Überlappung kollabiert).

**Wofür sinnvoll:** „Wie viel meines Tages war tracker-abgedeckt." Coverage-Metrik. Auch: gesetzliche Überzeit (parallele Wochenend-Arbeit darf nicht doppelt zählen).

**Wofür _nicht_ sinnvoll:** Headline-KPI „wie viel habe ich heute gearbeitet" — wenn der User parallel arbeitet, unterschätzt es die Leistungsmenge.

**Implementierung:** `computeWallClockMs` und `computeLiveWallClockMs` in `src/lib/utils.ts`.

**Wo verwendet:**
- Innerer Ring im DayRing (Timer-Tab)
- Coverage-Widget im Timer-Tab
- Überzeit-Berechnung (`computeOvertimeWallClockMs`)

### Präsenzzeit / „Anwesenheit"
**Definition:** Brutto-Fenster vom ersten Eintrag-Start bis zum letzten Eintrag-Ende eines Tages, in Stunden. Bei laufendem Timer ist „letzter Eintrag-Ende" durch „jetzt" ersetzt.

**Beispiel:** Erster Eintrag 07:49, letzter endet 17:26 → Präsenz = 9:37h. Lücken (Mittagspause, vergessen zu tracken) sind enthalten.

**Wofür sinnvoll:** „Wie lange war ich heute am Arbeiten" als Brutto-Aussage. Goal-Indikator (8:24h Tagesziel = Präsenz). Per-Person-Tagestotal (Tagesübersicht-Card).

**Wofür _nicht_ sinnvoll:** Coverage-Berechnung (dafür Wallclock-Union nehmen). Attribution pro Stakeholder (dafür Naive nehmen).

**Implementierung:** `computePresenceMs` in `src/lib/utils.ts`. Pro-Member-pro-Tag in `TeamDaily.tsx`. Über mehrere Tage summiert in `TeamMatrix.tsx` (memberPresenceHours-Helper).

**Wo verwendet:**
- Äußerer Ring im DayRing (Timer-Tab)
- Tagesübersicht-Cells (Team-Tab)
- Präsenz-Row in Stakeholder×Person und Projekt×Person Tabellen

### Coverage
**Definition:** Wallclock-Union / Präsenzzeit, in Prozent. Misst, welcher Anteil deines Anwesenheits-Fensters mit Trackern abgedeckt war.

**Beispiel:** 8:45h getrackt von 9:37h Präsenz = 91% Coverage. Die fehlenden 9% (= 52min) sind die Lücken.

**Wo verwendet:**
- Coverage-Widget im Timer-Tab (mit Lückenliste)
- Inner-Ring-Beschriftung im DayRing

### Zusammenhänge — die Ungleichungskette
```
Naive ≥ Wallclock-Union ≤ Präsenz
```
- Naive ≥ Wallclock immer (Multitasking macht Naive größer, aber Wallclock kollabiert Überlappungen)
- Wallclock ≤ Präsenz immer (Tracker-Aktivität kann das Brutto-Fenster nicht überschreiten)
- Naive vs. Präsenz: keine feste Relation. Naive kann größer (viel Multitasking) oder kleiner (große Lücken) als Präsenz sein.

**Konkretes Beispiel (gnac, 4.5.2026):**
- Naive: 11.3h (Multitasking-Attribution)
- Wallclock-Union: 8:45h (echte Tracker-Zeit)
- Präsenz: 9:37h (07:49 → 17:26)
- Lücken: 52min (≈ 0.87h)
- Multitasking-Zuschlag: 11.3 − 8:45 = 2:33h

### Absence-Einträge
Sonderfall: Einträge mit Tätigkeit ∈ {Ferien, Krankheit, Militär, Freistellung}. Werden in den meisten Berechnungen ausgeschlossen (würden sonst die Produktivitäts-KPIs verzerren). Zentrale Liste in `src/lib/absences.ts`.

---

## 2. Datenmodell

### Lokal: Zustand-Stores

| Store | Datei | Verantwortung | Persistenz |
|---|---|---|---|
| `authStore` | `stores/authStore.ts` | Profile, Session-Tokens, Encryption-Keys | localStorage (Keys), Supabase Auth (Session) |
| `entriesStore` | `stores/entriesStore.ts` | Time-Entries (CRUD + Sync) | localStorage (`ze_<userId>_entries`) + Supabase |
| `masterStore` | `stores/masterStore.ts` | Stakeholders, Projekte, Tätigkeiten, Formats | localStorage + Supabase |
| `teamStore` | `stores/teamStore.ts` | Team-Mitgliedschaft, Rollen, Team-Member-Einträge | localStorage + Supabase |
| `timerStore` | `stores/timerStore.ts` | Aktive Timer-Slots (laufend/pausiert) | localStorage + Supabase Realtime |
| `uiStore` | `stores/uiStore.ts` | UI-State (Toasts, Theme, Sprache) | localStorage |

**Konvention:** Alle localStorage-Keys sind user-scoped: `ze_<userId>_<key>`. Migrations-Logik in `src/lib/userStorage.ts`.

### Remote: Supabase-Schema (Stand 20260428)

```
profiles                 — Codename + UUID
teams                    — Team-Stammdaten + Invite-Code
team_members             — Team-Mitgliedschaften
ze_roles                 — Persistente Admin/Mitarbeiter-Rollen pro Team
stakeholders             — Master-Daten Stakeholder
projects                 — Master-Daten Projekte
activities               — Master-Daten Tätigkeiten
formats                  — Master-Daten Formate
time_entries             — Time-Entries (verschlüsselt) + deleted_at Tombstones
running_timers           — Aktiv laufende Timer (für Cross-Device-Sicht)
user_settings            — Theme, Sprache, Pinned-Shortcuts
```

Alle migrations in `supabase/migrations/`, chronologisch nummeriert.

### Encryption — was wo verschlüsselt

**Personal Key:** AES-Schlüssel aus User-Passwort abgeleitet. Verschlüsselt **alle** Felder von Time-Entries und Master-Daten beim Push zu Supabase. Server sieht NUR `id`, `user_id`, `team_id`, `created_at`, `updated_at`, `deleted_at` im Klartext.

**Team Key:** AES-Schlüssel pro Team, vom Team-Creator generiert und an Members beim Join verschlüsselt-mit-Personal-Key weitergegeben. Verschlüsselt Felder, die andere Team-Members entschlüsseln können sollen.

**Verschlüsselte Felder:** `stakeholder`, `projekt`, `taetigkeit`, `format`, `start_time`, `end_time`, `duration_ms`, `notiz`, `date`. Implementierung: `src/lib/crypto.ts`.

**Konsequenz:** Server-side queries auf verschlüsselte Felder sind unmöglich. Alle Filter, Aggregationen, Such­vorgänge laufen client-side gegen entschlüsselte lokale Kopie.

### TimeEntry-Felder (das wichtigste Datenmodell)

```ts
interface TimeEntry {
  id: string;              // UUID v4
  user_id: string;         // owner
  date: string;            // YYYY-MM-DD
  stakeholder: string | string[];  // legacy: string, neu: string[]
  projekt: string;
  taetigkeit: string;
  format: string;          // "Einzelarbeit" | "Meeting" | "Telefonat" | "Email"
  start_time: string;      // HH:MM
  end_time: string;        // HH:MM
  duration_ms: number;
  notiz?: string | null;
  created_at: string;      // ISO
  updated_at: string;      // ISO
  deleted_at?: string | null;  // Tombstone — null = aktiv
}
```

**Tech-Debt:** `stakeholder: string | string[]` ist Backward-Compat-Pflaster. Neue Einträge sind immer Array; Reads müssen beide Formen handhaben. Kandidat für Refactor.

---

## 3. Sync-Invarianten

Diese Aussagen müssen immer wahr sein. Wenn der Code so schreibt, dass eine davon kippt, ist das ein Bug.

### I1 — Local first, ohne Verlust
Ein Eintrag, der lokal in `entriesStore.entries[]` und in localStorage steht, geht **nie** verloren, solange der User nicht aktiv `delete()` aufruft (oder die Verwaltung das Recovery-Tool benutzt).

Konsequenz: jeder Pull/Merge muss lokale Einträge **erhalten**, auch wenn sie nicht in Supabase sind. Das ist die Soft-Merge-Logik. Siehe Defense D2.

### I2 — Tombstone als Wahrheitsquelle für Löschungen
`delete()` setzt **niemals** ein echtes SQL DELETE auf `time_entries`. Stattdessen wird `deleted_at` per UPDATE auf einen Timestamp gesetzt. Reads filtern Tombstones aus dem Display, behalten sie aber als Information. Cross-Device-Devices erkennen die Löschung am Tombstone und entfernen den Eintrag aus ihrer lokalen Sicht.

Konsequenz: Soft-Delete macht Löschungen propagier­bar UND wiederherstellbar. Siehe Defense D5.

### I3 — Pending-Pflicht bis zum Confirm
Jeder neu erstellte Eintrag wird in `_pendingLocalIds` (localStorage `ze_<userId>_pending_entry_ids`) eingetragen. Erst wenn der Supabase-Upsert erfolgreich confirmed ist, wird die ID aus dem Pending-Set entfernt.

Konsequenz: nach Crash/Reload kann die App alle nicht-bestätigten Einträge wieder pushen.

### I4 — Stop-Journal als zusätzliche Beweis-Schicht
Vor jedem `entriesStore.add()`, ausgelöst durch einen Timer-Stop, wird ein Journal-Eintrag in localStorage geschrieben. Erst nach erfolgreichem `add()` wird der Journal-Eintrag entfernt. Beim App-Boot wird das Journal geprüft und nicht-confirmierte Stops dem User per Recovery-Banner zur Wiederherstellung angeboten.

Konsequenz: selbst wenn der „happy path" durch eine spätere Korruption Daten verliert, hat das Journal eine unabhängige Spur. Siehe Defense D4.

### I5 — Eindeutige IDs across Devices
Time-Entry-IDs sind UUID v4. Beim Stop wird die ID `pre-allocated` und sowohl an das Journal als auch an `add()` weitergegeben. So teilen Journal-Eintrag und resultierender Time-Entry dieselbe ID — Voraussetzung für die Recovery-Dedup-Logik.

### I6 — Zeitbasierte Felder sind reine Strings
`start_time` / `end_time` sind `"HH:MM"` ohne Sekunden, ohne Zeitzone. `date` ist `"YYYY-MM-DD"` Local-Time. Beim Schreiben werden sie aus `new Date()` mit `getHours()`, `getMinutes()` gewonnen — also Local-Time des aktuellen Geräts. **Konsequenz:** Cross-Timezone-Synchronisation ist undefiniert. Wenn Device A in CH und Device B in US arbeiten, ist das Ergebnis nicht garantiert konsistent.

---

## 4. Defense-Mechanismen — was schützt was

Jeder dieser Mechanismen kam als Antwort auf einen realen Bug-Vorfall. Die Reihenfolge ist chronologisch.

### D1 — User-scoped localStorage
**Problem (frühe Tage):** Auf demselben Browser teilten mehrere User dieselben localStorage-Keys → Daten-Cross-Contamination beim User-Switch.

**Lösung:** Alle Keys haben den User-ID-Prefix `ze_<userId>_<key>`. Migration-Logik in `getUserData` für legacy-Keys.

**Implementiert in:** `src/lib/userStorage.ts`

### D2 — Soft-Merge bei Pulls 🔄 ändert sich (Phase 3)
> Unter Server-First entfällt die Soft-Merge-Logik komplett. Server ist Wahrheitsquelle, Pulls replacen statt zu mergen. Die ganze `localOnly`-/`sbActiveFiltered`-Mechanik wird obsolet.

**Problem (Supabase IO Crisis):** Der frühere Merge replaced lokale entries[] mit Supabase-Daten. Wenn ein lokaler Eintrag noch nicht gepushed war (z.B. weil 503-Fehler), ging er beim nächsten Pull verloren.

**Lösung:** Pulls mergen statt replacen. Konkret:
```
sbActive          = Supabase-Rows ohne deleted_at
sbTombstones      = Supabase-Rows mit deleted_at (Set von IDs)
localOnly         = lokale Einträge, die NICHT in sbActiveIds, NICHT in sbTombstoneIds, und KEIN local tombstone haben
sbActiveFiltered  = sbActive ohne IDs, die in localTombstones sind
merged            = [...sbActiveFiltered, ...localOnly]
```

**Garantie:** lokale Einträge bleiben präserviert. Tombstone-Propagation funktioniert trotzdem (sbTombstones-Filter).

**Implementiert in:** `entriesStore.ts` — `fetch()` und `pullEntriesFromSupabase()`.

### D3 — Force-Resync (Notfall-Werkzeug) 🔄 entfällt (Phase 3)
> Server-First kennt keine "lokal-pending"-Einträge — jede Aktion wird vom Server bestätigt bevor lokal angewandt. Das Werkzeug wird nicht mehr gebraucht und entfernt.

**Problem:** Wenn das Pending-Tracking aus irgendeinem Grund kaputt ist (z.B. nach Sync-Crash), gibt es lokale Einträge die NICHT als pending markiert sind, aber auch nicht in Supabase liegen. Dann werden sie nie gepushed.

**Lösung:** Ein Admin-Tool in der Verwaltung („Einträge jetzt synchronisieren"), das ALLE lokalen Einträge als pending markiert und dann zwangsweise zu Supabase pushed. Idempotent (`ON CONFLICT id`), also safe to retry.

**Implementiert in:** `forceResyncAllLocalEntries` in `entriesStore.ts`. UI: `ManageView.tsx`.

### D4 — Stop-Journal + Recovery-Banner 🔄 vereinfacht (Phase 3)
> Unter Server-First wird das Stop-Journal stark vereinfacht: Stop = `await server.create(entry)` synchron. Bei Erfolg lokales Update + Slot-Removal, bei Fehler Toast + Slot bleibt erhalten. Kein eigenes Journal mit Recovery-Banner mehr nötig — die "verschwindet stillschweigend nach happy path"-Failure-Mode existiert nicht mehr, weil der Server Wahrheit ist. Optional: kleine Retry-Queue für Netzwerk-Fehler bei der Stop-Aktion (max. 1-2 Einträge tief, kein 7-Tage-Journal).

**Problem (Stop-Verluste):** Nach `await addEntry(...)` ist der Eintrag in localStorage UND möglicherweise in Supabase. Aber Bugs nach `add()` (fehlerhafter Merge, Tab-Reload, Decrypt-Glitch) konnten den Eintrag stillschweigend verschwinden lassen — ohne Pending-Spur, weil der Push schon confirmed war.

**Lösung:** Vor JEDEM async-Schritt der Stop-Aktion wird ein Journal-Row in `ze_<userId>_stop_journal` geschrieben (mit pre-allocated UUID). Nach erfolgreichem `add()` wird der Journal-Row entfernt. Beim App-Boot prüft `getRecoveryCandidates(entries)`:
- Match per ID → still entfernen (Stop war erfolgreich, Confirm-Schritt war nur nicht durchgekommen)
- Fingerprint-Match (date + start + end + dimensions) → still entfernen (selbe Erkennung)
- Sonst → Recovery-Kandidat → Banner zeigen

User klickt „Wiederherstellen" → addEntry mit der gespeicherten Original-ID. Per-Eintrag dismissable.

**Implementiert in:** `src/lib/stopJournal.ts`, `src/components/Timer/RecoveryBanner.tsx`. Aufgerufen aus `TimerLane.handleStop` und `timerStore.stopTimer`.

### D5 — Tombstones für Cross-Device-Delete-Propagation 🔄 Rolle ändert sich (Phase 3)
> Unter Server-First wird die Cross-Device-Propagations-Rolle obsolet (jeder Pull holt den aktuellen Server-State, Tombstone-Filtering ist nicht mehr nötig). ABER: das `deleted_at`-Feld bleibt im Schema und wird zu einem reinen **Soft-Delete-Feature** für Versehentliche-Löschungen-Wiederherstellen umgewidmet (siehe DeletedEntriesPanel). `_localTombstones` (das offline-buffer Map) entfällt.

**Problem (vor Migration 20260428):** `delete()` machte echtes SQL DELETE. Andere Devices konnten nicht erkennen, ob ein Eintrag „nie gepushed" oder „gelöscht" war — Soft-Merge präservierte ihn. → Zombie-Einträge.

**Lösung:** Migration 20260428 fügt `deleted_at timestamptz` zu `time_entries` hinzu. `delete()` macht UPDATE statt DELETE. Reads ziehen Tombstones MIT (filtern aber im Display). Cross-Device: Tombstone wird gepulled → lokaler Eintrag verschwindet.

Lokale Tombstones (`_localTombstones` Map) decken den Offline-Delete-Fall ab: User löscht offline, Tombstone wird beim nächsten Online-Sync nachgeschoben.

**Implementiert in:** `entriesStore.ts` — `delete()`, `addLocalTombstone`, `removeLocalTombstone`, `pushLocalTombstonesToSupabase`. SQL: `supabase/migrations/20260428000000_time_entries_tombstones.sql`.

### D6 — Stop-Button Click-Debounce
**Problem (4.5. Bug-Vorfall):** Doppelklick auf Stop während des langen `await addEntry`-Fensters erzeugte zwei Einträge mit minimal verschobenen Zeitstempeln (08:10–09:15 und 08:10–09:16), weil zweiter Klick `getSlotElapsed` neu berechnete und ein leicht jüngeres `now` einsetzte.

**Lösung:** `isStopping`-Flag in `TimerLane`. Button wird visuell ausgegraut + cursor:wait + Re-Entrancy-Guard im Handler. Gleiches Pattern für „Tag beenden" in `TimerView` (`isEndingDay`-Flag).

**Implementiert in:** `src/components/Timer/TimerLane.tsx`, `src/components/Timer/TimerView.tsx`.

### D7 — Near-Duplicate-Detector + Recovery
**Problem:** Trotz D6 gibt es historische Duplikate aus der Zeit davor. Plus Edge-Cases (Race-Conditions, Manual-Entry mit ähnlichen Werten).

**Lösung:**
- `findNearDuplicateGroups` in `src/lib/duplicates.ts` findet PAARE (kein transitives Clustern!) von Einträgen mit gleicher Dimension (date + stakeholder + projekt + taetigkeit + format + **notiz**) und zeitlich überlappenden Intervallen.
- Notiz-Inklusion verhindert false-positives bei parallel-arbeit-mit-unterschiedlichen-Themen (z.B. „srf mengele" vs „bloomberg mengele").
- UI zeigt jedes Paar mit Default-Vorschlag (längeren behalten); User kann durch Klick auf den jeweiligen Eintrag die Auswahl spiegeln, dann „Duplikat entfernen".
- Falls falsch gelöscht: Tombstone in Supabase ist da → DeletedEntriesPanel ermöglicht Wiederherstellung.

**Implementiert in:** `src/lib/duplicates.ts`, `src/components/Manage/EntryDuplicatesPanel.tsx`, `src/components/Manage/DeletedEntriesPanel.tsx`.

### D8 — Tracking-Coverage-Widget
**Problem:** Wallclock-Lücken (User vergisst zu tracken) waren unsichtbar — Coverage = niedrig sah „normal" aus.

**Lösung:** Widget unter dem DayRing zeigt „Getrackt X von Y Präsenz · N Lücken". Klick öffnet Lücken-Liste mit großen Lücken (≥30min) hervorgehoben. Macht ungetrackte Zeit aktionable.

**Implementiert in:** `src/components/Timer/TrackingCoverage.tsx`, `findTrackingGaps` in `utils.ts`.

### D9 — InfoTooltip auf jeder KPI
**Problem:** Begriffe wie „Erfasst", „Präsenz", „Getrackt" sind verwandte aber unterschiedliche Konzepte. Ohne Erklärung verloren sich User.

**Lösung:** Wiederverwendbare `InfoTooltip`-Komponente mit kleinem (i)-Icon neben jedem KPI-Label. Hover (Desktop) / Tap (Mobile) zeigt 1-Paragraph-Definition.

**Implementiert in:** `src/components/UI/InfoTooltip.tsx`, eingehängt in `KpiCards`, `DayRing`, `TrackingCoverage`, `TeamMatrix`.

---

## 5. Happy-Path-Dataflows

### F1 — Stop-Klick → Eintrag persistent → andere Devices

```
User klickt Stop auf TimerLane (Slot S, Dimensionen D, Elapsed E)
  ↓
TimerLane.handleStop:
  isStopping=true (D6)
  ↓
  entryId = generateEntryId()                       (I5)
  payload = { date, dimensions, start, end, duration_ms, notiz }
  ↓
  recordStopAttempt({ entryId, payload, source })   (D4: Journal schreibt synchron)
  ↓
  await entriesStore.add({ ...payload, id: entryId })
    ↓
    entries[] = [...entries, newEntry]
    setUserData('entries', entries)                 (localStorage write)
    markEntryPending(entryId)                       (I3)
    ↓
    if (online && hasKey) {
      row = encryptEntryForSupabase(newEntry)
      upsert into time_entries
      if success: _pendingLocalIds.delete(entryId)  (I3 confirm)
    }
  ↓
  confirmStopSucceeded(journalId)                   (D4: Journal cleart)
  if (E ≥ 30min) showToast("Gespeichert · …")
  removeSlot(S)
  ↓
  [auf Device B, beim nächsten Pull-Tick:]
  pullEntriesFromSupabase()
    ↓ Supabase liefert decrypteEntries inkl. unseren neuen
    ↓ merged via D2 Soft-Merge
    ↓ entries[] enthält neuen Eintrag
    ↓ UI rendert neu
```

### F2 — Delete → Cross-Device-Propagation

```
User klickt Lösch-Icon
  ↓
entriesStore.delete(id)
  ↓
  if (online) {
    UPDATE time_entries SET deleted_at = now() WHERE id = id
    if success: entries[] = entries.filter(e => e.id !== id)
                setUserData('entries', entries)
  } else {
    addLocalTombstone(id, now())                    (für offline retry)
    entries[] = entries.filter(e => e.id !== id)
    setUserData('entries', entries)
  }
  ↓
  [auf Device B:]
  pullEntriesFromSupabase()
    ↓ Supabase liefert die Row mit deleted_at gesetzt
    ↓ sbTombstoneIds enthält id
    ↓ localOnly-Filter und sbActiveFiltered-Filter ziehen id raus
    ↓ entries[] auf Device B zeigt Eintrag nicht mehr
```

### F3 — Boot-Up

```
App-Mount (App.tsx)
  ↓
1. authStore.restoreSession()      — JWT, encryption keys
2. uiStore lädt Theme/Sprache
3. Falls authenticated:
   a. teamStore.syncTeamData()      — Team, Mitglieder, Rollen, Team-Member-Entries
   b. entriesStore.fetch()           — eigene Einträge (mit Soft-Merge)
   c. masterStore.fetch()            — eigene Master-Daten
   d. timerStore.restoreTimers()     — laufende Timer aus localStorage + Cross-Device
4. Boot ist sequenziell mit 800ms-Pausen zwischen Steps (Disk-IO-Budget unter Last)
5. RecoveryBanner prüft Stop-Journal → zeigt Banner falls offene Stops
```

### F4 — Offline → Online-Übergang

```
Während offline:
  - User stoppt Timer → Eintrag in entries[], pending=true, in localStorage
  - User löscht Eintrag → addLocalTombstone, aus entries[] entfernt, in localStorage
  - User bearbeitet Eintrag → updates entries[], pending=true (re-pushed beim Online)

Beim Online:
  - pullEntriesFromSupabase() läuft (Visibility-Change oder Poll-Tick)
  - pushLocalEntriesToSupabase() pushed alle lokalen-only Einträge (D2)
  - pushLocalTombstonesToSupabase() pushed offline-Deletes
  - merge runs as normal
```

---

## 6. Aktuelle Pain-Points / Tech-Debt

Liste der Stellen, wo der Code sichtbar Geschichte trägt. Nicht zwingend Bugs, aber Cleanup-Kandidaten.

1. **`stakeholder: string | string[]`** in TimeEntry — Backward-Compat-Pflaster. Sollte `string[]` werden, mit One-Time-Migration der bestehenden String-Einträge.

2. **`entriesStore.ts` ~1800 Zeilen** — vermischt Store-State, Sync-Logik, Encryption, Tombstones, Recovery. Kandidat zum Splitten in `entriesStore` (state) + `entriesSync` (Supabase IO) + `entriesTombstones` (delete propagation).

3. **Drei Delete-Propagation-Mechanismen nebeneinander** — Tombstone (Supabase), Local Tombstone (offline-buffer), Stop-Journal (recovery). Funktional korrekt, konzeptionell aber drei Mechanismen für ein Problem. Konsolidierung möglich.

4. **Kein Test-Harness** — keine Unit-Tests für die kritischen Helper (`computeWallClockMs`, `findNearDuplicateGroups`, Soft-Merge). Refactor ist deshalb riskant. Vor jedem strukturellen Refactor sollte ein Test-Harness aufgebaut werden.

5. **`computeKpiHours` ignoriert das Filter-Argument** — nach dem Naive-Switch ist das `filter`-Argument unused (`_filter`). Sollte entweder verwendet oder entfernt werden.

6. **TimerView.combinedMs entfernt, aber Variable-Name lebt in Refs noch** — Suchpfade.

7. **i18n-Keys mit `legacy`-Kommentar** — alte Übersetzungen, die durch neue Keys abgelöst wurden, aber zur Sicherheit nicht entfernt sind. Sollten beim Cleanup mit weg.

8. **Poll-Intervalle hartcodiert auf 300s** — sollte konfigurierbar oder Realtime-Subscription-basiert sein.

9. **TimeZone-Annahme: alles Local-Time** — keine UTC-Umrechnung. Funktioniert für Single-User in einer Zeitzone, bricht bei Cross-Timezone.

---

## 7. Strategie-Fragen — beantwortet, Mai 2026

### S1 — Anwendungsmodell: Single-User-mit-Team oder Multi-Tenant?
**Antwort: Single-User mit Team.** Aktuelles Modell wird beibehalten. Personal Key + optionaler Team Key, ein Team pro User. Kein Multi-Tenant, keine Subscriptions.

**Konsequenz für Refactor:** Schema bleibt strukturell wie heute. RLS-Policies stay.

### S2 — Semantik final?
**Antwort: Final.** Naive / Wallclock / Präsenz / Coverage sind in Sektion 1 dieses Dokuments gesetzt. Künftige Verschiebungen brauchen explizite Doc-Änderung _bevor_ Code geschrieben wird (siehe Sektion 9 Pflege-Regel).

**Konsequenz für Refactor:** Die jetzt sichtbaren Inkonsistenzen (Dashboard zeigt naive, andere Cards Präsenz) bleiben unter Refactor-Betrachtung. Ggf. in Phase 6 (Cleanup) mit harmonisieren — aber ohne nochmal die Begriffe zu kippen.

### S3 — Mobile vs Desktop?
**Antwort: Desktop-first, neu PWA-optimieren.** Kein React-Native, keine Mobile-Native-App. Aber: Manifest, Service-Worker für Asset-Cache (kein Offline-Sync — siehe S4), Install-Prompt, Mobile-responsive bleiben. Ziel ist „App-like" Verhalten ohne App-Store-Pflege.

**Konsequenz für Refactor:** Phase 4 in der Roadmap. PWA ist additiv, kein Re-Engineering.

### S4 — Offline-First behalten?
**Antwort: Server-First mit lokaler Backup-Option.** Wechsel von Local-First-mit-optimistischem-Sync auf Server-First. Konkret:
- Jede Schreibaktion (add/update/delete) ist ein synchroner Server-Roundtrip mit Confirm.
- Kein optimistisches Lokal-Update vor Server-Confirm. Bei Netzwerkfehler: Toast + lokal nichts geändert.
- Local Backup ist eine **separate manuelle Snapshot-Funktion** (Export/Import als Verschlüsselter JSON), kein laufender Mirror.
- Tracker-State (Timer-Slots) bleibt lokal für flüssige UI; beim Stop wird der Server-Write angeschoben, der Slot bleibt sichtbar bis Confirm.

**Konsequenz für Refactor:** Größter Eingriff. Defense-Stack D2-D5 (siehe Sektion 4) wird stark vereinfacht oder entfernt. ~30-50% Code-Reduktion in `entriesStore.ts` realistisch.

### S5 — Feature-Set: was ist Kern, was Beilage?
**Antwort:**
- **Essenziell:** Timer + Manual-Entry, Dashboard, Team-View, Rollen (Admin/Mitarbeiter), Backup/Restore, E2E-Encryption mit Team-Sharing, 2 Sprachen (DE + FR).
- **Reports nur Admin:** Auswahl Einzelreport-pro-Mitglied oder Teamreport. (Bisher: für alle User sichtbar.)
- **Implizit gestrichen:** zusätzliche Sprachen über DE/FR hinaus, Mobile-Native, Multi-Tenant-Funktionen.

**Konsequenz für Refactor:** Phase 5 in der Roadmap. Role-Gate auf den Report-Tab + UI-Toggle „Einzelreport / Teamreport" im ReportModal.

---

## 8. Refactor-Roadmap (gewählter Pfad, Stand Mai 2026)

Auf Basis der S1–S5-Antworten ist **kein Greenfield-Rewrite** vorgesehen. Stattdessen ein konzentrierter Phasen-Refactor. Aufwand-Schätzung in Sessions à ~2h, ist eine grobe Hausnummer.

### Phase 2 — Test-Harness (2 Sessions)
Vor jedem strukturellen Eingriff: Sicherheitsnetz bauen.

- Vitest-Setup (oder Jest, wenn schon konfiguriert)
- Unit-Tests:
  - `computeWallClockMs`, `computeLiveWallClockMs`, `computePresenceMs`
  - `findTrackingGaps`
  - `findNearDuplicateGroups`
  - `entryFingerprint`, Tombstone-Helfer
- Integration-Test: Stop → Save → Pull-Zyklus (gegen Mock-Supabase)
- Goldener Pfad: jeder dieser Tests muss VOR und NACH dem Server-First-Refactor identische Resultate liefern. Das beweist „nichts kaputt gemacht".

### Phase 3 — Server-First-Refactor (3 Sessions)
Der eigentliche Eingriff.

**Session 3a — Read-Pfad zu Server-First.** Pulls werden vom Soft-Merge zum Replace-Pull. localStorage wird zum Cache, nicht mehr zur Source of Truth. Race-Conditions zwischen Pull und User-Edit klären (User-Edits gewinnen lokal, bis nächster Pull).

**Session 3b — Write-Pfad zu Server-First.** `add()`, `update()`, `delete()` werden synchron mit Server-Confirm. Pending-Tracking entfällt. Force-Resync wird entfernt. Stop-Journal wird zu einer minimalen Retry-Queue für Netzwerk-Fehler beim Stop (max. 2 offene Stops; verschwindet sobald Verbindung zurück ist).

**Session 3c — Tombstone-Refactor.** `deleted_at` bleibt im Schema, aber als Soft-Delete-Feature. `_localTombstones` Map wird entfernt. Cross-Device-Propagation entfällt (Server ist Wahrheit). DeletedEntriesPanel funktioniert weiter mit dem `deleted_at`-Feld.

Test-Harness aus Phase 2 läuft nach jeder Session — ist der Lackmus-Test, ob „nichts kaputt".

### Phase 4 — PWA-Optimierung (1 Session)
Additiv, ohne Architektur-Eingriff.

- `manifest.json` mit Icons, Display-Mode standalone
- Service-Worker via Vite-PWA-Plugin oder manuell:
  - Asset-Cache (CSS/JS/Bilder) für offline-Page-Loads
  - **Kein** API-Cache, **kein** Background-Sync — Server-First-Modell bleibt strikt
- Install-Prompt-Banner für eligible-User
- iOS-Add-to-Home-Screen-Meta-Tags

### Phase 5 — Reports admin-only + Einzel/Team-Variante (1 Session)
- Role-Gate: Reports-Tab nur sichtbar für `isAdmin`
- ReportModal-UI: Toggle „Einzelreport (Mitglied wählen)" vs. „Teamreport"
- Bei Einzelreport: Member-Picker mit Suche, Reports werden mit gefilterten Daten generiert
- i18n: neue Strings für die Toggle-Labels und den Member-Picker

### Phase 6 — Cleanup-Sweep (1 Session)
Aufräumarbeit, die durch Phase 3 leichter wird.

- `stakeholder: string | string[]` → nur `string[]`, mit One-Time-Migration
- Tote i18n-Keys (`legacy`-markierte Einträge) entfernen
- Tote Code-Pfade (`computeKpiHours` mit unused `_filter` etc.)
- entriesStore-Split: `entriesStore` (state) + `entriesApi` (server-IO) — wenn Phase 3 die Logik schon stark reduziert hat, ist der Split einfach
- Inkonsistente Headline-Semantik harmonisieren (siehe S2 Konsequenz)

### Total: 8 Sessions
Vergleich: ein realistischer Greenfield-Rewrite wäre 15-25 Sessions mit Regression-Risiko.

**Meilenstein zwischen Phase 3 und 4:** vor PWA-Aktivierung lokal vollständig testen, dass der Server-First-Modus stabil läuft. Wenn S4-Antwort sich in der Praxis als Fehlentscheidung erweist (z.B. "Termine ohne Internet" doch wichtig), ist Phase 4 ein guter Re-Eval-Punkt.

---

## 9. Stand des Dokuments

**Erstellt:** Mai 2026, nach ~102 Iterations-Tasks an der bestehenden App.

**Update Mai 2026:** Sektion 0 + Sektion 7 + Sektion 8 ergänzt nach Beantwortung S1-S5. Refactor-Pfad statt Greenfield-Rewrite gewählt.

**Nächster Update-Trigger:**
- Phase 2 (Test-Harness) abgeschlossen → neue Sektion „Tests" einbauen, beschreibt was getestet ist
- Phase 3 (Server-First) abgeschlossen → Sektionen 3 (Invarianten) + 4 (Defenses) konsolidieren — Streichungen einarbeiten, neue Server-First-Invarianten hinzufügen
- Phase 4 (PWA) abgeschlossen → Sektion 2 (Datenmodell) um Service-Worker / Manifest erweitern
- Strukturelle Code-Änderungen, die Invarianten betreffen → Update Sektion 3
- Begriffsverschiebungen → ALARM. Erst Glossar updaten, dann Code.

**Pflege-Regel:** vor jedem strukturellen Refactor (= Code-Änderung, die mehr als nur Bugfix ist) wird zuerst dieses Dokument aktualisiert. So bleibt die Dokumentation nicht nachlauf, sondern führt.
