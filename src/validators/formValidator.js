/* src/validators/formValidator.js */

// ─────────────────────────────
// VALIDADORES
// ─────────────────────────────

export function validateField(field, value) {
    if (!value) return false;

    const v = String(value).trim();

    switch (field) {

        case 'nombre_origen':
        case 'nombre_destino':
            return /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s&-]{3,100}$/.test(v);

        case 'calle_origen':
        case 'calle_destino':
            return v.length >= 3 && /[a-zA-Z0-9]/.test(v);

        case 'colonia_origen':
        case 'colonia_destino':
            return /^[a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s.#&-]{2,80}$/.test(v);

        case 'ciudad_origen':
        case 'ciudad_destino':
            return /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s,.-]{3,80}$/.test(v);

        case 'cp_origen':
        case 'cp_destino':
            return /^\d{5}$/.test(v);

        case 'cel_origen':
        case 'cel_destino':
            return /^\d{10}$/.test(v);

        case 'medidas':
            return /^\d+(?:\.\d+)?x\d+(?:\.\d+)?x\d+(?:\.\d+)?$/i.test(v);

        case 'peso': {
            const num = parseFloat(v);
            return !isNaN(num) && num > 0 && num <= 1000;
        }

        case 'contenido':
            return v.length >= 3 && v.length <= 200 && /[a-zA-Z]/.test(v);

        default:
            return true;
    }
}
