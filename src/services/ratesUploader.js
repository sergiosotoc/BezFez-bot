// src/services/ratesUploader.js
import xlsx from 'xlsx';
import { supabase } from './supabase.js';
import { invalidateRatesCache } from './rates.js';

export async function processRatesExcel(buffer) {
    const workbook = xlsx.read(buffer);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    const tarifas = rows
        .slice(1)
        .map((r, index) => {

            if (!r || r.length === 0) return null;

            if (isNaN(r[0])) {
                throw new Error(`Fila ${index + 2}: Peso inválido`);
            }

            const parseOrNull = (value) => {
                if (value === undefined || value === null || value === '') return null;
                const num = Number(value);
                return isNaN(num) ? null : num;
            };

            const data = {
                peso: Number(r[0]),
                estafeta_express: parseOrNull(r[1]),
                estafeta_express_iva: parseOrNull(r[2]),
                estafeta_terrestre: parseOrNull(r[3]),
                estafeta_terrestre_iva: parseOrNull(r[4]),
                fedex: parseOrNull(r[5]),
                fedex_iva: parseOrNull(r[6]),
            };

            const hasAtLeastOneRate =
                data.estafeta_express ||
                data.estafeta_terrestre ||
                data.fedex;

            if (!hasAtLeastOneRate) {
                throw new Error(`Fila ${index + 2}: No tiene ninguna tarifa válida`);
            }

            return data;
        })
        .filter(Boolean); 

    // 🔥 transacción lógica
    await supabase.from('rates').delete().neq('peso', 0);

    const { error } = await supabase
        .from('rates')
        .insert(tarifas);

    if (error) throw error;

    invalidateRatesCache();

    return tarifas.length;
}