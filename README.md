# AHSE Bot — WhatsApp Cotizador de Guías

Chatbot de WhatsApp para cotizaciones de guías de envío con 3 paqueterías (Estafeta Express, Estafeta Terrestre, FedEx Terrestre).

## Stack

| Capa | Tecnología |
|------|-----------|
| WhatsApp API | Baileys (`@whiskeysockets/baileys`) |
| Runtime | Node.js >= 18 (ESM) |
| Base de datos | Supabase (PostgreSQL + Storage) |
| Tarifas | Google Sheets |
| Logs | Pino |

---

## Requisitos previos

- Node.js >= 18
- Cuenta de Supabase con proyecto creado
- Google Cloud project con Sheets API habilitada
- Número de WhatsApp dedicado para el bot

---

## Instalación

```bash
git clone <repo>
cd ahse-bot
npm install
cp .env.example .env
# Editar .env con tus credenciales
```

---

## Configuración

### 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com)
2. Ve a **SQL Editor** y ejecuta el archivo `src/db/migrations/001_initial.sql`
3. Copia la `URL` y la `service_role` key de **Project Settings → API**
4. En **Storage**, el bucket `comprobantes` se crea automáticamente al arrancar el bot

### 2. Google Sheets

1. Crea una hoja de cálculo con la siguiente estructura en la pestaña `Tarifas`:

   | A (Paquetería)      | B (Precio Base) | C (Descripción) |
   |---------------------|-----------------|-----------------|
   | Estafeta Express    | 720             | Entrega 1-2 días |
   | Estafeta Terrestre  | 525             | Entrega 3-5 días |
   | FedEx Terrestre     | 600             | Entrega 3-4 días |

2. Crea una cuenta de servicio en Google Cloud Console:
   - Ve a **IAM & Admin → Service Accounts**
   - Crea cuenta → genera clave JSON
   - Comparte la hoja con el email de la cuenta de servicio (rol Viewer)
3. El contenido del JSON va en `GOOGLE_SERVICE_ACCOUNT_JSON` (como una sola línea)

### 3. Variables de entorno

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

GOOGLE_SHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
GOOGLE_SHEET_TAB=Tarifas
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

ADMIN_PHONE=5216181096537   # Sin + ni espacios
BANK_NAME=BBVA
BANK_ACCOUNT=1234567890
BANK_CLABE=012345678901234567
BANK_HOLDER=AHSE Paqueteria SA de CV

IVA_RATE=0.16
LOG_LEVEL=info
```

---

## Ejecución

```bash
# Producción
npm start

# Desarrollo (recarga automática con Node.js --watch)
npm run dev
```

Al iniciar por primera vez, se muestra un **código QR** en la terminal. Escanéalo con WhatsApp → **Dispositivos vinculados → Vincular dispositivo**.

Las credenciales se guardan en `./auth_info/` y persisten entre reinicios.

---

## Estructura del proyecto

```
src/
├── index.js                  # Punto de entrada
├── config/
│   ├── index.js              # Configuración centralizada
│   └── logger.js             # Logger Pino
├── bot/
│   ├── index.js              # Conexión Baileys + event listeners
│   ├── router.js             # Router: deduplicación, separación admin/cliente
│   └── sender.js             # Wrapper de envío de mensajes
├── fsm/
│   ├── machine.js            # Dispatcher de estados FSM
│   └── states/
│       ├── s1_format.js      # IDLE → AWAITING_FORMAT
│       ├── s2_parsing.js     # AWAITING_FORMAT → AWAITING_INVOICE
│       ├── s3_invoice.js     # AWAITING_INVOICE → AWAITING_SELECTION
│       ├── s4_selection.js   # AWAITING_SELECTION → AWAITING_PAYMENT
│       ├── s5_payment.js     # AWAITING_PAYMENT → PAUSED
│       └── s6_paused.js      # PAUSED (bot suspendido)
├── services/
│   ├── supabase.js           # Cliente + helpers con bloqueo optimista
│   ├── sheets.js             # Tarifas con caché 10min + fallback
│   ├── calculator.js         # Peso facturable, IVA, formatos de mensaje
│   ├── storage.js            # Upload a Supabase Storage con reintentos
│   └── deadman.js            # Temporizador de pausa + boot recovery
├── parsers/
│   └── formParser.js         # Extracción Regex de CP, medidas, peso
└── db/
    └── migrations/
        └── 001_initial.sql   # Schema completo de Supabase
```

---

## Flujo conversacional

```
Cliente escribe → S0: IDLE
                     ↓ Envía formato
                  S1: AWAITING_FORMAT
                     ↓ Parser Regex extrae datos
                  S3: AWAITING_INVOICE  ← pide Sí/No factura
                     ↓ Calcula cotización (peso facturable + cargos)
                  S4: AWAITING_SELECTION ← muestra 3 opciones
                     ↓ Cliente elige paquetería
                  S5: AWAITING_PAYMENT  ← genera folio PED-XXXXXX
                     ↓ Cliente envía foto/PDF
                  S6: PAUSED  ← notifica al admin, deadman 60min
                     ↓ Timer expira (o admin no extiende)
                  S0: IDLE  ← lista para nueva cotización
```

---

## Comandos del admin

El encargado puede escribir al número del bot para controlar el deadman switch:

| Comando | Efecto |
|---------|--------|
| `EXTENDER` | Extiende la pausa del chat más reciente 60 minutos más |
| `EXTENDER 5216181096537` | Extiende la pausa de un cliente específico |
| `FINALIZADO` | Marca como finalizado (log de auditoría) |

---

## Reglas de negocio implementadas

| Regla | Implementación |
|-------|---------------|
| Peso facturable | `max(peso_bascula, L×A×A / 5000)` |
| Cargo por sobredimensión | +$175 si cualquier dimensión > 100 cm |
| IVA | +16% sobre el total si el cliente requiere factura |
| Tarifas | Leídas de Google Sheets con caché de 10 min |
| Fallback de tarifas | Usa última caché si Sheets no responde |
| Deduplicación | `processed_messages` table con TTL 5 min |
| Bloqueo optimista | UPDATE con condición `WHERE state = 'expected'` |
| Boot recovery | Restaura timers de pausas activas al reiniciar |

---

## Despliegue en producción

### Con PM2

```bash
npm install -g pm2
pm2 start src/index.js --name ahse-bot --interpreter node
pm2 save
pm2 startup
```

### Con Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
VOLUME ["/app/auth_info"]
CMD ["node", "src/index.js"]
```

```bash
docker build -t ahse-bot .
docker run -d \
  --name ahse-bot \
  --env-file .env \
  -v $(pwd)/auth_info:/app/auth_info \
  --restart unless-stopped \
  ahse-bot
```

> **Importante:** Monta `auth_info/` como volumen para que las credenciales de WhatsApp persistan entre reinicios del contenedor.

---

## Solución de problemas

| Problema | Solución |
|----------|----------|
| Bot no responde | Verifica que el QR fue escaneado y `connection === 'open'` en logs |
| `SUPABASE_SERVICE_ROLE_KEY` inválida | Usa la key de tipo `service_role`, no la `anon` |
| Google Sheets 403 | Comparte la hoja con el email de la cuenta de servicio |
| Bucket no creado | El bot lo crea automáticamente; verifica permisos del `service_role` |
| Mensajes duplicados | Normal — la deduplicación los filtra; revisa tabla `processed_messages` |
| Timer no restaurado | Verifica que `pause_expires_at > NOW()` en la sesión pausada |
