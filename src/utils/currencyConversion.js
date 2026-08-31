const { getSetting, setSetting } = require('../db');
const { isSupportedCurrency } = require('./regional');

const AUTO_REFRESH_MS = 12 * 60 * 60 * 1000;
const PROVIDER_NAME = 'ExchangeRate-API';
const PROVIDER_URL = 'https://www.exchangerate-api.com';
const rateRequests = new Map();

function positiveRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function normalizeConversionSettings(raw = {}, scope = '') {
  const baseCurrency = String(raw.currency || 'MXN').trim().toUpperCase();
  const targetCurrency = String(raw.currency_conversion_target || '').trim().toUpperCase();
  const mode = raw.currency_conversion_mode === 'automatic' ? 'automatic' : 'manual';
  const enabledForScope = !scope || String(raw[`currency_conversion_${scope}_enabled`] || '0') === '1';
  const enabled = String(raw.currency_conversion_enabled || '0') === '1'
    && enabledForScope
    && isSupportedCurrency(baseCurrency)
    && isSupportedCurrency(targetCurrency)
    && baseCurrency !== targetCurrency;
  const rate = positiveRate(raw.currency_conversion_rate);
  const updatedAt = String(raw.currency_conversion_updated_at || '').trim();
  return {
    enabled: enabled && rate > 0,
    configured: enabled,
    baseCurrency,
    targetCurrency,
    mode,
    rate,
    updatedAt,
    provider: mode === 'automatic' ? PROVIDER_NAME : 'manual',
    providerUrl: mode === 'automatic' ? PROVIDER_URL : '',
  };
}

async function fetchAutomaticRate(baseCurrency, targetCurrency, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('El servidor no puede consultar tasas automáticas');
  const key = `${baseCurrency}:${targetCurrency}`;
  if (rateRequests.has(key)) return rateRequests.get(key);
  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetchImpl(`https://open.er-api.com/v6/latest/${encodeURIComponent(baseCurrency)}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Proveedor respondió HTTP ${response.status}`);
      const data = await response.json();
      const rate = positiveRate(data?.rates?.[targetCurrency]);
      if (data?.result !== 'success' || !rate) throw new Error('El proveedor no devolvió una tasa válida');
      return { rate, updatedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timeout);
    }
  })();
  rateRequests.set(key, request);
  try {
    return await request;
  } finally {
    rateRequests.delete(key);
  }
}

async function readRawSettings(t) {
  const keys = [
    'currency', 'currency_conversion_enabled', 'currency_conversion_target', 'currency_conversion_mode',
    'currency_conversion_rate', 'currency_conversion_updated_at', 'currency_conversion_chatbot_enabled',
    'currency_conversion_pos_enabled',
  ];
  const values = await Promise.all(keys.map((key) => getSetting(t, key, '')));
  return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
}

async function resolveCurrencyConversion(t, { scope = '', forceRefresh = false, raw = null, fetchImpl } = {}) {
  const values = raw || await readRawSettings(t);
  let conversion = normalizeConversionSettings(values, scope);
  if (!conversion.configured || conversion.mode !== 'automatic') return conversion;

  const updatedTime = Date.parse(conversion.updatedAt || '');
  const stale = !Number.isFinite(updatedTime) || Date.now() - updatedTime >= AUTO_REFRESH_MS;
  if (!forceRefresh && !stale && conversion.rate > 0) return conversion;

  try {
    const fresh = await fetchAutomaticRate(conversion.baseCurrency, conversion.targetCurrency, fetchImpl);
    await Promise.all([
      setSetting(t, 'currency_conversion_rate', fresh.rate),
      setSetting(t, 'currency_conversion_updated_at', fresh.updatedAt),
    ]);
    conversion = normalizeConversionSettings({
      ...values,
      currency_conversion_rate: String(fresh.rate),
      currency_conversion_updated_at: fresh.updatedAt,
    }, scope);
    return conversion;
  } catch (error) {
    if (conversion.rate > 0) return { ...conversion, stale: true, warning: error.message };
    throw error;
  }
}

function convertedAmount(amount, conversion) {
  if (!conversion?.enabled) return null;
  const value = Number(amount) * positiveRate(conversion.rate);
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : null;
}

function convertedMoney(amount, conversion, locale = 'es-MX') {
  const value = convertedAmount(amount, conversion);
  if (value === null) return '';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: conversion.targetCurrency }).format(value);
}

module.exports = {
  AUTO_REFRESH_MS,
  PROVIDER_NAME,
  PROVIDER_URL,
  positiveRate,
  normalizeConversionSettings,
  fetchAutomaticRate,
  resolveCurrencyConversion,
  convertedAmount,
  convertedMoney,
};
