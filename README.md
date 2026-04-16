# BazFez Bot — WhatsApp Cotizador de Guías

Chatbot de WhatsApp para cotizaciones de guías de envío con 3 paqueterías (Estafeta Express, Estafeta Terrestre, FedEx Terrestre).

## Stack

| Capa | Tecnología |
|------|-----------|
| WhatsApp API | Baileys (`@whiskeysockets/baileys`) |
| Runtime | Node.js >= 18 (ESM) |
| Base de datos | Supabase (PostgreSQL + Storage) |
| Tarifas | Supabase `rates` actualizable por Excel enviado por admin |
| Logs | Pino |

---

## Requisitos previos

- Node.js >= 18
- Cuenta de Supabase con proyecto creado
- Número de WhatsApp dedicado para el bot

---

## Instalación

```bash
git clone <repo>
cd bazfez-bot
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
4. En **Storage**, los buckets `bot-files` y `auth-sessions` se crean automáticamente al arrancar el bot

### 2. Tarifas

1. Ejecuta la migración para crear la tabla `rates`.
2. Envía desde el número admin un archivo `.xlsx` al bot con columnas: peso, express, expressIVA, terrestre, terrestreIVA, fedex, fedexIVA.
3. El bot reemplaza las tarifas de Supabase y limpia el caché.

### 3. Variables de entorno

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

ADMIN_PHONE=5216181096537

IVA_RATE=0.16
LOG_LEVEL=info
OPENCAGE_API_KEY=opcional
```

---

## Ejecución

```bash
# Producción
npm start

# Desarrollo (recarga automática)
npm run dev
```

Al iniciar por primera vez, se muestra un **código QR** en la terminal. Escanéalo con WhatsApp → **Dispositivos vinculados → Vincular dispositivo**.

Las credenciales se guardan en `./auth_info/` localmente **y se sincronizan automáticamente** con Supabase Storage (bucket `auth-sessions`) para sobrevivir reinicios y deploys.

---

## Estructura del proyecto

```
src/
├── index.js                  # Punto de entrada
├── server.js                 # Servidor HTTP (health check + keep-alive)
├── config/
│   ├── index.js              # Configuración centralizada
│   └── logger.js             # Logger Pino
├── bot/
│   ├── index.js              # Conexión Baileys + event listeners
│   ├── auth.js               # Persistencia de sesión WhatsApp en Supabase
│   ├── router.js             # Router: deduplicación, separación admin/cliente
│   └── sender.js             # Wrapper de envío de mensajes
├── fsm/
│   ├── machine.js            # Dispatcher de estados FSM
│   └── states/
│       ├── s1_format.js      # IDLE → PARSING_DATA/AWAITING_INVOICE
│       ├── s2_parsing.js     # PARSING_DATA → AWAITING_INVOICE
│       ├── s3_invoice.js     # AWAITING_INVOICE → AWAITING_SELECTION
│       ├── s4_selection.js   # AWAITING_SELECTION → AWAITING_ADDRESS
│       ├── s4b_address.js    # AWAITING_ADDRESS → PAUSED
│       └── s6_paused.js      # PAUSED (bot suspendido)
├── services/
│   ├── supabase.js           # Cliente + helpers con bloqueo optimista
│   ├── rates.js              # Tarifas desde Supabase con caché
│   ├── ratesUploader.js      # Carga de tarifas desde Excel
│   ├── calculator.js         # Peso facturable, IVA, formatos de mensaje
│   ├── storage.js            # Upload a Supabase Storage con reintentos
│   └── deadman.js            # Temporizador de pausa + boot recovery
├── parsers/
│   └── formParser.js         # Parser flexible: formato libre, etiquetado y mixto
└── db/
    └── migrations/
        └── 001_initial.sql   # Schema completo de Supabase
```

---

## Flujo conversacional

```
Cliente escribe → S0: IDLE
                     ↓ Envía datos de paquete (medidas, peso, CPs)
                  S2: PARSING_DATA
                     ↓ Parser extrae datos; pide los que falten
                  S3: AWAITING_INVOICE  ← ¿Requiere factura?
                     ↓ Calcula cotización (peso facturable + cargos)
                  S4: AWAITING_SELECTION ← muestra 3 opciones de paquetería
                     ↓ Cliente elige
                  S4b: AWAITING_ADDRESS ← pide datos de origen/destino
                     ↓ Parser extrae; pide campo por campo si falta algo
                  S6: PAUSED  ← notifica al admin, deadman 60 min
                     ↓ Timer expira (o admin no extiende)
                  S0: IDLE  ← lista para nueva cotización
```

---

## Formatos de mensaje aceptados

El bot acepta datos de paquete y dirección en cualquiera de estos formatos:

**Cotización en una línea:**
```
25x25x25, 5kg, 34198, 77710
```

**Cotización multilínea:**
```
25x25x25
5 kg
34198
77710
```

**Dirección formato libre (remitente/receptor):**
```
Remitente
Juan Pérez
Av. Reforma 100
Centro
CDMX, CDMX
5512345678

Receptor
María López
Calle 5 de Mayo 200
Zona Centro
Monterrey, Nuevo León
8112345678

Ropa y calzado
```

