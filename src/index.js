'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

loadLocalEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const CINEMETA_BASE_URL = (process.env.CINEMETA_BASE_URL || 'https://v3-cinemeta.strem.io').replace(/\/$/, '');
const KINOPOISK_API_KEY = (process.env.KINOPOISK_API_KEY || process.env.KINOPOISK_UNOFFICIAL_API_KEY || '').trim();
const CACHE_TTL_MINUTES = Math.max(Number(process.env.CACHE_TTL_MINUTES || 720), 1);
const FETCH_TIMEOUT_MS = Math.max(Number(process.env.FETCH_TIMEOUT_MS || 10000), 1000);
const MAX_ENRICH_CONCURRENCY = Math.max(Number(process.env.MAX_ENRICH_CONCURRENCY || 2), 1);
const MAX_ENRICH_ITEMS = Math.max(Number(process.env.MAX_ENRICH_ITEMS || 12), 0);
const SEARCH_FALLBACK_ENABLED = String(process.env.SEARCH_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
const MAX_SEARCH_FALLBACK_ITEMS = Math.max(Number(process.env.MAX_SEARCH_FALLBACK_ITEMS || 3), 0);
const RATE_LIMIT_COOLDOWN_SECONDS = Math.max(Number(process.env.RATE_LIMIT_COOLDOWN_SECONDS || 300), 30);
const KINOPOISK_MIN_INTERVAL_MS = Math.max(Number(process.env.KINOPOISK_MIN_INTERVAL_MS || 250), 50);
const POSTER_OVERLAY_ENABLED = String(process.env.POSTER_OVERLAY_ENABLED || 'false').toLowerCase() === 'true';
const TITLE_RATING_ENABLED = String(process.env.TITLE_RATING_ENABLED || 'true').toLowerCase() !== 'false';
const STREAM_FETCH_CINEMETA_META = String(process.env.STREAM_FETCH_CINEMETA_META || 'false').toLowerCase() === 'true';
const DEFAULT_STREAM_NAME = process.env.DEFAULT_STREAM_NAME || 'Kinopoisk рейтинг';
const DEFAULT_RATING_FORMAT = process.env.DEFAULT_RATING_FORMAT || 'withMax';
const DEFAULT_VOTES_FORMAT = process.env.DEFAULT_VOTES_FORMAT || 'commas';
const DEFAULT_DISPLAY_FORMAT = process.env.DEFAULT_DISPLAY_FORMAT || 'multiLine';
const DEFAULT_SHOW_VOTES = String(process.env.DEFAULT_SHOW_VOTES || 'true').toLowerCase() !== 'false';
const DEFAULT_SHOW_MOVIES = String(process.env.DEFAULT_SHOW_MOVIES || 'true').toLowerCase() !== 'false';
const DEFAULT_SHOW_SERIES = String(process.env.DEFAULT_SHOW_SERIES || 'true').toLowerCase() !== 'false';

function loadLocalEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  let fileContent = '';

  try {
    fileContent = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  const lines = fileContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, '\n');
  }
}

const MANIFEST_ID = process.env.ADDON_ID || 'org.ennanoff.kinopoisk.rating';
const MANIFEST_VERSION = process.env.ADDON_VERSION || '1.1.0';
const MANIFEST_NAME = process.env.ADDON_NAME || 'Kinopoisk рейтинг';

const configuredPublicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
let runtimePublicUrl = configuredPublicUrl || `http://localhost:${PORT}`;
let hasLoggedMissingToken = false;
const kinopoiskApiState = new Map();

const ratingCache = new Map();

const catalogExtra = [
  { name: 'search', isRequired: false },
  { name: 'genre', isRequired: false },
  { name: 'skip', isRequired: false },
];

const manifest = {
  id: MANIFEST_ID,
  version: MANIFEST_VERSION,
  name: MANIFEST_NAME,
  description: 'Показывает рейтинг Кинопоиска на странице фильма или сериала.',
  logo: 'https://www.kinopoisk.ru/favicon.ico',
  background: 'https://st.kp.yandex.net/images/logo/inverseLogo2018.svg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'top',
      name: 'Top Movies (KinoPoisk)',
      extra: catalogExtra,
    },
    {
      type: 'series',
      id: 'top',
      name: 'Top Series (KinoPoisk)',
      extra: catalogExtra,
    },
  ],
  idPrefixes: ['tt'],
  behaviorHints: {
    configurable: true,
  },
  config: [
    {
      key: 'apiKey',
      type: 'text',
      title: 'KinoPoisk API key (optional)',
    },
    {
      key: 'streamName',
      type: 'text',
      title: 'Stream name',
    },
    {
      key: 'displayFormat',
      type: 'select',
      title: 'Display format',
      options: ['multiLine', 'singleLine'],
    },
    {
      key: 'ratingFormat',
      type: 'select',
      title: 'Rating format',
      options: ['withMax', 'plain'],
    },
    {
      key: 'showVotes',
      type: 'checkbox',
      title: 'Show votes',
    },
    {
      key: 'votesFormat',
      type: 'select',
      title: 'Votes format',
      options: ['commas', 'compact'],
    },
    {
      key: 'showMovies',
      type: 'checkbox',
      title: 'Show ratings for movies',
    },
    {
      key: 'showSeries',
      type: 'checkbox',
      title: 'Show ratings for series',
    },
  ],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const catalogUrl = buildCinemetaCatalogUrl(type, id, extra);
  let payload;

  try {
    payload = await fetchJson(catalogUrl);
  } catch (error) {
    console.error(`[catalog] failed to fetch ${catalogUrl}:`, error.message);
    return { metas: [] };
  }

  const metas = Array.isArray(payload.metas) ? payload.metas : [];

  return {
    metas,
    cacheMaxAge: 60,
    staleRevalidate: 300,
    staleError: 86400,
  };
});

