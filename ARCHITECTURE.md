# Zeiterfassung — Architecture

Stand: Mai 2026. Living document, wird mit jeder strukturellen Änderung mitgepflegt.

Dieses Dokument hält fest, **was die App ist** und **warum sie so gebaut ist** — getrennt vom Code. Zweck ist, dass eine spätere Person (oder eine spätere Version derselben Person) in 30 Minuten verstehen kann, warum bestimmte Entscheidungen so getroffen wurden, ohne sich durch den Commit-Log arbeiten zu müssen.

Reihenfolge der Sektionen ist bewusst: erst Glossar (damit Begriffe sitzen), dann Datenmodell (das Was), dann Sync-Invarianten (die Regeln), dann Defenses (was schiefgehen kann und wie wir's auffangen), dann Dataflows (das Wie), dann Strategie (offene Fragen).

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

### D2 — Soft-Merge bei Pulls
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

### D3 — Force-Resync (Notfall-Werkzeug)
**Problem:** Wenn das Pending-Tracking aus irgendeinem Grund kaputt ist (z.B. nach Sync-Crash), gibt es lokale Einträge die NICHT als pending markiert sind, aber auch nicht in Supabase liegen. Dann werden sie nie gepushed.

**Lösung:** Ein Admin-Tool in der Verwaltung („Einträge jetzt synchronisieren"), das ALLE lokalen Einträge als pending markiert und dann zwangsweise zu Supabase pushed. Idempotent (`ON CONFLICT id`), also safe to retry.

**Implementiert in:** `forceResyncAllLocalEntries` in `entriesStore.ts`. UI: `ManageView.tsx`.

### D4 — Stop-Journal + Recovery-Banner
**Problem (Stop-Verluste):** Nach `await addEntry(...)` ist der Eintrag in localStorage UND möglicherweise in Supabase. Aber Bugs nach `add()` (fehlerhafter Merge, Tab-Reload, Decrypt-Glitch) konnten den Eintrag stillschweigend verschwinden lassen — ohne Pending-Spur, weil der Push schon confirmed war.

**Lösung:** Vor JEDEM async-Schritt der Stop-Aktion wird ein Journal-Row in `ze_<userId>_stop_journal` geschrieben (mit pre-allocated UUID). Nach erfolgreichem `add()` wird der Journal-Row entfernt. Beim App-Boot prüft `getRecoveryCandidates(entries)`:
- Match per ID → still entfernen (Stop war erfolgreich, Confirm-Schritt war nur nicht durchgekommen)
- Fingerprint-Match (date + start + end + dimensions) → still entfernen (selbe Erkennung)
- Sonst → Recovery-Kandidat → Banner zeigen

User klickt „Wiederherstellen" → addEntry mit der gespeicherten Original-ID. Per-Eintrag dismissable.

**Implementiert in:** `src/lib/stopJournal.ts`, `src/components/Timer/RecoveryBanner.tsx`. Aufgerufen aus `TimerLane.handleStop` und `timerStore.stopTimer`.

### D5 — Tombstones für Cross-Device-Delete-Propagation
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

## 7. Strategie-Fragen — beantworten, bevor v3.0 in Frage kommt

### S1 — Anwendungsmodell: Single-User-mit-Team oder Multi-Tenant?
**Aktuelles Modell:** Single-User-mit-Team. Jeder User hat einen Personal Key, kann optional einem Team beitreten und bekommt dann auch einen Team Key. Nur ein Team pro User aktiv.

**Konsequenzen:**
- Multi-Tenant würde User-Isolation auf DB-Ebene bedeuten (Row-Level-Security pro Tenant). Aktuell: pro User, mit Team als zusätzlicher RLS-Schicht.
- Echtes B2B SaaS-Modell würde Subscriptions / Billing erfordern.
- Single-User-mit-Team hält die Komplexität klein, passt zum derzeitigen Use-Case (eine Person + ihre Direct Reports).

**Frage zu beantworten:** Bleibt das Modell so, oder soll v3 Multi-Tenant werden?

### S2 — Semantik final?
**Stand:** Präsenz / Getrackt / Erfasst / Coverage haben wir in Sektion 1 dieses Dokuments festgeschrieben. Ist das jetzt _final_? Oder gibt es weitere Pivots?

**Kandidat:** Dashboard-Headline „Erfasst Heute" zeigt aktuell die naive Summe. Wäre es konsistenter, dort auch Präsenz anzuzeigen (analog zur Tagesübersicht-Card)? Falls ja: Dashboard-Headline-Switch ist eine letzte offene Konsistenz-Lücke.

**Frage zu beantworten:** Bleiben die drei Begriffe so, oder kommt noch eine Bereinigung?

### S3 — Mobile vs Desktop?
**Aktuell:** Desktop-first Web-App, responsive aber nicht PWA-optimiert. Kein Native-App.

**Alternativen:**
- PWA mit Offline-First (mehr Engagement auf Mobile, App-Icon auf Home-Screen)
- React Native Wrapper (echte Mobile-App, App Store)
- Bleibt Web-only

**Frage zu beantworten:** Lohnt sich PWA-Investment?

### S4 — Offline-First behalten?
**Aktuelles Modell:** Local-First-mit-optimistischem-Sync. localStorage ist Source of Truth, Supabase ist Backup + Cross-Device-Vehicle.

**Alternative:** Server-First, jeder Action ein Round-Trip (klassisch). Ergibt einfachere Architektur, keine Soft-Merge / Tombstones / Pending-IDs nötig. Bricht aber bei Offline-Use komplett.

**Frage zu beantworten:** Ist Offline-Use ein hard Requirement (z.B. Termine ohne Internet trackbar)? Wenn ja: Local-First behalten. Wenn nein: könnte ein Rewrite die Komplexität halbieren.

### S5 — Feature-Set: was ist Kern, was Beilage?
**Aktuell vorhanden:**
- Timer + Manual-Entry
- Dashboard mit KPIs + Breakdowns + Heatmap
- Team-View mit Tagesübersicht + Workload + Timeline
- Reports (HTML)
- Rollen (Admin/Mitarbeiter)
- Backup/Restore
- Recovery-Banner + DuplicateDetektor + DeletedEntries-Panel
- E2E-Encryption mit Team-Sharing
- 4 Sprachen (DE/FR via i18n; PWA + Mobile-spezifisch nicht ausgebaut)

**Frage zu beantworten:** Bei einem v3-Rewrite: was ist tatsächlich essential? Häufig wird in Rewrites zu viel mitgenommen.

---

## 8. Bei einer v3.0-Entscheidung: Empfohlene Reihenfolge

Falls die fünf Strategie-Fragen beantwortet sind und ein Rewrite tatsächlich sinnvoll erscheint, wäre die empfohlene Reihenfolge:

1. **Test-Harness für die jetzige App** (1-2 Sessions). Unit-Tests für `computeWallClockMs`, `computePresenceMs`, `findNearDuplicateGroups`, Soft-Merge. Macht den Rewrite-Vergleich faktisch — neuer Code muss dieselben Tests bestehen.
2. **Daten-Export-Pfad bewahren** (1 Session). CSV-Export funktioniert ja, aber zusätzlich ein JSON-Backup-Format mit Encryption-Keys, das v3 importieren kann.
3. **Schema-Lock** (1 Session). DB-Schema einfrieren, Migrations bis hier dokumentieren. v3 startet von hier (kein neues Schema).
4. **Greenfield-Entwicklung** der UI + Stores, gegen das gelockte Schema und die existierenden Tests.
5. **Side-by-Side-Phase**: v3 als separate Subdomain, User können wechseln, Daten bleiben kompatibel. Bug-Reports → Fixes in v3, alte App im Read-Only-Modus.
6. **Cutover** wenn v3 stabil ist. Alte App archiviert, nicht gelöscht.

---

## 9. Stand des Dokuments

**Erstellt:** Mai 2026, nach ~95 Iterations-Tasks an der bestehenden App.

**Nächster Update-Trigger:**
- Beantwortung der Strategie-Fragen S1–S5 (Sektion 7) → Update Sektion 7 mit Antworten
- Test-Harness-Session → Sektion 8 Schritt 1 streichen, neue Sektion „Tests" einbauen
- Strukturelle Code-Änderungen, die Invarianten betreffen → Update Sektion 3
- Neue Defense-Mechanismen → Sektion 4 erweitern
- Begriffsverschiebungen → ALARM. Erst Glossar updaten, dann Code.

**Pflege-Regel:** vor jedem strukturellen Refactor (= Code-Änderung, die mehr als nur Bugfix ist) wird zuerst dieses Dokument aktualisiert. So bleibt die Dokumentation nicht nachlauf, sondern führt.
