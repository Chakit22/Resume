FROM node:20-bookworm-slim

# Install tectonic (LaTeX compiler)
# Tarball contains single 'tectonic' binary at root; use %2B for + in URL
RUN apt-get update && apt-get install -y --no-install-recommends \
  curl ca-certificates \
  libgraphite2-3 libharfbuzz0b libicu72 libfreetype6 libfontconfig1 libpng16-16 && \
  curl -sL "https://github.com/tectonic-typesetting/tectonic/releases/download/continuous/tectonic-0.15.0%2B20251006-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/tectonic.tar.gz && \
  tar -xzf /tmp/tectonic.tar.gz -C /tmp && \
  cp /tmp/tectonic /usr/local/bin/ && \
  rm /tmp/tectonic.tar.gz /tmp/tectonic && \
  apt-get purge -y curl && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Pre-warm Tectonic cache so runtime compilations don't need network access
RUN cd resumes && tectonic base-resume.tex --outdir output && rm -f output/base-resume.pdf

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
CMD ["node", "dist/server.js"]