builder.defineMetaHandler(async ({ type, id, config }) => {
  const metaUrl = `${CINEMETA_BASE_URL}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  let sourceMeta = { id, type };
  const displayOptions = buildDisplayOptions(config);
  const apiKey = getConfigApiKey(config);

  try {
    const payload = await fetchJson(metaUrl);
    if (payload && payload.meta && typeof payload.meta === 'object') {
      sourceMeta = payload.meta;
    }
  } catch (error) {
    console.warn(`[meta] failed to fetch upstream meta ${metaUrl}:`, error.message);
  }

  const ratingPayload = await resolveKinopoiskRating(sourceMeta, {
    allowSearchFallback: SEARCH_FALLBACK_ENABLED,
    apiKey,
  });

  return {
    meta: {
      id,
      type,
      name: displayOptions.streamName,
      description: `${displayOptions.streamName}\n${buildKinopoiskStreamDescription(ratingPayload, displayOptions)}`,
    },
    cacheMaxAge: 120,
    staleRevalidate: 600,
    staleError: 86400,
  };
});

builder.defineStreamHandler(async ({ type, id, config }) => {
  const displayOptions = buildDisplayOptions(config);
  const apiKey = getConfigApiKey(config);

  if (type === 'movie' && !displayOptions.showMovies) {
    return {
      streams: [],
      cacheMaxAge: 120,
      staleRevalidate: 600,
      staleError: 86400,
    };
  }

  if (type === 'series' && !displayOptions.showSeries) {
    return {
      streams: [],
      cacheMaxAge: 120,
      staleRevalidate: 600,
      staleError: 86400,
    };
  }

  const sourceMeta = {
    id: String(id),
    type,
  };

  if (STREAM_FETCH_CINEMETA_META) {
    const meta = await fetchCinemetaMetaForStream(type, id);
    mergeStreamSourceMeta(sourceMeta, meta);
  }

  let ratingPayload = null;
  try {
    ratingPayload = await resolveKinopoiskRating(sourceMeta, {
      allowSearchFallback: SEARCH_FALLBACK_ENABLED,
      apiKey,
    });
  } catch (error) {
    console.error(`[stream] rating lookup failed for ${id}:`, error.message);
  }

  // If IMDb-based lookup missed and we are in fast mode, fetch Cinemeta title once and retry.
  if (!ratingPayload && !STREAM_FETCH_CINEMETA_META && SEARCH_FALLBACK_ENABLED) {
    const meta = await fetchCinemetaMetaForStream(type, id);
    mergeStreamSourceMeta(sourceMeta, meta);

    try {
      ratingPayload = await resolveKinopoiskRating(sourceMeta, {
        allowSearchFallback: true,
        apiKey,
      });
    } catch (error) {
      console.error(`[stream] fallback lookup failed for ${id}:`, error.message);
    }
  }

  const imdbId = extractImdbId(sourceMeta) || extractImdbId({ id: String(id) });
  const externalUrl = buildKinopoiskExternalUrl(ratingPayload, sourceMeta, imdbId);

  return {
    streams: [
      {
        name: displayOptions.streamName,
        description: buildKinopoiskStreamDescription(ratingPayload, displayOptions),
        externalUrl,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `kinopoisk-rating-${id}`,
        },
      },
    ],
    cacheMaxAge: 120,
    staleRevalidate: 600,
    staleError: 86400,
  };
});

function buildCinemetaCatalogUrl(type, id, extra) {
  const base = `${CINEMETA_BASE_URL}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
  const extraPath = buildExtraPath(extra);
  return `${base}${extraPath}.json`;
}

function buildExtraPath(extra) {
  if (!extra || typeof extra !== 'object') {
    return '';
  }

  const segments = Object.entries(extra)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);

  if (segments.length === 0) {
    return '';
  }

  return `/${segments.join('/')}`;
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function parseEnum(value, allowedValues, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function parseNonEmptyString(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function getConfigApiKey(config) {
  if (!config || typeof config !== 'object') {
    return null;
  }

  if (typeof config.apiKey !== 'string') {
    return null;
  }

  const trimmed = config.apiKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildDisplayOptions(config) {
  const source = config && typeof config === 'object' ? config : {};

  return {
    streamName: parseNonEmptyString(source.streamName, DEFAULT_STREAM_NAME),
    ratingFormat: parseEnum(source.ratingFormat, ['withMax', 'plain'], DEFAULT_RATING_FORMAT),
    showVotes: parseBoolean(source.showVotes, DEFAULT_SHOW_VOTES),
    votesFormat: parseEnum(source.votesFormat, ['commas', 'compact'], DEFAULT_VOTES_FORMAT),
    displayFormat: parseEnum(source.displayFormat, ['multiLine', 'singleLine'], DEFAULT_DISPLAY_FORMAT),
    showMovies: parseBoolean(source.showMovies, DEFAULT_SHOW_MOVIES),
    showSeries: parseBoolean(source.showSeries, DEFAULT_SHOW_SERIES),
  };
}

function buildDefaultConfigureConfig() {
  return {
    streamName: DEFAULT_STREAM_NAME,
    ratingFormat: DEFAULT_RATING_FORMAT,
    showVotes: DEFAULT_SHOW_VOTES,
    votesFormat: DEFAULT_VOTES_FORMAT,
    displayFormat: DEFAULT_DISPLAY_FORMAT,
    showMovies: DEFAULT_SHOW_MOVIES,
    showSeries: DEFAULT_SHOW_SERIES,
  };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'kinopoisk-stremio-addon/1.0',
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.url = url;
      const retryAfterHeader = response.headers.get('retry-after');
      if (retryAfterHeader) {
        const asNumber = Number(retryAfterHeader);
        if (Number.isFinite(asNumber) && asNumber > 0) {
          error.retryAfterSeconds = asNumber;
        } else {
          const asDateMs = Date.parse(retryAfterHeader);
          if (Number.isFinite(asDateMs)) {
            const computedSeconds = Math.ceil((asDateMs - Date.now()) / 1000);
            if (computedSeconds > 0) {
              error.retryAfterSeconds = computedSeconds;
            }
          }
        }
      }
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function isHttpStatus(error, statuses) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const status = Number(error.status);
  return Number.isFinite(status) && statuses.includes(status);
}

function resolveApiKey(apiKeyOverride) {
  if (typeof apiKeyOverride === 'string' && apiKeyOverride.trim().length > 0) {
    return apiKeyOverride.trim();
  }

  return KINOPOISK_API_KEY;
}

function getApiScope(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) {
    return 'env:none';
  }

  return `key:${Buffer.from(key).toString('base64url').slice(0, 10)}`;
}

function getKinopoiskApiState(apiKey) {
  const scope = getApiScope(apiKey);
  let state = kinopoiskApiState.get(scope);

  if (!state) {
    state = {
      scope,
      rateLimitedUntil: 0,
      hasLoggedRateLimit: false,
      quotaExceeded: false,
      hasLoggedQuotaExceeded: false,
      nextRequestAt: 0,
      rateGate: Promise.resolve(),
    };
    kinopoiskApiState.set(scope, state);
  }

  return state;
}

function isKinopoiskRateLimited(apiKey) {
  const state = getKinopoiskApiState(apiKey);
  if (Date.now() < state.rateLimitedUntil) {
    return true;
  }

  if (state.rateLimitedUntil !== 0) {
    state.rateLimitedUntil = 0;
    state.hasLoggedRateLimit = false;
  }

  return false;
}

function markKinopoiskRateLimited(error, apiKey) {
  const state = getKinopoiskApiState(apiKey);
  const retryAfterSeconds =
    error && Number.isFinite(Number(error.retryAfterSeconds)) && Number(error.retryAfterSeconds) > 0
      ? Number(error.retryAfterSeconds)
      : RATE_LIMIT_COOLDOWN_SECONDS;

  const cooldownUntil = Date.now() + retryAfterSeconds * 1000;
  if (cooldownUntil > state.rateLimitedUntil) {
    state.rateLimitedUntil = cooldownUntil;
  }

  if (!state.hasLoggedRateLimit) {
    const untilDate = new Date(state.rateLimitedUntil).toISOString();
    console.warn(`[kp unofficial ${state.scope}] HTTP 429 received. Cooling down requests until ${untilDate}`);
    state.hasLoggedRateLimit = true;
  }
}

function markKinopoiskQuotaExceeded(apiKey) {
  const state = getKinopoiskApiState(apiKey);
  state.quotaExceeded = true;

  if (!state.hasLoggedQuotaExceeded) {
    console.warn(`[kp unofficial ${state.scope}] HTTP 402 received. API quota is exhausted; rating enrichment is paused.`);
    state.hasLoggedQuotaExceeded = true;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithKinopoiskRateGate(task, apiKey) {
  const state = getKinopoiskApiState(apiKey);
  const run = async () => {
    const waitMs = Math.max(0, state.nextRequestAt - Date.now());
    if (waitMs > 0) {
      await delay(waitMs);
    }

    state.nextRequestAt = Date.now() + KINOPOISK_MIN_INTERVAL_MS;
    return task();
  };

  const queued = state.rateGate.then(run, run);
  state.rateGate = queued.catch(() => undefined);
  return queued;
}

function mapStremioTypeToKinopoiskType(stremioType) {
  if (stremioType === 'movie') {
    return 'FILM';
  }

  if (stremioType === 'series') {
    return 'TV_SERIES';
  }

  return 'ALL';
}

function extractImdbId(meta) {
  const candidates = [
    meta && meta.id,
    meta && meta.imdb_id,
    meta && meta.imdbId,
    meta && meta.imdb,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const match = candidate.match(/tt\d+/i);
    if (match) {
      return match[0].toLowerCase();
    }
  }

  return null;
}

function extractTitle(meta) {
  if (!meta || typeof meta !== 'object') {
    return null;
  }

  const candidates = [meta.name, meta.originalName, meta.title];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function extractYear(meta) {
  if (!meta || typeof meta !== 'object') {
    return null;
  }

  const yearCandidate = meta.year || meta.releaseInfo || meta.released;
  if (!yearCandidate) {
    return null;
  }

  const match = String(yearCandidate).match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function mergeStreamSourceMeta(sourceMeta, meta) {
  if (!sourceMeta || typeof sourceMeta !== 'object' || !meta || typeof meta !== 'object') {
    return;
  }

  if (typeof meta.id === 'string' && meta.id.length > 0) {
    sourceMeta.id = meta.id;
  }

  if (typeof meta.name === 'string' && meta.name.trim().length > 0) {
    sourceMeta.name = meta.name.trim();
  }

  if (typeof meta.originalName === 'string' && meta.originalName.trim().length > 0) {
    sourceMeta.originalName = meta.originalName.trim();
  }

  if (typeof meta.title === 'string' && meta.title.trim().length > 0) {
    sourceMeta.title = meta.title.trim();
  }

  if (typeof meta.releaseInfo === 'string' && meta.releaseInfo.trim().length > 0) {
    sourceMeta.releaseInfo = meta.releaseInfo.trim();
  }

  if (typeof meta.released === 'string' && meta.released.trim().length > 0) {
    sourceMeta.released = meta.released.trim();
  }

  if (typeof meta.year === 'number' || typeof meta.year === 'string') {
    sourceMeta.year = meta.year;
  }
}

function readCache(key) {
  const item = ratingCache.get(key);
  if (!item) {
    return undefined;
  }

  if (item.expiresAt <= Date.now()) {
    ratingCache.delete(key);
    return undefined;
  }

  return item.value;
}

function writeCache(key, value) {
  ratingCache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MINUTES * 60 * 1000,
  });
}

function firstNumber(values) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }

    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && numberValue > 0) {
      return numberValue;
    }
  }

  return null;
}

function extractRatingPayload(movie) {
  if (!movie || typeof movie !== 'object') {
    return null;
  }

  const kpId = extractKinopoiskId(movie);
  const rating = firstNumber([
    movie.rating && movie.rating.kp,
    movie.rating && movie.rating.kinoPoisk,
    movie.rating && movie.rating.kinopoisk,
    movie.ratingKinopoisk,
    movie.ratingAwait,
    movie.ratingKp,
    movie.kpRating,
    typeof movie.rating === 'string' ? movie.rating.replace(/%/g, '') : null,
  ]);

  if (!rating) {
    return null;
  }

  const votes = firstNumber([
    movie.votes && movie.votes.kp,
    movie.votes && movie.votes.kinoPoisk,
    movie.votes && movie.votes.kinopoisk,
    movie.ratingKinopoiskVoteCount,
    movie.kpRatingVoteCount,
  ]);

  return {
    rating,
    votes,
    kpId,
  };
}

function extractKinopoiskId(movie) {
  if (!movie || typeof movie !== 'object') {
    return null;
  }

  return firstNumber([
    movie.kinopoiskId,
    movie.filmId,
    movie.id,
  ]);
}

function getKinopoiskApiHeaders(apiKey) {
  return {
    'X-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };
}

async function fetchKinopoiskJson(pathWithQuery, apiKey) {
  const url = `https://kinopoiskapiunofficial.tech${pathWithQuery}`;
  return runWithKinopoiskRateGate(
    () =>
      fetchJson(url, {
        headers: getKinopoiskApiHeaders(apiKey),
      }),
    apiKey
  );
}

function normalizeText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCandidateNames(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return [];
  }

  return [
    candidate.nameRu,
    candidate.nameEn,
    candidate.originalName,
    candidate.nameOriginal,
    candidate.alternativeName,
    candidate.title,
  ]
    .map((name) => normalizeText(name))
    .filter(Boolean);
}

function scoreSearchCandidate(candidate, title, year) {
  if (!candidate || typeof candidate !== 'object') {
    return -1;
  }

  const targetTitle = normalizeText(title);
  const candidateYear = firstNumber([candidate.year, candidate.startYear]);
  const candidateNames = extractCandidateNames(candidate);

  let score = 0;

  if (year && candidateYear === year) {
    score += 5;
  } else if (year && candidateYear && Math.abs(candidateYear - year) <= 1) {
    score += 2;
  } else if (year && candidateYear && Math.abs(candidateYear - year) > 1) {
    score -= 5;
  } else if (year && !candidateYear) {
    score -= 1;
  }

  if (targetTitle && candidateNames.includes(targetTitle)) {
    score += 4;
  } else if (
    targetTitle &&
    candidateNames.some((name) => name.includes(targetTitle) || targetTitle.includes(name))
  ) {
    score += 2;
  }

  return score;
}

function needsCandidateHydration(bestCandidate, context) {
  if (!bestCandidate || !context || typeof context !== 'object') {
    return false;
  }

  const { title, year, imdbId } = context;
  const normalizedImdb = typeof imdbId === 'string' ? imdbId.toLowerCase() : null;
  const candidateImdb = typeof bestCandidate.imdbId === 'string' ? bestCandidate.imdbId.toLowerCase() : null;

  if (normalizedImdb && candidateImdb && normalizedImdb === candidateImdb) {
    return false;
  }

  const bestScore = scoreSearchCandidate(bestCandidate, title, year);
  if (bestScore <= 0) {
    return true;
  }

  if (year && !firstNumber([bestCandidate.year, bestCandidate.startYear])) {
    return true;
  }

  if (title && extractCandidateNames(bestCandidate).length === 0) {
    return true;
  }

  return false;
}

function buildHydrationCandidates(items, limit, title, year) {
  if (!Array.isArray(items) || items.length === 0 || limit <= 0) {
    return [];
  }

  const ranked = items
    .map((item, index) => ({
      item,
      index,
      score: scoreSearchCandidate(item, title, year),
      kpId: extractKinopoiskId(item),
    }))
    .filter((entry) => entry.kpId);

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = [];
  const usedKpIds = new Set();

  for (const entry of ranked) {
    if (usedKpIds.has(entry.kpId)) {
      continue;
    }

    usedKpIds.add(entry.kpId);
    selected.push(entry);

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

async function pickBestFilmCandidateWithHydration(items, context, apiKey) {
  const best = pickBestFilmCandidate(items, context);
  if (!best || !needsCandidateHydration(best, context) || MAX_SEARCH_FALLBACK_ITEMS <= 0) {
    return best;
  }

  const { title, year } = context || {};
  const hydrationTargets = buildHydrationCandidates(items, MAX_SEARCH_FALLBACK_ITEMS, title, year);
  if (hydrationTargets.length === 0) {
    return best;
  }

  const hydratedItems = [...items];
  for (const target of hydrationTargets) {
    try {
      const details = await fetchKinopoiskJson(`/api/v2.2/films/${encodeURIComponent(String(target.kpId))}`, apiKey);
      if (details && typeof details === 'object') {
        hydratedItems[target.index] = { ...target.item, ...details };
      }
    } catch (error) {
      if (isHttpStatus(error, [400, 404])) {
        continue;
      }

      throw error;
    }
  }

  return pickBestFilmCandidate(hydratedItems, context) || best;
}

function pickBestFilmCandidate(items, { title, year, imdbId }) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const normalizedImdb = typeof imdbId === 'string' ? imdbId.toLowerCase() : null;
  if (normalizedImdb) {
    const imdbExact = items.find(
      (item) => typeof item.imdbId === 'string' && item.imdbId.toLowerCase() === normalizedImdb
    );
    if (imdbExact) {
      return imdbExact;
    }
  }

  let bestCandidate = items[0];
  let bestScore = scoreSearchCandidate(bestCandidate, title, year);

  for (let i = 1; i < items.length; i += 1) {
    const candidate = items[i];
    const currentScore = scoreSearchCandidate(candidate, title, year);
    if (currentScore > bestScore) {
      bestScore = currentScore;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

async function lookupKinopoiskByImdb(imdbId, stremioType, apiKey, context = {}) {
  const params = new URLSearchParams();
  params.set('imdbId', imdbId);
  params.set('page', '1');
  const kpType = mapStremioTypeToKinopoiskType(stremioType);
  if (kpType !== 'ALL') {
    params.set('type', kpType);
  }

  const payload = await fetchKinopoiskJson(`/api/v2.2/films?${params.toString()}`, apiKey);
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const best = await pickBestFilmCandidateWithHydration(items, {
    title: context.title || null,
    year: context.year || null,
    imdbId,
  }, apiKey);
  const kpId = extractKinopoiskId(best);
  const baseRating = extractRatingPayload(best);
  return hydrateRatingPayload(baseRating, kpId, apiKey);
}

async function lookupKinopoiskByKeyword(title, year, stremioType, apiKey) {
  const params = new URLSearchParams();
  params.set('keyword', title);
  params.set('page', '1');
  const kpType = mapStremioTypeToKinopoiskType(stremioType);
  if (kpType !== 'ALL') {
    params.set('type', kpType);
  }

  if (year) {
    params.set('yearFrom', String(year));
    params.set('yearTo', String(year));
  }

  const payload = await fetchKinopoiskJson(`/api/v2.2/films?${params.toString()}`, apiKey);
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const best = await pickBestFilmCandidateWithHydration(items, { title, year, imdbId: null }, apiKey);
  const kpId = extractKinopoiskId(best);
  const baseRating = extractRatingPayload(best);
  return hydrateRatingPayload(baseRating, kpId, apiKey);
}

async function hydrateRatingPayload(basePayload, fallbackKpId = null, apiKey) {
  const kpId =
    (basePayload && basePayload.kpId) ||
    (Number.isFinite(Number(fallbackKpId)) && Number(fallbackKpId) > 0 ? Number(fallbackKpId) : null);

  if (!kpId) {
    return basePayload;
  }

  if (basePayload && basePayload.votes && basePayload.votes > 0) {
    return basePayload;
  }

  try {
    const details = await fetchKinopoiskJson(`/api/v2.2/films/${encodeURIComponent(String(kpId))}`, apiKey);
    const detailedPayload = extractRatingPayload(details);
    if (detailedPayload) {
      return {
        rating: detailedPayload.rating,
        votes: detailedPayload.votes || (basePayload ? basePayload.votes : null),
        kpId,
      };
    }
  } catch (error) {
    if (isHttpStatus(error, [404])) {
      return basePayload ? { ...basePayload, kpId } : null;
    }

    throw error;
  }

  return basePayload ? { ...basePayload, kpId } : null;
}

function handleKinopoiskLookupError(error, contextLabel, apiKey) {
  if (isHttpStatus(error, [429])) {
    markKinopoiskRateLimited(error, apiKey);
    return;
  }

  if (isHttpStatus(error, [402])) {
    markKinopoiskQuotaExceeded(apiKey);
    return;
  }

  if (isHttpStatus(error, [400, 404])) {
    return;
  }

  console.error(`[kp unofficial ${contextLabel}] failed:`, error.message);
}

async function resolveKinopoiskRating(meta, options = {}) {
  const imdbId = extractImdbId(meta);
  const title = extractTitle(meta);
  const year = extractYear(meta);
  const stremioType =
    meta && typeof meta === 'object' && typeof meta.type === 'string' ? meta.type : null;
  const allowSearchFallback =
    options && Object.prototype.hasOwnProperty.call(options, 'allowSearchFallback')
      ? Boolean(options.allowSearchFallback)
      : SEARCH_FALLBACK_ENABLED;
  const apiKey = resolveApiKey(options.apiKey);
  const apiScope = getApiScope(apiKey);
  const apiState = getKinopoiskApiState(apiKey);

  if (!imdbId && !title) {
    return null;
  }

  const cacheKey = `kp:${apiScope}:${imdbId || '-'}:${title || '-'}:${year || '-'}`;
  const cached = readCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  if (!apiKey && !hasLoggedMissingToken) {
    console.warn('No KinoPoisk API key configured. Set KINOPOISK_API_KEY.');
    hasLoggedMissingToken = true;
  }

  if (apiState.quotaExceeded || isKinopoiskRateLimited(apiKey)) {
    return null;
  }

  let rating = null;
  let shouldSkipNullCache = false;

  if (apiKey && imdbId && !apiState.quotaExceeded && !isKinopoiskRateLimited(apiKey)) {
    try {
      rating = await lookupKinopoiskByImdb(imdbId, stremioType, apiKey, { title, year });
    } catch (error) {
      handleKinopoiskLookupError(error, 'imdb', apiKey);
      if (isHttpStatus(error, [429, 402])) {
        shouldSkipNullCache = true;
      }
    }
  }

  if (
    !rating &&
    apiKey &&
    title &&
    allowSearchFallback &&
    !apiState.quotaExceeded &&
    !isKinopoiskRateLimited(apiKey)
  ) {
    try {
      rating = await lookupKinopoiskByKeyword(title, year, stremioType, apiKey);
    } catch (error) {
      handleKinopoiskLookupError(error, 'search', apiKey);
      if (isHttpStatus(error, [429, 402])) {
        shouldSkipNullCache = true;
      }
    }
  }

  if (isKinopoiskRateLimited(apiKey) || apiState.quotaExceeded) {
    shouldSkipNullCache = true;
  }

  if (rating || !shouldSkipNullCache) {
    writeCache(cacheKey, rating || null);
  }

  return rating;
}

function formatRating(rating) {
  const normalized = Number(rating);
  if (!Number.isFinite(normalized)) {
    return null;
  }

  return normalized.toFixed(1);
}

function formatVotes(votes, votesFormat) {
  const normalizedVotes = Number(votes);
  if (!Number.isFinite(normalizedVotes) || normalizedVotes < 1) {
    return null;
  }

  if (votesFormat === 'compact') {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(Math.round(normalizedVotes));
  }

  return Math.round(normalizedVotes).toLocaleString('en-US');
}

function formatRatingByConfig(rating, ratingFormat) {
  const ratingText = formatRating(rating);
  if (!ratingText) {
    return null;
  }

  if (ratingFormat === 'plain') {
    return ratingText;
  }

  return `${ratingText}/10`;
}

function appendRatingLine(description, ratingPayload, displayOptions = buildDefaultConfigureConfig()) {
  const ratingText = formatRating(ratingPayload.rating);
  if (!ratingText) {
    return description;
  }

  let line = `KinoPoisk: ${formatRatingByConfig(ratingPayload.rating, displayOptions.ratingFormat)}`;
  if (displayOptions.showVotes) {
    const votesText = formatVotes(ratingPayload.votes, displayOptions.votesFormat);
    if (votesText) {
      line += ` (${votesText} votes)`;
    }
  }

  if (!description || typeof description !== 'string') {
    return line;
  }

  if (description.includes('KinoPoisk:')) {
    return description;
  }

  return `${description.trim()}\n\n${line}`;
}

function buildKinopoiskStreamDescription(ratingPayload, displayOptions = buildDefaultConfigureConfig()) {
  if (!ratingPayload || !formatRating(ratingPayload.rating)) {
    return '⭐ Кинопоиск: нет данных';
  }

  const ratingText = formatRatingByConfig(ratingPayload.rating, displayOptions.ratingFormat);
  const votesText = displayOptions.showVotes ? formatVotes(ratingPayload.votes, displayOptions.votesFormat) : null;
  const mainLine = `⭐ Кинопоиск: ${ratingText}`;

  if (displayOptions.displayFormat === 'singleLine') {
    if (votesText) {
      return `${mainLine} (${votesText} голосов)`;
    }
    return mainLine;
  }

  const lines = [mainLine];
  if (votesText) {
    lines.push(`(${votesText} голосов)`);
  }

  return lines.join('\n');
}

function buildKinopoiskExternalUrl(ratingPayload, meta, imdbId) {
  if (ratingPayload && ratingPayload.kpId) {
    return `https://www.kinopoisk.ru/film/${ratingPayload.kpId}/`;
  }

  const title = extractTitle(meta);
  if (title) {
    return `https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(title)}`;
  }

  if (imdbId) {
    return `https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(imdbId)}`;
  }

  return 'https://www.kinopoisk.ru/';
}

async function fetchCinemetaMetaForStream(type, id) {
  const imdbIdFromRequest = extractImdbId({ id: String(id) });
  const metaId = imdbIdFromRequest || String(id);
  const metaUrl = `${CINEMETA_BASE_URL}/meta/${encodeURIComponent(type)}/${encodeURIComponent(metaId)}.json`;

  try {
    const payload = await fetchJson(metaUrl);
    if (payload && payload.meta && typeof payload.meta === 'object') {
      return payload.meta;
    }
  } catch {
    return { id: metaId, type };
  }

  return { id: metaId, type };
}

function appendRatingToName(name, ratingPayload) {
  const ratingText = formatRating(ratingPayload.rating);
  if (!ratingText) {
    return name;
  }

  const suffix = `[KP ${ratingText}]`;
  if (!name || typeof name !== 'string') {
    return suffix;
  }

  if (name.includes('[KP ')) {
    return name;
  }

  return `${name} ${suffix}`;
}

function getPublicBaseUrl() {
  return configuredPublicUrl || runtimePublicUrl;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildConfigurePageHtml(baseUrl) {
  const defaultManifestUrl = `${baseUrl}/manifest.json`;
  const safeDefaultManifestUrl = escapeHtml(defaultManifestUrl);
  const defaults = buildDefaultConfigureConfig();
  const defaultsJson = JSON.stringify(defaults);

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(MANIFEST_NAME)} - Configure</title>
    <style>
      :root {
        --bg: #11131a;
        --panel: #1a1f2d;
        --panel-2: #242c40;
        --text: #f5f7ff;
        --muted: #b8bfd6;
        --accent: #7d6bff;
        --border: #343d58;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
        background: radial-gradient(circle at top right, #1f2145, var(--bg) 55%);
        color: var(--text);
      }
      .wrap {
        max-width: 900px;
        margin: 28px auto;
        padding: 0 16px;
      }
      .card {
        background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01));
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 20px;
        margin-bottom: 16px;
      }
      h1, h2 {
        margin: 0 0 12px;
        line-height: 1.2;
      }
      .muted {
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      label {
        display: block;
        font-size: 14px;
        margin-bottom: 6px;
        color: var(--muted);
      }
      input, select {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--panel-2);
        color: var(--text);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .row input[type="checkbox"] {
        width: 18px;
        height: 18px;
      }
      pre {
        margin: 0;
        padding: 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: #151b2a;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 12px;
      }
      button, .btn {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--panel-2);
        color: var(--text);
        padding: 10px 14px;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
      }
      .btn-primary {
        background: var(--accent);
        border-color: transparent;
      }
      @media (max-width: 760px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>${escapeHtml(MANIFEST_NAME)}</h1>
        <p class="muted">Быстрая настройка аддона: API ключ + формат вывода рейтинга и голосов.</p>
      </div>

      <div class="card">
        <h2>Quick Install (Default)</h2>
        <pre id="defaultManifest">${safeDefaultManifestUrl}</pre>
        <div class="actions">
          <a class="btn btn-primary" id="installDefault" href="#" rel="noreferrer">Install Default Version</a>
          <button type="button" id="copyDefault">Copy URL</button>
        </div>
      </div>

      <div class="card">
        <h2>Custom Settings</h2>
        <div class="grid">
          <div>
            <label for="apiKey">KinoPoisk API key (optional)</label>
            <input id="apiKey" type="password" placeholder="a285172c-..." />
          </div>
          <div>
            <label for="streamName">Stream Name</label>
            <input id="streamName" type="text" value="${escapeHtml(defaults.streamName)}" />
          </div>
          <div>
            <label for="displayFormat">Display Format</label>
            <select id="displayFormat">
              <option value="multiLine">Multi-line</option>
              <option value="singleLine">Single-line</option>
            </select>
          </div>
          <div>
            <label for="ratingFormat">Rating Format</label>
            <select id="ratingFormat">
              <option value="withMax">With max (8.5/10)</option>
              <option value="plain">Plain (8.5)</option>
            </select>
          </div>
          <div>
            <label for="votesFormat">Vote Format</label>
            <select id="votesFormat">
              <option value="commas">With commas (45,123)</option>
              <option value="compact">Rounded (45.1K)</option>
            </select>
          </div>
          <div>
            <label>Visibility</label>
            <div class="row"><input id="showVotes" type="checkbox" checked /><span>Show vote counts</span></div>
            <div class="row"><input id="showMovies" type="checkbox" checked /><span>Show ratings for movies</span></div>
            <div class="row"><input id="showSeries" type="checkbox" checked /><span>Show ratings for series</span></div>
          </div>
        </div>

        <h2 style="margin-top: 16px;">Generated Manifest URL</h2>
        <pre id="customManifest"></pre>
        <div class="actions">
          <a class="btn btn-primary" id="installCustom" href="#" rel="noreferrer">Install Custom Version</a>
          <button type="button" id="copyCustom">Copy URL</button>
        </div>
      </div>
    </div>

    <script>
      (function () {
        const baseUrl = ${JSON.stringify(baseUrl)};
        const defaults = ${defaultsJson};

        const ids = [
          'apiKey',
          'streamName',
          'displayFormat',
          'ratingFormat',
          'votesFormat',
          'showVotes',
          'showMovies',
          'showSeries',
        ];

        const defaultManifestEl = document.getElementById('defaultManifest');
        const customManifestEl = document.getElementById('customManifest');
        const installDefaultEl = document.getElementById('installDefault');
        const installCustomEl = document.getElementById('installCustom');
        const copyDefaultEl = document.getElementById('copyDefault');
        const copyCustomEl = document.getElementById('copyCustom');

        function toStremioUrl(url) {
          return 'stremio://' + url.replace(/^https?:\\/\\//, '');
        }

        function collectConfig() {
          const apiKey = document.getElementById('apiKey').value.trim();
          return {
            apiKey: apiKey,
            streamName: document.getElementById('streamName').value.trim() || defaults.streamName,
            displayFormat: document.getElementById('displayFormat').value || defaults.displayFormat,
            ratingFormat: document.getElementById('ratingFormat').value || defaults.ratingFormat,
            votesFormat: document.getElementById('votesFormat').value || defaults.votesFormat,
            showVotes: document.getElementById('showVotes').checked,
            showMovies: document.getElementById('showMovies').checked,
            showSeries: document.getElementById('showSeries').checked,
          };
        }

        function buildUrl() {
          const cfg = collectConfig();
          const payload = {};

          if (cfg.apiKey) payload.apiKey = cfg.apiKey;
          if (cfg.streamName !== defaults.streamName) payload.streamName = cfg.streamName;
          if (cfg.displayFormat !== defaults.displayFormat) payload.displayFormat = cfg.displayFormat;
          if (cfg.ratingFormat !== defaults.ratingFormat) payload.ratingFormat = cfg.ratingFormat;
          if (cfg.votesFormat !== defaults.votesFormat) payload.votesFormat = cfg.votesFormat;
          if (cfg.showVotes !== defaults.showVotes) payload.showVotes = cfg.showVotes;
          if (cfg.showMovies !== defaults.showMovies) payload.showMovies = cfg.showMovies;
          if (cfg.showSeries !== defaults.showSeries) payload.showSeries = cfg.showSeries;

          if (Object.keys(payload).length === 0) {
            return baseUrl + '/manifest.json';
          }

          return baseUrl + '/' + encodeURIComponent(JSON.stringify(payload)) + '/manifest.json';
        }

        function refresh() {
          const defaultUrl = baseUrl + '/manifest.json';
          const customUrl = buildUrl();

          defaultManifestEl.textContent = defaultUrl;
          customManifestEl.textContent = customUrl;

          installDefaultEl.href = toStremioUrl(defaultUrl);
          installCustomEl.href = toStremioUrl(customUrl);
        }

        async function copyText(text) {
          try {
            await navigator.clipboard.writeText(text);
            return true;
          } catch (_) {
            return false;
          }
        }

        copyDefaultEl.addEventListener('click', async function () {
          await copyText(defaultManifestEl.textContent || '');
        });

        copyCustomEl.addEventListener('click', async function () {
          await copyText(customManifestEl.textContent || '');
        });

        ids.forEach(function (id) {
          const el = document.getElementById(id);
          if (!el) return;
          el.addEventListener('input', refresh);
          el.addEventListener('change', refresh);
        });

        refresh();
      })();
    </script>
  </body>
</html>`;
}

function buildPosterOverlayUrl(posterUrl, ratingPayload) {
  const ratingText = formatRating(ratingPayload.rating);
  if (!ratingText || !isHttpUrl(posterUrl)) {
    return posterUrl;
  }

  const params = new URLSearchParams();
  params.set('poster', posterUrl);
  params.set('rating', ratingText);

  return `${getPublicBaseUrl()}/poster.svg?${params.toString()}`;
}

async function enrichMeta(meta, options = {}) {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }

  const ratingPayload = await resolveKinopoiskRating(meta, options);
  if (!ratingPayload) {
    return meta;
  }

  const enriched = { ...meta };
  enriched.description = appendRatingLine(meta.description, ratingPayload);

  if (TITLE_RATING_ENABLED) {
    enriched.name = appendRatingToName(meta.name, ratingPayload);
  }

  if (POSTER_OVERLAY_ENABLED && meta.poster) {
    enriched.poster = buildPosterOverlayUrl(meta.poster, ratingPayload);
  }

  return enriched;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeRatingLabel(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^\d{1,2}(?:\.\d)?$/);
  return match ? match[0] : null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const output = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;

      try {
        output[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch {
        output[currentIndex] = items[currentIndex];
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers = [];

  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return output;
}

const addonInterface = builder.getInterface();

const app = express();
app.disable('x-powered-by');

app.use((req, _res, next) => {
  if (!configuredPublicUrl) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;

    if (typeof host === 'string' && host.length > 0) {
      runtimePublicUrl = `${protocol}://${host}`;
    }
  }

  next();
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/poster.svg', (req, res) => {
  const posterUrl = typeof req.query.poster === 'string' ? req.query.poster : '';
  const ratingLabel = normalizeRatingLabel(typeof req.query.rating === 'string' ? req.query.rating : '');

  if (!posterUrl || !ratingLabel || !isHttpUrl(posterUrl)) {
    res.status(400).send('Invalid poster or rating');
    return;
  }

  const escapedPosterUrl = escapeXml(posterUrl);
  const escapedRating = escapeXml(`KP ${ratingLabel}`);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="kpBadge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff7a00"/>
      <stop offset="100%" stop-color="#ffb347"/>
    </linearGradient>
    <filter id="badgeShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/>
    </filter>
  </defs>
  <image href="${escapedPosterUrl}" width="300" height="450" preserveAspectRatio="xMidYMid slice"/>
  <g filter="url(#badgeShadow)">
    <rect x="14" y="14" width="96" height="34" rx="8" ry="8" fill="url(#kpBadge)"/>
  </g>
  <text x="62" y="36" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#111">${escapedRating}</text>
</svg>`;

  res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=86400, stale-while-revalidate=86400');
  res.status(200).send(svg);
});

app.get('/configure', (_req, res) => {
  const html = buildConfigurePageHtml(getPublicBaseUrl());
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.status(200).send(html);
});

app.get('/', (_req, res) => {
  res.redirect(302, '/configure');
});

app.use(getRouter(addonInterface));

app.listen(PORT, HOST, () => {
  console.log(`KinoPoisk addon running at ${getPublicBaseUrl()}`);
  console.log(`Manifest: ${getPublicBaseUrl()}/manifest.json`);
  console.log(`Configure: ${getPublicBaseUrl()}/configure`);
});
