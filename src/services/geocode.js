/* src/services/geocode.js */

import fetch from 'node-fetch';
import { config } from '../config/index.js';

export async function getLocationData(query) {
  if (!query || !config.opencage.apiKey) return null;

  try {
    const url = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(query)}&key=${config.opencage.apiKey}&countrycode=mx&limit=1`;

    const res = await fetch(url);
    const data = await res.json();

    const result = data.results?.[0];
    if (!result) return null;

    const comp = result.components;

    return {
      ciudad:
        comp.city ||
        comp.town ||
        comp.village ||
        comp.county ||
        null,
      estado: comp.state || null,
    };

  } catch (err) {
    return null;
  }
}