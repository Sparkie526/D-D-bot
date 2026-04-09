FROM node:22.12.0-bookworm-slim

ENV NODE_ENV=production

# Native deps for @discordjs/opus / @snazzah/davey and ffmpeg for voice playback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=optional --omit=dev

COPY . ./

# Bot writes dm_response.mp3 at runtime.
RUN chown -R node:node /app
USER node

CMD ["npm", "start"]
