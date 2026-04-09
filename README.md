# Zeiterfassung V1.0 – Web & Mobile App

Moderne Zeiterfassungs-App mit React, Supabase und E2E-Verschlüsselung. Erste öffentliche Version.

## Features

- **Parallele Timer**: Bis zu 8 gleichzeitige Task-Slots mit Start/Pause/Stopp
- **5 Dimensionen pro Eintrag**: Stakeholder (Multi-Select), Projekt, Tätigkeit, Format, Notiz
- **Quick-Start Shortcuts**: Auto Top-5 + manuell angepinnte Kombinationen (max. 10)
- **Manueller Eintrag**: Datum, Von/Bis, Stakeholder(s)/Projekt/Tätigkeit/Format, Notiz
- **Einträge-Ansicht**: Filterbarer, sortierbarer Table mit Modal-Edit
- **Dashboard**: KPIs, Stakeholder×Projekt-Heatmap, Tätigkeits-Balken, Format-Balken, Zeitverlauf
- **Stammdaten-Verwaltung**: CRUD für Stakeholder, Projekte, Tätigkeiten, Formate
- **Team-Dashboard**: Tagesübersicht, Stakeholder×Person, Projekt×Person, Auslastung, Timeline
- **Team-Sync**: Über Supabase Realtime mit E2E-Verschlüsselung
- **E2E-Verschlüsselung**: AES-GCM, immer aktiv — alle Text-Felder werden clientseitig verschlüsselt
- **Backup & Restore**: HTML-Vollbackup, CSV-Export/Import mit Duplikaterkennung
- **i18n**: Deutsch/Französisch (314+ Schlüssel)
- **Themes**: Cyber (Dark) + Light Theme
- **Offline-Support**: Service Worker, localStorage-Fallback
- **PWA**: Installierbar auf Desktop und Mobile

## Tech Stack

| Schicht | Technologie |
|---------|------------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + CSS Custom Properties |
| State | Zustand (persistiert in localStorage) |
| Backend | Supabase (PostgreSQL + Auth + Realtime) |
| Encryption | AES-GCM (Web Crypto API) |
| Icons | Lucide React |
| Dates | date-fns |
| CI/CD | GitHub Actions → GitHub Pages |

## Schnellstart

### 1. Repository klonen

```bash
git clone https://github.com/vob0x/Zeiterfassung.git
cd zeiterfassung-app
```

### 2. Dependencies installieren

```bash
npm install
```

### 3. Supabase-Projekt einrichten

1. Neues Projekt auf [supabase.com](https://supabase.com) erstellen
2. **SQL Editor** öffnen und die Migrations in `supabase/migrations/` der Reihe nach ausführen
3. Unter **Settings → API** die Projekt-URL und den anon-Key kopieren

### 4. Umgebungsvariablen konfigurieren

```bash
cp .env.example .env
```

Dann `.env` bearbeiten:
```
VITE_SUPABASE_URL=https://dein-projekt.supabase.co
VITE_SUPABASE_ANON_KEY=dein-anon-key
```

### 5. Entwicklungsserver starten

```bash
npm run dev
```

Die App läuft auf `http://localhost:5173`

## Supabase-Datenbank

Die Migrations in `supabase/migrations/` erstellen:

| Tabelle | Beschreibung |
|---------|-------------|
| `profiles` | Pseudonyme Benutzerprofile (nur Codename, verschlüsselt) |
| `teams` | Teams mit 6-stelligem Invite-Code + verschlüsseltem Team Key |
| `team_members` | Team-Mitgliedschaften + verschlüsselter Team Key pro Mitglied |
| `stakeholders` | Stakeholder pro User (verschlüsselt, mit sort_order) |
| `projects` | Projekte pro User (verschlüsselt) |
| `activities` | Tätigkeiten pro User (verschlüsselt) |
| `formats` | Formate pro User (verschlüsselt) |
| `time_entries` | Zeiteinträge (verschlüsselte Text-Felder, Zeiten im Klartext) |
| `user_settings` | Theme, Sprache, Pinned Shortcuts |

Alle Tabellen sind mit Row Level Security (RLS) geschützt. Team-Mitglieder können gegenseitig Einträge lesen (nicht ändern).

## GitHub Pages Deployment

1. Repository-Settings → Pages → Source: "GitHub Actions"
2. Repository-Settings → Secrets → folgende Secrets anlegen:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Push auf `main` → automatischer Deploy

## Projektstruktur

```
zeiterfassung-app/
├── .github/workflows/     # CI/CD Pipelines
├── public/                # Static assets, PWA manifest
├── supabase/migrations/   # PostgreSQL Schema (4 Migrations)
├── src/
│   ├── components/
│   │   ├── Auth/          # Login/Register/Unlock
│   │   ├── Timer/         # Timer, TaskSlot, ManualEntry, FuzzySearch, DayRing
│   │   ├── Entries/       # EntriesView, EntryRow, EditEntryModal
│   │   ├── Dashboard/     # KpiCards, ActivityBars, Heatmap, TimelineChart
│   │   ├── Manage/        # ManageView, DuplicateReview
│   │   ├── Team/          # TeamView, TeamDaily, TeamMatrix, TeamWorkload, TeamTimeline
│   │   ├── Settings/      # SettingsView
│   │   └── UI/            # Modal, Toast, ConfirmDialog, NoteInput
│   ├── stores/            # Zustand Stores (auth, timer, entries, master, team, ui)
│   ├── i18n/              # DE/FR Übersetzungen (314+ Keys)
│   ├── lib/               # crypto, utils, backup, supabase
│   └── styles/            # Global CSS + Tailwind
├── docs/                  # Quick-Start Guide + User Manual (DE/FR)
├── package.json
├── vite.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

## Datenschutz & Sicherheit

- **Keine Klarnamen**: Anmeldung nur mit Codename + Passwort
- **Keine E-Mails**: Intern wird `codename@zeiterfassung.local` als Supabase-E-Mail genutzt
- **E2E-Verschlüsselung**: Alle Text-Felder (Stakeholder, Projekt, Tätigkeit, Format, Notiz) werden clientseitig mit AES-GCM verschlüsselt
- **Team Key**: Wird beim Team-Erstellen generiert und verschlüsselt transportiert
- **Personal Key**: Wird aus dem Passwort abgeleitet (PBKDF2)
- **RLS**: Jeder User sieht nur seine eigenen Daten
- **Team-Zugang**: Nur über 6-stelligen Invite-Code (kein E-Mail-Versand)

## Befehle

```bash
npm run dev       # Entwicklungsserver
npm run build     # Production-Build
npm run preview   # Production-Preview
```
