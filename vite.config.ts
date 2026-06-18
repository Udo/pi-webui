import tailwindcss from "@tailwindcss/vite";
import { createLogger, defineConfig } from "vite";

const logger = createLogger();
function shouldSuppress(message: string) {
  return message.includes("fonts/KaTeX_");
}

const warn = logger.warn;
logger.warn = (message, options) => {
  if (shouldSuppress(message)) return;
  warn(message, options);
};

const warnOnce = logger.warnOnce;
logger.warnOnce = (message, options) => {
  if (shouldSuppress(message)) return;
  warnOnce(message, options);
};

export default defineConfig({
  root: ".",
  customLogger: logger,
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "client/index.html",
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
});