**Dirección con etiquetas:**
```
Nombre Origen: Juan Pérez
Calle y Número Origen: Av. Reforma 100
Colonia Origen: Centro
Ciudad y Estado Origen: CDMX
Cel Origen: 5512345678
...
```

El parser detecta automáticamente el formato y extrae los campos. Si faltan datos, los pide uno por uno.

---

## Comandos del admin

El encargado escribe al número del bot para controlar el sistema:

| Comando | Efecto |
|---------|--------|
| `EXTENDER` | Extiende la pausa 60 minutos más |
| `FINALIZADO` | Marca como finalizado (auditoría) |
| `RESET_AUTH` | Elimina la sesión de WhatsApp guardada en Supabase (para cambiar de número) |

---

## Reglas de negocio

| Regla | Implementación |
|-------|---------------|
| Peso facturable | `max(peso_bascula, L×A×A / 5000)` |
| Cargo por sobredimensión | +$175 si cualquier dimensión > 100 cm |
| IVA | +16% sobre el total si el cliente requiere factura |
| Tarifas | Leídas desde Supabase `rates` con caché de 10 min |
| Fallback de tarifas | Usa caché local mientras no expire |
| Deduplicación | Tabla `processed_messages` con TTL 5 min |
| Bloqueo optimista | `UPDATE` con condición `WHERE state = 'expected'` |
| Boot recovery | Restaura timers de pausas activas al reiniciar |
| Expiración por inactividad | Sesión reseteada automáticamente tras 1 hora sin actividad |

---

## Despliegue en Render

### 1. Variables de entorno

En **Render → tu servicio → Environment**, agrega todas las variables del archivo `.env` más:

```env
NODE_ENV=production
RENDER_EXTERNAL_URL=https://tu-servicio.onrender.com
```

> `RENDER_EXTERNAL_URL` es necesaria para el keep-alive automático que evita que el servicio se suspenda.

### 2. Configuración del servicio

| Campo | Valor |
|-------|-------|
| Build command | `npm install` |
| Start command | `npm start` |
| Node version | >= 18 |

O crea un archivo `render.yaml` en la raíz:

```yaml
services:
  - type: web
    name: bazfez-bot
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
      - key: RENDER_EXTERNAL_URL
        fromService:
          type: web
          name: bazfez-bot
          property: host
```

### 3. Primera conexión

Al hacer el primer deploy, el bot no tendrá sesión de WhatsApp guardada. Verás en los logs del servicio en Render algo como:

```
No hay sesión guardada en Supabase — se generará QR
```

Seguido del QR en texto. Escanéalo desde WhatsApp → **Dispositivos vinculados → Vincular dispositivo**.

Tras escanearlo, la sesión se guarda automáticamente en Supabase Storage (bucket `auth-sessions`). Los deploys futuros arrancarán sin necesidad de escanear el QR.

### 4. Cambiar de número

Para cambiar el número del bot desde el admin de WhatsApp, envía el comando `RESET_AUTH` al bot. Esto elimina la sesión guardada en Supabase. Luego reinicia el servicio en Render y escanea el QR con el número nuevo.

También puedes hacerlo manualmente desde **Supabase → Storage → auth-sessions → baileys-session**, seleccionando y eliminando todos los archivos.

### 5. Keep-alive

El bot incluye un servidor HTTP en el puerto `PORT` (por defecto 3000) que expone `/health`. Cada 13 minutos se hace un self-ping a esa URL para evitar que Render suspenda el servicio en el plan gratuito.

---

## Despliegue con PM2

```bash
npm install -g pm2
pm2 start src/index.js --name bazfez-bot --interpreter node
pm2 save
pm2 startup
```

---

## Despliegue con Docker

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
docker build -t bazfez-bot .
docker run -d \
  --name bazfez-bot \
  --env-file .env \
  -v $(pwd)/auth_info:/app/auth_info \
  --restart unless-stopped \
  bazfez-bot
```

> En Docker la sesión persiste en el volumen `auth_info/`. Si usas Render, la persistencia la maneja Supabase Storage automáticamente.

---

## Solución de problemas

| Problema | Solución |
|----------|----------|
| Bot no responde | Verifica que el QR fue escaneado y `connection === 'open'` aparece en logs |
| `SUPABASE_SERVICE_ROLE_KEY` inválida | Usa la key de tipo `service_role`, no la `anon` |
| No cotiza | Verifica que la tabla `rates` exista y que el admin haya cargado un `.xlsx` de tarifas |
| Bucket no creado | El bot los crea automáticamente al arrancar; verifica permisos del `service_role` |
| Mensajes duplicados | Normal — la deduplicación los filtra; revisa tabla `processed_messages` |
| Timer no restaurado | Verifica que `pause_expires_at > NOW()` en la sesión pausada |
| QR en cada deploy | La sesión no está en Supabase Storage; corre el bot local y espera el evento `creds.update` para que se suba |
| Servicio suspendido en Render | Verifica que `RENDER_EXTERNAL_URL` está definida correctamente |
| Colonia/ciudad no detectada | El parser usa orden posicional; asegúrate de enviar las líneas en orden: nombre → calle → colonia → ciudad → teléfono |
