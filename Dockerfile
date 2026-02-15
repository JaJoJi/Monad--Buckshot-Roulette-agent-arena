    # ---------- Base Image ----------
FROM node:20-bookworm

# ---------- Install Python ----------
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    apt-get clean

# ---------- Enable pnpm ----------
RUN corepack enable && corepack prepare pnpm@latest --activate

# ---------- Set working directory ----------
WORKDIR /app

# ---------- Copy package files ----------
COPY package.json pnpm-lock.yaml ./

# ---------- Install Node deps ----------
RUN pnpm install --frozen-lockfile

# ---------- Install Python deps ----------
RUN pip3 install --no-cache-dir \
    google-generativeai \
    python-dotenv \
    requests \
    web3

# ---------- Copy rest of project ----------
COPY . .

# ---------- Expose port ----------
EXPOSE 3000

# ---------- Start server ----------
CMD ["pnpm", "start"]