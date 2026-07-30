FROM node:20-slim

# Chromium + todas as bibliotecas de sistema que ele precisa (inclui libnss3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# dizer ao puppeteer-core onde está o Chromium do sistema
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# evitar que o puppeteer tente descarregar o seu próprio Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

# instalar dependências primeiro (cache)
COPY package*.json ./
RUN npm install --omit=dev

# copiar o resto do código
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
