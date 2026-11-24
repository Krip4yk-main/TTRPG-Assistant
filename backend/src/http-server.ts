import { createServer, type Server } from 'node:http';
import { createApp, type AppDeps } from './app.js';
import { attachRealtime } from './realtime/socket.js';

/**
 * Express мусить бути слухачем 'request' ДО attachRealtime: engine.io перехоплює
 * /socket.io лише для слухачів, що вже існували, інакше Express теж відповідає.
 * deps мутується (deps.realtime), бо маршрути читають його під час запиту.
 */
export function createHttpServer(deps: AppDeps): Server {
  const httpServer = createServer(createApp(deps));
  deps.realtime = attachRealtime(httpServer, deps);
  return httpServer;
}
