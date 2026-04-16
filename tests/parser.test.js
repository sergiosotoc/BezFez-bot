import { parseFormatoLibre } from '../src/parsers/formParser.js';

const tests = [
  {
    name: 'FORMATO COMPLETO',
    input: `Remitente
Juan Perez
Calle 123
Colonia Centro
Guadalajara Jalisco
44100
3312345678

Destinatario
Maria Lopez
Av Siempre Viva 742
Colonia Roma
CDMX
06600
5512345678

Medidas 30x20x15
Peso 3kg
Contenido ropa`,
  },

  {
    name: 'MENSAJE DESORDENADO',
    input: `envio 30x20x15 pesa 5kg de 44100 a 06600`,
  },

  {
    name: 'SOLO CP',
    input: `44100`,
  }
];

tests.forEach(test => {
  const result = parseFormatoLibre(test.input);
  console.log('\n====', test.name, '====');
  console.log(result);
});