/**
 * Zeiterfassung App - Type Definitions
 */

// ============================================================================
// Authentication & Profiles
// ============================================================================

export interface Profile {
  id: string;
  codename: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Teams & Collaboration
// ============================================================================

export interface Team {
  id: string;
  name: string;
  creator_id: string;
  invite_code: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  display_name?: string;
  joined_at: string;
}

/**
 * Persistent role row (analog Dienstplan's dp_roles).
 * Two-tier model: 'admin' has full access, 'mitarbeiter' is restricted.
 * Stored in `ze_roles` (migration 20260427000000_persistent_roles.sql).
 */
export type ZeRoleName = 'admin' | 'mitarbeiter';

export interface ZeRole {
  id: string;
  team_id: string;
  user_id: string;
  role: ZeRoleName;
  created_at: string;
  updated_at: string;
}

export interface TeamWithMembers extends Team {
  members: TeamMember[];
}

// ============================================================================
// Master Data (Stakeholders, Projects, Activities)
// ============================================================================

export interface Stakeholder {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Activity {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Time Entries
// ============================================================================

export interface TimeEntry {
  id: string;
  user_id: string;
  date: string; // YYYY-MM-DD format
  stakeholder: string | string[]; // Backward compat: accept both
  projekt: string;
  taetigkeit: string;
  format?: string; // NEW: format dimension (default 'Einzelarbeit')
  start_time: string; // HH:MM format
  end_time: string; // HH:MM format
  duration_ms: number;
  notiz?: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Soft-delete tombstone. NULL/undefined = active entry.
   * Set by delete() to propagate deletions across devices: instead of
   * removing the row, we mark it as deleted so other devices can learn
   * about the deletion on their next pull. The client filters
   * non-null deleted_at out of the displayed entries[].
   */
  deleted_at?: string | null;
}

export interface TimeEntryInput {
  date: string;
  stakeholder: string | string[];
  projekt: string;
  taetigkeit: string;
  format?: string; // NEW: format dimension
  start_time: string;
  end_time: string;
  duration_ms: number;
  notiz?: string;
}

export interface TimeEntryWithProfile extends TimeEntry {
  profile: Profile;
}

// ============================================================================
// User Settings
// ============================================================================

export interface UserSettings {
  id: string;
  user_id: string;
  theme: 'cyber' | 'light';
  language: 'de' | 'fr';
  pinned_shortcuts: string[]; // Array of shortcut IDs or names
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Running Timer State
// ============================================================================

export interface TimerSlot {
  id: string;
  date: string; // YYYY-MM-DD format
  stakeholder: string[]; // Array of stakeholders (multi-select)
  projekt: string;
  taetigkeit: string;
  format: string; // Format dimension (default 'Einzelarbeit')
  start_time: string; // HH:MM format
  elapsed_ms: number;
  notiz?: string;
  is_running: boolean;
  color: string; // Assigned palette color for visual distinction
  // Timer runtime fields
  startTime: Date;
  pausedMs: number;
  isPaused: boolean;
}

// ============================================================================
// API Responses
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  count: number;
  total: number;
  page: number;
  page_size: number;
}

// ============================================================================
// Enums
// ============================================================================

export enum AuthStatus {
  UNAUTHENTICATED = 'unauthenticated',
  AUTHENTICATING = 'authenticating',
  AUTHENTICATED = 'authenticated',
  ERROR = 'error',
}

export enum ViewMode {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export enum SortDirection {
  ASC = 'asc',
  DESC = 'desc',
}

// ============================================================================
// App State
// ============================================================================

export interface AppState {
  // Auth
  authStatus: AuthStatus;
  user_id: string | null;
  codename: string | null;

  // Teams
  current_team_id: string | null;
  teams: Team[];
  team_members: Map<string, TeamMember[]>;

  // Master Data
  stakeholders: Stakeholder[];
  projects: Project[];
  activities: Activity[];

