FROM node:18-slim

# Install system dependencies for Playwright and Xvfb
RUN apt-get update \
    && apt-get install -y xvfb xauth procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create user early
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser

# Copy package files and install as root (for npm modules)
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .
RUN npm run build

# Fix ownership
RUN chown -R pptruser:pptruser /app

# Switch to pptruser
USER pptruser

# Install Playwright browsers as pptruser
RUN npx playwright install --with-deps chromium

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 & export DISPLAY=:99 && npm start"]
