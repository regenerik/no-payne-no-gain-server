# No Payne No Gain Server

Servidor autoritativo Socket.IO para las rooms online de No Payne No Gain.

El servidor ejecuta la simulacion a 60 Hz y publica snapshots a 30 Hz. Los clientes
envian inputs y pedidos de tiro; no deciden posiciones, goles ni el estado de la pelota.

## Local

```bash
npm install
npm test
npm run dev
```

El servidor abre en:

```text
http://localhost:3001
```

Con el servidor local encendido, la prueba de dos clientes se ejecuta con:

```bash
npm run test:network
```

## Render

Crear un Web Service apuntando a esta carpeta.

- Build command: `npm install`
- Start command: `npm start`
- Environment:
  - `CLIENT_ORIGIN`: URL del frontend, por ejemplo `https://futbol-fun.onrender.com`.
  - `PORT`: no configurarlo; Render lo define automaticamente.

Las rooms viven en memoria. Si el servicio gratuito se duerme o reinicia, las rooms
activas se pierden y la primera conexion puede demorar mientras Render lo despierta.
