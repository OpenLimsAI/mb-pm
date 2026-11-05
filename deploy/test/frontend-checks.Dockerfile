# Local/CI verification only. No application port is published by this image.
FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["sleep", "infinity"]
