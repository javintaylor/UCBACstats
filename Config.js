/**
 * UCBAC Stats — Config.gs
 * Central configuration. Nothing else hardcodes an ID or a magic string.
 */

const CONFIG = {

  // The UCBAC_database spreadsheet (owned by contact@example.invalid)
  DB_ID: 'CONFIGURE_PRIVATE_RESOURCE_ID',

  CURRENT_SEASON: 'SEA-2026',

  /**
   * The public Google Site this application hangs off.
   *
   * The Site is the front door at UCBACstats.com; this deployment is the
   * statistics application behind it. The Site's navigation links IN here with
   * ?p=<page> (see webAppRoute in WebApp.gs), and the app links back OUT to
   * this address. Set it to '' to hide every link home and run standalone.
   */
  SITE_URL: 'https://www.ucbacstats.com',

  TABS: {
    SEASONS:      'Seasons',
    TEAMS:        'Teams',
    MEDIA:        'Media',
    GAMES:        'Games',
    PLAYERS:      'Players',
    PLAYER_SEASONS:'PlayerSeasons',
    PLAYER_STATS: 'PlayerGameStats',
    TEAM_STATS:   'TeamGameStats',
    TEAM_SEASONS: 'TeamSeasons',
    EXCEPTIONS:   'Exceptions',
    // created on demand by ensureOpsTabs()
    AUDIT:        'AuditLog',
    SUBMISSIONS:  'StatSubmissions',
    CORRECTIONS:  'StatCorrections'
  },

  // Grain values. SEASON_REF is a reconciliation reference and is NEVER summed.
  GRAIN: { GAME: 'GAME', SEASON_TOTAL: 'SEASON_TOTAL', SEASON_REF: 'SEASON_REF' },

  CACHE_TTL_SECONDS: 600,
  LOCK_TIMEOUT_MS: 30000,

  // Statistics that are DERIVED on read and must never be stored (Doc 3 §7.1)
  DERIVED_FIELDS: [
    'CompPct', 'YPA', 'YPC', 'RecAvg', 'FGPct', 'XPPct', 'PuntAvg', 'TacklesTotal',
    // one-number ratings and rollups — computed on read, never entered
    'QBRating', 'NFLRating', 'AYA', 'TDPct', 'IntPct',
    'ScrimYds', 'Touches', 'YdsPerTouch', 'AllPurpose',
    'Havoc', 'HavocPG', 'TOForced', 'TOGiven', 'TOMargin',
    'KickPoints', 'KRAvg', 'PRAvg'
  ],

  ROLES: { ADMIN: 'ADMIN', COACH: 'COACH', PLAYER: 'PLAYER', PUBLIC: 'PUBLIC' },

  SEVERITY: { ERROR: 'ERROR', WARNING: 'WARNING', INFO: 'INFO' }
};

/** Open the database spreadsheet (cached per execution). */
var __ss = null;
function db_() {
  if (!__ss) __ss = SpreadsheetApp.openById(CONFIG.DB_ID);
  return __ss;
}