const STORAGE_KEY = 'tradingagents.runner.keys.v1'
const TTL_MS = 24 * 60 * 60 * 1000

const safeNow = () => Date.now()

const parseRaw = (raw) => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const readStore = () => {
  try {
    return parseRaw(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

const writeStore = (store) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store || {}))
  } catch {
    // ignore storage failures
  }
}

const isExpired = (entry, nowMs = safeNow()) => {
  const expiresAt = Number(entry?.expiresAt || 0)
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs
}

export const purgeExpiredRunnerKeys = () => {
  const nowMs = safeNow()
  const current = readStore()
  const next = {}
  Object.entries(current).forEach(([provider, entry]) => {
    if (!entry || typeof entry !== 'object') return
    const key = String(entry.key || '')
    if (!key) return
    if (isExpired(entry, nowMs)) return
    next[provider] = {
      key,
      expiresAt: Number(entry.expiresAt),
      updatedAt: Number(entry.updatedAt || nowMs),
    }
  })
  writeStore(next)
  return next
}

export const getRunnerKeyForProvider = (provider) => {
  if (!provider) return ''
  const normalized = String(provider).trim().toLowerCase()
  const store = purgeExpiredRunnerKeys()
  const entry = store[normalized]
  return String(entry?.key || '')
}

export const setRunnerKeyForProvider = (provider, key) => {
  const normalized = String(provider || '').trim().toLowerCase()
  if (!normalized) return false
  const trimmedKey = String(key || '').trim()
  const nowMs = safeNow()
  const store = purgeExpiredRunnerKeys()
  if (!trimmedKey) {
    delete store[normalized]
    writeStore(store)
    return true
  }
  store[normalized] = {
    key: trimmedKey,
    updatedAt: nowMs,
    expiresAt: nowMs + TTL_MS,
  }
  writeStore(store)
  return true
}

export const clearRunnerKeyForProvider = (provider) => {
  return setRunnerKeyForProvider(provider, '')
}

export const getRunnerKeyMetaForProvider = (provider) => {
  const normalized = String(provider || '').trim().toLowerCase()
  if (!normalized) return null
  const store = purgeExpiredRunnerKeys()
  const entry = store[normalized]
  if (!entry) return null
  return {
    provider: normalized,
    hasKey: Boolean(entry.key),
    updatedAt: Number(entry.updatedAt || 0) || null,
    expiresAt: Number(entry.expiresAt || 0) || null,
  }
}

export const getRunnerKeyStorageConstants = () => ({
  STORAGE_KEY,
  TTL_MS,
})

