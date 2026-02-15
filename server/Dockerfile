FROM node:20-bookworm

WORKDIR /app

RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
RUN ln -s /usr/bin/python3 /usr/bin/python
COPY . .
RUN pnpm list typescript
RUN pnpm build

EXPOSE 3000

CMD ["node", "dist/index.js"]