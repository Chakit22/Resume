FROM node:20-bookworm-slim

# Install tectonic (LaTeX compiler)
RUN apt-get update && apt-get install -y curl xz-utils && \
  curl -sL "https://github.com/tectonic-typesetting/tectonic/releases/download/continuous/tectonic-0.15.0+20251006-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/tectonic.tar.gz && \
  tar -xzf /tmp/tectonic.tar.gz -C /tmp && \
  cp /tmp/tectonic-*/bin/tectonic /usr/local/bin/ && \
  rm -rf /tmp/tectonic* && \
  apt-get purge -y curl xz-utils && apt-get autoremove -y

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
CMD ["node", "dist/server.js"]
