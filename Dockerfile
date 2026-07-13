# The Midnight Express — app image (Node WebSocket + static server).
FROM node:20-alpine

WORKDIR /app

# Install server deps first for better layer caching.
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# Bring in the server code and the static screens (root of the repo).
COPY . .

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app

EXPOSE 8080
WORKDIR /app/server
CMD ["node", "server.js"]