  // Time Entries
  time_entries: TimeEntry[];

  // Settings
  settings: UserSettings | null;

  // UI State
  view_mode: ViewMode;
  selected_date: string; // YYYY-MM-DD
  timer_slot: TimerSlot | null;
  is_loading: boolean;
  error: string | null;
}

// ============================================================================
// Form Data
// ============================================================================

export interface SignUpFormData {
  codename: string;
  password: string;
  password_confirm: string;
}

export interface SignInFormData {
  codename: string;
  password: string;
}

export interface CreateTeamFormData {
  name: string;
}

export interface JoinTeamFormData {
  invite_code: string;
}

export interface TimeEntryFormData {
  date: string;
  stakeholder: string | string[];
  projekt: string;
  taetigkeit: string;
  format: string; // NEW: format dimension
  start_time: string;
  end_time: string;
  notiz?: string;
}

// ============================================================================
// Database Response Types
// ============================================================================

export interface DatabaseProfiles {
  id: string;
  codename: string;
  created_at: string;
  updated_at: string;
}

export interface DatabaseTeams {
  id: string;
  name: string;
  creator_id: string;
  invite_code: string;
  created_at: string;
  updated_at: string;
}

export interface DatabaseTeamMembers {
  id: string;
  team_id: string;
  user_id: string;
  joined_at: string;
}

export interface DatabaseStakeholders {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DatabaseProjects {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DatabaseActivities {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DatabaseTimeEntries {
  id: string;
  user_id: string;
  date: string;
  stakeholder: string;
  projekt: string;
  taetigkeit: string;
  format: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  notiz: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatabaseUserSettings {
  id: string;
  user_id: string;
  theme: 'cyber' | 'light';
  language: 'de' | 'fr';
  pinned_shortcuts: string[];
  created_at: string;
  updated_at: string;
}

// ============================================================================
// UI & App Configuration Types
// ============================================================================

export type Language = 'de' | 'fr';
export type Theme = 'cyber' | 'light';
export type ViewType = 'timer' | 'entries' | 'dashboard' | 'manage' | 'team';
export type PeriodType = 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';

// ============================================================================
// Session & Auth
// ============================================================================

export interface Session {
  user: Profile;
  access_token: string;
  refresh_token: string;
}

// ============================================================================
// Utility Types
// ============================================================================

export type MasterDataType = 'stakeholder' | 'project' | 'activity';

export interface MasterDataItem {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TimeRange {
  start: string; // HH:MM
  end: string; // HH:MM
}

export interface DayTimeEntries {
  date: string;
  entries: TimeEntry[];
  total_duration_ms: number;
}

export interface WeekTimeEntries {
  week_start: string; // YYYY-MM-DD (Monday)
  days: DayTimeEntries[];
  total_duration_ms: number;
}

export interface MonthTimeEntries {
  month: string; // YYYY-MM
  weeks: WeekTimeEntries[];
  total_duration_ms: number;
}

// ============================================================================
// UI Components
// ============================================================================

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  duration?: number;
}

export interface FilterState {
  from: string;
  to: string;
  stakeholder: string;
  project: string;
  activity: string;
  format: string; // NEW: format filter
  notiz: string;
}

// ============================================================================
// Error Types
// ============================================================================

export interface AppError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export enum ErrorCode {
  AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS',
  AUTH_CODENAME_TAKEN = 'AUTH_CODENAME_TAKEN',
  AUTH_SESSION_EXPIRED = 'AUTH_SESSION_EXPIRED',
  TEAM_NOT_FOUND = 'TEAM_NOT_FOUND',
  TEAM_INVALID_CODE = 'TEAM_INVALID_CODE',
  TIME_ENTRY_INVALID = 'TIME_ENTRY_INVALID',
  TIME_ENTRY_NOT_FOUND = 'TIME_ENTRY_NOT_FOUND',
  DATABASE_ERROR = 'DATABASE_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}
