// src/services/rates.js
import { supabase } from './supabase.js';

let cache = {
  tarifas: null,
  lastFetched: 0,
};

const TTL = 10 * 60 * 1000;

export async function getTarifas() {
  const now = Date.now();

  if (cache.tarifas && (now - cache.lastFetched < TTL)) {
    return cache.tarifas;
  }

  const { data, error } = await supabase
    .from('rates')
    .select('*')
    .order('peso', { ascending: true });

  if (error) throw error;

  cache = {
    tarifas: data,
    lastFetched: now,
  };

  return data;
}

export async function getPreciosPorPeso(pesoACobrar, conIVA) {
  const tarifas = await getTarifas();

  const fila = tarifas.find(t => t.peso === pesoACobrar)
    ?? tarifas[tarifas.length - 1];

  return {
    estafeta_express:   conIVA ? fila.estafeta_express_iva : fila.estafeta_express,
    estafeta_terrestre: conIVA ? fila.estafeta_terrestre_iva : fila.estafeta_terrestre,
    fedex_terrestre:    conIVA ? fila.fedex_iva : fila.fedex,
  };
}

export function invalidateRatesCache() {
  cache = { tarifas: null, lastFetched: 0 };
}